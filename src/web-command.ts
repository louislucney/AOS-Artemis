import { loadProject } from "./config/loader.js";
import { createProjectStore, type CreateStoreResult } from "./db/index.js";
import type { ProjectStore } from "./db/types.js";
import { generateScriptSetForProject, ScriptGenerationError } from "./web/script-generation.js";
import { ScriptSetStoreError } from "./web/script-set.js";
import type { PreconditionMode, ScriptPlatform } from "./web/script-gen.js";

export interface WebCliDeps {
  store?: ProjectStore;
  createStore?: (databaseUrl: string | null) => Promise<CreateStoreResult>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  has: (key: string) => boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key: string;
    let value: string | true;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    const existing = flags.get(key);
    if (existing === undefined) flags.set(key, value);
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags.set(key, [String(existing), String(value)]);
  }
  return {
    positional,
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    has: (key) => flags.has(key)
  };
}

export function printWebUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp web — Web 项目脚本工具

Usage:
  mobile-testing-mcp web scripts generate --project <dir> --excel <assetId> --package <assetId>
      --platform <android|ios> [--app-id <package|bundleId>]
      [--strict|--assume-prepared] [--dry-run] [--json]

说明:
  --project <dir>       项目根目录（缺省按 AOS_PROJECT_DIR / cwd）
  --excel <assetId>     Excel/CSV 资产 id（项目资产版本）
  --package <assetId>   安装包资产 id
  --platform            android | ios；必须已在项目 platforms 中
  --app-id              缺省用项目 appPackage；双端建议显式传
  --strict              前置条件非空 → unresolved（默认）
  --assume-prepared     前置条件视为环境已准备；clearState/stopApp=false，结果标注
  --dry-run             只生成 manifest，不写 scripts 资产
  --json                机器可读输出
  --help                本帮助

