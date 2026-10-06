import fs from "node:fs";
import path from "node:path";

import { traceEvidence } from "./artemis/evidence.js";
import {
  API_ERRORS_ARTIFACT,
  loadApiErrorCatalog,
  matchApiErrors
} from "./artemis/api-errors.js";
import { loadProject } from "./config/loader.js";
import { createProjectStore } from "./db/index.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "./device/logcat.js";
import { classifyIosSerial } from "./device/ios.js";
import { IosLogCollector, type IosLogWindowRequest } from "./device/ios-log.js";
import { compareBaseline, saveBaseline, type BaselineRequest } from "./diff/baseline.js";
import { buildGenerationFeedback } from "./figma/generation-feedback.js";
import { buildRunReport } from "./figma/run-report.js";
import { runGeneratedTests } from "./figma/suite-runner.js";
import { Runtime } from "./runtime.js";
import { errorMessage, writeFileAtomic } from "./util.js";

type LogcatCollector = (request: {
  serial: string | null;
  windowStartMs: number;
  windowEndMs: number | null;
}) => Promise<LogcatWindowResult>;

type IosLogCollectorFn = (request: IosLogWindowRequest) => Promise<LogcatWindowResult>;

export interface SuiteCliDeps {
  buildRuntime?: (
    projectDir: string | null
  ) => Promise<{ runtime: Runtime; dispose: () => Promise<void> }>;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  logcatCollector?: LogcatCollector;
  iosLogCollector?: IosLogCollectorFn;
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  list: (key: string) => string[];
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
    list: (key) => {
      const value = flags.get(key);
      if (value === undefined || value === true) return [];
      return Array.isArray(value) ? value : [value];
    }
  };
}

function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function splitList(values: string[]): string[] {
  return values.flatMap((value) => value.split(",")).filter((value) => value !== "");
}

function parseIgnoreRegions(values: string[]): Array<{ x: number; y: number; width: number; height: number }> | null {
  const regions: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const value of values) {
    const parts = value.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
    regions.push({ x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! });
  }
  return regions;
}

async function defaultBuildRuntime(
  projectDir: string | null
): Promise<{ runtime: Runtime; dispose: () => Promise<void> }> {
  const env = projectDir
    ? { ...process.env, AOS_PROJECT_DIR: projectDir, AOS_CONFIG: "" }
    : process.env;
  const project = loadProject({ env });
  const { store, reason } = await createProjectStore();
  const runtime = new Runtime(project, { store, storeNote: reason });
  await runtime.initialize();
  return {
    runtime,
    dispose: async () => {
      try {
        runtime.proxy.disposeSync();
      } catch {
        /* already gone */
      }
      try {
        await store.close();
      } catch {
        /* ignore */
      }
    }
  };
}

export function printSuiteUsage(log: (line: string) => void): void {
  log(`aos-mcp suite — 测试闭环（生成用例的确定性执行与取证）

Usage:
  aos-mcp suite run [options]        执行 tests.json：每例复位→提交→轮询→台账→逐例分类
  aos-mcp suite evidence <traceId> [options]
                                     聚合某 trace 的失败证据包（失败项/崩溃/锚点截图/设计差异）
  aos-mcp suite api-errors <traceId> [options]
                                     按 trace 时间窗采集设备日志，匹配 error-codes.json 并落盘
  aos-mcp suite baseline save|compare [options]
                                     设备对设备基线视觉回归（last-known-good）
  aos-mcp suite report [options]     从运行台账导出 xlsx 结果页 + JUnit XML
  aos-mcp suite feedback [options]   基于台账与基线的生成改进建议（只读）

common: [--project <dir>] [--json]
run:    [--tests <path>] [--max <n>] [--stop-on-failure] [--device <serial>]
        [--app <package>] [--model Flash|Pro] [--poll-timeout <ms>]
        [--no-api-errors] [--fail-on api-error]
evidence: [--full-trace] [--out <dir>] [--no-save] [--design-figma <url>|--design-pen <path>] [--node <id>]
api-errors: [--serial <s>] [--app <bundleId>] [--no-save] [--json]
baseline: --case <caseId> --step <n> --trace <traceId> [--image post|pre] [--serial <s>] [--dpi <n>]
          [--ignore x,y,w,h]... [--no-save] [--fail-on new|persisting|any]
report: [--limit <n>] [--case <id>]... [--out <dir>] [--stamp <s>] [--no-save] [--no-sync]
feedback: [--limit <n>] [--min-failures <n>]

exit codes: 0 成功/全通过；1 用例失败或证据缺失；2 参数/执行错误或 --fail-on 命中（基线回归/未处理 API 错误）
错误码注册表: .artemis/design/error-codes.json（未配置时 api-errors 跳过并如实标注 degraded）`);
}

