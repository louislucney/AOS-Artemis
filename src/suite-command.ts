import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { traceEvidence } from "./artemis/evidence.js";
import { openCenterStore, resolveHostReference } from "./center/store.js";
import {
  API_ERRORS_ARTIFACT,
  loadApiErrorCatalog,
  matchApiErrors
} from "./artemis/api-errors.js";
import { defaultBuildRuntime, type CliRuntimeBundle } from "./cli-runtime.js";
import { isMigrationIncompleteError } from "./db/index.js";
import { hostStrictFrom } from "./host/strict.js";
import { isHostOnline, precheckTask } from "./console/dispatch.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "./device/logcat.js";
import { classifyIosSerial } from "./device/ios.js";
import { latestFeatureRefs, type ResolvedTaskRef } from "./tasks/feature-refs.js";
import { IosLogCollector, type IosLogWindowRequest } from "./device/ios-log.js";
import {
  compareBaseline,
  saveBaseline,
  textWeightGateFails,
  type BaselineRequest
} from "./diff/baseline.js";
import { buildGenerationFeedback } from "./figma/generation-feedback.js";
import {
  INTEGRATION_LABELS,
  integrationReadinessFromFailures,
  type IntegrationFailureInput,
  type IntegrationReadiness
} from "./figma/integration-readiness.js";
import type { VerdictExits } from "./tasks/verdict-exits.js";
import {
  designDir,
  loadDesignFlowGraph,
  loadGeneratedCases,
  readTestsDocument,
  resolveCaseSelector
} from "./figma/design-store.js";
import { designFlowsPath } from "./figma/design-source.js";
import { flowGraphFingerprint } from "./figma/test-gen.js";
import { buildCalibration, parseTestResults, type CalibrationReport } from "./figma/calibration.js";
import { buildFlakeReport, renderFlakeMarkdown } from "./figma/flake.js";
import { buildRetentionReport, collectRetentionEntries, formatBytes } from "./figma/retention.js";
import { gateIssueForTests, isImportedTestsFile } from "./figma/gate.js";
import { preflightGeneratedTests, renderDesignWarningLine } from "./figma/preflight.js";
import {
  loadReconciliation,
  reconciliationFilePath,
  reconciliationListing,
  reviewEdge,
  saveReconciliation
} from "./figma/reconciliation.js";
import {
  buildRunReport,
  buildTaskRunReport,
  updateTestsWorkbookWithResults,
  type RunReport
} from "./figma/run-report.js";
import { buildUiContract, type UiContract, type UiScreenContract } from "./ui/contract.js";
import { runUiLint } from "./ui/lint.js";
import { auditUiParity } from "./ui/parity.js";
import {
  loadUiParityBaseline,
  partitionByBaseline,
  writeUiParityBaseline,
  type UiParityBaselineEntry
} from "./ui/parity-baseline.js";
import { loadUiRuntimeSnapshot } from "./ui/parity-source.js";
import { loadUiSemantics, semanticsForScreen } from "./ui/semantics.js";
import {
  defaultContractPath,
  defaultSemanticsPath,
  initUiSemantics,
  UiSemanticsInitError
} from "./ui/semantics-init.js";
import { runTextWeightCalibration } from "./ui/text-calibrate.js";
import { compareParityDocs, readParityDoc } from "./figma/parity.js";
import { readPenTextBounds } from "./pen/bounds.js";
import type { WarningSummary } from "./design/warnings.js";
import {
  executeSuiteBatch,
  loadSuiteQuarantine,
  outcomeCasesOf,
  persistSuiteRunManifest,
  suiteRegistrationLine
} from "./figma/suite-batch.js";
import {
  buildSuiteLoopReport,
  loopPercent,
  renderSuiteLoopMarkdown,
  type SuiteLoopCheck
} from "./figma/suite-loop.js";
import type {
  TaskStatRecord,
  ProjectStore,
  RegressionTaskStatus,
  HostRecord,
  SuiteRunRecord
} from "./db/types.js";
import { deviceLeaseTtlMs } from "./db/types.js";
import { recordAuditSafe } from "./db/audit-event.js";
import {
  runGeneratedTests,
  type SuiteCaseResult,
  type SuiteRunOptions,
  type SuiteRunReport
} from "./figma/suite-runner.js";
import { Runtime } from "./runtime.js";
import { runRunnerAgent } from "./runner/agent.js";
import { startRunnerArtifactServer, type RunnerArtifactServer } from "./runner/artifact-server.js";
import type { HostSnapshot } from "./runner/host-snapshot.js";
import type { RunnerInventory } from "./runner/inventory.js";
import { isRunnerOnline, runnerTtlFrom } from "./runner/status.js";
import { logWarn } from "./log.js";
import { errorMessage, writeFileAtomic } from "./util.js";
import { baselineFor, platformOf, registerSuiteRun } from "./tasks/run-registry.js";
import { runBackfill } from "./tasks/backfill.js";
import { compareRuns, crossPlatformDeltas, type CompareCaseInput } from "./tasks/run-compare.js";

type LogcatCollector = (request: {
  serial: string | null;
  windowStartMs: number;
  windowEndMs: number | null;
}) => Promise<LogcatWindowResult>;

type IosLogCollectorFn = (request: IosLogWindowRequest) => Promise<LogcatWindowResult>;

/** 手动执行设备租约续租的时钟/调度注入缝（测试用；缺省真实时钟与 setInterval）。 */
export interface ManualLeaseTimers {
  now?: () => number;
  setInterval?: (
    callback: () => void | Promise<void>,
    ms: number
  ) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface SuiteCliDeps {
  buildRuntime?: (
    projectDir: string | null
  ) => Promise<{ runtime: Runtime; dispose: () => Promise<void> }>;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  /** 批次清单开关读取（默认 process.env；测试注入）。 */
  env?: NodeJS.ProcessEnv;
  logcatCollector?: LogcatCollector;
  iosLogCollector?: IosLogCollectorFn;
  /** Injected for tests; defaults to `xcrun xcresulttool get test-results tests`. */
  xcresultReader?: (xcresultPath: string) => Promise<unknown>;
  /** runner 子命令注入缝（测试）。 */
  runner?: {
    executeSuite?: (argv: string[], options?: { shouldAbort?: () => boolean }) => Promise<number | null>;
    collectInventory?: () => Promise<RunnerInventory>;
    collectHostSnapshot?: (input: {
      projectRoot: string;
      env: NodeJS.ProcessEnv;
    }) => Promise<HostSnapshot>;
    sleep?: (ms: number) => Promise<void>;
    shouldStop?: () => boolean;
  };
  /** 登记透传：suite run 的 suite_runs.runner（缺省 hostname）。 */
  runnerName?: string;
  /** 面板停止请求（runner 注入；true → 用例边界停止后续）。 */
  shouldAbort?: () => boolean;
  /** runner 内嵌调用 `suite run --task`：设备租约由 runner 生命周期持有，内层不再获取/释放。 */
  leasesHeld?: boolean;
  /** 手动执行租约续租的时钟/调度（测试注入；缺省 Date.now + setInterval）。 */
  leaseTimers?: ManualLeaseTimers;
  /** 中心模式（`suite task … --host`）：注入 store 或自建；带 `--host` 时不构建本地 Runtime。 */
  center?: {
    store?: ProjectStore;
    openStore?: () => Promise<ProjectStore>;
  };
}

interface ParsedFlags {
  positional: string[];
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  list: (key: string) => string[];
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
    list: (key) => {
      const value = flags.get(key);
      if (value === undefined || value === true) return [];
      return Array.isArray(value) ? value : [value];
    },
    has: (key) => flags.has(key)
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

function normalizeRootPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "/") return trimmed;
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

async function knownRootPaths(store: ProjectStore, hostId: string): Promise<string[]> {
  const projects = (await store.listProjects()).filter((project) => project.hostId === hostId);
  return [...new Set(projects.map((project) => project.rootPath))].sort();
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

function retryCountOf(flags: ParsedFlags): number {
  return Math.min(Math.max(intOrNull(flags.get("retry")) ?? 0, 0), 3);
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
    uiDiff: flags.bool("ui-diff"),
    uiDiffMax: intOrNull(flags.get("ui-diff-max")) ?? undefined,
    failOnUi: flags.bool("fail-on-ui"),
    failOnUiWeight: flags.bool("fail-on-ui-weight"),
    pollTimeoutMs: intOrNull(flags.get("poll-timeout")) ?? undefined,
    apiErrors: !flags.bool("no-api-errors"),
    failOnApiErrors: flags.get("fail-on") === "api-error",
    logcatCollector,
    iosLogCollector
  };
}

function apiReviewPendingInTests(testsPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as { apiReview?: unknown };
    return (
      parsed.apiReview !== null &&
      typeof parsed.apiReview === "object" &&
      !Array.isArray(parsed.apiReview) &&
      (parsed.apiReview as { status?: unknown }).status === "pending"
    );
  } catch {
    return false;
  }
}

function pendingApiBlocked(flags: ParsedFlags, testsPath: string): boolean {
  return !flags.bool("allow-pending-api") && apiReviewPendingInTests(testsPath);
}

function resolveCaseSelectors(
  configDirAbs: string,
  testsPath: string,
  selectors: string[],
  options: { allowUnresolved?: boolean } = {}
): { ids: string[]; errors: string[] } {
  if (selectors.length === 0) return { ids: [], errors: [] };
  const cases = loadGeneratedCases(configDirAbs, { testsPath });
  if (cases === null) {
    return options.allowUnresolved === true
      ? { ids: [...selectors], errors: [] }
      : { ids: [], errors: [`无法读取用例文件：${testsPath}`] };
  }
  const ids: string[] = [];
  const errors: string[] = [];
  for (const selector of selectors) {
    const resolved = resolveCaseSelector(selector, cases);
    if (!resolved.ok) {
      if (resolved.reason === "not-found" && options.allowUnresolved === true) {
        if (!ids.includes(selector)) ids.push(selector);
        continue;
      }
      errors.push(
        resolved.reason === "ambiguous"
          ? `用例选择器歧义：${selector}（候选：${resolved.candidates.join("、")}；请改传完整 caseId）`
          : `用例不存在于 ${testsPath}: ${selector}`
      );
      continue;
    }
    if (!ids.includes(resolved.caseId)) ids.push(resolved.caseId);
  }
  return { ids, errors };
}

type SuiteIo = {
  log: (line: string) => void;
  errorLog: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  runnerName?: string | null;
  shouldAbort?: () => boolean;
  /** runner 已持有本任务设备租约（内嵌 `suite run --task` 不再重复获取/释放；缺省 CLI 自行管理）。 */
  leasesHeld?: boolean;
  leaseTimers?: ManualLeaseTimers;
};

export function printSuiteUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp suite — 测试闭环（生成用例的确定性执行与取证）

Usage:
  mobile-testing-mcp suite run [options]        执行 tests.json：每例复位→提交→轮询→台账→逐例分类（批次清单自动落盘）
  mobile-testing-mcp suite check [options]      静态检查：覆盖 × 三件套（tests.xlsx）× 真实数据约束（不连设备，CI 友好）
  mobile-testing-mcp suite calibrate [options]  确定性套件（xcresult）与 MCP 台账差分校准（漏报/误报率）
  mobile-testing-mcp suite loop [options]       测试闭环：静态检查→执行(可选)→反馈→差分校准(可选)，产出闭环报告与下一步
  mobile-testing-mcp suite flake [options]      重复采样量化确定性：通过率/翻转矩阵/flaky 率（--cases × --runs）
  mobile-testing-mcp suite retention [options]  审计产物保留期只读报告（不删除；--days 默认 90、--limit 默认 20）
  mobile-testing-mcp suite evidence <traceId> [options]
                                     聚合某 trace 的失败证据包（失败项/崩溃/锚点截图/设计差异）
  mobile-testing-mcp suite api-errors <traceId> [options]
                                     按 trace 时间窗采集设备日志，匹配 error-codes.json 并落盘
  mobile-testing-mcp suite baseline save|compare [options]
                                     设备对设备基线视觉回归（last-known-good）
  mobile-testing-mcp suite report [options]     从运行台账导出 xlsx 结果页 + JUnit XML
  mobile-testing-mcp suite feedback [options]   生成改进建议与出口清单（只读）
  mobile-testing-mcp suite reconcile list|confirm|reject [options]
                                     对账资产审阅：列举差异并人工确认（human-confirmed）或驳回（rejected）
  mobile-testing-mcp suite task create|list|show|release|cancel [options]
                                     回归任务：create --ref <featureKey>… [--platform ios|android]… [--baseline latest|none]（引用取该功能最新用例集）
                                     中心模式：create|list|cancel --host <id|hostname> [--project <rootPath>]（只连 PG，不构建本机 Runtime）
                                     release <taskId> [--force]：管理侧救济，claimed/running → 待执行（默认要求执行机离线）
                                     cancel <taskId> [--note <text>]：取消任务（pending → 已取消；执行中 → 停止中，待执行机确认）
  mobile-testing-mcp suite runner [options]     项目机常驻 runner：心跳/自动领取执行/产物只读服务（--once 单轮冒烟）
  mobile-testing-mcp suite queue status|pause|resume [options]
                                     主机队列：status 显示暂停状态与待执行数；pause/resume 暂停/恢复自动领取（[--note <text>] 写入审计）
                                     中心模式：--host <id|hostname>（只连 PG，不构建本机 Runtime）
  mobile-testing-mcp suite schedule add|list|show|enable|disable|remove [options]
                                     定时回归：add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>（缺省＝首个 featureKey）]
  mobile-testing-mcp suite backfill [options]   从磁盘产物幂等重建登记（runs + case-sets；--dry-run 只读不写库）
  mobile-testing-mcp suite ui-contract [options] 从 flows.json + 逐屏 .pen 投影 UI 契约（token/几何/状态；--out <dir>；默认经 pen CLI 补 auto-layout 文本几何，--no-bounds 关闭）
  mobile-testing-mcp suite ui-semantics init [options] 从 ui-contract 生成 draft 语义骨架（逐屏 regions:[]；--contract/--out/--force/--json；owner 确认前 draft 不会假绿）
  mobile-testing-mcp suite ui-parity (--trace <traceId> --step <n> | --snapshot <json>) [--visual-text <json>] [--region <id>] [--screen <id|name>] [--contract/--semantics/--baseline] [--update-baseline] [--json]
                                     语义一致性：分类树/截断/IA/覆盖率/动态资产；单屏只给部分覆盖，unverified/offscreen > 0 不返回 layout-compatible（exit 0/1/2）
  mobile-testing-mcp suite ui-lint [options] 检查源码圆角/颜色/字号/字重/字体族字面量是否来自 ui-contract token；--per-screen 按 screen-map 逐屏收窄、--require-mapping 要求 extracted 屏有显式映射、--fail-on-stale-contract 契约指纹过期即失败（--contract/--allowlist/--screen-map/--changed/--require-complete/--fail-on-expiring/--expiry-warn-days <n>/--max-total-bytes <n>；--json；exit 0/1/2）
  mobile-testing-mcp suite parity --a <tests.json> --b <tests.json> [--json] 对比两端人类层用例（semanticId/步骤/预期/屏幕），忽略 taskDesc/i18n/a11y）
  mobile-testing-mcp suite text-weight-calibrate --manifest <json> [--out <dir>] [--no-save] [--strict] [--json]
                                     离线字重校准：成对图片 → 混淆矩阵/高置信误报/delta 分布/阈值建议

common: [--project <dir>] [--json]
run:    [--tests <path>] [--case <caseId|semanticId|displayId>]... [--max <n>] [--stop-on-failure] [--device <serial>]
        [--app <package>] [--model Flash|Pro] [--poll-timeout <ms>]
        [--ui-diff] [--ui-diff-max <n>]（访问屏逐屏设计对比；默认关闭，单例默认最多 10 屏）
        [--fail-on-ui]（窄门禁：非隔离用例 ui.status=failed → exit 2；unverified 不阻断）
        [--fail-on-ui-weight]（窄门禁：非隔离用例高置信字重 heavier → exit 2；默认关闭，待样本校准）
        [--allow-pending-api]（API 说明 pending 时仍执行；默认 check/run 阻断）
        [--no-api-errors] [--fail-on api-error] [--fail-on-uncovered] [--retry <n>] [--no-quarantine] [--strict] [--no-save]
        [--task <id>（回归任务：与 --tests 互斥；--device 可重复，按端展开设备运行）]
check:  [--tests <path>] [--strict] [--allow-pending-api] [--semantics <path>]
        [--fail-on-dynamic] [--dynamic-baseline <json>] [--update-dynamic-baseline]
calibrate: [--report <json|junit.xml>|--xcresult <bundle>] [--tests <path>] [--limit <n>] [--no-sync] [--no-save] [--out <dir>] [--fail-on-miss]
loop:   [--tests <path>] [--skip-run] [--calibration <json>] [--retry <n>] [--max <n>]
        [--device <serial>] [--app <package>] [--model Flash|Pro] [--ui-diff] [--fail-on-ui] [--fail-on-ui-weight]
        [--allow-uncovered] [--no-quarantine] [--no-save] [--out <dir>]
flake:  --cases <caseId|semanticId|displayId,...> [--runs <n>] [--tests <path>] [--device <serial>] [--app <package>]
        [--model Flash|Pro] [--poll-timeout <ms>] [--no-api-errors] [--fail-on-flaky] [--no-save] [--out <dir>]
