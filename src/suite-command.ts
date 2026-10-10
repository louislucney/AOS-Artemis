import fs from "node:fs";
import path from "node:path";

import { traceEvidence } from "./artemis/evidence.js";
import {
  API_ERRORS_ARTIFACT,
  loadApiErrorCatalog,
  matchApiErrors
} from "./artemis/api-errors.js";
import { defaultBuildRuntime } from "./cli-runtime.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "./device/logcat.js";
import { classifyIosSerial } from "./device/ios.js";
import { IosLogCollector, type IosLogWindowRequest } from "./device/ios-log.js";
import { compareBaseline, saveBaseline, type BaselineRequest } from "./diff/baseline.js";
import { buildGenerationFeedback } from "./figma/generation-feedback.js";
import { buildCalibration, parseTestResults, type CalibrationReport } from "./figma/calibration.js";
import { buildFlakeReport, renderFlakeMarkdown } from "./figma/flake.js";
import { loadQuarantine } from "./figma/quarantine.js";
import { buildRetentionReport, collectRetentionEntries, formatBytes } from "./figma/retention.js";
import { preflightGeneratedTests, type PreflightReport } from "./figma/preflight.js";
import { buildRunReport } from "./figma/run-report.js";
import {
  buildSuiteLoopReport,
  loopPercent,
  renderSuiteLoopMarkdown,
  type SuiteLoopCheck
} from "./figma/suite-loop.js";
import type { TaskStatRecord } from "./db/types.js";
import {
  runGeneratedTests,
  type SuiteCaseResult,
  type SuiteRunOptions,
  type SuiteRunReport
} from "./figma/suite-runner.js";
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
  /** Injected for tests; defaults to `xcrun xcresulttool get test-results tests`. */
  xcresultReader?: (xcresultPath: string) => Promise<unknown>;
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

/** Reason the run fails the flow-coverage gate, or null when it passes.
 * Hard coverage gaps (explicit/observed/confirmed/legacy evidence) always
 * gate; inferred exploration gaps never do. `--strict` additionally gates on
 * weak assertions (non-explore steps without a checkable expectation).
 * Fail-closed: unreadable preflight data or missing flows.json both count as
 * "cannot prove completeness" (DESIGN §6.10). */
function coverageGateIssue(
  preflight: PreflightReport | null,
  options: { strict?: boolean } = {}
): string | null {
  if (!preflight) {
    return "流程覆盖校验不可用：预检数据缺失（tests.json 不可读）";
  }
  const coverage = preflight.coverage;
  if (!coverage.available) {
    return "流程覆盖校验不可用：缺 flows.json，无法判定流程完整性（按不通过处理）";
  }
  const uncovered = coverage.uncoveredScreens.length + coverage.uncoveredEdges.length;
  const generation = preflight.generation as { truncated?: unknown } | null;
  const truncated = generation?.truncated === true;
  const strictWeak = options.strict === true && preflight.weakCases.length > 0;
  if (uncovered === 0 && !truncated && !strictWeak) return null;
  if (uncovered === 0 && !truncated) {
    return `--strict 门禁未通过：弱断言 ${preflight.weakCases.length} 条（explore 步骤已豁免）`;
  }
  return (
    `流程未完整覆盖：未硬覆盖屏幕 ${coverage.uncoveredScreens.length} · ` +
    `未硬覆盖跳转 ${coverage.uncoveredEdges.length}${truncated ? " · 路径截断" : ""}` +
    (strictWeak ? ` · --strict 弱断言 ${preflight.weakCases.length} 条` : "")
  );
}

function retryCountOf(flags: ParsedFlags): number {
  return Math.min(Math.max(intOrNull(flags.get("retry")) ?? 0, 0), 3);
}

