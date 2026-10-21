import fs from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MemoryStore } from "../db/memory.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import { figmaExtractFlows } from "../figma/flows.js";
import { figmaGenerateTests } from "../figma/test-gen.js";
import type { DesignRuntimeLike } from "../figma/design-runtime.js";
import { rewriteCasesForWeb } from "../figma/web-wording.js";
import { penExtractFlows } from "../pen/flows.js";
import { ensurePenCli } from "../pen/install.js";
import { penEnvFrom, penExec } from "../pen/cli.js";
import { buildZip, type ZipEntry } from "./zip.js";
import { renderCmsWorkbook } from "./template-map.js";

export class OpenJobError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "OpenJobError";
    this.code = code;
    this.hint = hint;
  }
}

export interface OpenJobInput {
  source: "figma" | "pen";
  figmaUrl?: string;
  figmaToken?: string;
  nodeId?: string;
  /** Path to the uploaded .pen inside the job workspace. */
  penFile?: string;
  templatePath?: string;
  llm: { baseUrl: string; model: string; apiKey: string } | null;
  maxFlows?: number;
  maxDepth?: number;
}

export interface OpenPipelineDeps {
  extractFigma?: typeof figmaExtractFlows;
  extractPen?: typeof penExtractFlows;
  generate?: typeof figmaGenerateTests;
  penReady?: () => Promise<{ ok: true } | { ok: false; hint: string }>;
  now?: () => Date;
  /** Cooperative cancel: checked at step boundaries. */
  isCancelled?: () => boolean;
}

export interface OpenJobResult {
  zipPath: string;
  counts: { screens: number; cases: number };
  warnings: string[];
}

function toolError(result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }): string | null {
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  if (!result.isError) {
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; error?: unknown };
      if (parsed.ok === false) return typeof parsed.error === "string" ? parsed.error : "生成失败";
    } catch {
      /* non-JSON success payload */
    }
    return null;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    /* fall through */
  }
  return text || "生成失败";
}

function warningMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === "object" ? (entry as { message?: unknown }).message : null))
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

async function collectScreens(designDir: string): Promise<ZipEntry[]> {
  const root = path.join(designDir, "screens");
  if (!fs.existsSync(root)) return [];
  const entries: ZipEntry[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await visit(full);
      } else if (dirent.isFile()) {
        entries.push({
          path: path.relative(designDir, full).split(path.sep).join("/"),
          data: await readFile(full)
        });
      }
    }
  };
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function defaultPenReady(): Promise<{ ok: true } | { ok: false; hint: string }> {
  const env = penEnvFrom({}, process.env);
  const ready = await ensurePenCli({ env });
  if (!ready.ok || ready.path === null) {
    return { ok: false, hint: ready.hint ?? "pen CLI 不可用：请安装 @pen.dev/cli 或设置 AOS_PEN_CLI_PATH" };
  }
  const status = await penExec(ready.path, ["status"], { timeoutMs: 30_000, env });
  if (status.code !== 0) {
    return { ok: false, hint: "pen CLI 未登录：在服务机执行 pen login（或设置 PEN_CLI_KEY）后重试" };
  }
  return { ok: true };
}