retention: [--days <n>] [--limit <n>]
evidence: [--full-trace] [--out <dir>] [--no-save] [--design-figma <url>|--design-pen <path>] [--node <id>]
api-errors: [--serial <s>] [--app <bundleId>] [--no-save] [--json]
baseline: --case <caseId|semanticId|displayId> --step <n> --trace <traceId> [--image post|pre] [--serial <s>] [--dpi <n>]
          [--ignore x,y,w,h]... [--screen <name|id>] [--no-save] [--fail-on new|persisting|any|text-weight（仅同平台 baseline 高置信 heavier）]
report: [--limit <n>] [--case <caseId|semanticId|displayId>]... [--out <dir>] [--stamp <s>] [--no-save] [--no-sync] [--task <id>（回归任务报告：命名 <时间>_<功能>_回归.xlsx）]
        [--update-tests [--tests-xlsx <path>]]（把结果写入 tests.xlsx 的「执行结果」sheet；默认 .artemis/design/tests.xlsx）
feedback: [--limit <n>] [--min-failures <n>]
reconcile: list|confirm|reject [--from <screen> --to <screen>] [--reviewer <name>] [--note <text>]
runner: [--name <n>] [--poll-ms <n>] [--heartbeat-ms <n>] [--artifact-port <n>（0 关闭）] [--artifact-host <h>] [--once]
        （需要中心 PG；AOS_RUNNER_* 环境变量可配，AOS_RUNNER_DEVICES 显式覆盖设备清单）
schedule: add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>]；list/show/enable/disable/remove <id>
backfill: [--dry-run] [--since <ISO>] [--project <dir>] [--json]