/** 读取 `.artemis/design/quarantine.json`：生效项不计门禁，过期/无效项如实提示。 */
function quarantineFor(
  runtime: Runtime,
  flags: ParsedFlags
): { ids: Set<string> | undefined; messages: string[] } {
  if (flags.bool("no-quarantine")) return { ids: undefined, messages: [] };
  const load = loadQuarantine(runtime.configDirAbs);
  if (!load.exists) return { ids: undefined, messages: [] };
  const messages: string[] = [];
  if (load.active.size > 0) {
    messages.push(`quarantine: ${load.active.size} 条生效（失败不计门禁）`);
  }
  for (const entry of load.stale) {
    messages.push(`quarantine 已过期、恢复门禁: ${entry.caseId}（owner=${entry.owner}）`);
  }
  for (const message of load.invalid) {
    messages.push(`quarantine 无效忽略: ${message}`);
  }
  return { ids: load.active.size > 0 ? new Set(load.active.keys()) : undefined, messages };
}

function suiteRunOptions(
  flags: ParsedFlags,
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): SuiteRunOptions {
  return {
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
  };
}

/** `--retry` 诊断（D3 口径）：只补写 retry 注记，不改首跑计数与退出码。 */
async function applyRetryDiagnostics(
  runtime: Runtime,
  report: SuiteRunReport,
  retryCount: number,
  runOptions: ReturnType<typeof suiteRunOptions>
): Promise<void> {
  for (const entry of report.cases) {
    if (entry.status === "passed" || entry.quarantined === true) continue;
    let attempts = 0;
    let finalStatus: SuiteCaseResult["status"] = entry.status;
    let finalTraceId = entry.traceId;
    while (attempts < retryCount && finalStatus !== "passed") {
      const retried = await runGeneratedTests(runtime, { ...runOptions, caseIds: [entry.caseId] });
      attempts += 1;
      const first = retried.cases[0];
      if (!first) break;
      finalStatus = first.status;
      finalTraceId = first.traceId;
    }
    if (attempts > 0) {
      entry.retry = { attempts, finalStatus, finalTraceId, flaky: finalStatus === "passed" };
    }
  }
}

export function printSuiteUsage(log: (line: string) => void): void {
  log(`aos-mcp suite — 测试闭环（生成用例的确定性执行与取证）

Usage:
  aos-mcp suite run [options]        执行 tests.json：每例复位→提交→轮询→台账→逐例分类
  aos-mcp suite check [options]      静态覆盖检查：tests.json × flows.json（不连设备，CI 友好）
  aos-mcp suite calibrate [options]  确定性套件（xcresult）与 MCP 台账差分校准（漏报/误报率）
  aos-mcp suite loop [options]       测试闭环：静态检查→执行(可选)→反馈→差分校准(可选)，产出闭环报告与下一步
  aos-mcp suite flake [options]      重复采样量化确定性：通过率/翻转矩阵/flaky 率（--cases × --runs）
  aos-mcp suite retention [options]  审计产物保留期只读报告（不删除；--days 默认 90、--limit 默认 20）
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
        [--no-api-errors] [--fail-on api-error] [--fail-on-uncovered] [--retry <n>] [--no-quarantine] [--strict]
check:  [--tests <path>] [--strict]
calibrate: [--report <json|junit.xml>|--xcresult <bundle>] [--tests <path>] [--limit <n>] [--no-sync] [--no-save] [--out <dir>] [--fail-on-miss]
loop:   [--tests <path>] [--skip-run] [--calibration <json>] [--retry <n>] [--max <n>]
        [--device <serial>] [--app <package>] [--model Flash|Pro] [--allow-uncovered] [--no-quarantine] [--no-save] [--out <dir>]
flake:  --cases <id,id,...> [--runs <n>] [--tests <path>] [--device <serial>] [--app <package>]
        [--model Flash|Pro] [--poll-timeout <ms>] [--no-api-errors] [--fail-on-flaky] [--no-save] [--out <dir>]
retention: [--days <n>] [--limit <n>]
evidence: [--full-trace] [--out <dir>] [--no-save] [--design-figma <url>|--design-pen <path>] [--node <id>]
api-errors: [--serial <s>] [--app <bundleId>] [--no-save] [--json]
baseline: --case <caseId> --step <n> --trace <traceId> [--image post|pre] [--serial <s>] [--dpi <n>]
          [--ignore x,y,w,h]... [--no-save] [--fail-on new|persisting|any]
report: [--limit <n>] [--case <id>]... [--out <dir>] [--stamp <s>] [--no-save] [--no-sync]
feedback: [--limit <n>] [--min-failures <n>]

exit codes: 0 成功/全通过；1 用例失败或证据缺失；2 参数/执行错误或 --fail-on 命中（基线回归/未处理 API 错误/流程未覆盖或无法校验）
错误码注册表: .artemis/design/error-codes.json（未配置时 api-errors 跳过并如实标注 degraded）`);
}