async function suiteRun(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): Promise<number> {
  const report = await runGeneratedTests(runtime, {
    testsPath: flags.get("tests") ?? undefined,
    maxCases: intOrNull(flags.get("max")) ?? undefined,
    stopOnFailure: flags.bool("stop-on-failure"),
    deviceSerial: flags.get("device") ?? undefined,
    lockedAppPackage: flags.get("app") ?? undefined,
    model: flags.get("model") ?? undefined,
    pollTimeoutMs: intOrNull(flags.get("poll-timeout")) ?? undefined,
    apiErrors: !flags.bool("no-api-errors"),
    failOnApiErrors: flags.get("fail-on") === "api-error",
    logcatCollector,
    iosLogCollector
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`套件: ${report.testsPath}`);
    if (report.preflight) {
      io.log(
        `预检: 弱用例 ${report.preflight.weakCases.length} 条 · 未覆盖屏幕 ${report.preflight.coverage.uncoveredScreens.length} · 未覆盖边 ${report.preflight.coverage.uncoveredEdges.length}`
      );
    }
    if (report.apiErrorCatalog) {
      io.log(
        `错误码注册表: ${report.apiErrorCatalog.rules} 条规则${report.apiErrorCatalog.errors.length > 0 ? `（${report.apiErrorCatalog.errors.length} 条无效）` : ""}`
      );
    }
    for (const entry of report.cases) {
      const label =
        entry.status === "passed" ? "PASS" : entry.status === "failed" ? "FAIL" : entry.status.toUpperCase();
      const failure = entry.failure
        ? ` · 失败域 ${entry.failure.domain}(${entry.failure.confidence})：${entry.failure.reason}`
        : "";
      const apiNote =
        entry.apiErrors.length > 0
          ? ` · API 错误 ${entry.apiErrors.map((error) => `${error.code}(${error.verdict})`).join("、")}`
          : "";
      const degraded = entry.apiErrorsDegraded ? ` · API 采集降级(${entry.apiErrorsDegraded})` : "";
      io.log(
        `[${label}] ${entry.name} (${entry.caseId}) trace=${entry.traceId ?? "-"}${failure}${apiNote}${degraded}`
      );
      if (entry.traceId && entry.status !== "passed") {
        io.log(`       证据: node dist/cli.js suite evidence ${entry.traceId}`);
      }
    }
    io.log(
      `结果: pass ${report.passed} / fail ${report.failed} / skipped ${report.skipped}（executed ${report.executed}）`
    );
    if (!report.ok) io.errorLog(`套件未执行: ${report.error ?? "无可提交用例"}`);
  }
  if (!report.ok) return 2;
  return report.failed === 0 ? 0 : 1;
}