exit codes: 0 成功/全通过；1 用例失败或证据缺失；2 参数/执行错误或 --fail-on 命中（基线回归/未处理 API 错误/流程未覆盖或无法校验）
错误码注册表: .artemis/design/error-codes.json（未配置时 api-errors 跳过并如实标注 degraded）`);
}

function integrationFailuresOfSuite(cases: SuiteCaseResult[]): IntegrationFailureInput[] {
  return cases
    .filter((entry) => entry.status !== "passed" && entry.quarantined !== true)
    .map((entry) => ({
      caseId: entry.caseId,
      traceId: entry.traceId,
      domain: entry.failure?.domain ?? null,
      reason: entry.error ?? entry.failure?.reason ?? null,
      failedItemTexts: (entry.testSummary?.failedItems ?? []).flatMap((item) => [
        item.itemText ?? "",
        item.evidence ?? ""
      ]),
      apiErrorHandled: (entry.apiErrors ?? []).map((error) => error.handled)
    }));
}

function readinessOfSuite(report: SuiteRunReport): IntegrationReadiness {
  return integrationReadinessFromFailures(integrationFailuresOfSuite(report.cases));
}

function logIntegrationReadiness(
  readiness: IntegrationReadiness,
  log: (line: string) => void
): void {
  if (!readiness.needed) return;
  log("接入检查（按失败证据）：");
  for (const check of readiness.checks) {
    const refs = [
      check.caseIds.length > 0 ? `cases=${check.caseIds.join(",")}` : null,
      check.traceIds.length > 0 ? `traces=${check.traceIds.join(",")}` : null
    ]
      .filter(Boolean)
      .join(" ");
    log(`- [${check.code}] ${INTEGRATION_LABELS[check.code]}：${check.message}${refs ? ` （${refs}）` : ""}`);
  }
}

async function suiteRunTask(
  runtime: Runtime,
  flags: ParsedFlags,
  io: SuiteIo,
  taskId: string,
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn,
  shouldAbort?: () => boolean
): Promise<number> {
  const jsonMode = flags.bool("json");
  const say = jsonMode ? (_line: string): void => {} : (line: string): void => io.log(line);
  if (flags.get("tests") !== null) {
    io.errorLog("--task 与 --tests 不能同用（task 引用用例集存档，--tests 指定单一用例文件）");
    return 2;
  }
  const task = await runtime.store.getRegressionTask(runtime.project.rootDir, taskId);
  if (!task) {
    io.errorLog(`未找到回归任务 ${taskId}`);
    return 2;
  }
  const localHostId = runtime.hostIdentity?.id ?? null;
  if (hostStrictFrom(io.env ?? process.env) && localHostId === null) {
    io.errorLog(
      "AOS_HOST_STRICT=1：本机主机身份未知，拒绝执行回归任务（先确认 AOS_HOST_ID/AOS_HOST_DIR 能解析出主机身份）"
    );
    return 2;
  }
  if (task.targetHostId !== null && localHostId === null) {
    io.errorLog(`本机身份未知，拒绝执行定向任务 ${taskId}（目标主机 ${task.targetHostId}）`);
    return 2;
  }
  if (task.targetHostId !== null && task.targetHostId !== localHostId) {
    io.errorLog(`任务 ${taskId} 不属于本机（目标主机 ${task.targetHostId}），拒绝执行`);
    return 2;
  }
  if (task.claimedHostId !== null && localHostId === null) {
    io.errorLog(`本机身份未知，拒绝执行已认领任务 ${taskId}（认领主机 ${task.claimedHostId}）`);
    return 2;
  }
  if (task.claimedHostId !== null && task.claimedHostId !== localHostId) {
    io.errorLog(`任务 ${taskId} 不属于本机（认领主机 ${task.claimedHostId}），拒绝执行`);
    return 2;
  }
  if (
    task.status === "cancelled" ||
    task.status === "stopped" ||
    task.status === "stopping"
  ) {
    say("任务已取消或已请求停止：不再执行（可重新派发新任务）");
    return 2;
  }
  const devices = splitList(flags.list("device"));
  if (devices.length === 0) {
    io.errorLog("用法: suite run --task <id> --device <serial>（可重复传多个设备）");
    return 2;
  }
  say("子集运行不做全图覆盖门禁（全图完整性由生成时 requireFullCoverage 保障）");
  if (flags.bool("fail-on-uncovered")) {
    say("注意: --fail-on-uncovered 在 task 模式忽略（子集天然不完整）");
  }

  const sets = await runtime.store.listCaseSets(runtime.project.rootDir);
  const setById = new Map(sets.map((set) => [set.id, set]));
  const resolvedRefs: ResolvedTaskRef[] = [];
  for (const ref of task.refs) {
    const feature = setById
      .get(ref.caseSetId)
      ?.features.find((entry) => entry.key === ref.featureKey);
    if (!feature) {
      say(`注意: 引用用例集已不可用（跳过）：caseSet=${ref.caseSetId} feature=${ref.featureKey}`);
      continue;
    }
    resolvedRefs.push({
      caseSetId: ref.caseSetId,
      featureKey: ref.featureKey,
      featureName: feature.name,
      caseCount: feature.caseCount,
      jsonPath: feature.jsonPath
    });
  }
  if (resolvedRefs.length === 0) {
    io.errorLog(`回归任务 ${taskId} 的引用用例集均不可用（先重新生成/登记用例集）`);
    return 2;
  }
  if (!flags.bool("allow-pending-api")) {
    const pending = resolvedRefs.find((ref) => apiReviewPendingInTests(ref.jsonPath));
    if (pending) {
      io.errorLog(
        `任务 ${taskId} 的引用用例集 API 说明待补充（apiReview.status=pending）：${pending.jsonPath}；先补 apiSpec，或传 --allow-pending-api`
      );
      return 2;
    }
  }

  const devicePlatforms = new Set<string>(devices.map((device) => platformOf(device)));
  for (const platform of task.platforms) {
    if (!devicePlatforms.has(platform)) {
      say(`注意: 目标端 ${platform} 无设备（该端未执行）`);
    }
  }

  const baseOptions = suiteRunOptions(flags, logcatCollector, iosLogCollector);
  const quarantine = loadSuiteQuarantine(
    runtime,
    flags.bool("no-quarantine"),
    flags.get("tests") ?? undefined
  );
  baseOptions.quarantinedCaseIds = quarantine.ids;

  const beforeRun = await runtime.store
    .getRegressionTask(runtime.project.rootDir, task.id)
    .catch(() => null);
  if (
    beforeRun?.status === "cancelled" ||
    beforeRun?.status === "stopped" ||
    beforeRun?.status === "stopping"
  ) {
    say("任务已取消或已请求停止：不再执行（可重新派发新任务）");
    return 2;
  }

  let leaseHeld = false;
  const manualLeaseId = `manual:${task.id}`;
  let leaseTimer: ReturnType<typeof setInterval> | null = null;
  let clearLeaseTimer: ((handle: ReturnType<typeof setInterval>) => void) | null = null;
  if (io.leasesHeld !== true && localHostId !== null && devices.length > 0) {
    const hostId = localHostId;
    const now = io.leaseTimers?.now ?? (() => Date.now());
    const schedule =
      io.leaseTimers?.setInterval ??
      ((callback: () => void | Promise<void>, ms: number) => setInterval(callback, ms));
    const clear =
      io.leaseTimers?.clearInterval ??
      ((handle: ReturnType<typeof setInterval>) => clearInterval(handle));
    const ttlMs = deviceLeaseTtlMs(io.env ?? process.env);
    let acquired: Awaited<ReturnType<Runtime["store"]["acquireDeviceLeases"]>>;
    try {
      acquired = await runtime.store.acquireDeviceLeases({
        hostId,
        taskId: manualLeaseId,
        projectId: runtime.projectSummary()?.id ?? null,
        serials: devices,
        ttlMs,
        at: new Date(now()).toISOString()
      });
    } catch (error) {
      io.errorLog(`设备租约获取失败：${errorMessage(error)}`);
      return 2;
    }
    if (!acquired.ok) {
      io.errorLog(`设备被占用：${acquired.busy.join("、")}（先等待或释放租约）`);
      return 2;
    }
    leaseHeld = true;
    clearLeaseTimer = clear;
    leaseTimer = schedule(async () => {
      try {
        const renewed = await runtime.store.renewDeviceLeases({
          hostId,
          taskId: manualLeaseId,
          serials: devices,
          ttlMs,
          at: new Date(now()).toISOString()
        });
        if (renewed < devices.length) {
          logWarn(`手动执行设备租约续租不足（${renewed}/${devices.length}）`);
        }
      } catch (error) {
        logWarn(`手动执行设备租约续租失败: ${errorMessage(error)}`);
      }
    }, Math.max(1, Math.trunc(ttlMs / 3)));
    (leaseTimer as { unref?: () => void }).unref?.();
  }

  try {
    let markedRunning = false;
    try {
      markedRunning = await runtime.store.updateRegressionTask(runtime.project.rootDir, task.id, {
        status: "running",
        expectStatuses: ["claimed", "running"]
      });
    } catch (error) {
      logWarn(`任务状态回写失败: ${errorMessage(error)}`);
      say("注意: 任务状态回写失败（运行结果不受影响）");
    }
    if (!markedRunning) {
      const fresh = await runtime.store
        .getRegressionTask(runtime.project.rootDir, task.id)
        .catch(() => null);
      if (
        fresh?.status === "cancelled" ||
        fresh?.status === "stopped" ||
        fresh?.status === "stopping"
      ) {
        say("任务已取消或已请求停止：不再执行（可重新派发新任务）");
        return 2;
      }
      if (fresh?.status === "pending") {
        try {
          markedRunning = await runtime.store.updateRegressionTask(
            runtime.project.rootDir,
            task.id,
            { status: "running", expectStatuses: ["pending"] }
          );
        } catch (error) {
          logWarn(`任务状态回写失败: ${errorMessage(error)}`);
        }
        if (!markedRunning) {
          const again = await runtime.store
            .getRegressionTask(runtime.project.rootDir, task.id)
            .catch(() => null);
          if (
            again?.status === "cancelled" ||
            again?.status === "stopped" ||
            again?.status === "stopping"
          ) {
            say("任务已取消或已请求停止：不再执行（可重新派发新任务）");
            return 2;
          }
          say(`注意: 任务状态未能置为执行中（当前 ${again?.status ?? "未知"}），继续执行`);
        }
      } else {
        say(`注意: 任务状态为 ${fresh?.status ?? "未知"}，未改写为执行中`);
      }
    }

    const subRuns: Array<{
      device: string;
      platform: string;
      feature: string;
      total: number;
      passed: number;
      failed: number;
      fixed: number;
      regressed: number;
      runId: string | null;
    }> = [];
    const readinessFailures: IntegrationFailureInput[] = [];
    const runIds: string[] = [];
    const seenByDevice = new Map<string, Set<string>>();
    const platformCases = new Map<string, CompareCaseInput[]>();
    let anyFailure = false;
    let anyExecError = false;
    let anyExecuted = false;
    let anyUiFailure = false;
    let anyUiWeightFailure = false;

    for (const device of devices) {
      const platform = platformOf(device);
      const seen = seenByDevice.get(device) ?? new Set<string>();
      seenByDevice.set(device, seen);
      for (const ref of resolvedRefs) {
        const archive = readTestsDocument(runtime.configDirAbs, { testsPath: ref.jsonPath });
        if (!archive) {
          io.errorLog(`份不可读（跳过）：${ref.jsonPath}`);
          anyExecError = true;
          continue;
        }
        const caseIds = archive.records.map((record) => record.id).filter((id) => !seen.has(id));
        const deduped = archive.records.length - caseIds.length;
        if (deduped > 0) {
          say(`[${platform}] ${ref.featureName}: 去重 ${deduped} 例（跨份重复 caseId 只跑一次）`);
        }
        if (caseIds.length === 0) {
          say(`[${platform}] ${ref.featureName}: 用例均已在前序份执行（去重跳过）`);
          continue;
        }
        for (const id of caseIds) seen.add(id);
        const startedAtMs = Date.now();
        const report = await runGeneratedTests(runtime, {
          ...baseOptions,
          testsPath: ref.jsonPath,
          deviceSerial: device,
          caseIds,
          ...(shouldAbort === undefined ? {} : { shouldAbort })
        });
        anyExecuted = true;
        readinessFailures.push(...integrationFailuresOfSuite(report.cases));
        const quarantinedFailures = report.cases.filter(
          (entry) => entry.quarantined === true && entry.status !== "passed"
        ).length;
        const uiFailures = report.cases.filter(
          (entry) => entry.quarantined !== true && entry.ui?.status === "failed"
        ).length;
        const uiWeightFailures = report.cases.filter(
          (entry) =>
            entry.quarantined !== true &&
            (entry.ui?.textStyles?.highConfidenceHeavier ?? 0) > 0
        ).length;
        const uiGate =
          (baseOptions.failOnUi === true && uiFailures > 0) ||
          (baseOptions.failOnUiWeight === true && uiWeightFailures > 0);
        if (uiGate) anyUiFailure = true;
        if (baseOptions.failOnUiWeight === true && uiWeightFailures > 0) {
          anyUiWeightFailure = true;
        }
        const exitCode = !report.ok
          ? 2
          : uiGate
            ? 2
            : report.failed - quarantinedFailures === 0
              ? 0
              : 1;
        if (!report.ok) {
          anyExecError = true;
        } else if (exitCode !== 0) {
          anyFailure = true;
        }
        const comparison = compareRuns(
          task.baseline === "none"
            ? null
            : await baselineFor(runtime, {
                caseSetId: ref.caseSetId,
                featureKey: ref.featureKey,
                platform
              }),
          outcomeCasesOf(report)
        );
        const runId = await registerSuiteRun(runtime, {
          report,
          trigger: "cli",
          regressionTaskId: task.id,
          caseSetId: ref.caseSetId,
          featureKey: ref.featureKey,
          featureName: ref.featureName,
          platform,
          device,
          runner: io.runnerName ?? null,
          exitCode,
          startedAtMs,
          finishedAtMs: Date.now(),
          manifestPath: flags.bool("no-save")
            ? null
            : await persistSuiteRunManifest(runtime, report, io, {
                source: "suite-run",
                startedAtMs,
                exitCode,
                coverageIssue: null,
                strict: flags.bool("strict"),
                failOnUncovered: false,
                retry: retryCountOf(flags),
                options: {
                  ...baseOptions,
                  testsPath: ref.jsonPath,
                  deviceSerial: device,
                  caseIds
                },
                quarantinedCaseIds: quarantine.ids,
                registration: {
                  regressionTaskId: task.id,
                  caseSetId: ref.caseSetId,
                  featureKey: ref.featureKey,
                  featureName: ref.featureName,
                  platform,
                  runner: io.runnerName ?? os.hostname(),
                  caseSetJsonPath: ref.jsonPath
                }
              }),
          comparison
        });
        if (runId) runIds.push(runId);
        platformCases.set(platform, [
          ...(platformCases.get(platform) ?? []),
          ...outcomeCasesOf(report)
        ]);
        subRuns.push({
          device,
          platform,
          feature: ref.featureName,
          total: report.total,
          passed: report.passed,
          failed: report.failed,
          fixed: comparison.fixed,
          regressed: comparison.regressed,
          runId
        });
        say(
          `[${platform}] ${ref.featureName}: pass ${report.passed}/${report.total} · 修复${comparison.fixed} 回归${comparison.regressed}` +
            (comparison.baseline === "established" ? "（基准建立）" : "") +
            (runId ? ` · run ${runId}` : " · 未登记")
        );
      }
    }

    const finalStatus: "completed" | "partial" | "failed" = !anyExecuted
      ? "failed"
      : anyFailure || anyExecError || anyUiFailure || anyUiWeightFailure
        ? "partial"
        : "completed";
    const duringRun = await runtime.store
      .getRegressionTask(runtime.project.rootDir, task.id)
      .catch(() => null);
    const stoppedDuringRun =
      duringRun?.status === "cancelled" ||
      duringRun?.status === "stopped" ||
      duringRun?.status === "stopping";
    let finalWritten = false;
    try {
      finalWritten = await runtime.store.updateRegressionTask(runtime.project.rootDir, task.id, {
        ...(stoppedDuringRun
          ? {}
          : { status: finalStatus, expectStatuses: ["running"] satisfies RegressionTaskStatus[] }),
        runIds
      });
    } catch (error) {
      logWarn(`任务状态回写失败: ${errorMessage(error)}`);
    }
    if (!finalWritten) {
      const fresh = await runtime.store
        .getRegressionTask(runtime.project.rootDir, task.id)
        .catch(() => null);
      if (
        stoppedDuringRun ||
        fresh?.status === "cancelled" ||
        fresh?.status === "stopped" ||
        fresh?.status === "stopping"
      ) {
        say("任务已取消：保留取消状态（不回写终态、不自动重试）");
      } else {
        logWarn(`任务状态已变化（${fresh?.status ?? "未知"}），未覆盖终态`);
        say(`注意: 任务状态已变化（当前 ${fresh?.status ?? "未知"}），未覆盖终态`);
      }
    } else if (stoppedDuringRun) {
      say("任务已取消：保留取消状态（不回写终态、不自动重试）");
    }

    const deltas = crossPlatformDeltas(
      [...platformCases.entries()].map(([platform, cases]) => ({ platform, cases }))
    );
    const totalPassed = subRuns.reduce((sum, entry) => sum + entry.passed, 0);
    const totalCases = subRuns.reduce((sum, entry) => sum + entry.total, 0);
    const exitCode = !anyExecuted ? 2 : anyExecError ? 2 : anyUiFailure ? 2 : anyUiWeightFailure ? 2 : anyFailure ? 1 : 0;
    const readiness = integrationReadinessFromFailures(readinessFailures);
    if (jsonMode) {
      io.log(
        JSON.stringify(
          {
            ok: exitCode === 0,
            taskId: task.id,
            status: finalStatus,
            runIds,
            subRuns,
            crossPlatform: deltas,
            readiness
          },
          null,
          2
        )
      );
    } else {
      if (deltas.length > 0) {
        io.log(`跨端差异 ${deltas.length} 条：`);
        for (const delta of deltas.slice(0, 10)) {
          io.log(
            `- ${delta.name}：${Object.entries(delta.results)
              .map(([platform, outcome]) => `${platform}=${outcome}`)
              .join(" ")}`
          );
        }
      }
      io.log(
        `回归任务 ${task.id}: ${finalStatus} · 设备运行 ${subRuns.length} · pass ${totalPassed}/${totalCases}`
      );
      logIntegrationReadiness(readiness, io.log);
    }
    return exitCode;
  } finally {
    if (leaseTimer !== null && clearLeaseTimer !== null) clearLeaseTimer(leaseTimer);
    if (leaseHeld && localHostId !== null) {
      try {
        await runtime.store.releaseDeviceLeases({ hostId: localHostId, taskId: manualLeaseId });
      } catch (error) {
        logWarn(`释放设备租约失败: ${errorMessage(error)}`);
      }
    }
  }
}

async function suiteRun(
  runtime: Runtime,
  flags: ParsedFlags,
  io: SuiteIo,
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): Promise<number> {
  const taskId = flags.get("task");
  if (taskId) {
    return await suiteRunTask(runtime, flags, io, taskId, logcatCollector, iosLogCollector, io.shouldAbort);
  }
  const runOptions = suiteRunOptions(flags, logcatCollector, iosLogCollector);
  const configuredTests = flags.get("tests");
  const pendingPath = configuredTests
    ? path.resolve(runtime.project.rootDir, configuredTests)
    : path.join(runtime.configDirAbs, "design", "tests.json");
  if (!isImportedTestsFile(pendingPath) && pendingApiBlocked(flags, pendingPath)) {
    io.errorLog(`API 变更说明待补充（apiReview.status=pending）：先补 apiSpec，或传 --allow-pending-api；${pendingPath}`);
    return 2;
  }
  const requestedCases = splitList(flags.list("case"));
  if (requestedCases.length > 0) {
    const selected = resolveCaseSelectors(runtime.configDirAbs, pendingPath, requestedCases);
    if (selected.errors.length > 0) {
      for (const line of selected.errors) io.errorLog(line);
      return 2;
    }
    runOptions.caseIds = selected.ids;
  }
  const retryCount = retryCountOf(flags);
  const batch = await executeSuiteBatch(
    runtime,
    {
      options: runOptions,
      source: "suite-run",
      quarantine: flags.bool("no-quarantine") ? "skip" : "load",
      retry: retryCount,
      resolveCoverageIssue: (report) =>
        flags.bool("fail-on-uncovered")
          ? gateIssueForTests(report.testsPath, report.preflight, { strict: flags.bool("strict") })
          : null,
      strict: flags.bool("strict"),
      failOnUncovered: flags.bool("fail-on-uncovered"),
      registration: {
        platform: runOptions.deviceSerial ? platformOf(runOptions.deviceSerial) : null
      },
      persist: !flags.bool("no-save"),
      logRegistration: false
    },
    io
  );
  const report = batch.report;
  const coverageIssue = batch.coverageIssue;
  const readiness = readinessOfSuite(report);
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ...report, readiness }, null, 2));
  } else {
    io.log(`套件: ${report.testsPath}`);
    if (flags.bool("strict") && !flags.bool("fail-on-uncovered")) {
      io.log("注意: --strict 需与 --fail-on-uncovered 同时使用才参与门禁");
    }
    for (const message of batch.quarantineMessages) {
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
      const uiNote = entry.ui
        ? entry.ui.status === "unverified"
          ? ` · UI 未验证${entry.ui.reason ? `(${entry.ui.reason})` : ""}`
          : ` · UI ${entry.ui.status.toUpperCase()}`
        : "";
      io.log(
        `[${label}] ${entry.name} (${entry.caseId}) trace=${entry.traceId ?? "-"}${failure}${scriptNote}${apiNote}${degraded}${quarantineNote}${retryNote}${uiNote}`
      );
      if (entry.traceId && entry.status !== "passed") {
        io.log(`       证据: node dist/cli.js suite evidence ${entry.traceId}`);
      }
    }
    io.log(
      `结果: pass ${report.passed} / fail ${report.failed} / skipped ${report.skipped}（executed ${report.executed}）`
    );
    if (report.ui) {
      io.log(
        `UI: pass ${report.ui.passed} / fail ${report.ui.failed} / 未验证 ${report.ui.unverified}` +
          (report.ui.notApplicable > 0 ? ` / n/a ${report.ui.notApplicable}` : "")
      );
    }
    if (report.uiCoverage) {
      const coverage = report.uiCoverage;
      const missing = coverage.contractNotCompared;
      const missingText =
        missing.length === 0
          ? ""
          : ` · 契约未覆盖 ${missing.length}（${missing
              .slice(0, 8)
              .map((screen) => screen.name || screen.id)
              .join("、")}${missing.length > 8 ? "…" : ""}）`;
      io.log(
        `UI 覆盖: 契约 ${coverage.contractScreens} 屏${
          (coverage.contractStates ?? 0) > 0 ? ` + ${coverage.contractStates} 状态` : ""
        } · 已比对 ${coverage.comparedScreens.length} 屏` +
          missingText +
          ` · 请求 ${coverage.requested}/匹配 ${coverage.matched}/跳过 ${coverage.skipped}/未匹配 ${coverage.unmatched}`
      );
    }
    if (flags.bool("fail-on-ui")) {
      const uiFailures = report.cases.filter(
        (entry) => entry.quarantined !== true && entry.ui?.status === "failed"
      ).length;
      io.log(`UI 门禁: ${uiFailures > 0 ? "未通过" : "通过"}（fail ${uiFailures}；unverified 不阻断）`);
      if (uiFailures > 0) {
        io.errorLog(
          `--fail-on-ui：${uiFailures} 例 UI failed（仅 lossless PNG 的 blocker/major；unverified 不阻断）。`
        );
      }
    }
    if (flags.bool("fail-on-ui-weight")) {
      const weightFailures = report.cases.filter(
        (entry) =>
          entry.quarantined !== true &&
          (entry.ui?.textStyles?.highConfidenceHeavier ?? 0) > 0
      ).length;
      io.log(
        `UI 字重门禁: ${weightFailures > 0 ? "未通过" : "通过"}（高置信 heavier ${weightFailures} 例；unverified 不阻断）`
      );
      if (weightFailures > 0) {
        io.errorLog(
          `--fail-on-ui-weight：${weightFailures} 例命中高置信字重 heavier（confidence ≥0.7）。`
        );
      }
    }
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
    logIntegrationReadiness(readiness, io.log);
    if (!report.ok) io.errorLog(`套件未执行: ${report.error ?? "无可提交用例"}`);
    if (coverageIssue) io.errorLog(coverageIssue);
    if (!flags.bool("no-save")) {
      io.log(
        batch.runId !== null
          ? suiteRegistrationLine({ runId: batch.runId, comparison: batch.comparison })
          : "登记降级: suite run 未入库（见日志）"
      );
    }
  }
  return batch.exitCode;
}

function flowsFingerprintStatus(
  configDirAbs: string,
  testsPath: string,
  flowsPath: string
): { declared: string | null; current: string | null; stale: boolean } {
  let declared: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as { flowsFingerprint?: unknown };
    if (typeof parsed.flowsFingerprint === "string" && parsed.flowsFingerprint !== "") {
      declared = parsed.flowsFingerprint;
    }
  } catch {
    return { declared: null, current: null, stale: false };
  }
  const graph = loadDesignFlowGraph(configDirAbs, { flowsPath });
  const current = graph === null ? null : flowGraphFingerprint(graph);
  return {
    declared,
    current,
    stale: declared !== null && current !== null && declared !== current
  };
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
  const effectiveFlowsPath = designFlowsPath(runtime);
  const semanticsFlag = flags.get("semantics");
  const semanticsPath =
    semanticsFlag !== null
      ? path.resolve(runtime.project.rootDir, semanticsFlag)
      : path.join(runtime.configDirAbs, "design", "ui-semantics.json");
  const dynamicBaselineFlag = flags.get("dynamic-baseline");
  const dynamicBaselinePath =
    dynamicBaselineFlag !== null
      ? path.resolve(runtime.project.rootDir, dynamicBaselineFlag)
      : path.join(runtime.configDirAbs, "design", "ui-dynamic-baseline.json");
  const updateDynamicBaseline = flags.bool("update-dynamic-baseline");
  const dynamicBaselineExists = fs.existsSync(dynamicBaselinePath);
  let dynamicBaseline: Awaited<ReturnType<typeof loadUiParityBaseline>>["file"] = null;
  if (
    (dynamicBaselineFlag !== null || dynamicBaselineExists) &&
    !(updateDynamicBaseline && !dynamicBaselineExists)
  ) {
    const loaded = loadUiParityBaseline(dynamicBaselinePath);
    if (loaded.errors.length > 0) {
      io.errorLog(`读取 dynamic baseline 失败: ${loaded.errors.join(" | ")}`);
      return 2;
    }
    dynamicBaseline = loaded.file;
  }
  const preflight = preflightGeneratedTests(runtime.configDirAbs, {
    testsPath,
    flowsPath: effectiveFlowsPath,
    semanticsPath,
    ...(dynamicBaseline !== null ? { dynamicBaseline } : {})
  });
  if (!preflight) {
    const message = `无法读取用例文件：${testsPath}`;
    if (flags.bool("json")) {
      io.log(JSON.stringify({ ok: false, testsPath, error: message }, null, 2));
    } else {
      io.errorLog(message);
    }
    return 2;
  }

  if (!isImportedTestsFile(testsPath) && pendingApiBlocked(flags, testsPath)) {
    io.errorLog(`API 变更说明待补充（apiReview.status=pending）：先补 apiSpec，或传 --allow-pending-api；${testsPath}`);
    return 2;
  }
  if (
    preflight.dynamicContent.semanticsError !== null &&
    (semanticsFlag !== null || fs.existsSync(semanticsPath))
  ) {
    io.errorLog(`ui-semantics 解析失败: ${preflight.dynamicContent.semanticsError}`);
    return 2;
  }
  let dynamicContent = preflight.dynamicContent;
  if (updateDynamicBaseline) {
    const entries: UiParityBaselineEntry[] = [];
    for (const entry of dynamicContent.cases) {
      for (const text of entry.texts) {
        entries.push({
          tool: "check-dynamic",
          caseId: entry.caseId,
          kind: "dynamic-content",
          text
        });
      }
    }
    try {
      writeUiParityBaseline(dynamicBaselinePath, entries);
    } catch (error) {
      io.errorLog(`写入 dynamic baseline 失败: ${errorMessage(error)}`);
      return 2;
    }
    dynamicContent = {
      ...dynamicContent,
      cases: dynamicContent.cases.map((entry) => ({ ...entry, baselined: false })),
      fresh: dynamicContent.total,
      baselined: 0
    };
  }
  const failOnDynamic = flags.bool("fail-on-dynamic");
  const coverage = preflight.coverage;
  const imported = isImportedTestsFile(testsPath);
  const flowsFingerprint = flowsFingerprintStatus(runtime.configDirAbs, testsPath, effectiveFlowsPath);
  const issue = gateIssueForTests(testsPath, preflight, { strict: flags.bool("strict") });
  const routeDrift =
    !imported && coverage.available
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
          ok: issue === null && !(failOnDynamic && dynamicContent.fresh > 0),
          testsPath,
          imported,
          cases: preflight.cases,
          weakCases: preflight.weakCases,
          coverage,
          generation: preflight.generation,
          dynamicContent,
          designWarnings: preflight.designWarnings,
          designWarningSummary: preflight.designWarningSummary,
          designWarningsSource: preflight.designWarningsSource,
          designWarningsSnapshotAt: preflight.designWarningsSnapshotAt,
          designWarningsStale: preflight.designWarningsStale,
          routeDrift,
          flowsFingerprint,
          issue
        },
        null,
        2
      )
    );
  } else {
    io.log(`静态覆盖检查: ${testsPath}`);
    if (flowsFingerprint.stale) {
      io.log("警告: flows.json 已更新（flowsFingerprint 不一致）；请重新生成用例以保持跨端同步");
    }
    io.log(`用例: ${preflight.cases} · 弱用例 ${preflight.weakCases.length}`);
    if (dynamicContent.semanticsPath === null) {
      io.log("动态内容: 未配置 ui-semantics/dynamicExamples（不检查；非穷尽）");
    } else {
      io.log(
        `动态内容: ${dynamicContent.total} 例（fresh ${dynamicContent.fresh} / baselined ${dynamicContent.baselined}）` +
          " · 仅匹配已登记 dynamicExamples/dynamicPatterns，非穷尽；新动态值需 owner 更新词表"
      );
      for (const entry of dynamicContent.cases) {
        io.log(
          `  - ${entry.caseId} ${entry.name}: ${entry.texts.join("、")}${entry.baselined ? "（baselined）" : ""}`
        );
      }
    }
    io.log(
      renderDesignWarningLine({
        designWarningSummary: preflight.designWarningSummary,
        designWarningsSource: preflight.designWarningsSource,
        designWarningsStale: preflight.designWarningsStale
      })
    );
    if (imported) {
      io.log("覆盖: n/a (imported)");
    } else if (!coverage.available) {
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
    if (failOnDynamic && dynamicContent.fresh > 0) {
      io.errorLog(
        `动态内容未基线化：${dynamicContent.fresh} 例把设计样例/动态值写成断言；用 --update-dynamic-baseline 固化历史或修正用例`
      );
    }
    if (issue) io.errorLog(issue);
    else if (!(failOnDynamic && dynamicContent.fresh > 0)) {
      io.log(flags.bool("strict") ? "结论: 完整（--strict 弱断言 0）" : "结论: 完整");
    }
  }
  return issue === null && !(failOnDynamic && dynamicContent.fresh > 0) ? 0 : 2;
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
      "用法: mobile-testing-mcp suite calibrate (--report <json|junit.xml>|--xcresult <bundle>) [--tests <path>] [--limit <n>] [--no-sync] [--no-save] [--out <dir>] [--fail-on-miss]"
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

  const defaultTestsPath = path.join(designDir(runtime.configDirAbs), "tests.json");
  const customTests = flags.get("tests");
  const testsPath = customTests ? path.resolve(runtime.project.rootDir, customTests) : defaultTestsPath;
  const testsDocument = readTestsDocument(runtime.configDirAbs, { testsPath });
  if (testsDocument === null) {
    io.errorLog(`无法读取用例文件：${testsPath}`);
    return 2;
  }
  const cases = testsDocument.records.map((record) => ({ id: record.id, name: record.name }));

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
  io: SuiteIo,
  deps: { logcatCollector?: LogcatCollector; iosLogCollector?: IosLogCollectorFn }
): Promise<number> {
  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const customTests = flags.get("tests");
  const testsPath = customTests ? path.resolve(runtime.project.rootDir, customTests) : defaultTestsPath;

  const preflight = preflightGeneratedTests(runtime.configDirAbs, {
    testsPath,
    flowsPath: designFlowsPath(runtime)
  });
  let check: SuiteLoopCheck | null = null;
  if (preflight) {
    const issue = flags.bool("allow-uncovered") ? null : gateIssueForTests(testsPath, preflight);
    const routeDrift = preflight.coverage.available
      ? preflight.coverage.screens.filter((screen) => !preflight.coverage.designScreens.includes(screen))
      : [];
    check = {
      testsPath,
      preflight,
      issue,
      routeDrift,
      designWarnings: preflight.designWarningSummary,
      designWarningsSource: preflight.designWarningsSource
    };
  }

  const runOptions = suiteRunOptions(flags, deps.logcatCollector, deps.iosLogCollector);
  let quarantineMessages: string[] = [];
  let report: SuiteRunReport | null = null;
  if (!flags.bool("skip-run")) {
    const batch = await executeSuiteBatch(
      runtime,
      {
        options: runOptions,
        source: "suite-loop",
        quarantine: flags.bool("no-quarantine") ? "skip" : "load",
        retry: retryCountOf(flags),
        resolveCoverageIssue: () => (check && check.issue !== null ? check.issue : null),
        strict: flags.bool("strict"),
        failOnUncovered: !flags.bool("allow-uncovered"),
        registration: {
          platform: runOptions.deviceSerial ? platformOf(runOptions.deviceSerial) : null
        },
        persist: !flags.bool("no-save"),
        logRegistration: !flags.bool("json")
      },
      io
    );
    report = batch.report;
    quarantineMessages = batch.quarantineMessages;
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
    for (const message of quarantineMessages) {
      io.log(message);
    }
    io.log(
      `静态检查: ${
        step.check ? (step.check.issue ? `未通过（${step.check.issue}）` : "通过") : "不可用（无 tests.json）"
      }`
    );
    if (step.check) {
      io.log(
        renderDesignWarningLine({
          designWarningSummary: step.check.designWarnings,
          designWarningsSource: step.check.designWarningsSource,
          designWarningsStale: step.check.designWarnings.stale === true
        })
      );
    }
    io.log(
      `执行: ${
        step.run
          ? `pass ${step.run.passed} / fail ${step.run.failed} / skipped ${step.run.skipped}（flaky ${step.run.flaky}）`
          : "未执行（--skip-run）"
      }`
    );
    if (report?.ui) {
      io.log(
        `UI: pass ${report.ui.passed} / fail ${report.ui.failed} / 未验证 ${report.ui.unverified}` +
          (report.ui.notApplicable > 0 ? ` / n/a ${report.ui.notApplicable}` : "")
      );
    }
    if (report?.uiCoverage) {
      const coverage = report.uiCoverage;
      io.log(
        `UI 覆盖: 契约 ${coverage.contractScreens} 屏${
          (coverage.contractStates ?? 0) > 0 ? ` + ${coverage.contractStates} 状态` : ""
        } · 已比对 ${coverage.comparedScreens.length} · 契约未覆盖 ${coverage.contractNotCompared.length} · 请求 ${coverage.requested}/匹配 ${coverage.matched}/跳过 ${coverage.skipped}/未匹配 ${coverage.unmatched}`
      );
    }
    if (report && flags.bool("fail-on-ui-weight")) {
      const weightFailures = report.cases.filter(
        (entry) =>
          entry.quarantined !== true &&
          (entry.ui?.textStyles?.highConfidenceHeavier ?? 0) > 0
      ).length;
      io.log(
        `UI 字重门禁: ${weightFailures > 0 ? "未通过" : "通过"}（高置信 heavier ${weightFailures} 例）`
      );
    }
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
    if (loopReport.readiness.needed) {
      io.log("接入检查（按失败证据）:");
      for (const check of loopReport.readiness.checks) {
        const refs = [
          check.caseIds.length > 0 ? `cases=${check.caseIds.join(",")}` : null,
          check.traceIds.length > 0 ? `traces=${check.traceIds.join(",")}` : null
        ]
          .filter(Boolean)
          .join(" ");
        io.log(`  - [${check.code}] ${check.message}${refs ? ` （${refs}）` : ""}`);
      }
    }
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
  const uiFailures = report.cases.filter(
    (entry) => entry.quarantined !== true && entry.ui?.status === "failed"
  ).length;
  if (flags.bool("fail-on-ui") && uiFailures > 0) {
    io.errorLog(
      `--fail-on-ui：${uiFailures} 例 UI failed（仅 lossless PNG 的 blocker/major；unverified 不阻断）。`
    );
    return 2;
  }
  const weightFailures = report.cases.filter(
    (entry) =>
      entry.quarantined !== true &&
      (entry.ui?.textStyles?.highConfidenceHeavier ?? 0) > 0
  ).length;
  if (flags.bool("fail-on-ui-weight") && weightFailures > 0) {
    io.errorLog(
      `--fail-on-ui-weight：${weightFailures} 例命中高置信字重 heavier（confidence ≥0.7）。`
    );
    return 2;
  }
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
      "用法: mobile-testing-mcp suite flake --cases <id,id,...> [--runs <n>] [--tests <path>] [--device <serial>] [--app <package>] [--model Flash|Pro] [--fail-on-flaky] [--no-save] [--out <dir>]"
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
  const flakeDocument = readTestsDocument(runtime.configDirAbs, { testsPath });
  if (flakeDocument === null) {
    io.errorLog(`无法读取用例文件：${testsPath}`);
    return 2;
  }
  const selected = resolveCaseSelectors(runtime.configDirAbs, testsPath, requested);
  if (selected.errors.length > 0) {
    for (const line of selected.errors) io.errorLog(line);
    return 2;
  }
  const selectedIds = selected.ids;
  const caseNames = new Map<string, string>();
  for (const record of flakeDocument.records) caseNames.set(record.id, record.name);
  const missingIds = selectedIds.filter((caseId) => !caseNames.has(caseId));
  if (missingIds.length > 0) {
    io.errorLog(`用例不存在于 ${testsPath}: ${missingIds.join("、")}`);
    return 2;
  }

  const rounds: SuiteRunReport["cases"][] = [];
  for (let round = 0; round < runs; round += 1) {
    const report = await runGeneratedTests(runtime, { ...runOptions, caseIds: selectedIds });
    if (report.cases.length === 0) {
      io.errorLog(`第 ${round + 1} 轮执行失败: ${report.error ?? "无可提交用例"}`);
      return 2;
    }
    rounds.push(report.cases);
  }

  const flake = buildFlakeReport({
    generatedAt: new Date().toISOString(),
    caseIds: selectedIds,
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
      "用法: mobile-testing-mcp suite api-errors <traceId> [--serial <s>] [--app <bundleId>] [--no-save] [--json]"
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
  const serialKind = serial !== null ? classifyIosSerial(serial) : null;
  const iosTarget = serialKind !== null;
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
    source: iosTarget
      ? serialKind === "device"
        ? ("idevicesyslog" as const)
        : ("simctl-log" as const)
      : ("logcat" as const),
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
    io.errorLog("用法: mobile-testing-mcp suite evidence <traceId> [--full-trace] [--out <dir>] [--no-save]");
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
      "用法: mobile-testing-mcp suite baseline save|compare --case <caseId> --step <n> --trace <traceId> [--image post|pre] [--serial <s>] [--dpi <n>] [--ignore x,y,w,h]..."
    );
    return 2;
  }
  let resolvedCaseId = caseId;
  const baselineCases = loadGeneratedCases(runtime.configDirAbs);
  if (baselineCases !== null) {
    const resolved = resolveCaseSelector(caseId, baselineCases);
    if (!resolved.ok && resolved.reason === "ambiguous") {
      io.errorLog(
        `用例选择器歧义：${caseId}（候选：${resolved.candidates.join("、")}；请改传完整 caseId）`
      );
      return 2;
    }
    if (resolved.ok) resolvedCaseId = resolved.caseId;
  }
  const image = flags.get("image") === "pre" ? "pre" : "post";
  const ignoreValues = flags.list("ignore");
  const ignoreRegions = ignoreValues.length === 0 ? [] : parseIgnoreRegions(ignoreValues);
  if (ignoreRegions === null) {
    io.errorLog("--ignore 参数格式应为 x,y,w,h（可多次）");
    return 2;
  }
  const request: BaselineRequest = {
    caseId: resolvedCaseId,
    stepNumber,
    traceId,
    image,
    serial: flags.get("serial"),
    dpi: intOrNull(flags.get("dpi")),
    ignoreRegions,
    screen: flags.get("screen")
  };
  if (action === "save") {
    const saved = await saveBaseline(runtime, request);
    if (flags.bool("json")) {
      io.log(JSON.stringify(saved, null, 2));
    } else {
      io.log(`已保存基线 serial=${saved.meta.serial} case=${resolvedCaseId} step=${stepNumber} ${image}`);
      io.log(
        `文本基线: ${saved.texts} 条（来源 ${saved.textSource}；trace 优先，缺省 design-bbox；0 表示无可用 bbox）`
      );
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
    if (report.textStyles) {
      io.log(
        `文本字重: ${report.textStyles.checked}/${report.textStyles.textsTotal} 已判（lighter ${report.textStyles.lighter} / similar ${report.textStyles.similar} / heavier ${report.textStyles.heavier}，高置信 heavier ${report.textStyles.highConfidenceHeavier}）· unverified ${report.textStyles.unverified}`
      );
      for (const item of report.textStyles.items) {
        const hint = item.weightHint ?? "unverified";
        io.log(
          `- [${hint}] ${item.content} @ ${item.bbox.x},${item.bbox.y} ${item.bbox.width}x${item.bbox.height}${item.reason ? `（${item.reason}）` : ""}`
        );
      }
    } else {
      io.log("文本字重: 无文本基线（保存基线时 trace 无 texts）");
    }
    if (report.saved) io.log(`差异记录: ${report.saved.lastDiff}`);
  }
  const failOn = flags.get("fail-on");
  if (textWeightGateFails(report, failOn)) return 2;
  if (failOn === "new") return report.summary.new > 0 ? 2 : 0;
  if (failOn === "persisting") return report.summary.persisting > 0 ? 2 : 0;
  if (failOn === "any") return report.summary.new + report.summary.persisting > 0 ? 2 : 0;
  return 0;
}

/** `suite report` 文本行：明确区分「未知 / 不可用 / 0 条 / N 条」，不伪造 0。 */
function renderReportDesignWarnings(summary: WarningSummary | null): string {
  if (summary === null) return "设计源警告: 未知（本次报告未读取到设计快照）";
  if (!summary.available) return "设计源警告: 不可用（缺 tests.json / flows.json 快照）";
  const codes = summary.codes.length > 0 ? `（${summary.codes.join("、")}）` : "";
  const stale = summary.stale === true ? " · stale-snapshot（tests 快照早于 flows.json）" : "";
  return `设计源警告: ${summary.total} 条${codes}${stale}`;
}

async function suiteReport(runtime: Runtime, flags: ParsedFlags, io: { log: (line: string) => void; errorLog: (line: string) => void }): Promise<number> {
  const applyTestsUpdate = async (report: RunReport): Promise<void> => {
    if (!flags.bool("update-tests")) return;
    const target = flags.get("tests-xlsx")
      ? path.resolve(runtime.project.rootDir, flags.get("tests-xlsx")!)
      : path.join(runtime.configDirAbs, "design", "tests.xlsx");
    let runs: SuiteRunRecord[] = [];
    try {
      runs = await runtime.store.listSuiteRuns(runtime.project.rootDir, {
        ...(flags.get("task") ? { taskId: flags.get("task")! } : {}),
        limit: 100
      });
    } catch (error) {
      if (!flags.bool("json")) {
        io.errorLog(`执行结果历史读取失败: ${errorMessage(error)}`);
      }
    }
    try {
      report.testsUpdated = await updateTestsWorkbookWithResults(target, report, { runs });
      if (!flags.bool("json")) {
        const history =
          report.testsUpdated.historyRows === undefined
            ? ""
            : `，跨端对比 ${report.testsUpdated.historyRows} 条`;
        io.log(
          `执行结果已回填: ${report.testsUpdated.path}（${report.testsUpdated.rows} 条${history}）`
        );
      }
    } catch (error) {
      report.testsUpdateError = errorMessage(error);
      if (!flags.bool("json")) {
        io.errorLog(`执行结果回填失败: ${errorMessage(error)}`);
      }
    }
  };
  const taskId = flags.get("task");
  if (taskId) {
    const report = await buildTaskRunReport(runtime, {
      taskId,
      outputDir: flags.get("out") ?? undefined,
      stamp: flags.get("stamp") ?? undefined,
      save: !flags.bool("no-save")
    });
    await applyTestsUpdate(report);
    if (flags.bool("json")) {
      io.log(JSON.stringify(report, null, 2));
    } else {
      io.log(
        `任务报告: 共 ${report.total} · 通过 ${report.passed} · 失败 ${report.failed} · 待定 ${report.pending}`
      );
      io.log(renderReportDesignWarnings(report.designWarnings));
      if (report.saved) {
        io.log(`xlsx: ${report.saved.xlsx}`);
        io.log(`junit: ${report.saved.junit}`);
      }
      if (report.error) io.errorLog(report.error);
    }
    if (!report.ok) {
      return report.error?.includes("未找到回归任务") ? 2 : 1;
    }
    return report.testsUpdateError ? 1 : 0;
  }
  if (!flags.bool("no-sync")) {
    await runtime.syncTaskStatuses();
    await runtime.flushCrashScans();
  }
  const reportSelectors = splitList(flags.list("case"));
  let reportCaseIds: string[] = [];
  if (reportSelectors.length > 0) {
    const testsPath = path.join(runtime.configDirAbs, "design", "tests.json");
    const resolved = resolveCaseSelectors(runtime.configDirAbs, testsPath, reportSelectors, {
      allowUnresolved: true
    });
    if (resolved.errors.length > 0) {
      for (const line of resolved.errors) io.errorLog(line);
      return 2;
    }
    reportCaseIds = resolved.ids;
  }
  const report = await buildRunReport(runtime, {
    limit: intOrNull(flags.get("limit")) ?? undefined,
    caseIds: reportCaseIds,
    outputDir: flags.get("out") ?? undefined,
    stamp: flags.get("stamp") ?? undefined,
    save: !flags.bool("no-save")
  });
  await applyTestsUpdate(report);
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
  } else {
    io.log(`运行报告: 共 ${report.total} · 通过 ${report.passed} · 失败 ${report.failed} · 待定 ${report.pending}`);
    io.log(renderReportDesignWarnings(report.designWarnings));
    if (report.saved) {
      io.log(`xlsx: ${report.saved.xlsx}`);
      io.log(`junit: ${report.saved.junit}`);
    }
    if (report.error) io.errorLog(report.error);
  }
  return report.ok ? (report.testsUpdateError ? 1 : 0) : 1;
}

/** 出口清单文本面（与面板/JSON 同源）：三行 + 空态。 */
function renderVerdictExits(exits: VerdictExits, log: (line: string) => void): void {
  const { caseDefects, environment, appDefects } = exits;
  if (caseDefects.length === 0 && environment.length === 0 && appDefects.length === 0) {
    log("出口清单为空（暂无已裁决失败）。");
    return;
  }
  log("出口清单（按最新裁决）：");
  const features: string[] = [];
  for (const entry of caseDefects) {
    const name = entry.featureName ?? entry.featureKey;
    if (name !== null && name !== "" && !features.includes(name)) features.push(name);
  }
  log(
    `- 案例问题：${caseDefects.length} 条${features.length > 0 ? `（功能：${features.join("、")}）` : ""}`
  );
  const environmentTotal = environment.reduce((sum, group) => sum + group.count, 0);
  const deviceCounts = environment.map((group) => `${group.device ?? "—"}(${group.count})`);
  log(
    `- 执行偏差：${environmentTotal} 条${
      deviceCounts.length > 0 ? `（设备：${deviceCounts.join("、")}）` : ""
    }`
  );
  const created = appDefects.filter((entry) => entry.jiraKey !== null && entry.jiraKey !== "").length;
  log(`- 应用缺陷：${appDefects.length} 条${created > 0 ? `（已建单 ${created}）` : ""}`);
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
    if (feedback.readiness.needed) {
      io.log("接入检查（按失败证据）：");
      for (const check of feedback.readiness.checks) {
        const refs = [
          check.caseIds.length > 0 ? `cases=${check.caseIds.join(",")}` : null,
          check.traceIds.length > 0 ? `traces=${check.traceIds.join(",")}` : null
        ]
          .filter(Boolean)
          .join(" ");
        io.log(`- [${check.code}] ${check.message}${refs ? ` （${refs}）` : ""}`);
      }
    }
    if (feedback.suggestions.length === 0) io.log("无改进建议（数据不足或均已满足阈值）。");
    if (feedback.exits) renderVerdictExits(feedback.exits, io.log);
  }
  return feedback.ok ? 0 : 1;
}

/** 对账审阅面：list / confirm / reject——人工只仲裁不一致；未裁决项保持待办、不升权。 */
async function suiteReconcile(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const action = flags.positional[1];
  if (!action || !["list", "confirm", "reject"].includes(action)) {
    io.errorLog(
      "用法: suite reconcile list|confirm|reject [--from <screen> --to <screen>] [--reviewer <name>] [--note <text>] [--json]"
    );
    return 2;
  }
  const from = flags.get("from")?.trim();
  const to = flags.get("to")?.trim();
  if (action !== "list" && (!from || !to)) {
    io.errorLog("confirm/reject 需要 --from 与 --to（屏幕名，与 list 输出一致）");
    return 2;
  }
  const file = reconciliationFilePath(runtime.configDirAbs);
  if (action === "list") {
    const listing = reconciliationListing(runtime.configDirAbs);
    if (flags.bool("json")) {
      io.log(
        JSON.stringify(
          {
            ok: true,
            file: listing.file,
            updatedAt: listing.updatedAt,
            counts: listing.counts,
            ...(listing.corrupt ? { corrupt: true } : {}),
            edges: listing.edges
          },
          null,
          2
        )
      );
      return 0;
    }
    if (listing.edges.length === 0) {
      io.log(
        `对账资产为空（${listing.file}）${listing.corrupt ? "；文件损坏按空资产处理" : ""}：iOS 套件运行后自动产生观测；confirm/reject 需要已有条目`
      );
      return 0;
    }
    io.log(
      `对账资产: ${listing.file}（${listing.edges.length} 条${listing.corrupt ? "；文件损坏按空资产处理" : ""}）`
    );
    for (const entry of listing.edges) {
      const review = entry.review
        ? ` · 审阅 ${entry.review.decision}${entry.review.reviewer ? ` by ${entry.review.reviewer}` : ""}${entry.review.note ? `（${entry.review.note}）` : ""}`
        : "";
      const direction = entry.direction === "runtime-only" ? " · 逆向观测（设计无此边，不参与生成）" : "";
      const history =
        entry.history.length > 0
          ? ` · 决定历史 ${entry.history.map((item) => item.decision).join("→")}`
          : "";
      const traces =
        entry.traces.length > 0
          ? `（traces: ${entry.traces.slice(-3).join(", ")}${entry.traces.length > 3 ? ", …" : ""}）`
          : "";
      const context = entry.toTextHints.length > 0 ? ` · 目标文本「${entry.toTextHints.join("」「")}」` : "";
      io.log(
        `[${entry.status}] ${entry.from} → ${entry.to} · 来源 ${entry.designProvenance}→${entry.provenance} · 命中 ${entry.hits}${traces}${context}${direction}${history}${review}`
      );
    }
    io.log(
      `汇总: pending ${listing.counts.pending} · upgraded ${listing.counts.upgraded} · confirmed ${listing.counts.confirmed} · rejected ${listing.counts.rejected}`
    );
    return 0;
  }

  const asset = loadReconciliation(runtime.configDirAbs);
  const result = reviewEdge(asset, {
    from: from!,
    to: to!,
    decision: action === "confirm" ? "confirmed" : "rejected",
    reviewer: flags.get("reviewer") ?? null,
    note: flags.get("note") ?? undefined,
    at: new Date().toISOString()
  });
  if ("error" in result) {
    io.errorLog(result.error);
    return 1;
  }
  saveReconciliation(runtime.configDirAbs, result.asset);
  const entry = result.entry;
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, file, edge: entry }, null, 2));
  } else {
    io.log(
      `已${action === "confirm" ? "确认" : "驳回"}：${entry.from} → ${entry.to}（status=${entry.status}，provenance=${entry.provenance}${entry.review?.reviewer ? `，reviewer=${entry.review.reviewer}` : ""}）`
    );
    io.log(
      action === "confirm"
        ? "下一次 figma_generate_tests 将以硬断言生成该边（human-confirmed）。"
        : "该边不再进入后续生成（rejected）。"
    );
  }
  return 0;
}

type CaseSetList = Awaited<ReturnType<ProjectStore["listCaseSets"]>>;

function resolveTaskRefsFromSets(
  sets: CaseSetList,
  keys: string[],
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): ResolvedTaskRef[] | null {
  const latest = latestFeatureRefs(sets);
  const resolved: ResolvedTaskRef[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const hit = latest.get(key);
    if (!hit) {
      missing.push(key);
      continue;
    }
    resolved.push(hit);
  }
  if (missing.length > 0) {
    const available = [...latest.keys()].sort().join("、");
    io.errorLog(`未知 feature key：${missing.join("、")}（可用：${available || "无"}）`);
    return null;
  }
  return resolved;
}

function parseTaskPriority(
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): number | null {
  const raw = (flags.get("priority") ?? "").trim();
  if (raw === "") return 0;
  if (!/^\d+$/.test(raw)) {
    io.errorLog(`非法 --priority：${raw}（须为 0–100 的整数）`);
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (value < 0 || value > 100) {
    io.errorLog(`非法 --priority：${raw}（须为 0–100 的整数）`);
    return null;
  }
  return value;
}

function parseTaskTargeting(
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): { platforms: string[]; baseline: "latest" | "none" } | null {
  const platforms =
    flags.list("platform").length > 0 ? splitList(flags.list("platform")) : ["ios", "android"];
  const invalidPlatforms = platforms.filter(
    (platform) => platform !== "ios" && platform !== "android"
  );
  if (invalidPlatforms.length > 0) {
    io.errorLog(`非法 --platform：${invalidPlatforms.join("、")}（仅支持 ios/android）`);
    return null;
  }
  const uniquePlatforms = [...new Set(platforms)];
  const rawBaseline = flags.get("baseline");
  if (rawBaseline !== null && rawBaseline !== "latest" && rawBaseline !== "none") {
    io.errorLog(`非法 --baseline：${rawBaseline}（仅支持 latest/none）`);
    return null;
  }
  return { platforms: uniquePlatforms, baseline: rawBaseline === "none" ? "none" : "latest" };
}

async function suiteTask(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  env: NodeJS.ProcessEnv
): Promise<number> {
  const action = flags.positional[1];
  if (action === "create") return await suiteTaskCreate(runtime, flags, io);
  if (action === "list") return await suiteTaskList(runtime, flags, io);
  if (action === "show") return await suiteTaskShow(runtime, flags, io);
  if (action === "release") return await suiteTaskRelease(runtime, flags, io);
  if (action === "cancel") return await suiteTaskCancel(runtime, flags, io, env);
  io.errorLog("用法: suite task create|list|show|release|cancel …（见 suite help）");
  return 2;
}

async function suiteTaskCreate(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const refs = splitList(flags.list("ref"));
  if (refs.length === 0) {
    io.errorLog(
      "用法: suite task create --ref <featureKey> [--ref …] [--platform ios|android]… [--baseline latest|none]"
    );
    return 2;
  }
  const resolved = resolveTaskRefsFromSets(
    await runtime.store.listCaseSets(runtime.project.rootDir),
    refs,
    io
  );
  if (resolved === null) return 2;
  const targeting = parseTaskTargeting(flags, io);
  if (targeting === null) return 2;
  const priority = parseTaskPriority(flags, io);
  if (priority === null) return 2;
  const { platforms: uniquePlatforms, baseline } = targeting;
  const projectRecord = runtime.projectSummary();
  const localHostId = runtime.store.localHostId ?? null;
  const task = await runtime.store.createRegressionTask({
    rootPath: runtime.project.rootDir,
    refs: resolved.map((entry) => ({ caseSetId: entry.caseSetId, featureKey: entry.featureKey })),
    platforms: uniquePlatforms,
    baseline,
    createdBy: "cli",
    targetHostId: projectRecord?.hostId ?? localHostId,
    createdHostId: localHostId,
    priority
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, task, resolved }, null, 2));
    return 0;
  }
  io.log(
    `回归任务 ${task.id}（status=${task.status} · platforms=${uniquePlatforms.join(",")} · baseline=${baseline}）`
  );
  for (const entry of resolved) {
    io.log(
      `- ${entry.featureName}（${entry.featureKey}）· caseSet=${entry.caseSetId} · 用例 ${entry.caseCount} · ${entry.jsonPath}`
    );
  }
  return 0;
}

async function suiteTaskList(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const tasks = await runtime.store.listRegressionTasks(runtime.project.rootDir, 50);
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, tasks }, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    io.log("暂无回归任务（suite task create 创建）");
    return 0;
  }
  for (const task of tasks) {
    io.log(
      `${task.id} · ${task.status} · refs ${task.refs.length} · platforms ${task.platforms.join(",")} · runs ${task.runIds.length} · ${task.createdAt}`
    );
  }
  return 0;
}

async function suiteQueuePending(
  scoped: ProjectStore,
  hostId: string,
  fallbackRootPaths: string[] = []
): Promise<number> {
  const roots = [
    ...new Set([
      ...(await scoped.listProjects())
        .filter((project) => project.hostId === hostId)
        .map((project) => project.rootPath),
      ...fallbackRootPaths
    ])
  ];
  let pending = 0;
  for (const rootPath of roots) {
    const tasks = await scoped.listRegressionTasks(rootPath, 1000);
    pending += tasks.filter((task) => task.status === "pending").length;
  }
  return pending;
}

function queueStatusLine(host: HostRecord, pending: number): string {
  const state = host.queuePaused
    ? `暂停（by=${host.queuePausedBy ?? "?"}，at=${host.queuePausedAt ?? "?"}）`
    : "运行";
  return `主机 ${host.id}（${host.hostname}）队列：${state}；待执行 ${pending} 条`;
}

function queueJson(input: {
  hostId: string;
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  pending: number;
}) {
  return {
    ok: true,
    hostId: input.hostId,
    paused: input.paused,
    pausedAt: input.pausedAt,
    pausedBy: input.pausedBy,
    pending: input.pending
  };
}

function queueJsonFromHost(host: HostRecord, pending: number) {
  return queueJson({
    hostId: host.id,
    paused: host.queuePaused,
    pausedAt: host.queuePausedAt,
    pausedBy: host.queuePausedBy,
    pending
  });
}

async function suiteQueue(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  env: NodeJS.ProcessEnv
): Promise<number> {
  const action = flags.positional[1] ?? "status";
  if (action !== "status" && action !== "pause" && action !== "resume") {
    io.errorLog("用法: suite queue status|pause|resume [--host <id|hostname>] [--json]");
    return 2;
  }
  const identity = runtime.hostIdentity;
  if (!identity) {
    io.errorLog("本机身份未知：无法确定队列所属主机（检查主机身份配置）");
    return 2;
  }
  const existing = await runtime.store.getHost(identity.id).catch(() => null);
  const actor = actorFromEnv(env);
  if (action === "status") {
    const pending = await suiteQueuePending(runtime.store, identity.id, [
      runtime.project.rootDir
    ]);
    const view = {
      hostId: identity.id,
      paused: existing?.queuePaused ?? false,
      pausedAt: existing?.queuePausedAt ?? null,
      pausedBy: existing?.queuePausedBy ?? null,
      pending
    };
    if (flags.bool("json")) {
      io.log(JSON.stringify(queueJson(view), null, 2));
      return 0;
    }
    io.log(
      existing
        ? queueStatusLine(existing, pending)
        : `主机 ${identity.id}（${identity.hostname}）队列：运行（未登记）；待执行 ${pending} 条`
    );
    return 0;
  }
  const host =
    existing ??
    (await runtime.store.upsertHost({
      id: identity.id,
      hostname: identity.hostname,
      hardwareId: identity.hardwareId,
      username: identity.username,
      osPlatform: identity.osPlatform,
      osVersion: identity.osVersion,
      arch: identity.arch,
      kind: identity.kind,
      identitySource: identity.identitySource
    }));
  const paused = action === "pause";
  const record = await runtime.store.setHostQueuePaused({
    hostId: host.id,
    paused,
    by: actor
  });
  if (!record) {
    io.errorLog(`未知主机 ${host.id}（无法${paused ? "暂停" : "恢复"}队列）`);
    return 2;
  }
  const pending = await suiteQueuePending(runtime.store, record.id, [
    runtime.project.rootDir
  ]);
  const note = flags.get("note")?.trim() ?? "";
  await recordAuditSafe(runtime.store, runtime.project.rootDir, {
    domain: "suite",
    action: paused ? "action.queue.pause" : "action.queue.resume",
    result: "ok",
    summary: `${paused ? "暂停" : "恢复"}主机 ${record.id} 队列（待执行 ${pending} 条）`,
    refs: { hostId: record.id, ...(note === "" ? {} : { note }) },
    actor,
    actorHostId: identity.id,
    channel: "cli"
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(queueJsonFromHost(record, pending), null, 2));
    return 0;
  }
  io.log(
    paused
      ? `主机 ${record.id} 队列已暂停（by=${record.queuePausedBy ?? actor}）；待执行 ${pending} 条`
      : `主机 ${record.id} 队列已恢复；待执行 ${pending} 条`
  );
  return 0;
}

async function suiteQueueOnCenterHost(
  hostReference: string,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  center: NonNullable<SuiteCliDeps["center"]>,
  env: NodeJS.ProcessEnv
): Promise<number> {
  const action = flags.positional[1] ?? "status";
  if (action !== "status" && action !== "pause" && action !== "resume") {
    io.errorLog("用法: suite queue status|pause|resume [--host <id|hostname>] [--json]");
    return 2;
  }
  let store = center.store ?? null;
  let opened = false;
  if (store === null) {
    try {
      store = center.openStore ? await center.openStore() : await openCenterStore(env);
      opened = true;
    } catch (error) {
      io.errorLog(`suite queue --host 需要中心 PG：${errorMessage(error)}`);
      return 2;
    }
  }
  try {
    const lookup = await resolveHostReference(store, hostReference);
    if (!lookup.ok) {
      if (lookup.reason === "not-found") {
        io.errorLog(`未知主机 ${hostReference}（用 host list 查看已登记主机）`);
      } else {
        io.errorLog(
          `主机名不唯一：${hostReference}（${lookup.candidates.map((host) => host.id).join("、")}）；请改用主机 id`
        );
      }
      return 2;
    }
    const scoped = store.scopeHost(lookup.host.id);
    if (action === "status") {
      const pending = await suiteQueuePending(scoped, lookup.host.id);
      if (flags.bool("json")) {
        io.log(JSON.stringify(queueJsonFromHost(lookup.host, pending), null, 2));
        return 0;
      }
      io.log(queueStatusLine(lookup.host, pending));
      return 0;
    }
    const actor = actorFromEnv(env);
    const paused = action === "pause";
    const record = await store.setHostQueuePaused({
      hostId: lookup.host.id,
      paused,
      by: actor
    });
    if (!record) {
      io.errorLog(`未知主机 ${lookup.host.id}（无法${paused ? "暂停" : "恢复"}队列）`);
      return 2;
    }
    const pending = await suiteQueuePending(scoped, record.id);
    const note = flags.get("note")?.trim() ?? "";
    const projects = (await scoped.listProjects())
      .filter((project) => project.hostId === record.id)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    await recordAuditSafe(scoped, projects[0]?.rootPath ?? "", {
      domain: "suite",
      action: paused ? "action.queue.pause" : "action.queue.resume",
      result: "ok",
      summary: `中心${paused ? "暂停" : "恢复"}主机 ${record.id} 队列（待执行 ${pending} 条）`,
      refs: { hostId: record.id, ...(note === "" ? {} : { note }) },
      actor,
      actorHostId: null,
      channel: "cli"
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify(queueJsonFromHost(record, pending), null, 2));
      return 0;
    }
    io.log(
      paused
        ? `主机 ${record.id} 队列已暂停（by=${record.queuePausedBy ?? actor}）；待执行 ${pending} 条`
        : `主机 ${record.id} 队列已恢复；待执行 ${pending} 条`
    );
    return 0;
  } catch (error) {
    io.errorLog(`suite queue --host 失败：${errorMessage(error)}`);
    return 2;
  } finally {
    if (opened && store !== null) {
      try {
        await store.close();
      } catch {
        /* best effort */
      }
    }
  }
}

async function suiteTaskOnCenterHost(
  hostReference: string,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  center: NonNullable<SuiteCliDeps["center"]>,
  env: NodeJS.ProcessEnv
): Promise<number> {
  let store = center.store ?? null;
  let opened = false;
  if (store === null) {
    try {
      store = center.openStore ? await center.openStore() : await openCenterStore(env);
      opened = true;
    } catch (error) {
      io.errorLog(`suite task --host 需要中心 PG：${errorMessage(error)}`);
      return 2;
    }
  }
  try {
    const lookup = await resolveHostReference(store, hostReference);
    if (!lookup.ok) {
      if (lookup.reason === "not-found") {
        io.errorLog(`未知主机 ${hostReference}（用 host list 查看已登记主机）`);
      } else {
        io.errorLog(
          `主机名不唯一：${hostReference}（${lookup.candidates.map((host) => host.id).join("、")}）；请改用主机 id`
        );
      }
      return 2;
    }
    const hostId = lookup.host.id;
    const scoped = store.scopeHost(hostId);
    const action = flags.positional[1];
    if (action === "create") {
      return await suiteTaskCreateOnHost(scoped, lookup.host, store.localHostId ?? null, flags, io, env);
    }
    if (action === "list") return await suiteTaskListOnHost(store, scoped, hostId, flags, io);
    if (action === "cancel") {
      return await suiteTaskCancelOnHost(scoped, hostId, flags, io, env);
    }
    io.errorLog(`suite task ${action ?? ""} 暂不支持 --host（中心模式支持 create|list|cancel）`);
    return 2;
  } catch (error) {
    io.errorLog(`suite task --host 失败：${errorMessage(error)}`);
    return 2;
  } finally {
    if (opened && store !== null) {
      try {
        await store.close();
      } catch {
        /* best effort */
      }
    }
  }
}

async function suiteTaskCreateOnHost(
  scoped: ProjectStore,
  host: HostRecord,
  createdHostId: string | null,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  env: NodeJS.ProcessEnv
): Promise<number> {
  const hostId = host.id;
  const rawProject = flags.get("project");
  const rootPath = rawProject === null ? null : normalizeRootPath(rawProject);
  if (rootPath === null || rootPath === "") {
    io.errorLog(
      "用法: suite task create --host <id|hostname> --project <rootPath> --ref <featureKey> [--ref …] [--platform ios|android]… [--baseline latest|none]"
    );
    return 2;
  }
  const refs = splitList(flags.list("ref"));
  if (refs.length === 0) {
    io.errorLog(
      "用法: suite task create --host <id|hostname> --project <rootPath> --ref <featureKey> [--ref …] [--platform ios|android]… [--baseline latest|none]"
    );
    return 2;
  }
  const project = await scoped.getProjectByPath(rootPath);
  if (project === null) {
    const known = await knownRootPaths(scoped, hostId);
    io.errorLog(
      `未知项目：${rootPath}（主机 ${hostId} 已登记：${known.length > 0 ? known.join("、") : "无"}；请先在目标机接入项目）`
    );
    return 2;
  }
  const resolved = resolveTaskRefsFromSets(await scoped.listCaseSets(rootPath), refs, io);
  if (resolved === null) return 2;
  const targeting = parseTaskTargeting(flags, io);
  if (targeting === null) return 2;
  const priority = parseTaskPriority(flags, io);
  if (priority === null) return 2;
  const precheck = precheckTask(
    {
      id: host.id,
      kind: host.kind,
      osPlatform: host.osPlatform,
      capabilities: host.capabilities,
      online: isHostOnline(host, Date.now(), env)
    },
    targeting.platforms
  );
  if (!precheck.ok) {
    io.errorLog(`目标主机无法满足所需平台：${precheck.reasons.join("；")}`);
    return 2;
  }
  for (const reason of precheck.reasons) io.log(`警告：${reason}`);
  const task = await scoped.createRegressionTask({
    rootPath,
    refs: resolved.map((entry) => ({ caseSetId: entry.caseSetId, featureKey: entry.featureKey })),
    platforms: targeting.platforms,
    baseline: targeting.baseline,
    createdBy: "cli",
    targetHostId: hostId,
    createdHostId,
    priority
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, task, resolved }, null, 2));
    return 0;
  }
  io.log(
    `回归任务 ${task.id}（host=${hostId} · status=${task.status} · platforms=${targeting.platforms.join(",")} · baseline=${targeting.baseline}）`
  );
  for (const entry of resolved) {
    io.log(
      `- ${entry.featureName}（${entry.featureKey}）· caseSet=${entry.caseSetId} · 用例 ${entry.caseCount} · ${entry.jsonPath}`
    );
  }
  return 0;
}

async function suiteTaskListOnHost(
  store: ProjectStore,
  scoped: ProjectStore,
  hostId: string,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const rawProject = flags.get("project");
  const projectArg = rawProject === null ? null : normalizeRootPath(rawProject);
  const rootPaths: string[] = [];
  if (projectArg !== null && projectArg !== "") {
    if ((await scoped.getProjectByPath(projectArg)) === null) {
      const known = await knownRootPaths(scoped, hostId);
      io.errorLog(
        `未知项目：${projectArg}（主机 ${hostId} 已登记：${known.length > 0 ? known.join("、") : "无"}）`
      );
      return 2;
    }
    rootPaths.push(projectArg);
  } else {
    const projects = (await store.listProjects()).filter((project) => project.hostId === hostId);
    for (const project of projects) {
      if (!rootPaths.includes(project.rootPath)) rootPaths.push(project.rootPath);
    }
  }
  const tasks: Awaited<ReturnType<ProjectStore["listRegressionTasks"]>> = [];
  for (const rootPath of rootPaths) {
    tasks.push(...(await scoped.listRegressionTasks(rootPath, 50)));
  }
  tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, hostId, tasks }, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    io.log(`主机 ${hostId} 暂无回归任务（suite task create --host ${hostId} 创建）`);
    return 0;
  }
  for (const task of tasks) {
    io.log(
      `${task.id} · ${task.status} · refs ${task.refs.length} · platforms ${task.platforms.join(",")} · runs ${task.runIds.length} · ${task.createdAt}`
    );
  }
  return 0;
}

function actorFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = (env.AOS_ACTOR ?? "").trim();
  if (raw !== "") return raw;
  try {
    return os.userInfo().username;
  } catch {
    return "unknown";
  }
}

function cancelStatusNote(status: string): string {
  if (status === "stopping") return "已请求取消（等待执行机确认）";
  if (status === "cancelled") return "已取消";
  return `当前状态 ${status}，未改动`;
}

async function suiteTaskCancel(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  env: NodeJS.ProcessEnv
): Promise<number> {
  const taskId = flags.positional[2];
  if (!taskId) {
    io.errorLog("用法: suite task cancel <taskId> [--note <text>]");
    return 2;
  }
  const rootPath = runtime.project.rootDir;
  const existing = await runtime.store.getRegressionTask(rootPath, taskId);
  if (!existing) {
    io.errorLog(`未找到回归任务 ${taskId}`);
    return 2;
  }
  const localHostId = runtime.hostIdentity?.id ?? null;
  if (hostStrictFrom(env) && localHostId === null) {
    io.errorLog(
      "AOS_HOST_STRICT=1：本机主机身份未知，拒绝取消回归任务（先确认 AOS_HOST_ID/AOS_HOST_DIR 能解析出主机身份）"
    );
    return 2;
  }
  const actor = actorFromEnv(env);
  const actorHostId = runtime.hostIdentity?.id ?? null;
  const note = flags.get("note");
  const task = await runtime.store.cancelRegressionTask({
    rootPath,
    taskId,
    source: "local-cli",
    actor,
    actorHostId,
    note
  });
  if (!task) {
    io.errorLog(`未找到回归任务 ${taskId}`);
    return 2;
  }
  await recordAuditSafe(runtime.store, rootPath, {
    domain: "suite",
    action: "action.tasks.cancel",
    result: "ok",
    summary: `取消回归任务 ${taskId}（${cancelStatusNote(task.status)}）`,
    refs: {
      taskId,
      status: task.status,
      ...(actorHostId === null ? {} : { hostId: actorHostId })
    },
    actor,
    actorHostId,
    channel: "cli"
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, task }, null, 2));
    return 0;
  }
  io.log(`回归任务 ${taskId}：${cancelStatusNote(task.status)}（status=${task.status}）`);
  return 0;
}

async function suiteTaskCancelOnHost(
  scoped: ProjectStore,
  hostId: string,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  env: NodeJS.ProcessEnv
): Promise<number> {
  const taskId = flags.positional[2];
  const rawProject = flags.get("project");
  const rootPath = rawProject === null ? null : normalizeRootPath(rawProject);
  if (!taskId || rootPath === null || rootPath === "") {
    io.errorLog(
      "用法: suite task cancel <taskId> --host <id|hostname> --project <rootPath> [--note <text>]"
    );
    return 2;
  }
  if ((await scoped.getProjectByPath(rootPath)) === null) {
    const known = await knownRootPaths(scoped, hostId);
    io.errorLog(
      `未知项目：${rootPath}（主机 ${hostId} 已登记：${known.length > 0 ? known.join("、") : "无"}；请先在目标机接入项目）`
    );
    return 2;
  }
  const actor = actorFromEnv(env);
  const note = flags.get("note");
  const task = await scoped.cancelRegressionTask({
    rootPath,
    taskId,
    source: "panel",
    actor,
    actorHostId: null,
    note
  });
  if (!task) {
    io.errorLog(`未找到回归任务 ${taskId}`);
    return 2;
  }
  await recordAuditSafe(scoped, rootPath, {
    domain: "suite",
    action: "action.tasks.cancel",
    result: "ok",
    summary: `中心取消回归任务 ${taskId}（${cancelStatusNote(task.status)}）`,
    refs: { taskId, status: task.status, hostId },
    actor,
    actorHostId: null,
    channel: "cli"
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, hostId, task }, null, 2));
    return 0;
  }
  io.log(`回归任务 ${taskId}（host=${hostId}）：${cancelStatusNote(task.status)}（status=${task.status}）`);
  return 0;
}

async function suiteTaskRelease(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const taskId = flags.positional[2];
  if (!taskId) {
    io.errorLog("用法: suite task release <taskId> [--force]");
    return 2;
  }
  const rootPath = runtime.project.rootDir;
  const task = await runtime.store.getRegressionTask(rootPath, taskId);
  if (!task) {
    io.errorLog(`未找到回归任务 ${taskId}`);
    return 2;
  }
  if (task.status !== "claimed" && task.status !== "running") {
    io.errorLog(`任务 ${taskId} 状态为 ${task.status}，无需释放`);
    return 2;
  }
  if (task.claimedBy === null && !flags.bool("force")) {
    io.errorLog(`任务 ${taskId} 领取信息缺失（claimed_by 为空）；如需强制重置加 --force`);
    return 2;
  }
  if (task.claimedBy !== null && !flags.bool("force")) {
    const runners = await runtime.store.listRunners(rootPath);
    const holder = runners.find((runner) => runner.id === task.claimedBy);
    const online = holder
      ? isRunnerOnline(holder.lastSeenAt, Date.now(), runnerTtlFrom(process.env))
      : false;
    if (online) {
      io.errorLog(
        `任务 ${taskId} 由在线 runner「${holder?.name ?? task.claimedBy}」持有；如需强制重置加 --force`
      );
      return 2;
    }
  }
  let released: boolean;
  try {
    released = await runtime.store.releaseRegressionTask({
      rootPath,
      runnerId: task.claimedBy,
      taskId
    });
  } catch (error) {
    io.errorLog(`任务 ${taskId} 释放失败：${errorMessage(error)}`);
    return 2;
  }
  if (!released) {
    io.errorLog(`任务 ${taskId} 状态已变化（可能已完成回写），未释放`);
    return 2;
  }
  io.log(`任务 ${taskId} 已重置为待执行（清除领取）`);
  return 0;
}

async function suiteSchedule(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const action = flags.positional[1];
  if (action === "add") return await suiteScheduleAdd(runtime, flags, io);
  if (action === "list") return await suiteScheduleList(runtime, flags, io);
  if (action === "show") return await suiteScheduleShow(runtime, flags, io);
  if (action === "enable") return await suiteScheduleSetEnabled(runtime, flags, io, true);
  if (action === "disable") return await suiteScheduleSetEnabled(runtime, flags, io, false);
  if (action === "remove") return await suiteScheduleRemove(runtime, flags, io);
  io.errorLog("用法: suite schedule add|list|show|enable|disable|remove …（见 suite help）");
  return 2;
}

async function suiteScheduleAdd(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const refs = splitList(flags.list("ref"));
  if (refs.length === 0) {
    io.errorLog(
      "用法: suite schedule add --ref <featureKey> [--ref …] --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>（缺省＝首个 featureKey）]"
    );
    return 2;
  }
  const rootPath = runtime.project.rootDir;
  const sets = await runtime.store.listCaseSets(rootPath);
  const latest = latestFeatureRefs(sets);
  const missing = refs.filter((key) => !latest.has(key));
  if (missing.length > 0) {
    const available = [...latest.keys()].sort().join("、");
    io.errorLog(`未知 feature key：${missing.join("、")}（可用：${available || "无"}）`);
    return 2;
  }
  const rawPlatforms =
    flags.list("platform").length > 0 ? splitList(flags.list("platform")) : ["ios", "android"];
  const invalidPlatforms = rawPlatforms.filter(
    (platform) => platform !== "ios" && platform !== "android"
  );
  if (invalidPlatforms.length > 0) {
    io.errorLog(`非法 --platform：${invalidPlatforms.join("、")}（仅支持 ios/android）`);
    return 2;
  }
  const platforms = [...new Set(rawPlatforms)];
  const baselineRaw = flags.get("baseline");
  if (baselineRaw !== null && baselineRaw !== "latest" && baselineRaw !== "none") {
    io.errorLog(`非法 --baseline：${baselineRaw}（仅支持 latest/none）`);
    return 2;
  }
  const baseline = baselineRaw === "none" ? "none" : "latest";
  const everyRaw = flags.get("every");
  const everyMinutes = everyRaw === null ? null : parsePositiveInt(everyRaw);
  if (everyMinutes === null || everyMinutes < 5) {
    io.errorLog("用法: --every 需为 ≥5 的整数（分钟）");
    return 2;
  }
  const name = flags.get("name")?.trim() || refs[0]!;
  try {
    const schedule = await runtime.store.createSchedule({
      rootPath,
      name,
      featureKeys: refs,
      platforms,
      baseline,
      everyMinutes,
      createdBy: "cli"
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify({ ok: true, schedule }, null, 2));
      return 0;
    }
    io.log(
      `定时回归 ${schedule.id}（name=${schedule.name} · every=${schedule.everyMinutes}min · platforms=${schedule.platforms.join(",")} · baseline=${schedule.baseline}）`
    );
    for (const key of refs) {
      const hit = latest.get(key)!;
      io.log(`- ${hit.featureName}（${key}）· caseSet=${hit.caseSetId} · 用例 ${hit.caseCount}`);
    }
    return 0;
  } catch (error) {
    io.errorLog(`创建定时回归失败：${errorMessage(error)}`);
    return 2;
  }
}

async function suiteScheduleList(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const schedules = await runtime.store.listSchedules(runtime.project.rootDir, 50);
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, schedules }, null, 2));
    return 0;
  }
  if (schedules.length === 0) {
    io.log("暂无定时回归（suite schedule add 创建）");
    return 0;
  }
  for (const schedule of schedules) {
    io.log(
      `${schedule.id} · ${schedule.name} · every ${schedule.everyMinutes}min · ${
        schedule.enabled ? "enabled" : "disabled"
      } · 上次触发 ${schedule.lastFiredAt ?? "—"}${
        schedule.lastNote ? ` · ${schedule.lastNote}` : ""
      }`
    );
  }
  return 0;
}

async function suiteScheduleShow(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const id = flags.positional[2];
  if (!id) {
    io.errorLog("用法: suite schedule show <id>");
    return 2;
  }
  const schedule = await runtime.store.getSchedule(runtime.project.rootDir, id);
  if (!schedule) {
    io.errorLog(`未找到定时回归 ${id}`);
    return 2;
  }
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, schedule }, null, 2));
    return 0;
  }
  io.log(
    `${schedule.id} · ${schedule.name} · every ${schedule.everyMinutes}min · ${
      schedule.enabled ? "enabled" : "disabled"
    }`
  );
  io.log(`refs: ${schedule.featureKeys.join("、")}`);
  io.log(`platforms: ${schedule.platforms.join(",")} · baseline: ${schedule.baseline}`);
  io.log(`上次触发: ${schedule.lastFiredAt ?? "—"}${schedule.lastNote ? ` · ${schedule.lastNote}` : ""}`);
  return 0;
}

async function suiteScheduleSetEnabled(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void },
  enabled: boolean
): Promise<number> {
  const id = flags.positional[2];
  if (!id) {
    io.errorLog(`用法: suite schedule ${enabled ? "enable" : "disable"} <id>`);
    return 2;
  }
  const rootPath = runtime.project.rootDir;
  const schedule = await runtime.store.getSchedule(rootPath, id);
  if (!schedule) {
    io.errorLog(`未找到定时回归 ${id}`);
    return 2;
  }
  if (schedule.enabled === enabled) {
    io.log(`定时回归 ${id} 已是${enabled ? "启用" : "停用"}状态`);
    return 0;
  }
  const ok = await runtime.store.updateSchedule(rootPath, id, { enabled });
  if (!ok) {
    io.errorLog(`定时回归 ${id} 更新失败`);
    return 2;
  }
  io.log(`定时回归 ${id} 已${enabled ? "启用" : "停用"}`);
  return 0;
}

async function suiteScheduleRemove(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const id = flags.positional[2];
  if (!id) {
    io.errorLog("用法: suite schedule remove <id>");
    return 2;
  }
  const ok = await runtime.store.deleteSchedule(runtime.project.rootDir, id);
  if (!ok) {
    io.errorLog(`未找到定时回归 ${id}`);
    return 2;
  }
  io.log(`定时回归 ${id} 已删除`);
  return 0;
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function suiteRunnerCommand(
  runtime: Runtime,
  flags: ParsedFlags,
  io: SuiteIo,
  deps: SuiteCliDeps,
  buildRuntime: (projectDir: string | null) => Promise<CliRuntimeBundle>
): Promise<number> {
  const env = io.env ?? process.env;
  if (runtime.store.kind !== "postgres") {
    io.errorLog("runner 需要中心 PG（文件台账不支持多进程）；请配置 MOBILE_TESTING_DATABASE_URL");
    return 2;
  }
  const pollRaw = flags.get("poll-ms");
  const heartbeatRaw = flags.get("heartbeat-ms");
  const pollMs = pollRaw === null ? undefined : parsePositiveInt(pollRaw);
  const heartbeatMs = heartbeatRaw === null ? undefined : parsePositiveInt(heartbeatRaw);
  if ((pollRaw !== null && pollMs === null) || (heartbeatRaw !== null && heartbeatMs === null)) {
    io.errorLog("用法: --poll-ms/--heartbeat-ms 需为正整数");
    return 2;
  }
  const resolvedPollMs = pollMs ?? undefined;
  const resolvedHeartbeatMs = heartbeatMs ?? undefined;

  let artifactPort = 8_770;
  const envPort = Number((env.AOS_RUNNER_ARTIFACT_PORT ?? "").trim());
  if (Number.isInteger(envPort) && envPort >= 0) artifactPort = envPort;
  const portRaw = flags.get("artifact-port");
  if (portRaw !== null) {
    const parsed = Number(portRaw.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      io.errorLog("用法: --artifact-port 需为非负整数（0 关闭产物服务）");
      return 2;
    }
    artifactPort = parsed;
  }
  const artifactHost =
    flags.get("artifact-host")?.trim() || env.AOS_RUNNER_ARTIFACT_HOST?.trim() || "0.0.0.0";

  let artifactServer: RunnerArtifactServer | null = null;
  let artifactBaseUrl: string | null = null;
  if (artifactPort !== 0) {
    try {
      artifactServer = await startRunnerArtifactServer({
        projectDir: runtime.project.rootDir,
        host: artifactHost,
        port: artifactPort,
        env
      });
      artifactBaseUrl =
        env.AOS_RUNNER_ADVERTISE_URL?.trim() || `http://${os.hostname()}:${artifactServer.port}`;
      if (artifactHost === "0.0.0.0" || artifactHost === "::") {
        io.log(
          `[runner] 注意: 产物服务监听 ${artifactHost}（无鉴权只读；范围 .artemis 含 logs/crashes）——仅限受控内网`
        );
      }
    } catch (error) {
      io.errorLog(`产物服务启动失败（继续执行，不广播产物基址）：${errorMessage(error)}`);
      artifactServer = null;
      artifactBaseUrl = null;
    }
  }

  let stopRequested = false;
  const onSignal = (): void => {
    stopRequested = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const name = flags.get("name")?.trim() || os.hostname();
    const seam = deps.runner ?? {};
    return await runRunnerAgent({
      projectDir: flags.get("project"),
      name,
      pollMs: resolvedPollMs,
      heartbeatMs: resolvedHeartbeatMs,
      once: flags.bool("once"),
      shouldStop: seam.shouldStop ?? ((): boolean => stopRequested),
      artifactBaseUrl,
      env,
      buildRuntime: async () => ({ runtime, dispose: async (): Promise<void> => {} }),
      executeSuite:
        seam.executeSuite ??
        ((argv, options) =>
          runSuiteCommand(argv, {
            buildRuntime,
            log: io.log,
            errorLog: io.errorLog,
            env,
            runnerName: name,
            shouldAbort: options?.shouldAbort,
            leasesHeld: true
          })),
      collectInventory: seam.collectInventory,
      collectHostSnapshot: seam.collectHostSnapshot,
      io: { log: io.log, errorLog: io.errorLog },
      sleep: seam.sleep
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (artifactServer) await artifactServer.close();
  }
}

async function suiteTaskShow(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const id = flags.positional[2];
  if (!id) {
    io.errorLog("用法: suite task show <id>");
    return 2;
  }
  const task = await runtime.store.getRegressionTask(runtime.project.rootDir, id);
  if (!task) {
    io.errorLog(`未找到回归任务 ${id}`);
    return 2;
  }
  const sets = await runtime.store.listCaseSets(runtime.project.rootDir);
  const byId = new Map(sets.map((set) => [set.id, set]));
  const resolved = task.refs.map((ref) => {
    const set = byId.get(ref.caseSetId);
    const feature = set?.features.find((entry) => entry.key === ref.featureKey) ?? null;
    return {
      caseSetId: ref.caseSetId,
      featureKey: ref.featureKey,
      featureName: feature?.name ?? null,
      caseCount: feature?.caseCount ?? null,
      jsonPath: feature?.jsonPath ?? null,
      createdAt: set?.createdAt ?? null
    };
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify({ ok: true, task, resolved }, null, 2));
    return 0;
  }
  io.log(
    `回归任务 ${task.id} · ${task.status} · platforms ${task.platforms.join(",")} · baseline ${task.baseline}`
  );
  for (const entry of resolved) {
    io.log(
      `- ${entry.featureName ?? entry.featureKey} · caseSet=${entry.caseSetId} · 用例 ${entry.caseCount ?? "?"} · ${entry.jsonPath ?? "（份已清理）"} · ${entry.createdAt ?? ""}`
    );
  }
  if (task.runIds.length > 0) io.log(`运行: ${task.runIds.join("、")}`);
  return 0;
}

/** UI 契约：flows.json + 逐屏 .pen 的投影（不另建第二份提取管线）。 */
async function suiteUiContract(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  try {
    const out = flags.get("out");
    const built = buildUiContract(runtime, {
      ...(out !== null ? { outDir: path.resolve(runtime.project.rootDir, out) } : {}),
      ...(flags.bool("no-bounds")
        ? {}
        : { boundsProvider: (file: string) => readPenTextBounds(file) })
    });
    if (flags.bool("json")) {
      io.log(
        JSON.stringify(
          {
            ok: true,
            summary: built.contract.summary,
            counts: built.contract.counts,
            fingerprint: built.contract.source.fingerprint,
            jsonPath: built.jsonPath,
            markdownPath: built.markdownPath,
            screens: built.contract.screens.map((screen) => ({
              id: screen.id,
              name: screen.name,
              presentation: screen.presentation,
              ...(screen.parentScreenId === undefined
                ? {}
                : { parentScreenId: screen.parentScreenId }),
              status: screen.status
            }))
          },
          null,
          2
        )
      );
      return 0;
    }
    io.log(
      `UI 契约: 主屏 ${built.contract.counts?.screens ?? built.contract.screens.length} · 状态变体 ${built.contract.counts?.states ?? 0} · extracted ${built.contract.summary.extracted} / partial ${built.contract.summary.partial} / unverifiable ${built.contract.summary.unverifiable} / no-baseline ${built.contract.summary["no-baseline"]}`
    );
    io.log(`产物: ${built.jsonPath} · ${built.markdownPath}`);
    for (const warning of built.contract.warnings) io.log(`警告: ${warning}`);
    return 0;
  } catch (error) {
    io.errorLog(`UI 契约生成失败: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

async function suiteUiSemantics(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const action = flags.positional[1];
  if (action !== "init") {
    io.errorLog(`未知 ui-semantics 动作 "${action ?? ""}"（可用：init）`);
    return 2;
  }
  const rootDir = runtime.project.rootDir;
  const contractFlag = flags.get("contract");
  const outFlag = flags.get("out");
  const contractAbs =
    contractFlag === null
      ? defaultContractPath(runtime.configDirAbs)
      : path.resolve(rootDir, contractFlag);
  const outAbs =
    outFlag === null ? defaultSemanticsPath(runtime.configDirAbs) : path.resolve(rootDir, outFlag);
  const contractRef =
    contractFlag === null
      ? path.relative(rootDir, contractAbs)
      : path.isAbsolute(contractFlag)
        ? path.relative(rootDir, contractAbs)
        : contractFlag;
  try {
    const result = initUiSemantics({
      contractPath: contractAbs,
      outPath: outAbs,
      contractRef,
      force: flags.bool("force"),
      generatedAt: new Date().toISOString()
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      io.log(`UI 语义草稿: ${result.path} · 屏 ${result.screens} · draft（owner 确认前不会假绿）`);
      for (const warning of result.warnings) io.log(`警告: ${warning}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UiSemanticsInitError) {
      io.errorLog(error.message);
      return 2;
    }
    io.errorLog(`UI 语义草稿生成失败: ${errorMessage(error)}`);
    return 2;
  }
}

function resolveContractScreen(
  contract: UiContract,
  query: string
): { screen: UiScreenContract } | { error: string } {
  const normalized = query.trim().toLowerCase();
  const exact = contract.screens.filter((screen) => screen.id === query);
  if (exact.length === 1) return { screen: exact[0]! };
  if (exact.length > 1) return { error: `屏幕 "${query}" 匹配到多个 contract id` };
  const byId = contract.screens.filter((screen) => screen.id.toLowerCase() === normalized);
  if (byId.length === 1) return { screen: byId[0]! };
  if (byId.length > 1) return { error: `屏幕 "${query}" 匹配到多个 contract id` };
  const byName = contract.screens.filter(
    (screen) => typeof screen.name === "string" && screen.name.trim().toLowerCase() === normalized
  );
  if (byName.length === 1) return { screen: byName[0]! };
  if (byName.length > 1) return { error: `屏幕 "${query}" 匹配到多个 contract name` };
  return { error: `未知屏幕 "${query}"（contract 屏：${contract.screens.map((screen) => screen.id).join(", ")}）` };
}

async function suiteUiParity(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const rootDir = runtime.project.rootDir;
  const design = designDir(runtime.configDirAbs);
  const contractFlag = flags.get("contract");
  const semanticsFlag = flags.get("semantics");
  const baselineFlag = flags.get("baseline");
  const contractPath =
    contractFlag === null ? path.join(design, "ui-contract.json") : path.resolve(rootDir, contractFlag);
  const semanticsPath =
    semanticsFlag === null ? path.join(design, "ui-semantics.json") : path.resolve(rootDir, semanticsFlag);
  const baselinePath =
    baselineFlag === null ? path.join(design, "ui-parity-baseline.json") : path.resolve(rootDir, baselineFlag);

  let contract: UiContract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf-8")) as UiContract;
  } catch (error) {
    io.errorLog(`读取 ui-contract 失败: ${errorMessage(error)}`);
    return 2;
  }
  if (!contract || !Array.isArray(contract.screens)) {
    io.errorLog("ui-contract 格式错误：缺少 screens[]");
    return 2;
  }

  const semanticsLoaded = loadUiSemantics(runtime.configDirAbs, { path: semanticsPath });
  if (semanticsLoaded.errors.length > 0) {
    io.errorLog(`读取 ui-semantics 失败: ${semanticsLoaded.errors.join(" | ")}`);
    return 2;
  }
  if (semanticsLoaded.file === null) {
    io.errorLog(
      `缺少 ui-semantics：${semanticsPath}；先运行 "suite ui-semantics init" 并由 owner 填写 invariant/taxonomy`
    );
    return 2;
  }
  const contractIds = new Set(contract.screens.map((screen) => screen.id));
  for (const screen of semanticsLoaded.file.screens) {
    if (!contractIds.has(screen.screenId)) {
      io.errorLog(`semantics 死屏：${screen.screenId} 不在 contract 中`);
      return 2;
    }
  }
  const semanticsIds = new Set(semanticsLoaded.file.screens.map((screen) => screen.screenId));
  const missingSemantics = contract.screens.filter((screen) => !semanticsIds.has(screen.id));
  const warnings: string[] = [];
  if (missingSemantics.length > 0) {
    warnings.push(
      `contract 有 ${missingSemantics.length} 屏没有 semantics（会 insufficient-data）：${missingSemantics
        .slice(0, 10)
        .map((screen) => screen.id)
        .join("、")}${missingSemantics.length > 10 ? "…" : ""}`
    );
  }
  const contractFingerprint =
    contract && typeof contract.source?.fingerprint === "string" ? contract.source.fingerprint : null;
  const semanticsFingerprint = semanticsLoaded.file.source?.contractFingerprint ?? null;
  if (
    contractFingerprint !== null &&
    semanticsFingerprint !== null &&
    contractFingerprint !== semanticsFingerprint
  ) {
    warnings.push(
      `semantics-stale：source.contractFingerprint=${semanticsFingerprint} 与当前 contract ${contractFingerprint} 不一致`
    );
  }

  const traceId = flags.get("trace") ?? undefined;
  const snapshotPath = flags.get("snapshot") ?? undefined;
  const visualText = flags.get("visual-text") ?? undefined;
  const stepRaw = flags.get("step");
  const stepNumber = stepRaw === null ? undefined : intOrNull(stepRaw);
  if (traceId !== undefined && snapshotPath !== undefined) {
    io.errorLog("--trace 与 --snapshot 二选一");
    return 2;
  }
  if (traceId !== undefined && (stepNumber === undefined || stepNumber === null || stepNumber <= 0)) {
    io.errorLog("--trace 需要正整数 --step <n>");
    return 2;
  }
  if (traceId === undefined && snapshotPath === undefined) {
    io.errorLog("需要 --trace <traceId> --step <n> 或 --snapshot <json>");
    return 2;
  }

  let snapshot: ReturnType<typeof loadUiRuntimeSnapshot>;
  try {
    snapshot = loadUiRuntimeSnapshot(runtime, {
      ...(traceId !== undefined ? { traceId } : {}),
      ...(stepNumber !== undefined && stepNumber !== null ? { stepNumber } : {}),
      ...(snapshotPath !== undefined ? { snapshotPath } : {}),
      ...(visualText !== undefined ? { visualTextPath: visualText } : {})
    });
  } catch (error) {
    io.errorLog(`读取运行时快照失败: ${errorMessage(error)}`);
    return 2;
  }

  let screenQuery =
    flags.get("screen") ??
    snapshot.screen ??
    (semanticsLoaded.file.screens.length === 1 ? semanticsLoaded.file.screens[0]!.screenId : null) ??
    (contract.screens.length === 1 ? contract.screens[0]!.id : null);
  if (screenQuery === null && snapshot.screenText !== undefined) {
    const text = snapshot.screenText.toLowerCase();
    const candidates = contract.screens.filter((screen) => {
      const name = screen.name.trim().toLowerCase();
      const base = name.split(/[_\s]/u)[0] ?? name;
      return name !== "" && (text.includes(name) || (base.length >= 2 && text.includes(base)));
    });
    if (candidates.length === 1) screenQuery = candidates[0]!.id;
  }
  if (screenQuery === null) {
    io.errorLog("无法确定屏幕；请用 --screen <id|name> 指定（trace screen 摘要无法唯一匹配 contract 屏名）");
    return 2;
  }
  const resolved = resolveContractScreen(contract, screenQuery);
  if ("error" in resolved) {
    io.errorLog(resolved.error);
    return 2;
  }
  const screen = resolved.screen;
  const semanticsScreen =
    semanticsForScreen(semanticsLoaded.file, screen.id) ?? semanticsForScreen(semanticsLoaded.file, screen.name);
  if (semanticsScreen === null) {
    warnings.push(`contract 屏 ${screen.id} 没有 semantics；该屏会 insufficient-data`);
  }
  const regionId = flags.get("region") ?? undefined;
  if (regionId !== undefined && semanticsScreen !== null && !semanticsScreen.regions.some((region) => region.id === regionId)) {
    io.errorLog(`未知 region "${regionId}"（可用：${semanticsScreen.regions.map((region) => region.id).join(", ")}）`);
    return 2;
  }

  const report = auditUiParity({
    screen,
    semantics: semanticsScreen,
    ...(semanticsLoaded.file.draft === true ? { draft: true } : {}),
    runtime: {
      ...(snapshot.screen !== undefined ? { screen: snapshot.screen } : {}),
      ...(snapshot.viewport !== undefined ? { viewport: snapshot.viewport } : {}),
      texts: snapshot.texts,
      ...(snapshot.assets !== undefined ? { assets: snapshot.assets } : {}),
      space: snapshot.space,
      ...(snapshot.source === "trace" ? { coverageComplete: true } : {}),
      ...(regionId !== undefined ? { regionId } : {})
    }
  });

  let findings = report.findings;
  let baselined = 0;
  const explicitBaseline = baselineFlag !== null;
  const baselineExists = fs.existsSync(baselinePath);
  const updateBaseline = flags.bool("update-baseline");
  let baseline = null;
  if (explicitBaseline && !(updateBaseline && !baselineExists)) {
    const loadedBaseline = loadUiParityBaseline(baselinePath);
    if (loadedBaseline.errors.length > 0) {
      io.errorLog(`读取 parity baseline 失败: ${loadedBaseline.errors.join(" | ")}`);
      return 2;
    }
    baseline = loadedBaseline.file;
  }
  if (updateBaseline) {
    const entries: UiParityBaselineEntry[] = report.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => ({
        tool: "ui-parity",
        screenId: screen.id,
        kind: finding.kind,
        text: finding.designText ?? finding.text,
        ...(finding.role !== undefined ? { role: finding.role } : {})
      }));
    try {
      writeUiParityBaseline(baselinePath, entries);
    } catch (error) {
      io.errorLog(`写入 parity baseline 失败: ${errorMessage(error)}`);
      return 2;
    }
    baseline = null;
  } else if (baseline !== null) {
    const partition = partitionByBaseline(report.findings, baseline, {
      screenId: screen.id,
      tool: "ui-parity"
    });
    findings = [...partition.fresh, ...partition.baselined];
    baselined = partition.baselined.length;
  }

  const baselineCovers =
    baseline !== null &&
    findings.length > 0 &&
    findings.every((finding) => finding.baselined === true || finding.severity === "info") &&
    report.verdict !== "no-invariants" &&
    report.verdict !== "insufficient-data";
  const freshBlocking = findings.filter(
    (finding) => finding.baselined !== true && finding.severity === "error"
  ).length;
  const coverageIncomplete = report.counts.unverified + report.counts.offscreen > 0;
  const blockingVerdict =
    report.verdict === "no-invariants" ||
    report.verdict === "truncated-labels" ||
    report.verdict === "ia-mismatch" ||
    report.verdict === "insufficient-coverage" ||
    report.verdict === "insufficient-data";
  const exitCode =
    report.verdict === "insufficient-data"
      ? 2
      : blockingVerdict && !(baselineCovers && freshBlocking === 0 && !coverageIncomplete)
        ? 1
        : 0;

  if (flags.bool("json")) {
    io.log(
      JSON.stringify(
        {
          ok: exitCode === 0,
          verdict: report.verdict,
          screenId: report.screenId,
          counts: report.counts,
          findings,
          warnings: [...new Set([...report.warnings, ...warnings])],
          snapshot: {
            source: snapshot.source,
            space: snapshot.space,
            step: snapshot.step ?? null,
            viewport: snapshot.viewport ?? null
          },
          baseline: {
            path: baselinePath,
            baselined,
            fresh: findings.filter((finding) => finding.baselined !== true).length
          }
        },
        null,
        2
      )
    );
  } else {
    io.log(
      `UI 一致性: ${screen.id} · ${report.verdict} · invariant ${report.counts.matched}/${report.counts.invariant} · visible ${report.counts.visible} · truncated ${report.counts.truncated} · unverified ${report.counts.unverified} · offscreen ${report.counts.offscreen} · taxonomy ${report.counts.taxonomyMatched}/${report.counts.taxonomyExpected} · assets ${report.counts.assetsPresent}/${report.counts.assetsExpected} · baselined ${baselined}`
    );
    for (const warning of new Set([...report.warnings, ...warnings])) io.log(`警告: ${warning}`);
    for (const finding of findings) {
      const suffix = [
        finding.role ? `role=${finding.role}` : null,
        finding.designText ? `design=${finding.designText}` : null,
        finding.runtimeText ? `runtime=${finding.runtimeText}` : null,
        finding.baselined ? "baselined" : null
      ]
        .filter((entry): entry is string => entry !== null)
        .join(" ");
      io.log(`- [${finding.severity}] ${finding.kind} ${finding.text}${suffix ? `（${suffix}）` : ""}`);
    }
    if (updateBaseline) io.log(`baseline 已更新: ${baselinePath}`);
  }
  return exitCode;
}

