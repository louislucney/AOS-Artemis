import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  buildAssetHashIndex,
  decideAssetWrite,
  planImports,
  renderIosContents,
  writeAssetFile,
  type GapAssetEntry,
  type ImportResultEntry
} from "../figma/import.js";
import { DEFAULT_ASSET_GLOBS, fallbackAssetName, isGenericLayerName, walkProjectFiles } from "../figma/gaps.js";
import { detectProjectStacks, primaryProfile, skippedStacksWarning } from "../projects/stack.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { detectPenFailure, penEnvFrom, runPenCli, runPenInteractive, type PenExecFn } from "./cli.js";
import { ensurePenCli, type PenEnsureFn } from "./install.js";
import { loadPenDocument, PEN_HINT, resolvePenTarget } from "./paths.js";
import { collectPenNodes } from "./read.js";

export interface PenAssetsArgs {
  path?: string;
  ids: string[];
  format?: "png" | "jpeg" | "webp";
  densities?: boolean;
  destDir?: string;
  overwrite?: boolean;
  dryRun?: boolean;
  save?: boolean;
  timeoutMs?: number;
}

export interface PenToolDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
}

const FORMAT_EXTENSION: Record<string, string> = { png: "png", jpeg: "jpeg", webp: "webp" };
const IMPORT_TIMEOUT_DEFAULT_MS = 120_000;
const IMPORT_TIMEOUT_MIN_MS = 5_000;
const IMPORT_TIMEOUT_MAX_MS = 30 * 60_000;
const IMPORT_TIMEOUT_BASE_MS = 60_000;
const IMPORT_TIMEOUT_PER_UNIT_MS = 5_000;

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/** Session-level budget: penExec enforces one hard timeout per interactive
 * spawn, so all per-density Export commands share it. Formula: explicit >
 * AOS_PEN_IMPORT_TIMEOUT_MS > max(AOS_PEN_TIMEOUT_MS, 60s + units × 5s). */
export function resolveImportTimeoutMs(
  explicit: number | undefined,
  env: NodeJS.ProcessEnv,
  units: number
): number {
  const override = Number(env.AOS_PEN_IMPORT_TIMEOUT_MS ?? "");
  const base = Number(env.AOS_PEN_TIMEOUT_MS ?? "");
  let value: number;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    value = Math.trunc(explicit);
  } else if (Number.isFinite(override) && override > 0) {
    value = Math.trunc(override);
  } else {
    const baseline = Number.isFinite(base) && base > 0 ? Math.trunc(base) : IMPORT_TIMEOUT_DEFAULT_MS;
    value = Math.max(baseline, IMPORT_TIMEOUT_BASE_MS + units * IMPORT_TIMEOUT_PER_UNIT_MS);
  }
  return Math.min(Math.max(value, IMPORT_TIMEOUT_MIN_MS), IMPORT_TIMEOUT_MAX_MS);
}

/** Absolute paths listed by the CLI as `Exported <path>` (contract snapshot
 * pen 0.3.10); used as the primary reconciliation source, tmp dir scan is the fallback. */
export function parseExportedPaths(log: string, baseDir: string): string[] {
  const base = path.resolve(baseDir);
  const out: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^\s*Exported\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const candidate = path.resolve(match[1]!);
    if (candidate.startsWith(base + path.sep)) out.push(candidate);
  }
  return out;
}

function displayPath(runtime: Runtime, absolute: string): string {
  const relative = path.relative(runtime.project.rootDir, absolute);
  return relative.startsWith("..") ? absolute : relative;
}

async function readPenVersion(
  exec: PenExecFn | undefined,
  cliPath: string | undefined,
  env: Record<string, string>
): Promise<string | null> {
  try {
    const run = await runPenCli(["version"], { exec, cliPath, env, timeoutMs: 5_000 });
    const text = run.result.stdout.trim();
    if (run.result.code !== 0 || text === "") return null;
    return text.split(/\s+/).pop() ?? null;
  } catch {
    return null;
  }
}