exit codes: 0 成功；1 没有 ready 用例/脚本集不可用；2 参数/项目/资产/解析错误`);
}

function parsePlatform(value: string | null): ScriptPlatform | null {
  return value === "android" || value === "ios" ? value : null;
}

function parsePreconditionMode(flags: ParsedFlags): PreconditionMode | null {
  if (flags.bool("strict") && flags.bool("assume-prepared")) return null;
  if (flags.bool("assume-prepared")) return "assume-prepared";
  if (flags.bool("strict")) return "strict";
  const value = flags.get("precondition-mode");
  if (value === null) return "strict";
  return value === "strict" || value === "assume-prepared" ? value : null;
}

function summarizeCases(
  manifest: { cases: Array<{ caseId: string; status: string; assertions: number; unresolved: Array<{ code: string; step: number | null }>; warnings: string[] }> },
  limit = 20
): string[] {
  const lines: string[] = [];
  for (const entry of manifest.cases.slice(0, limit)) {
    const issues = entry.unresolved.map((item) => `${item.code}${item.step === null ? "" : `:${item.step}`}`);
    const warnings = entry.warnings.length > 0 ? ` · warning ${entry.warnings.join(",")}` : "";
    lines.push(
      `  ${entry.caseId} ${entry.status} · assertions ${entry.assertions}` +
        (issues.length > 0 ? ` · ${issues.join(",")}` : "") +
        warnings
    );
  }
  if (manifest.cases.length > limit) lines.push(`  … 其余 ${manifest.cases.length - limit} 条见 --json`);
  return lines;
}

export async function runWebCommand(argv: string[], deps: WebCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  if (argv.includes("-h") || argv.includes("--help")) {
    printWebUsage(log);
    return 0;
  }
  if (flags.positional[0] !== "scripts" || flags.positional[1] !== "generate") {
    errorLog(`未知 web 子命令 "${flags.positional.join(" ") || "(空)"}"`);
    printWebUsage(errorLog);
    return 2;
  }

  const excelAssetId = (flags.get("excel") ?? "").trim();
  const packageAssetId = (flags.get("package") ?? "").trim();
  const platform = parsePlatform(flags.get("platform"));
  if (excelAssetId === "") return reportUsageError(errorLog, "缺少 --excel");
  if (packageAssetId === "") return reportUsageError(errorLog, "缺少 --package");
  if (platform === null) return reportUsageError(errorLog, "--platform 只能是 android 或 ios");
  const preconditionMode = parsePreconditionMode(flags);
  if (preconditionMode === null) {
    return reportUsageError(errorLog, "--strict 与 --assume-prepared 不能同时使用");
  }

  let store = deps.store;
  let ownsStore = false;
  try {
    if (store === undefined) {
      const projectDir = flags.get("project");
      const env = projectDir
        ? { ...(deps.env ?? process.env), AOS_PROJECT_DIR: projectDir.trim(), AOS_CONFIG: "" }
        : (deps.env ?? process.env);
      const project = loadProject({ env, ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }) });
      const createStore = deps.createStore ?? createProjectStore;
      const created = await createStore(null);
      store = created.store;
      ownsStore = true;
      const result = await generateScriptSetForProject({
        store,
        rootPath: project.rootDir,
        excelAssetId,
        packageAssetId,
        platform,
        appId: flags.get("app-id"),
        preconditionMode,
        dryRun: flags.bool("dry-run"),
        uploadedBy: "cli"
      });
      return printResult(result, flags.bool("json"), log, errorLog);
    }
    const projectDir = flags.get("project");
    const env = projectDir
      ? { ...(deps.env ?? process.env), AOS_PROJECT_DIR: projectDir.trim(), AOS_CONFIG: "" }
      : (deps.env ?? process.env);
    const project = loadProject({ env, ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }) });
    const result = await generateScriptSetForProject({
      store,
      rootPath: project.rootDir,
      excelAssetId,
      packageAssetId,
      platform,
      appId: flags.get("app-id"),
      preconditionMode,
      dryRun: flags.bool("dry-run"),
      uploadedBy: "cli"
    });
    return printResult(result, flags.bool("json"), log, errorLog);
  } catch (error) {
    if (error instanceof ScriptSetStoreError) {
      errorLog(`生成失败：${error.message}`);
      return error.code === "script-set-unusable" ? 1 : 2;
    }
    if (error instanceof ScriptGenerationError) {
      errorLog(`生成失败：${error.message}`);
      return 2;
    }
    errorLog(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    if (ownsStore && store !== undefined) {
      await store.close().catch(() => undefined);
    }
  }
}

function reportUsageError(errorLog: (line: string) => void, message: string): number {
  errorLog(message);
  printWebUsage(errorLog);
  return 2;
}

function printResult(
  result: Awaited<ReturnType<typeof generateScriptSetForProject>>,
  jsonOutput: boolean,
  log: (line: string) => void,
  errorLog: (line: string) => void
): number {
  if (jsonOutput) {
    log(
      JSON.stringify(
        {
          ok: true,
          dryRun: result.dryRun,
          appId: result.appId,
          platform: result.platform,
          ready: result.ready,
          unresolved: result.unresolved,
          created: result.created,
          asset:
            result.asset === null
              ? null
              : {
                  id: result.asset.id,
                  version: result.asset.version,
                  filename: result.asset.filename,
                  sha256: result.asset.sha256
                },
          manifest: result.manifest
        },
        null,
        2
      )
    );
  } else {
    log(
      `脚本生成${result.dryRun ? "（dry-run）" : ""} · 平台 ${result.platform} · appId ${result.appId}`
    );
    log(`用例 ${result.manifest.counts.cases}：ready ${result.ready} / unresolved ${result.unresolved}`);
    if (result.asset !== null) {
      log(
        `脚本集 v${result.asset.version} · ${result.asset.filename} · ${result.created ? "新建" : "复用"} · sha256 ${result.asset.sha256.slice(0, 12)}`
      );
    }
    for (const line of summarizeCases(result.manifest)) log(line);
  }
  if (result.ready === 0) {
    errorLog("没有 ready 用例：脚本集不可下发；请检查前置条件/步骤解析或使用 --assume-prepared");
    return 1;
  }
  return 0;
}