export async function runOpenJob(
  input: OpenJobInput,
  workDir: string,
  deps: OpenPipelineDeps = {}
): Promise<OpenJobResult> {
  const projectRoot = path.join(workDir, "project");
  const configDir = path.join(projectRoot, ".artemis");
  const designDir = path.join(configDir, "design");
  await mkdir(designDir, { recursive: true });
  const runtime: DesignRuntimeLike = {
    configDirAbs: configDir,
    project: { rootDir: projectRoot, dotenvValues: {} },
    store: new MemoryStore()
  };
  const chat: ChatFn | null = input.llm
    ? makeChatFn({ baseUrl: input.llm.baseUrl, apiKey: input.llm.apiKey, model: input.llm.model })
    : null;
  const now = deps.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  let warnings: string[] = [];
  let screenCount = 0;
  let designName = "design";

  if (input.source === "figma") {
    if (!input.figmaUrl) throw new OpenJobError("invalid_source", "缺少 figmaUrl");
    const result = await (deps.extractFigma ?? figmaExtractFlows)(
      runtime,
      { url: input.figmaUrl, nodeId: input.nodeId, screens: true, save: true },
      { figmaToken: input.figmaToken, chat }
    );
    const error = toolError(result);
    if (error !== null) throw new OpenJobError("figma_extract_failed", error);
  } else {
    const ready = await (deps.penReady ?? defaultPenReady)();
    if (!ready.ok) throw new OpenJobError("pen_unavailable", ready.hint, ready.hint);
    const penFile = input.penFile ?? path.join(designDir, "input.pen");
    designName = path.basename(penFile, ".pen");
    const result = await (deps.extractPen ?? penExtractFlows)(
      runtime,
      { path: path.relative(projectRoot, penFile), screens: true },
      { chat: chat ?? undefined }
    );
    const error = toolError(result);
    if (error !== null) throw new OpenJobError("pen_extract_failed", error);
    const flowsPath = path.join(designDir, "flows.json");
    if (fs.existsSync(flowsPath)) {
      const parsed = JSON.parse(await readFile(flowsPath, "utf-8")) as {
        screens?: unknown;
        warnings?: unknown;
      };
      screenCount = Array.isArray(parsed.screens) ? parsed.screens.length : 0;
      warnings.push(...warningMessages(parsed.warnings));
    }
  }

  const flowsFile = path.join(designDir, "flows.json");
  if (fs.existsSync(flowsFile)) {
    try {
      const parsed = JSON.parse(await readFile(flowsFile, "utf-8")) as {
        screens?: unknown;
        warnings?: unknown;
      };
      if (screenCount === 0 && Array.isArray(parsed.screens)) screenCount = parsed.screens.length;
      warnings = [...new Set([...warnings, ...warningMessages(parsed.warnings)])];
    } catch {
      /* flows.json is optional for the summary */
    }
  }

  const generate = deps.generate ?? figmaGenerateTests;
  if (deps.isCancelled?.()) throw new OpenJobError("cancelled", "任务已取消");
  const generated = await generate(
    runtime,
    {
      save: true,
      screens: false,
      excelPath: ".artemis/design/discard.xlsx",
      ...(input.maxFlows === undefined ? {} : { maxFlows: input.maxFlows }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth })
    },
    { chat, figmaToken: input.figmaToken }
  );
  const generationError = toolError(generated);
  if (generationError !== null) throw new OpenJobError("generation_failed", generationError);

  const testsPath = path.join(designDir, "tests.json");
  let cases: unknown[] = [];
  if (fs.existsSync(testsPath)) {
    const parsed = JSON.parse(await readFile(testsPath, "utf-8")) as { cases?: unknown };
    if (Array.isArray(parsed.cases)) cases = parsed.cases;
  }
  if (cases.length === 0) {
    throw new OpenJobError(
      "no_cases",
      "未生成任何用例",
      "设计稿可能缺少交互/箭头/注释，或 maxFlows 过窄；补充设计线索后重试"
    );
  }

  const webCases = rewriteCasesForWeb(cases as never);
  if (deps.isCancelled?.()) throw new OpenJobError("cancelled", "任务已取消");
  const xlsx = await renderCmsWorkbook(webCases, {
    source: input.source === "figma" ? "figma" : "pen",
    generatedAt,
    model: input.llm?.model ?? null,
    ...(input.maxFlows === undefined ? {} : { maxFlows: input.maxFlows }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    counts: { cases: cases.length, screens: screenCount },
    warnings
  }, { templatePath: input.templatePath });

  const designPath = path.join(designDir, "flow-map.md");
  const designMd = fs.existsSync(designPath)
    ? await readFile(designPath, "utf-8")
    : `# ${designName} · 设计理解\n\n（未生成流程图）\n`;

  const meta = {
    source: input.source,
    designName,
    generatedAt,
    model: input.llm?.model ?? null,
    maxFlows: input.maxFlows ?? 10,
    maxDepth: input.maxDepth ?? 30,
    counts: { screens: screenCount, cases: cases.length },
    warnings
  };
  const entries: ZipEntry[] = [
    { path: "design.md", data: Buffer.from(designMd, "utf-8") },
    { path: "cases.xlsx", data: xlsx },
    ...(await collectScreens(designDir)),
    { path: "meta.json", data: Buffer.from(JSON.stringify(meta, null, 2), "utf-8") }
  ];
  const zipPath = path.join(workDir, "result.zip");
  await writeFile(zipPath, buildZip(entries));
  return {
    zipPath,
    counts: { screens: screenCount, cases: cases.length },
    warnings
  };
}