async function suiteApiErrors(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): Promise<number> {
  const traceId = flags.positional[1];
  if (!traceId) {
    io.errorLog(
      "用法: aos-mcp suite api-errors <traceId> [--serial <s>] [--app <bundleId>] [--no-save] [--json]"
    );
    return 2;
  }
  const catalog = loadApiErrorCatalog(runtime.configDirAbs);
  if (catalog.rules.size === 0) {
    io.errorLog(
      `错误码注册表为空或缺失: ${catalog.file}${catalog.errors.length > 0 ? `（${catalog.errors.join("；")}）` : ""}`
    );
    return 2;
  }
  const status = await runtime.traceStatus(traceId);
  if (!status?.status) {
    io.errorLog(`未找到 trace ${traceId} 的状态，无法确定日志时间窗`);
    return 1;
  }
  if (status.startTimeMs === null) {
    io.errorLog(`trace ${traceId} 缺少开始时间，无法确定日志时间窗`);
    return 1;
  }
  const windowEndMs = status.endTimeMs ?? Date.now();
  const serial = flags.get("serial") ?? status.deviceSerial;
  const iosTarget = serial !== null && classifyIosSerial(serial) !== null;
  const appBundle = flags.get("app");
  let collected: LogcatWindowResult;
  try {
    if (iosTarget) {
      const collector = iosLogCollector ?? ((request) => new IosLogCollector().collect(request));
      collected = await collector({
        serial,
        windowStartMs: status.startTimeMs,
        windowEndMs,
        processName: appBundle ? appBundle.split(".").pop() ?? null : null
      });
    } else {
      const collector = logcatCollector ?? ((request) => new AdbLogcatCollector().collect(request));
      collected = await collector({ serial, windowStartMs: status.startTimeMs, windowEndMs });
    }
  } catch (error) {
    io.errorLog(`${iosTarget ? "iOS 日志" : "logcat"} 采集失败: ${errorMessage(error)}`);
    return 1;
  }
  if (collected.status !== "ok") {
    io.errorLog(`${iosTarget ? "iOS 日志" : "logcat"} 采集失败（${collected.reason ?? "unknown"}）`);
    return 1;
  }
  const errors = matchApiErrors(collected.text, catalog.rules);
  const artifact = {
    traceId,
    serial: collected.serial,
    window: { startMs: status.startTimeMs, endMs: windowEndMs },
    source: iosTarget ? ("simctl-log" as const) : ("logcat" as const),
    degraded: null,
    errors
  };
  if (!flags.bool("no-save")) {
    try {
      const dir = runtime.traceDir(traceId);
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, API_ERRORS_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`);
    } catch (error) {
      io.errorLog(`api-errors 产物写入失败: ${errorMessage(error)}`);
      return 1;
    }
  }
  if (flags.bool("json")) {
    io.log(JSON.stringify(artifact, null, 2));
  } else if (errors.length === 0) {
    io.log(`未发现注册表中的 API 错误（trace=${traceId}，serial=${collected.serial ?? "-"}）`);
  } else {
    for (const error of errors) {
      io.log(
        `- ${error.code} ${error.verdict} ×${error.count}${error.handler ? ` handler=${error.handler}` : ""}${
          error.expect ? `（${error.expect}）` : ""
        }`
      );
    }
  }
  return 0;
}

async function suiteEvidence(runtime: Runtime, flags: ParsedFlags, io: { log: (line: string) => void; errorLog: (line: string) => void }): Promise<number> {
  const traceId = flags.positional[1] ?? flags.get("trace");
  if (!traceId) {
    io.errorLog("用法: aos-mcp suite evidence <traceId> [--full-trace] [--out <dir>] [--no-save]");
    return 2;
  }
  const figmaUrl = flags.get("design-figma");
  const penPath = flags.get("design-pen");
  const bundle = await traceEvidence(runtime, {
    traceId,
    fullTrace: flags.bool("full-trace"),
    save: !flags.bool("no-save"),
    outputDir: flags.get("out") ?? undefined,
    design:
      figmaUrl || penPath
        ? {
            ...(figmaUrl ? { figmaUrl } : {}),
            ...(penPath ? { penPath } : {}),
            ...(flags.get("node") ? { nodeId: flags.get("node")! } : {})
          }
        : null
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(bundle, null, 2));
  } else {
    io.log(`trace=${bundle.traceId} status=${bundle.status ?? "-"} ok=${bundle.ok}`);
    bundle.failedItems.forEach((item, index) => {
      io.log(
        `失败项 ${index + 1}: ${[item.itemText, item.kind, item.evidence].filter(Boolean).join(" / ") || "(无描述)"}`
      );
    });
    io.log(
      `崩溃 ${bundle.crashes.length} · 锚点 ${bundle.anchor ? `step ${bundle.anchor.stepNumber}` : "-"} · 产物 ${bundle.artifacts.length} 项${bundle.dir ? ` · ${bundle.dir}` : ""}`
    );
    if (bundle.degraded.length > 0) io.log(`降级: ${bundle.degraded.join("；")}`);
    if (bundle.designDiff) {
      io.log(
        `设计差异: ${bundle.designDiff.ok ? bundle.designDiff.reportPath : `失败（${bundle.designDiff.error}）`}`
      );
    }
  }
  return bundle.ok ? 0 : 1;
}

async function suiteBaseline(runtime: Runtime, flags: ParsedFlags, io: { log: (line: string) => void; errorLog: (line: string) => void }): Promise<number> {
  const action = flags.positional[1];
  const caseId = flags.get("case");
  const stepNumber = intOrNull(flags.get("step"));
  const traceId = flags.get("trace");
  if ((action !== "save" && action !== "compare") || !caseId || stepNumber === null || !traceId) {
    io.errorLog(
      "用法: aos-mcp suite baseline save|compare --case <caseId> --step <n> --trace <traceId> [--image post|pre] [--serial <s>] [--dpi <n>] [--ignore x,y,w,h]..."
    );
    return 2;
  }
  const image = flags.get("image") === "pre" ? "pre" : "post";
  const ignoreValues = flags.list("ignore");
  const ignoreRegions = ignoreValues.length === 0 ? [] : parseIgnoreRegions(ignoreValues);
  if (ignoreRegions === null) {
    io.errorLog("--ignore 参数格式应为 x,y,w,h（可多次）");
    return 2;
  }
  const request: BaselineRequest = {
    caseId,
    stepNumber,
    traceId,
    image,
    serial: flags.get("serial"),
    dpi: intOrNull(flags.get("dpi")),
    ignoreRegions
  };
  if (action === "save") {
    const saved = await saveBaseline(runtime, request);
    if (flags.bool("json")) {
      io.log(JSON.stringify(saved, null, 2));
    } else {
      io.log(`已保存基线 serial=${saved.meta.serial} case=${caseId} step=${stepNumber} ${image}`);
      io.log(`产物: ${saved.image}`);
    }
    return 0;
  }
  const report = await compareBaseline(runtime, { ...request, save: !flags.bool("no-save") });
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
  } else if (report.status !== "ok") {
    io.log(`未比对（${report.status}）${report.reason ? `：${report.reason}` : ""}`);
  } else {
    io.log(
      `基线比较: 新出现 ${report.summary.new} · 持续 ${report.summary.persisting} · 已修复 ${report.summary.fixed}（共 ${report.summary.regions} 区域）`
    );
    for (const region of report.regions) {
      io.log(`- [${region.change}] ${region.category} @ ${region.bbox.x},${region.bbox.y} ${region.bbox.width}x${region.bbox.height}`);
    }
    if (report.saved) io.log(`差异记录: ${report.saved.lastDiff}`);
  }
  const failOn = flags.get("fail-on");
  if (failOn === "new") return report.summary.new > 0 ? 2 : 0;
  if (failOn === "persisting") return report.summary.persisting > 0 ? 2 : 0;
  if (failOn === "any") return report.summary.new + report.summary.persisting > 0 ? 2 : 0;
  return 0;
}

async function suiteReport(runtime: Runtime, flags: ParsedFlags, io: { log: (line: string) => void; errorLog: (line: string) => void }): Promise<number> {
  if (!flags.bool("no-sync")) {
    await runtime.syncTaskStatuses();
    await runtime.flushCrashScans();
  }
  const report = await buildRunReport(runtime, {
    limit: intOrNull(flags.get("limit")) ?? undefined,
    caseIds: splitList(flags.list("case")),
    outputDir: flags.get("out") ?? undefined,
    stamp: flags.get("stamp") ?? undefined,
    save: !flags.bool("no-save")
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`运行报告: 共 ${report.total} · 通过 ${report.passed} · 失败 ${report.failed} · 待定 ${report.pending}`);
    if (report.saved) {
      io.log(`xlsx: ${report.saved.xlsx}`);
      io.log(`junit: ${report.saved.junit}`);
    }
    if (report.error) io.errorLog(report.error);
  }
  return report.ok ? 0 : 1;
}

async function suiteFeedback(runtime: Runtime, flags: ParsedFlags, io: { log: (line: string) => void; errorLog: (line: string) => void }): Promise<number> {
  const feedback = await buildGenerationFeedback(runtime, {
    limit: intOrNull(flags.get("limit")) ?? undefined,
    minFailures: intOrNull(flags.get("min-failures")) ?? undefined
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(feedback, null, 2));
  } else if (!feedback.ok) {
    io.errorLog(feedback.error ?? "反馈聚合失败");
  } else {
    io.log(
      `反馈（台账 ${feedback.generatedFrom.tasks} 条 · 失败 ${feedback.generatedFrom.failed} · 基线热点 ${feedback.generatedFrom.baselines}）`
    );
    for (const suggestion of feedback.suggestions) {
      const refs = [
        suggestion.caseIds.length > 0 ? `cases=${suggestion.caseIds.join(",")}` : null,
        suggestion.traceIds.length > 0 ? `traces=${suggestion.traceIds.join(",")}` : null
      ]
        .filter(Boolean)
        .join(" ");
      io.log(`- [${suggestion.kind}] ${suggestion.message}${refs ? ` （${refs}）` : ""}`);
    }
    if (feedback.suggestions.length === 0) io.log("无改进建议（数据不足或均已满足阈值）。");
  }
  return feedback.ok ? 0 : 1;
}

export async function runSuiteCommand(argv: string[], deps: SuiteCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  const sub = flags.positional[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSuiteUsage(log);
    return sub ? 0 : 2;
  }
  if (!["run", "evidence", "api-errors", "baseline", "report", "feedback"].includes(sub)) {
    errorLog(`未知 suite 子命令 "${sub}"`);
    printSuiteUsage(log);
    return 2;
  }

  const buildRuntime = deps.buildRuntime ?? defaultBuildRuntime;
  let built: Awaited<ReturnType<typeof defaultBuildRuntime>> | null = null;
  try {
    built = await buildRuntime(flags.get("project"));
    if (sub === "run") {
      return await suiteRun(built.runtime, flags, { log, errorLog }, deps.logcatCollector, deps.iosLogCollector);
    }
    if (sub === "evidence") return await suiteEvidence(built.runtime, flags, { log, errorLog });
    if (sub === "api-errors") {
      return await suiteApiErrors(
        built.runtime,
        flags,
        { log, errorLog },
        deps.logcatCollector,
        deps.iosLogCollector
      );
    }
    if (sub === "baseline") return await suiteBaseline(built.runtime, flags, { log, errorLog });
    if (sub === "report") return await suiteReport(built.runtime, flags, { log, errorLog });
    return await suiteFeedback(built.runtime, flags, { log, errorLog });
  } catch (error) {
    errorLog(`suite ${sub} 失败: ${errorMessage(error)}`);
    return 1;
  } finally {
    if (built) await built.dispose();
  }
}