async function suiteUiLint(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  try {
    const rootDir = runtime.project.rootDir;
    const contract = flags.get("contract");
    const allowlist = flags.get("allowlist");
    const screenMap = flags.get("screen-map");
    const maxTotalRaw = flags.get("max-total-bytes");
    const maxTotalBytes = maxTotalRaw === null ? null : intOrNull(maxTotalRaw);
    if (maxTotalRaw !== null && (maxTotalBytes === null || maxTotalBytes <= 0)) {
      io.errorLog("--max-total-bytes 需要正整数");
      return 2;
    }
    const expiryRaw = flags.get("expiry-warn-days");
    const expiryWarnDays = expiryRaw === null ? 7 : intOrNull(expiryRaw);
    if (expiryWarnDays === null || expiryWarnDays < 0) {
      io.errorLog("--expiry-warn-days 需要非负整数");
      return 2;
    }
    const report = runUiLint({
      rootDir,
      contractPath: path.resolve(
        rootDir,
        contract ?? path.join(designDir(runtime.configDirAbs), "ui-contract.json")
      ),
      allowlistPath: path.resolve(
        rootDir,
        allowlist ?? path.join(designDir(runtime.configDirAbs), "ui-lint-allowlist.json")
      ),
      screenMapPath: path.resolve(
        rootDir,
        screenMap ?? path.join(designDir(runtime.configDirAbs), "screen-map.json")
      ),
      ...(maxTotalBytes === null ? {} : { maxTotalBytes }),
      expiryWarnDays,
      ...(flags.bool("changed") ? { changed: true } : {}),
      ...(flags.bool("require-complete") ? { requireComplete: true } : {}),
      ...(flags.bool("fail-on-expiring") ? { failOnExpiring: true } : {}),
      ...(flags.bool("per-screen") ? { perScreen: true } : {}),
      ...(flags.bool("require-mapping") ? { requireMapping: true } : {}),
      ...(flags.bool("fail-on-stale-contract") ? { failOnStaleContract: true } : {})
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    const ruleLabel = (rule: string): string =>
      rule === "radius"
        ? "圆角"
        : rule === "color"
          ? "颜色"
          : rule === "font-size"
            ? "字号"
            : rule === "font-weight"
              ? "字重"
              : "字体族";
    const allowedText = (allowed: Array<number | string>): string => {
      const shown = allowed.slice(0, 10).join("/");
      return allowed.length > 10 ? `${shown}…（共 ${allowed.length}）` : shown;
    };
    io.log(
      `UI lint: 契约 ${report.contract.screens} 屏（未完成 ${report.contract.incomplete.length}）· 指纹 ${report.contract.fingerprintStatus} · 允许 圆角 ${report.contract.radii.join(", ") || "—"} / 颜色 ${report.contract.colors.length} / 字号 ${report.contract.fontSizes.join(", ") || "—"} / 字重 ${report.contract.fontWeights.join(", ") || "—"} / 字体族 ${report.contract.fontFamilies.length} · 扫描 ${report.scanned.files} 文件 · 命中 ${report.findings.length}（allowlist ${report.allowlisted}）· allowlist ${report.allowlist.entries} 条（即将到期 ${report.allowlist.expiring.length}）`
    );
    io.log(
      `逐屏映射: screen-map ${report.mapping.screenMapPath} · 屏 ${report.mapping.screens.mapped}/${report.mapping.screens.total} · 文件逐屏可用 ${report.mapping.files.scoped} / 显式 ${report.mapping.files.explicit} / 启发式 ${report.mapping.files.heuristic} / 全局回退 ${report.mapping.files.globalFallback}${flags.bool("per-screen") ? " · per-screen 已启用" : ""}`
    );
    for (const finding of report.findings) {
      const suffix = finding.allowlisted
        ? ` [allowlist ${finding.allowlist?.owner ?? ""}：${finding.allowlist?.reason ?? ""}]`
        : "";
      const scope =
        finding.scope === "screen"
          ? `逐屏 ${(finding.screens ?? []).join("/")}；`
          : "";
      io.log(
        `  ${finding.file}:${finding.line}:${finding.column} ${finding.stack} ${ruleLabel(finding.rule)} ${finding.value}（${scope}允许 ${allowedText(finding.allowed)}）${suffix}`
      );
      if (finding.snippet !== "") io.log(`    ${finding.snippet}`);
    }
    for (const warning of report.warnings) io.log(`警告: ${warning}`);
    if (report.ok) {
      io.log(
        report.findings.length === 0
          ? "通过：未发现未登记字面量。"
          : "通过：未登记字面量均在 allowlist 内。"
      );
      return 0;
    }
    const unregistered = report.findings.filter((finding) => !finding.allowlisted);
    if (unregistered.length > 0) {
      const counts = {
        radius: 0,
        color: 0,
        "font-size": 0,
        "font-weight": 0,
        "font-family": 0
      };
      for (const finding of unregistered) counts[finding.rule] += 1;
      io.errorLog(
        `未登记字面量 ${unregistered.length} 处（圆角 ${counts.radius} / 颜色 ${counts.color} / 字号 ${counts["font-size"]} / 字重 ${counts["font-weight"]} / 字体族 ${counts["font-family"]}）；请改用契约 token 或登记 ui-lint-allowlist.json（rule?/owner/reason/expiresAt）。`
      );
    }
    if (report.contract.incomplete.length > 0) {
      io.errorLog(
        `契约未完成 ${report.contract.incomplete.length} 屏（no-baseline/partial/unverifiable/unknown）；先补设计或契约，或去掉 --require-complete。`
      );
    }
    if (flags.bool("require-mapping")) {
      const missing = report.mapping.screens.unmapped.filter(
        (screen) => screen.status === "extracted"
      );
      if (missing.length > 0) {
        io.errorLog(
          `--require-mapping：${missing.length} 个 extracted 屏缺少高置信显式映射（${missing
            .map((screen) => screen.name || screen.id)
            .join("、")}）；请在 screen-map.json 补 code.file/component，或去掉该开关。`
        );
      }
    }
    if (
      flags.bool("fail-on-stale-contract") &&
      report.contract.fingerprintStatus !== "current"
    ) {
      io.errorLog(
        `--fail-on-stale-contract：契约指纹 ${report.contract.fingerprintStatus}（契约 ${report.contract.fingerprint?.slice(0, 12) ?? "—"}…，当前 ${report.contract.fingerprintNow?.slice(0, 12) ?? "—"}…）；请重新运行 suite ui-contract 或去掉该开关。`
      );
    }
    if (flags.bool("fail-on-expiring") && report.allowlist.expiring.length > 0) {
      io.errorLog(
        `allowlist 有 ${report.allowlist.expiring.length} 条将在 ${expiryWarnDays} 天内到期（--fail-on-expiring）；请续期或清理。`
      );
    }
    return 1;
  } catch (error) {
    io.errorLog(`UI lint 失败: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

async function suiteTextWeightCalibrate(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const manifest = flags.get("manifest");
  if (manifest === null) {
    io.errorLog("字重校准需要 --manifest <json>");
    return 2;
  }
  const out = flags.get("out");
  const report = await runTextWeightCalibration({
    manifestPath: path.resolve(runtime.project.rootDir, manifest),
    outputDir: out
      ? path.resolve(runtime.project.rootDir, out)
      : path.join(designDir(runtime.configDirAbs), "reports"),
    save: !flags.bool("no-save"),
    strict: flags.bool("strict")
  });
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : report.total === 0 ? 2 : 1;
  }
  io.log(
    `字重校准: 共 ${report.total} 对 · labeled ${report.labeled} · checked ${report.checked} · unverified ${report.unverified} · 高置信误报 ${report.highConfidenceMismatches.length}（false-heavier ${report.highConfidenceFalseHeavier}）· labeled 不一致 ${report.labeledMismatches}`
  );
  for (const [expected, counts] of Object.entries(report.confusion)) {
    io.log(
      `  expected ${expected}: lighter ${counts.lighter ?? 0} / similar ${counts.similar ?? 0} / heavier ${counts.heavier ?? 0} / unverified ${counts.unverified ?? 0}`
    );
  }
  for (const stats of report.deltaStats) {
    io.log(
      `  delta ${stats.expected}: n=${stats.count} mean=${stats.mean} sd=${stats.stddev} min=${stats.min} max=${stats.max}`
    );
  }
  if (report.thresholdHint.separated !== null) {
    io.log(
      `  阈值建议: min(heavier)=${report.thresholdHint.minHeavierDelta ?? "—"} · max(non-heavier)=${report.thresholdHint.maxNonHeavierDelta ?? "—"} · separated=${report.thresholdHint.separated}${report.thresholdHint.suggestedHeavierDelta !== null ? ` · suggested=${report.thresholdHint.suggestedHeavierDelta}` : ""}`
    );
  }
  for (const mismatch of report.highConfidenceMismatches) {
    io.errorLog(
      `高置信不一致: ${mismatch.name} expected=${mismatch.expected} actual=${mismatch.actual} delta=${mismatch.delta ?? "—"} conf=${mismatch.confidence}`
    );
  }
  for (const error of report.errors) io.errorLog(`错误: ${error}`);
  if (report.saved) io.log(`报告: ${report.saved}`);
  return report.ok ? 0 : report.total === 0 ? 2 : 1;
}

function suiteParity(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): number {
  const a = flags.get("a");
  const b = flags.get("b");
  if (a === null || b === null) {
    io.errorLog("parity 需要 --a <tests.json> 与 --b <tests.json>");
    return 2;
  }
  try {
    const report = compareParityDocs(
      readParityDoc(path.resolve(runtime.project.rootDir, a)),
      readParityDoc(path.resolve(runtime.project.rootDir, b))
    );
    if (flags.bool("json")) {
      io.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    io.log(
      `Parity: A ${report.a.cases} 条 · B ${report.b.cases} 条 · 差异 ${report.diffs.length}`
    );
    for (const diff of report.diffs) {
      if (diff.kind === "field") {
        io.log(`  [${diff.field}] ${diff.message}`);
        io.log(`    A=${JSON.stringify(diff.a)}`);
        io.log(`    B=${JSON.stringify(diff.b)}`);
      } else {
        io.log(`  [${diff.kind}] ${diff.message}`);
      }
    }
    for (const warning of report.warnings) io.log(`警告: ${warning}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    io.errorLog(`parity 失败: ${errorMessage(error)}`);
    return 2;
  }
}

/** 回填扫描（只读产物 → 幂等重建登记）：PG 守卫 + 下界 + 报告输出。 */
async function suiteBackfill(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  if (runtime.store.kind === "memory") {
    io.errorLog("backfill 需要持久台账（当前为会话内存）；请配置 MOBILE_TESTING_DATABASE_URL 或使用项目文件台账");
    return 2;
  }
  const sinceRaw = flags.get("since");
  if (sinceRaw !== null && Number.isNaN(Date.parse(sinceRaw))) {
    io.errorLog("--since 非法（须为可解析的 ISO 时间）");
    return 2;
  }
  try {
    const report = await runBackfill(runtime, {
      dryRun: flags.bool("dry-run"),
      since: sinceRaw ?? undefined
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify(report, null, 2));
      return 0;
    }
    io.log(
      `回填: 扫描 runs ${report.scanned.runs} · caseSets ${report.scanned.caseSets} · ` +
        `登记 runs ${report.registered.runs} · caseSets ${report.registered.caseSets} · ` +
        `skipped ${report.skipped} · invalid ${report.invalid} · beforeSince ${report.beforeSince}`
    );
    if (report.dryRun) {
      io.log(
        `将登记: runs ${report.wouldRegister.runs} · caseSets ${report.wouldRegister.caseSets}（dry-run 未写库）`
      );
    }
    for (const warning of report.warnings) io.log(`警告: ${warning}`);
    return 0;
  } catch (error) {
    io.errorLog(`backfill 失败: ${errorMessage(error)}`);
    return 1;
  }
}

export async function runSuiteCommand(argv: string[], deps: SuiteCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));
  const flags = parseFlags(argv);
  if (argv.includes("-h") || argv.includes("--help")) {
    printSuiteUsage(log);
    return 0;
  }
  const sub = flags.positional[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSuiteUsage(log);
    return sub ? 0 : 2;
  }
  if (
    !["run", "check", "calibrate", "loop", "flake", "retention", "evidence", "api-errors", "baseline", "report", "feedback", "reconcile", "task", "queue", "runner", "schedule", "backfill", "ui-contract", "ui-semantics", "ui-parity", "ui-lint", "parity", "text-weight-calibrate"].includes(sub)
  ) {
    errorLog(`未知 suite 子命令 "${sub}"`);
    printSuiteUsage(log);
    return 2;
  }

  const buildRuntime = deps.buildRuntime ?? defaultBuildRuntime;
  if (sub === "queue" && flags.has("host")) {
    const hostReference = flags.get("host");
    if (hostReference === null || hostReference.trim() === "") {
      errorLog("--host 需要主机 id 或 hostname（用 host list 查看已登记主机）");
      return 2;
    }
    return await suiteQueueOnCenterHost(
      hostReference,
      flags,
      { log, errorLog },
      deps.center ?? {},
      deps.env ?? process.env
    );
  }
  if (sub === "task" && flags.has("host")) {
    const hostReference = flags.get("host");
    if (hostReference === null || hostReference.trim() === "") {
      errorLog("--host 需要主机 id 或 hostname（用 host list 查看已登记主机）");
      return 2;
    }
    return await suiteTaskOnCenterHost(
      hostReference,
      flags,
      { log, errorLog },
      deps.center ?? {},
      deps.env ?? process.env
    );
  }
  let built: Awaited<ReturnType<typeof defaultBuildRuntime>> | null = null;
  try {
    built = await buildRuntime(flags.get("project"));
    if (sub === "run") {
      return await suiteRun(
        built.runtime,
        flags,
        { log, errorLog, env: deps.env ?? process.env, runnerName: deps.runnerName ?? null, shouldAbort: deps.shouldAbort, leasesHeld: deps.leasesHeld === true, leaseTimers: deps.leaseTimers },
        deps.logcatCollector,
        deps.iosLogCollector
      );
    }
    if (sub === "check") return await suiteCheck(built.runtime, flags, { log, errorLog });
    if (sub === "calibrate") {
      return await suiteCalibrate(built.runtime, flags, { log, errorLog }, { xcresultReader: deps.xcresultReader });
    }
    if (sub === "loop") {
      return await suiteLoop(built.runtime, flags, { log, errorLog, env: deps.env ?? process.env, runnerName: deps.runnerName ?? null }, {
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
    if (sub === "reconcile") return await suiteReconcile(built.runtime, flags, { log, errorLog });
    if (sub === "task") return await suiteTask(built.runtime, flags, { log, errorLog }, deps.env ?? process.env);
    if (sub === "queue") {
      return await suiteQueue(built.runtime, flags, { log, errorLog }, deps.env ?? process.env);
    }
    if (sub === "schedule") return await suiteSchedule(built.runtime, flags, { log, errorLog });
    if (sub === "backfill") return await suiteBackfill(built.runtime, flags, { log, errorLog });
    if (sub === "ui-contract") return await suiteUiContract(built.runtime, flags, { log, errorLog });
    if (sub === "ui-semantics") return await suiteUiSemantics(built.runtime, flags, { log, errorLog });
    if (sub === "ui-parity") return await suiteUiParity(built.runtime, flags, { log, errorLog });
    if (sub === "ui-lint") return await suiteUiLint(built.runtime, flags, { log, errorLog });
    if (sub === "text-weight-calibrate") {
      return await suiteTextWeightCalibrate(built.runtime, flags, { log, errorLog });
    }
    if (sub === "parity") return suiteParity(built.runtime, flags, { log, errorLog });
    if (sub === "runner") {
      return await suiteRunnerCommand(
        built.runtime,
        flags,
        { log, errorLog, env: deps.env ?? process.env },
        deps,
        buildRuntime
      );
    }
    return await suiteFeedback(built.runtime, flags, { log, errorLog });
  } catch (error) {
    if (isMigrationIncompleteError(error)) {
      errorLog(errorMessage(error));
      return 2;
    }
    errorLog(`suite ${sub} 失败: ${errorMessage(error)}`);
    return 1;
  } finally {
    if (built) await built.dispose();
  }
}