async function suiteRun(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): Promise<number> {
  const runOptions = suiteRunOptions(flags, logcatCollector, iosLogCollector);
  const quarantine = quarantineFor(runtime, flags);
  runOptions.quarantinedCaseIds = quarantine.ids;
  const report = await runGeneratedTests(runtime, runOptions);
  const retryCount = retryCountOf(flags);
  if (retryCount > 0 && !runOptions.stopOnFailure) {
    await applyRetryDiagnostics(runtime, report, retryCount, runOptions);
  }
  const coverageIssue = flags.bool("fail-on-uncovered")
    ? coverageGateIssue(report.preflight, { strict: flags.bool("strict") })
    : null;
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`套件: ${report.testsPath}`);
    if (flags.bool("strict") && !flags.bool("fail-on-uncovered")) {
      io.log("注意: --strict 需与 --fail-on-uncovered 同时使用才参与门禁");
    }
    for (const message of quarantine.messages) {
      io.log(message);
    }
    if (report.preflight) {
      if (!report.preflight.coverage.available) {
        io.log(`预检: 弱用例 ${report.preflight.weakCases.length} 条 · 覆盖校验不可用（缺 flows.json）`);
      } else {
        const generation = report.preflight.generation as {
          truncated?: unknown;
          entryFallback?: unknown;
        } | null;
        const notes = [
          generation?.truncated === true ? "路径截断" : null,
          generation?.entryFallback === true ? "入口回退" : null
        ].filter((note): note is string => note !== null);
        const explore = report.preflight.coverage.explore;
        io.log(
          `预检: 弱用例 ${report.preflight.weakCases.length} 条 · 未硬覆盖屏幕 ${report.preflight.coverage.uncoveredScreens.length} · 未硬覆盖边 ${report.preflight.coverage.uncoveredEdges.length}` +
            ` · 探索缺口 屏 ${explore.uncoveredScreens.length}/边 ${explore.uncoveredEdges.length}（不阻断）` +
            (notes.length > 0 ? ` · ${notes.join(" · ")}` : "")
        );
      }
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
      const scriptNote = entry.scriptProvenance
        ? ` · 脚本 断言${entry.scriptProvenance.asserts}/探索${entry.scriptProvenance.explores}`
        : "";
      const apiNote =
        entry.apiErrors.length > 0
          ? ` · API 错误 ${entry.apiErrors.map((error) => `${error.code}(${error.verdict})`).join("、")}`
          : "";
      const degraded = entry.apiErrorsDegraded ? ` · API 采集降级(${entry.apiErrorsDegraded})` : "";
      const quarantineNote = entry.quarantined === true ? " · 已隔离（不计门禁）" : "";
      const retryNote = entry.retry
        ? ` · 重试 ${entry.retry.attempts} 次：${entry.status} → ${entry.retry.finalStatus}${
            entry.retry.flaky ? "（flaky，不计首跑）" : ""
          }`
        : "";
      io.log(
        `[${label}] ${entry.name} (${entry.caseId}) trace=${entry.traceId ?? "-"}${failure}${scriptNote}${apiNote}${degraded}${quarantineNote}${retryNote}`
      );
      if (entry.traceId && entry.status !== "passed") {
        io.log(`       证据: node dist/cli.js suite evidence ${entry.traceId}`);
      }
    }
    io.log(
      `结果: pass ${report.passed} / fail ${report.failed} / skipped ${report.skipped}（executed ${report.executed}）`
    );
    const flakyCount = report.cases.filter((entry) => entry.retry?.flaky === true).length;
    if (flakyCount > 0) {
      io.log(`重试转绿 ${flakyCount} 例（flaky，首跑结果仍为准）`);
    }
    const quarantinedFailed = report.cases.filter(
      (entry) => entry.quarantined === true && entry.status !== "passed"
    ).length;
    if (quarantinedFailed > 0) {
      io.log(`隔离 ${quarantinedFailed} 例失败（不计门禁）`);
    }
    if (!report.ok) io.errorLog(`套件未执行: ${report.error ?? "无可提交用例"}`);
    if (coverageIssue) io.errorLog(coverageIssue);
  }
  if (!report.ok) return 2;
  if (coverageIssue) return 2;
  const quarantinedFailures = report.cases.filter(
    (entry) => entry.quarantined === true && entry.status !== "passed"
  ).length;
  return report.failed - quarantinedFailures === 0 ? 0 : 1;
}

