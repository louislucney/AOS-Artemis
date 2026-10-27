import fs from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MemoryStore } from "../db/memory.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import { readTestsDocument } from "../figma/design-store.js";
import { figmaExtractFlows } from "../figma/flows.js";
import { figmaGenerateTests } from "../figma/test-gen.js";
import type { DesignRuntimeLike } from "../figma/design-runtime.js";
import { rewriteCasesForWeb } from "../figma/web-wording.js";
import { penExtractFlows } from "../pen/flows.js";
import { ensurePenCli } from "../pen/install.js";
import { penEnvFrom, penExec } from "../pen/cli.js";
import { runDesignReading } from "../design/reading/run.js";
import { readingPaths } from "../design/reading/store.js";
import type { ReadingAnswer } from "../design/reading/types.js";
import { buildZip, type ZipEntry } from "./zip.js";
import { renderCmsWorkbook } from "./template-map.js";
import { errorMessage } from "../util.js";

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
  /** Figma 无原型交互时是否按箭头/注释/画布顺序合成（默认 true）。 */
  staticFallback?: boolean;
  /** 可选：生成前做静态设计阅读（需要视觉 LLM）。默认 false。 */
  reading?: boolean;
  /** 阅读时把 pen 状态变体也作为独立屏（默认 false）。 */
  readingStates?: boolean;
  /** 阅读最多屏数（默认 30，最大 200）。 */
  readingMaxScreens?: number;
  /** 本次请求的人工答案，写入 reading/answers.json 后参与合并。 */
  readingAnswers?: ReadingAnswer[];
}