export async function penImportAssets(
  runtime: Runtime,
  args: PenAssetsArgs,
  deps: PenToolDeps = {}
): Promise<CallToolResult> {
  let tmpRoot: string | null = null;
  try {
    const target = resolvePenTarget(runtime, args.path);
    if (!target) {
      return jsonResult(
        { ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT },
        true
      );
    }
    const doc = loadPenDocument(target);
    const nameById = new Map<string, string>();
    for (const node of collectPenNodes(doc)) {
      if (typeof node.id === "string" && node.id.length > 0) {
        nameById.set(node.id, typeof node.name === "string" ? node.name : "");
      }
    }

    const requested = [...new Set(args.ids.map((id) => id.trim()).filter(Boolean))];
    if (requested.length === 0) {
      return jsonResult({ ok: false, error: "ids 不能为空" }, true);
    }
    const unknown = requested.filter((id) => !nameById.has(id));
    if (unknown.length > 0) {
      return jsonResult(
        {
          ok: false,
          error: `id 不存在于 .pen：${unknown.join("、")}`,
          hint: "先用 pen_inspect 核对节点 id，或检查 path 是否指向正确的 .pen。"
        },
        true
      );
    }

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const format = args.format ?? "png";
    const ext = FORMAT_EXTENSION[format] ?? "png";
    const densities = args.densities !== false;

    const entries: GapAssetEntry[] = requested.map((id) => {
      const raw = nameById.get(id) || id;
      return { name: isGenericLayerName(raw) ? fallbackAssetName(id) : raw, figmaId: id };
    });
    const plan = planImports(entries, profile, { destDir: args.destDir, format, densities });
    const imageEntries = plan.filter((entry) => entry.role === "image");
    const contentsEntries = plan.filter((entry) => entry.role === "contents");
    if (plan.length === 0) {
      return jsonResult({ ok: true, message: "没有可导出的目标文件", results: [] });
    }
    const imageIds = [...new Set(imageEntries.map((entry) => entry.sourceId))];
    const scales = [...new Set(imageEntries.map((entry) => entry.scale))].sort((a, b) => a - b);

    const dotenv = runtime.project.dotenvValues ?? {};
    const timeoutMs = resolveImportTimeoutMs(args.timeoutMs, { ...dotenv, ...process.env }, imageIds.length * scales.length);

    const env = penEnvFrom(dotenv, process.env);
    const ready = await (deps.ensure ?? ensurePenCli)({ env });
    if (!ready.ok) {
      return jsonResult({ ok: false, error: ready.error ?? "pen CLI 不可用", hint: ready.hint }, true);
    }

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-assets-"));
    const scaleDir = (scale: number): string => path.join(tmpRoot!, `s${scale}`);
    const commands = scales.map((scale) => {
      const expression = `Export(${JSON.stringify(imageIds)}, ${JSON.stringify(format)}, ${JSON.stringify(scaleDir(scale))}, { scale: ${scale} })`;
      return `execute({ input: ${JSON.stringify(expression)} })`;
    });

    const run = await runPenInteractive({
      input: target,
      output: path.join(tmpRoot, "session.pen"),
      commands,
      timeoutMs,
      exec: deps.exec,
      cliPath: ready.path ?? undefined,
      env
    });
    const failure = detectPenFailure(run.result, run.log);

    const present = new Map<number, Set<string>>();
    for (const scale of scales) {
      const dir = scaleDir(scale);
      const ids = new Set<string>();
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.toLowerCase().endsWith(`.${ext}`)) {
            ids.add(file.slice(0, -(ext.length + 1)));
          }
        }
      }
      present.set(scale, ids);
    }
    for (const printed of parseExportedPaths(run.log, tmpRoot)) {
      const relative = path.relative(tmpRoot, printed);
      const parts = relative.split(path.sep);
      const scaleMatch = /^s(\d+)$/.exec(parts[0] ?? "");
      const fileMatch = /^(.+)\.([A-Za-z0-9]+)$/.exec(parts[1] ?? "");
      if (!scaleMatch || !fileMatch) continue;
      const scale = Number(scaleMatch[1]);
      const ids = present.get(scale) ?? new Set<string>();
      ids.add(fileMatch[1]!);
      present.set(scale, ids);
    }

    const results: ImportResultEntry[] = [];
    const imageResults = new Map<string, ImportResultEntry>();
    const projectHashes = buildAssetHashIndex(
      runtime.project.rootDir,
      walkProjectFiles(runtime.project.rootDir, profile?.assetGlobs ?? DEFAULT_ASSET_GLOBS)
    );
    const batchHashes = new Map<string, string>();
    let missingUnits = 0;
    let producedUnits = 0;

    for (const entry of imageEntries) {
      const file = path.join(scaleDir(entry.scale), `${entry.sourceId}.${ext}`);
      let content: Buffer | null = null;
      if (present.get(entry.scale)?.has(entry.sourceId) === true || fs.existsSync(file)) {
        try {
          content = fs.readFileSync(file);
        } catch {
          content = null;
        }
      }
      if (!content) {
        missingUnits += 1;
        const result: ImportResultEntry = { ...entry, status: "error", error: "export-no-output" };
        results.push(result);
        imageResults.set(entry.relativePath, result);
        continue;
      }
      producedUnits += 1;

      const decision = decideAssetWrite({
        rootDir: runtime.project.rootDir,
        relativePath: entry.relativePath,
        content,
        projectHashes,
        batchHashes,
        overwrite: args.overwrite === true
      });

      let result: ImportResultEntry;
      if (decision.status === "written") {
        if (args.dryRun !== true) {
          writeAssetFile(runtime.project.rootDir, entry.relativePath, content, true);
        }
        batchHashes.set(decision.sha256, entry.relativePath);
        result = {
          ...entry,
          status: args.dryRun === true ? "planned" : "written",
          bytes: decision.bytes,
          sha256: decision.sha256
        };
      } else {
        result = {
          ...entry,
          status: decision.status,
          bytes: decision.bytes,
          sha256: decision.sha256,
          duplicateOf: decision.duplicateOf
        };
      }
      results.push(result);
      imageResults.set(entry.relativePath, result);
    }

    if (producedUnits === 0 && missingUnits > 0) {
      return jsonResult(
        {
          ok: false,
          error:
            failure ??
            "pen CLI 未产出任何导出文件（检查登录状态/PEN_CLI_KEY、.pen 内容与导出格式）",
          timeoutMs,
          log: run.log.slice(-2000),
          hint: PEN_HINT
        },
        true
      );
    }

    const dirOf = (relativePath: string): string => path.posix.dirname(relativePath);
    for (const entry of contentsEntries) {
      const failed = imageEntries.filter((image) => {
        const result = imageResults.get(image.relativePath);
        return (
          image.sourceId === entry.sourceId &&
          dirOf(image.relativePath) === dirOf(entry.relativePath) &&
          result !== undefined &&
          (result.status === "error" || result.status === "duplicate")
        );
      });
      if (failed.length > 0) {
        results.push({
          ...entry,
          status: "error",
          error: `有图片未写入（${failed.map((image) => image.relativePath).join("、")}），跳过 Contents.json`
        });
        continue;
      }
      const content = Buffer.from(
        renderIosContents(entry.contentsFiles ?? [], { vector: entry.contentsVector === true }),
        "utf-8"
      );
      const decision = decideAssetWrite({
        rootDir: runtime.project.rootDir,
        relativePath: entry.relativePath,
        content,
        projectHashes,
        batchHashes,
        overwrite: args.overwrite === true
      });
      if (decision.status === "written") {
        if (args.dryRun !== true) {
          writeAssetFile(runtime.project.rootDir, entry.relativePath, content, true);
        }
        batchHashes.set(decision.sha256, entry.relativePath);
        results.push({
          ...entry,
          status: args.dryRun === true ? "planned" : "written",
          bytes: decision.bytes,
          sha256: decision.sha256
        });
        continue;
      }
      results.push({
        ...entry,
        status: decision.status,
        bytes: decision.bytes,
        sha256: decision.sha256,
        duplicateOf: decision.duplicateOf
      });
    }

    const counts = results.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
      return accumulator;
    }, {});

    const warnings: string[] = [];
    const multiStackWarning = skippedStacksWarning(stacks, profile);
    if (multiStackWarning) warnings.push(multiStackWarning);
    if (failure) warnings.push(`pen CLI 报告错误（已按产物对账继续）：${failure}`);
    if (missingUnits > 0) {
      const scope = missingUnits === imageEntries.length ? "全缺（CLI/登录/格式问题）" : "部分缺（节点可能零尺寸/不可见，可先用 pen_inspect 复核）";
      warnings.push(`导出产物缺失 ${missingUnits}/${imageEntries.length}：${scope}；对应条目 status=error（export-no-output）`);
    }

    const penCliVersion = await readPenVersion(deps.exec, ready.path ?? undefined, env);
    const payload: Record<string, unknown> = {
      ok: true,
      source: "pen",
      schemaVersion: 2,
      ...(penCliVersion ? { penCliVersion } : {}),
      penPath: displayPath(runtime, target),
      format,
      densities,
      vector: "unsupported",
      dryRun: args.dryRun === true,
      detectedStacks: stacks,
      warnings,
      session: {
        timeoutMs,
        scales,
        commands: scales.length,
        exportedFiles: producedUnits
      },
      counts: {
        ...counts,
        assets: imageIds.length,
        files: plan.length
      },
      uniqueness: {
        indexedProjectAssets: projectHashes.size,
        duplicates: results.filter((entry) => entry.status === "duplicate").length
      },
      results,
      hint:
        (args.dryRun === true
          ? "dryRun 预览（渲染仍会执行以获得去重结果）：确认后去掉 dryRun 正式写入。"
          : "duplicate=同内容已存在（见 duplicateOf）；skipped_exists=同名但内容不同（需 overwrite）。") +
        " 位图按栈倍率集导出（Android drawable-xhdpi/-xxhdpi、Flutter 1x/2.0x/3.0x、iOS imageset、RN @2x/@3x）；densities:false 回退单文件 @2x；SVG 不受支持（vector:\"unsupported\"）。"
    };

    if (args.dryRun !== true && args.save !== false) {
      const reportPath = path.join(runtime.configDirAbs, "design", "import-report.pen.json");
      writeFileAtomic(reportPath, JSON.stringify(payload, null, 2) + "\n");
      payload.savedTo = reportPath;
    }

    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `pen 资源导入失败: ${errorMessage(error)}`, hint: PEN_HINT }, true);
  } finally {
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