/** Pure static coverage check: no device, no case submission (CI pre-merge). */
async function suiteCheck(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const customTests = flags.get("tests");
  const testsPath = customTests ? path.resolve(runtime.project.rootDir, customTests) : defaultTestsPath;
  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath });
  if (!preflight) {
    const message = `无法读取用例文件：${testsPath}`;
    if (flags.bool("json")) {
      io.log(JSON.stringify({ ok: false, testsPath, error: message }, null, 2));
    } else {
      io.errorLog(message);
    }
    return 2;
  }

  const coverage = preflight.coverage;
  const issue = coverageGateIssue(preflight, { strict: flags.bool("strict") });
  const routeDrift = coverage.available
    ? coverage.screens.filter((screen) => !coverage.designScreens.includes(screen))
    : [];
  const generation = preflight.generation as {
    truncated?: unknown;
    entryFallback?: unknown;
  } | null;
  const notes = [
    generation?.truncated === true ? "路径截断" : null,
    generation?.entryFallback === true ? "入口回退" : null
  ].filter((note): note is string => note !== null);

  if (flags.bool("json")) {
    io.log(
      JSON.stringify(
        {
          ok: issue === null,
          testsPath,
          cases: preflight.cases,
          weakCases: preflight.weakCases,
          coverage,
          generation: preflight.generation,
          routeDrift,
          issue
        },
        null,
        2
      )
    );
  } else {
    io.log(`静态覆盖检查: ${testsPath}`);
    io.log(`用例: ${preflight.cases} · 弱用例 ${preflight.weakCases.length}`);
    if (!coverage.available) {
      io.log("覆盖: 不可用（缺 flows.json）");
    } else {
      io.log(
        `覆盖: 未硬覆盖屏幕 ${coverage.uncoveredScreens.length} · 未硬覆盖跳转 ${coverage.uncoveredEdges.length}` +
          ` · 探索缺口 屏 ${coverage.explore.uncoveredScreens.length}/边 ${coverage.explore.uncoveredEdges.length}（不阻断）` +
          (notes.length > 0 ? ` · ${notes.join(" · ")}` : "")
      );
      if (coverage.uncoveredScreens.length > 0) {
        io.log(`  未硬覆盖屏幕: ${coverage.uncoveredScreens.join("、")}`);
      }
      if (coverage.uncoveredEdges.length > 0) {
        io.log(`  未硬覆盖跳转: ${coverage.uncoveredEdges.join("、")}`);
      }
      if (coverage.explore.uncoveredScreens.length > 0 || coverage.explore.uncoveredEdges.length > 0) {
        io.log(
          `  探索未覆盖（仅报告）: 屏 ${coverage.explore.uncoveredScreens.join("、") || "-"} · 跳转 ${
            coverage.explore.uncoveredEdges.join("、") || "-"
          }`
        );
      }
    }
    if (routeDrift.length > 0) {
      io.log(`路线漂移（测试引用、设计缺失）: ${routeDrift.join("、")}（警告，不阻断）`);
    }
    if (issue) io.errorLog(issue);
    else io.log(flags.bool("strict") ? "结论: 完整（--strict 弱断言 0）" : "结论: 完整");
  }
  return issue === null ? 0 : 2;
}