export interface OpenPipelineDeps {
  extractFigma?: typeof figmaExtractFlows;
  extractPen?: typeof penExtractFlows;
  generate?: typeof figmaGenerateTests;
  readDesign?: typeof runDesignReading;
  penReady?: () => Promise<{ ok: true } | { ok: false; hint: string }>;
  now?: () => Date;
  /** Cooperative cancel: checked at step boundaries. */
  isCancelled?: () => boolean;
  /** Progress hook for the job manager (`extracting` → `generating` → `packaging`). */
  onStep?: (step: string) => void;
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

function classifyFigmaError(message: string): string {
  if (/Figma API 401|Figma API 403|FIGMA_ACCESS_TOKEN|Invalid token/i.test(message)) {
    return "figma_auth";
  }
  if (/Figma API 404|Cannot parse Figma file key/i.test(message)) return "figma_not_found";
  if (/rate limit|429|retry-after/i.test(message)) return "figma_rate_limit";
  return "figma_extract_failed";
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

type DesignReadingResult = Awaited<ReturnType<typeof runDesignReading>>;

function readingSection(result: DesignReadingResult): string {
  const reading = result.reading;
  if (reading === null) return "";
  const lines = ["## 设计阅读", ""];
  lines.push(
    `- 状态: ${result.status} · 屏 ${reading.completeness.screensRead}/${reading.completeness.screensTotal} · 块 ${result.stats.chunksProcessed}/${result.stats.chunksRequested}`
  );
  lines.push(
    `- 问题: ${reading.questions.length} 条展示 / ${reading.completeness.questionsTotal} 条总计 · 已回答 ${reading.completeness.questionsAnswered}`
  );
  if (reading.spine !== null) {
    lines.push(`- CR 主线: ${reading.spine.title}（${reading.spine.status}）`);
    lines.push(`  ${reading.spine.summary}`);
  }
  lines.push("- 完整报告: `design-reading.md`", "");
  if (reading.questions.length > 0) {
    lines.push("### 关键问题", "");
    for (const question of reading.questions.slice(0, 10)) {
      lines.push(`- \`${question.screenId}\` ${question.question}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function readingMeta(
  result: DesignReadingResult | null,
  skipReason: string | null
): Record<string, unknown> {
  if (result === null) {
    return skipReason === null
      ? { status: "disabled" }
      : { status: "skipped", reason: skipReason };
  }
  const reading = result.reading;
  return {
    status: result.status,
    ...(result.reason === null ? {} : { reason: result.reason }),
    ...(reading === null
      ? {}
      : {
          screensRead: reading.completeness.screensRead,
          screensTotal: reading.completeness.screensTotal,
          chunksProcessed: result.stats.chunksProcessed,
          chunksRequested: result.stats.chunksRequested,
          questionsTotal: reading.completeness.questionsTotal,
          questionsAnswered: reading.completeness.questionsAnswered,
          spineStatus: reading.spine?.status ?? null,
          spineTitle: reading.spine?.title ?? null
        }),
    ...(result.artifacts === null
      ? {}
      : { artifacts: { markdown: "design-reading.md", json: "design-reading.json" } })
  };
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
      {
        url: input.figmaUrl,
        nodeId: input.nodeId,
        screens: true,
        save: true,
        ...(input.staticFallback === undefined ? {} : { staticFallback: input.staticFallback })
      },
      { figmaToken: input.figmaToken, chat }
    );
    const error = toolError(result);
    if (error !== null) {
      throw new OpenJobError(classifyFigmaError(error), error);
    }
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

  let readingResult: DesignReadingResult | null = null;
  let readingSkipReason: string | null = null;
  if (input.reading === true) {
    const llm = input.llm;
    if (chat === null || llm === null) {
      readingSkipReason = "未提供 LLM（设计阅读需要视觉模型）";
      warnings.push(`阅读跳过：${readingSkipReason}`);
    } else if (!fs.existsSync(flowsFile)) {
      readingSkipReason = "flows.json 不存在，无法阅读";
      warnings.push(`阅读跳过：${readingSkipReason}`);
    } else {
      deps.onStep?.("reading");
      if ((input.readingAnswers?.length ?? 0) > 0) {
        const root = readingPaths(runtime.configDirAbs).root;
        await mkdir(root, { recursive: true });
        await writeFile(
          path.join(root, "answers.json"),
          `${JSON.stringify({ version: 1, answers: input.readingAnswers }, null, 2)}\n`,
          "utf8"
        );
      }
      try {
        readingResult = await (deps.readDesign ?? runDesignReading)({
          runtime,
          flowsPath: flowsFile,
          options: {
            maxScreens: Math.min(200, Math.max(1, input.readingMaxScreens ?? 30)),
            includeStates: input.readingStates === true
          },
          model: llm.model,
          chat,
          env: process.env
        });
        warnings.push(...readingResult.warnings.map((warning) => warning.message));
      } catch (error) {
        readingSkipReason = errorMessage(error);
        warnings.push(`阅读失败：${readingSkipReason}`);
      }
    }
  }
  const readingInfo = readingMeta(readingResult, readingSkipReason);

  const generate = deps.generate ?? figmaGenerateTests;
  if (deps.isCancelled?.()) throw new OpenJobError("cancelled", "任务已取消");
  deps.onStep?.("generating");
  const generated = await generate(
    runtime,
    {
      save: true,
      screens: false,
      saveArtifacts: { markdown: false, xlsx: false, caseSets: false },
      ...(input.maxFlows === undefined ? {} : { maxFlows: input.maxFlows }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth })
    },
    { chat, figmaToken: input.figmaToken }
  );
  const generationError = toolError(generated);
  if (generationError !== null) throw new OpenJobError("generation_failed", generationError);

  const cases: unknown[] = readTestsDocument(runtime.configDirAbs)?.rawFlows ?? [];
  if (cases.length === 0) {
    throw new OpenJobError(
      "no_cases",
      "未生成任何用例",
      "设计稿可能缺少交互/箭头/注释，或 maxFlows 过窄；补充设计线索后重试"
    );
  }

  const webCases = rewriteCasesForWeb(cases as never);
  if (deps.isCancelled?.()) throw new OpenJobError("cancelled", "任务已取消");
  deps.onStep?.("packaging");
  const xlsx = await (async (): Promise<Buffer> => {
    try {
      return await renderCmsWorkbook(webCases, {
        source: input.source === "figma" ? "figma" : "pen",
        generatedAt,
        model: input.llm?.model ?? null,
        ...(input.maxFlows === undefined ? {} : { maxFlows: input.maxFlows }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        counts: { cases: cases.length, screens: screenCount },
        warnings
      }, { templatePath: input.templatePath });
    } catch (error) {
      throw new OpenJobError("template_invalid", errorMessage(error));
    }
  })();

  const designPath = path.join(designDir, "flow-map.md");
  let designMd = fs.existsSync(designPath)
    ? await readFile(designPath, "utf-8")
    : `# ${designName} · 设计理解\n\n（未生成流程图）\n`;
  const readingText = readingResult === null ? "" : readingSection(readingResult);
  if (readingText !== "") {
    designMd = `${designMd.trimEnd()}\n\n${readingText}\n`;
  }
  const readingEntries: ZipEntry[] = [];
  if (readingResult !== null && readingResult.artifacts !== null) {
    if (fs.existsSync(readingResult.artifacts.markdown)) {
      readingEntries.push({
        path: "design-reading.md",
        data: await readFile(readingResult.artifacts.markdown)
      });
    }
    if (fs.existsSync(readingResult.artifacts.json)) {
      readingEntries.push({
        path: "design-reading.json",
        data: await readFile(readingResult.artifacts.json)
      });
    }
  }

  const meta = {
    source: input.source,
    designName,
    generatedAt,
    model: input.llm?.model ?? null,
    maxFlows: input.maxFlows ?? 10,
    maxDepth: input.maxDepth ?? 30,
    counts: { screens: screenCount, cases: cases.length },
    reading: readingInfo,
    warnings
  };
  const entries: ZipEntry[] = [
    { path: "design.md", data: Buffer.from(designMd, "utf-8") },
    { path: "cases.xlsx", data: xlsx },
    ...readingEntries,
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