async function defaultXcResultReader(xcresultPath: string): Promise<unknown> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(
      "xcrun",
      ["xcresulttool", "get", "test-results", "tests", "--path", xcresultPath, "--format", "json"],
      { maxBuffer: 128 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`xcresulttool 读取失败: ${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`xcresulttool 输出无法解析: ${errorMessage(parseError)}`));
        }
      }
    );
  });
}

/** Differential calibration: deterministic suite (xcresult) vs MCP ledger. */
async function suiteCalibrate(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  deps: { xcresultReader?: (xcresultPath: string) => Promise<unknown> }
): Promise<number> {
  const reportFlag = flags.get("report");
  const xcresultFlag = flags.get("xcresult");
  if (!reportFlag && !xcresultFlag) {
    io.errorLog(
      "用法: aos-mcp suite calibrate (--report <json|junit.xml>|--xcresult <bundle>) [--tests <path>] [--limit <n>] [--no-sync] [--no-save] [--out <dir>] [--fail-on-miss]"
    );
    return 2;
  }

  let xcInput: unknown;
  let xcSource: string;
  try {
    if (reportFlag) {
      xcSource = path.resolve(runtime.project.rootDir, reportFlag);
      const raw = fs.readFileSync(xcSource, "utf-8");
      xcInput = raw.trim().startsWith("<") ? raw : JSON.parse(raw);
    } else {
      xcSource = path.resolve(runtime.project.rootDir, xcresultFlag!);
      const reader = deps.xcresultReader ?? defaultXcResultReader;
      xcInput = await reader(xcSource);
    }
  } catch (error) {
    io.errorLog(`校准输入读取失败: ${errorMessage(error)}`);
    return 2;
  }
  const xcTests = parseTestResults(xcInput);
  if (xcTests.length === 0) {
    io.errorLog(`警告: 未从输入解析出任何用例（${xcSource}）`);
  }

  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const customTests = flags.get("tests");
  const testsPath = customTests ? path.resolve(runtime.project.rootDir, customTests) : defaultTestsPath;
  let cases: Array<{ id: string; name: string }>;
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as {
      flows?: Array<{ id?: unknown; name?: unknown }>;
    };
    cases = (parsed.flows ?? [])
      .filter((entry): entry is { id: string; name?: unknown } => Boolean(entry) && typeof entry.id === "string")
      .map((entry) => ({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id }));
  } catch (error) {
    io.errorLog(`无法读取用例文件：${testsPath}（${errorMessage(error)}）`);
    return 2;
  }

  if (!flags.bool("no-sync")) {
    await runtime.syncTaskStatuses();
  }
  let tasks: TaskStatRecord[];
  try {
    tasks = await runtime.store.listTasks(runtime.project.rootDir, intOrNull(flags.get("limit")) ?? 200);
  } catch (error) {
    io.errorLog(`无法读取运行台账: ${errorMessage(error)}`);
    return 2;
  }
  const mcpOutcomes = new Map<string, "passed" | "failed" | "pending">();
  const ordered = [...tasks].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const task of ordered) {
    if (!task.caseId) continue;
    mcpOutcomes.set(
      task.caseId,
      task.status === "completed" ? "passed" : task.status === "submitted" ? "pending" : "failed"
    );
  }

  const report = buildCalibration({
    cases,
    mcpOutcomes,
    xcTests,
    generatedAt: new Date().toISOString(),
    xcSource
  });
  const payload: Record<string, unknown> = { ...report };
  if (!flags.bool("no-save")) {
    const outDir = flags.get("out")
      ? path.resolve(runtime.project.rootDir, flags.get("out")!)
      : path.join(runtime.configDirAbs, "design", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = report.generatedAt.slice(0, 19).replace(/[-:]/g, "");
    const savedTo = path.join(outDir, `calibration-${stamp}.json`);
    writeFileAtomic(savedTo, JSON.stringify(payload, null, 2) + "\n");
    payload.savedTo = savedTo;
  }

  if (flags.bool("json")) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    io.log(`差分校准（XCTest: ${xcSource}）`);
    io.log(
      `对齐 ${report.matched} · 一致通过 ${report.agreedPass} · 一致失败 ${report.agreedFail} · MCP 漏报 ${report.mcpMiss} · MCP 误报 ${report.mcpFalseAlarm}`
    );
    io.log(
      `漏报率 ${report.missRate === null ? "-" : `${(report.missRate * 100).toFixed(1)}%`} · 误报率 ${
        report.falseAlarmRate === null ? "-" : `${(report.falseAlarmRate * 100).toFixed(1)}%`
      }`
    );
    for (const entry of report.cases) {
      if (entry.verdict === "agreed-pass" || entry.verdict === "agreed-fail") continue;
      io.log(
        `  [${entry.verdict}] ${entry.caseName} (${entry.caseId}) mcp=${entry.mcp} xctest=${entry.xctest}${
          entry.testName ? ` test=${entry.testName}` : ""
        }`
      );
    }
    if (report.unmatchedXcTests.length > 0) {
      io.log(`未对齐的 XCTest 用例（测试名未内嵌 case_id）: ${report.unmatchedXcTests.join("、")}`);
    }
    if (payload.savedTo) io.log(`已保存: ${String(payload.savedTo)}`);
  }
  if (flags.bool("fail-on-miss") && report.mcpMiss > 0) {
    return 2;
  }
  return 0;
}

/** 测试闭环（test → improve）：静态检查 → 执行(可选) → 反馈 → 差分校准(可选)，产出闭环报告与下一步动作。 */
async function suiteLoop(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  deps: { logcatCollector?: LogcatCollector; iosLogCollector?: IosLogCollectorFn }
): Promise<number> {
  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const customTests = flags.get("tests");
  const testsPath = customTests ? path.resolve(runtime.project.rootDir, customTests) : defaultTestsPath;

  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath });
  let check: SuiteLoopCheck | null = null;
  if (preflight) {
    const issue = flags.bool("allow-uncovered") ? null : coverageGateIssue(preflight);
    const routeDrift = preflight.coverage.available
      ? preflight.coverage.screens.filter((screen) => !preflight.coverage.designScreens.includes(screen))
      : [];
    check = { testsPath, preflight, issue, routeDrift };
  }

  const runOptions = suiteRunOptions(flags, deps.logcatCollector, deps.iosLogCollector);
  const quarantine = quarantineFor(runtime, flags);
  runOptions.quarantinedCaseIds = quarantine.ids;
  let report: SuiteRunReport | null = null;
  if (!flags.bool("skip-run")) {
    report = await runGeneratedTests(runtime, runOptions);
    const retryCount = retryCountOf(flags);
    if (retryCount > 0 && !runOptions.stopOnFailure) {
      await applyRetryDiagnostics(runtime, report, retryCount, runOptions);
    }
  }

  const feedback = await buildGenerationFeedback(runtime, {
    limit: intOrNull(flags.get("limit")) ?? undefined
  });

  let calibration: CalibrationReport | null = null;
  const calibrationPath = flags.get("calibration");
  if (calibrationPath) {
    try {
      const abs = path.resolve(runtime.project.rootDir, calibrationPath);
      calibration = JSON.parse(fs.readFileSync(abs, "utf-8")) as CalibrationReport;
    } catch (error) {
      io.errorLog(`校准报告读取失败: ${errorMessage(error)}`);
      return 2;
    }
  }

  const loopReport = buildSuiteLoopReport({
    generatedAt: new Date().toISOString(),
    check,
    run: report,
    feedback: feedback.ok ? feedback : null,
    feedbackError: feedback.ok ? null : feedback.error ?? "反馈聚合失败",
    calibration
  });
  const payload: Record<string, unknown> = { ...loopReport };
  if (!flags.bool("no-save")) {
    const outDir = flags.get("out")
      ? path.resolve(runtime.project.rootDir, flags.get("out")!)
      : path.join(runtime.configDirAbs, "design", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = loopReport.generatedAt.slice(0, 19).replace(/[-:]/g, "");
    const jsonPath = path.join(outDir, `loop-${stamp}.json`);
    const markdownPath = path.join(outDir, `loop-${stamp}.md`);
    writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
    writeFileAtomic(markdownPath, renderSuiteLoopMarkdown(loopReport));
    payload.savedTo = { json: jsonPath, markdown: markdownPath };
  }

  if (flags.bool("json")) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    const step = loopReport.steps;
    io.log(`测试闭环: ${testsPath}`);
    for (const message of quarantine.messages) {
      io.log(message);
    }
    io.log(
      `静态检查: ${
        step.check ? (step.check.issue ? `未通过（${step.check.issue}）` : "通过") : "不可用（无 tests.json）"
      }`
    );
    io.log(
      `执行: ${
        step.run
          ? `pass ${step.run.passed} / fail ${step.run.failed} / skipped ${step.run.skipped}（flaky ${step.run.flaky}）`
          : "未执行（--skip-run）"
      }`
    );
    io.log(
      `反馈: ${
        step.feedback
          ? step.feedback.error
            ? `不可用（${step.feedback.error}）`
            : `建议 ${step.feedback.suggestions} 条`
          : "未生成"
      }`
    );
    io.log(
      `差分校准: ${
        step.calibration
          ? `漏报 ${step.calibration.mcpMiss}（${loopPercent(step.calibration.missRate)}）· 误报 ${step.calibration.mcpFalseAlarm}（${loopPercent(step.calibration.falseAlarmRate)}）`
          : "未提供"
      }`
    );
    io.log("下一步:");
    loopReport.nextActions.forEach((action, index) => io.log(`  ${index + 1}) ${action}`));
    if (payload.savedTo) {
      io.log(`已保存: ${(payload.savedTo as { json: string }).json}`);
    }
  }

  if (flags.bool("skip-run")) {
    return check && check.issue === null ? 0 : 2;
  }
  if (!report || !report.ok) return 2;
  if (check && check.issue !== null) return 2;
  const quarantinedFailures = report.cases.filter(
    (entry) => entry.quarantined === true && entry.status !== "passed"
  ).length;
  return report.failed - quarantinedFailures === 0 ? 0 : 1;
}

/** 重复采样（票据 10）：量化执行确定性——通过率/翻转矩阵/flaky 率。 */
async function suiteFlake(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  deps: { logcatCollector?: LogcatCollector; iosLogCollector?: IosLogCollectorFn }
): Promise<number> {
  const requested = splitList(flags.list("cases"));
  if (requested.length === 0) {
    io.errorLog(
      "用法: aos-mcp suite flake --cases <id,id,...> [--runs <n>] [--tests <path>] [--device <serial>] [--app <package>] [--model Flash|Pro] [--fail-on-flaky] [--no-save] [--out <dir>]"
    );
    return 2;
  }
  const runs = Math.min(Math.max(intOrNull(flags.get("runs")) ?? 3, 1), 50);
  const runOptions = suiteRunOptions(flags, deps.logcatCollector, deps.iosLogCollector);
  runOptions.stopOnFailure = false;

  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const testsPath = runOptions.testsPath
    ? path.resolve(runtime.project.rootDir, runOptions.testsPath)
    : defaultTestsPath;
  const caseNames = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as {
      flows?: Array<{ id?: unknown; name?: unknown }>;
    };
    for (const entry of parsed.flows ?? []) {
      if (entry && typeof entry.id === "string") {
        caseNames.set(entry.id, typeof entry.name === "string" ? entry.name : entry.id);
      }
    }
  } catch (error) {
    io.errorLog(`无法读取用例文件：${testsPath}（${errorMessage(error)}）`);
    return 2;
  }
  const missingIds = requested.filter((caseId) => !caseNames.has(caseId));
  if (missingIds.length > 0) {
    io.errorLog(`用例不存在于 ${testsPath}: ${missingIds.join("、")}`);
    return 2;
  }

  const rounds: SuiteRunReport["cases"][] = [];
  for (let round = 0; round < runs; round += 1) {
    const report = await runGeneratedTests(runtime, { ...runOptions, caseIds: requested });
    if (report.cases.length === 0) {
      io.errorLog(`第 ${round + 1} 轮执行失败: ${report.error ?? "无可提交用例"}`);
      return 2;
    }
    rounds.push(report.cases);
  }

  const flake = buildFlakeReport({
    generatedAt: new Date().toISOString(),
    caseIds: requested,
    caseNames,
    rounds
  });
  const payload: Record<string, unknown> = { ...flake };
  if (!flags.bool("no-save")) {
    const outDir = flags.get("out")
      ? path.resolve(runtime.project.rootDir, flags.get("out")!)
      : path.join(runtime.configDirAbs, "design", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = flake.generatedAt.slice(0, 19).replace(/[-:]/g, "");
    const jsonPath = path.join(outDir, `flake-${stamp}.json`);
    const markdownPath = path.join(outDir, `flake-${stamp}.md`);
    writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
    writeFileAtomic(markdownPath, renderFlakeMarkdown(flake));
    payload.savedTo = { json: jsonPath, markdown: markdownPath };
  }

  if (flags.bool("json")) {
    io.log(JSON.stringify(payload, null, 2));
  } else {
    io.log(`flake 采样: ${requested.length} 用例 × ${runs} 轮`);
    io.log(
      `轮次通过数: ${flake.rounds.map((round) => `R${round.round} ${round.passed}/${round.executed}`).join(" · ")}`
    );
    for (const entry of flake.cases) {
      io.log(
        `  [${entry.verdict}] ${entry.name ?? entry.caseId} (${entry.caseId}) ${entry.statuses.join(" → ")} · 通过率 ${(
          entry.passRate * 100
        ).toFixed(0)}% · 翻转 ${entry.flips}`
      );
    }
    io.log(
      `汇总: flaky ${flake.summary.flakyCases} · stable-pass ${flake.summary.stablePass} · stable-fail ${flake.summary.stableFail} · 未执行 ${flake.summary.untestedCases}`
    );
    if (payload.savedTo) io.log(`已保存: ${(payload.savedTo as { json: string }).json}`);
  }
  if (flags.bool("fail-on-flaky") && flake.summary.flakyCases > 0) return 2;
  return 0;
}

/** 审计产物保留期只读报告（不删除任何文件）。 */
async function suiteRetention(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const days = Math.min(Math.max(intOrNull(flags.get("days")) ?? 90, 1), 3650);
  const limit = Math.min(Math.max(intOrNull(flags.get("limit")) ?? 20, 1), 200);
  const entries = collectRetentionEntries(runtime.project.rootDir);
  const report = buildRetentionReport(entries, {
    days,
    nowMs: Date.now(),
    limit,
    projectRoot: runtime.project.rootDir
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
    return 0;
  }
  io.log(`保留期报告（只读，不删除；阈值 ${days} 天）`);
  for (const category of report.categories) {
    io.log(
      `  ${category.id}: 共 ${category.total} · 超期 ${category.overdue}（${formatBytes(category.overdueBytes)}）` +
        (category.oldestModifiedAt ? ` · 最旧 ${category.oldestModifiedAt.slice(0, 10)}` : "")
    );
  }
  io.log(`超期合计: ${report.overdue.count} 个文件 / ${formatBytes(report.overdue.totalBytes)}`);
  for (const item of report.items) {
    io.log(`  [${item.ageDays}d] ${item.category} ${item.path} (${formatBytes(item.sizeBytes)})`);
  }
  if (report.truncated) io.log(`（仅显示最旧 ${report.items.length} 条；--limit 可调）`);
  io.log("说明: 本命令只读；清理动作待合规口径确认后另行实现（临时默认 90d 见 DESIGN §6.10）。");
  return 0;
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
  if (
    !["run", "check", "calibrate", "loop", "flake", "retention", "evidence", "api-errors", "baseline", "report", "feedback"].includes(sub)
  ) {
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
    if (sub === "check") return await suiteCheck(built.runtime, flags, { log, errorLog });
    if (sub === "calibrate") {
      return await suiteCalibrate(built.runtime, flags, { log, errorLog }, { xcresultReader: deps.xcresultReader });
    }
    if (sub === "loop") {
      return await suiteLoop(built.runtime, flags, { log, errorLog }, {
        logcatCollector: deps.logcatCollector,
        iosLogCollector: deps.iosLogCollector
      });
    }
    if (sub === "flake") {
      return await suiteFlake(built.runtime, flags, { log, errorLog }, {
        logcatCollector: deps.logcatCollector,
        iosLogCollector: deps.iosLogCollector
      });
    }
    if (sub === "retention") return await suiteRetention(built.runtime, flags, { log, errorLog });
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
