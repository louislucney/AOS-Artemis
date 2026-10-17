import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { traceEvidence } from "./artemis/evidence.js";
import {
  API_ERRORS_ARTIFACT,
  loadApiErrorCatalog,
  matchApiErrors
} from "./artemis/api-errors.js";
import { defaultBuildRuntime, type CliRuntimeBundle } from "./cli-runtime.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "./device/logcat.js";
import { classifyIosSerial } from "./device/ios.js";
import { latestFeatureRefs, type ResolvedTaskRef } from "./tasks/feature-refs.js";
import { IosLogCollector, type IosLogWindowRequest } from "./device/ios-log.js";
import { compareBaseline, saveBaseline, type BaselineRequest } from "./diff/baseline.js";
import { buildGenerationFeedback } from "./figma/generation-feedback.js";
import type { VerdictExits } from "./tasks/verdict-exits.js";
import { designDir, readTestsDocument } from "./figma/design-store.js";
import { buildCalibration, parseTestResults, type CalibrationReport } from "./figma/calibration.js";
import { buildFlakeReport, renderFlakeMarkdown } from "./figma/flake.js";
import { buildRetentionReport, collectRetentionEntries, formatBytes } from "./figma/retention.js";
import {
  artifactGateIssue,
  coverageGateIssue,
  dataPolicyGateIssue,
  isImportedTestsFile
} from "./figma/gate.js";
import { preflightGeneratedTests } from "./figma/preflight.js";
import {
  loadReconciliation,
  reconciliationFilePath,
  reconciliationListing,
  reviewEdge,
  saveReconciliation
} from "./figma/reconciliation.js";
import { buildRunReport, buildTaskRunReport } from "./figma/run-report.js";
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
import type { TaskStatRecord } from "./db/types.js";
import {
  runGeneratedTests,
  type SuiteRunOptions,
  type SuiteRunReport
} from "./figma/suite-runner.js";
import { Runtime } from "./runtime.js";
import { runRunnerAgent } from "./runner/agent.js";
import { startRunnerArtifactServer, type RunnerArtifactServer } from "./runner/artifact-server.js";
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
    executeSuite?: (argv: string[]) => Promise<number>;
    collectInventory?: () => Promise<RunnerInventory>;
    sleep?: (ms: number) => Promise<void>;
    shouldStop?: () => boolean;
  };
  /** 登记透传：suite run 的 suite_runs.runner（缺省 hostname）。 */
  runnerName?: string;
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
    pollTimeoutMs: intOrNull(flags.get("poll-timeout")) ?? undefined,
    apiErrors: !flags.bool("no-api-errors"),
    failOnApiErrors: flags.get("fail-on") === "api-error",
    logcatCollector,
    iosLogCollector
  };
}

type SuiteIo = {
  log: (line: string) => void;
  errorLog: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  runnerName?: string | null;
};

export function printSuiteUsage(log: (line: string) => void): void {
  log(`aos-mcp suite — 测试闭环（生成用例的确定性执行与取证）

Usage:
  aos-mcp suite run [options]        执行 tests.json：每例复位→提交→轮询→台账→逐例分类（批次清单自动落盘）
  aos-mcp suite check [options]      静态检查：覆盖 × 三件套（tests.xlsx）× 真实数据约束（不连设备，CI 友好）
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
  aos-mcp suite feedback [options]   生成改进建议与出口清单（只读）
  aos-mcp suite reconcile list|confirm|reject [options]
                                     对账资产审阅：列举差异并人工确认（human-confirmed）或驳回（rejected）
  aos-mcp suite task create|list|show|release [options]
                                     回归任务：create --ref <featureKey>… [--platform ios|android]… [--baseline latest|none]（引用取该功能最新份）
                                     release <taskId> [--force]：管理侧救济，claimed/running → 待执行（默认要求执行机离线）
  aos-mcp suite runner [options]     项目机常驻 runner：心跳/自动领取执行/产物只读服务（--once 单轮冒烟）
  aos-mcp suite schedule add|list|show|enable|disable|remove [options]
                                     定时回归：add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>（缺省＝首个 featureKey）]
  aos-mcp suite backfill [options]   从磁盘产物幂等重建登记（runs + case-sets；--dry-run 只读不写库）

common: [--project <dir>] [--json]
run:    [--tests <path>] [--max <n>] [--stop-on-failure] [--device <serial>]
        [--app <package>] [--model Flash|Pro] [--poll-timeout <ms>]
        [--no-api-errors] [--fail-on api-error] [--fail-on-uncovered] [--retry <n>] [--no-quarantine] [--strict] [--no-save]
        [--task <id>（回归任务：与 --tests 互斥；--device 可重复，按端展开子运行）]
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
report: [--limit <n>] [--case <id>]... [--out <dir>] [--stamp <s>] [--no-save] [--no-sync] [--task <id>（回归任务报告：命名 <时间>_<功能>_回归.xlsx）]
feedback: [--limit <n>] [--min-failures <n>]
reconcile: list|confirm|reject [--from <screen> --to <screen>] [--reviewer <name>] [--note <text>]
runner: [--name <n>] [--poll-ms <n>] [--heartbeat-ms <n>] [--artifact-port <n>（0 关闭）] [--artifact-host <h>] [--once]
        （需要中心 PG；AOS_RUNNER_* 环境变量可配，AOS_RUNNER_DEVICES 显式覆盖设备清单）
schedule: add --ref <featureKey>… --every <minutes≥5> [--platform ios|android]… [--baseline latest|none] [--name <n>]；list/show/enable/disable/remove <id>
backfill: [--dry-run] [--since <ISO>] [--project <dir>] [--json]

exit codes: 0 成功/全通过；1 用例失败或证据缺失；2 参数/执行错误或 --fail-on 命中（基线回归/未处理 API 错误/流程未覆盖或无法校验）
错误码注册表: .artemis/design/error-codes.json（未配置时 api-errors 跳过并如实标注 degraded）`);
}

async function suiteRunTask(
  runtime: Runtime,
  flags: ParsedFlags,
  io: SuiteIo,
  taskId: string,
  logcatCollector?: LogcatCollector,
  iosLogCollector?: IosLogCollectorFn
): Promise<number> {
  const jsonMode = flags.bool("json");
  const say = jsonMode ? (_line: string): void => {} : (line: string): void => io.log(line);
  if (flags.get("tests") !== null) {
    io.errorLog("--task 与 --tests 不能同用（task 引用份存档，--tests 指定单一用例文件）");
    return 2;
  }
  const task = await runtime.store.getRegressionTask(runtime.project.rootDir, taskId);
  if (!task) {
    io.errorLog(`未找到回归任务 ${taskId}`);
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

  const sets = await runtime.store.listCaseSets(runtime.project.rootDir, 50);
  const setById = new Map(sets.map((set) => [set.id, set]));
  const resolvedRefs: ResolvedTaskRef[] = [];
  for (const ref of task.refs) {
    const feature = setById
      .get(ref.caseSetId)
      ?.features.find((entry) => entry.key === ref.featureKey);
    if (!feature) {
      say(`注意: 引用份已不可用（跳过）：caseSet=${ref.caseSetId} feature=${ref.featureKey}`);
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
    io.errorLog(`回归任务 ${taskId} 的引用份均不可用（先重新生成/登记用例集）`);
    return 2;
  }

  const devicePlatforms = new Set<string>(devices.map((device) => platformOf(device)));
  for (const platform of task.platforms) {
    if (!devicePlatforms.has(platform)) {
      say(`注意: 目标端 ${platform} 无设备（该端未执行）`);
    }
  }

  const baseOptions = suiteRunOptions(flags, logcatCollector, iosLogCollector);
  const quarantine = loadSuiteQuarantine(runtime, flags.bool("no-quarantine"));
  baseOptions.quarantinedCaseIds = quarantine.ids;

  try {
    await runtime.store.updateRegressionTask(runtime.project.rootDir, task.id, {
      status: "running"
    });
  } catch (error) {
    logWarn(`任务状态回写失败: ${errorMessage(error)}`);
    say("注意: 任务状态回写失败（运行结果不受影响）");
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
  const runIds: string[] = [];
  const seenByDevice = new Map<string, Set<string>>();
  const platformCases = new Map<string, CompareCaseInput[]>();
  let anyFailure = false;
  let anyExecError = false;
  let anyExecuted = false;

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
        caseIds
      });
      anyExecuted = true;
      const quarantinedFailures = report.cases.filter(
        (entry) => entry.quarantined === true && entry.status !== "passed"
      ).length;
      const exitCode = !report.ok ? 2 : report.failed - quarantinedFailures === 0 ? 0 : 1;
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
          (runId ? ` · run ${runId}` : " · 登记降级")
      );
    }
  }

  const finalStatus: "completed" | "partial" | "failed" = !anyExecuted
    ? "failed"
    : anyFailure || anyExecError
      ? "partial"
      : "completed";
  try {
    await runtime.store.updateRegressionTask(runtime.project.rootDir, task.id, {
      status: finalStatus,
      runIds
    });
  } catch (error) {
    logWarn(`任务状态回写失败: ${errorMessage(error)}`);
    say("注意: 任务状态回写失败（运行结果不受影响）");
  }

  const deltas = crossPlatformDeltas(
    [...platformCases.entries()].map(([platform, cases]) => ({ platform, cases }))
  );
  const totalPassed = subRuns.reduce((sum, entry) => sum + entry.passed, 0);
  const totalCases = subRuns.reduce((sum, entry) => sum + entry.total, 0);
  const exitCode = !anyExecuted ? 2 : anyExecError ? 2 : anyFailure ? 1 : 0;
  if (jsonMode) {
    io.log(
      JSON.stringify(
        {
          ok: exitCode === 0,
          taskId: task.id,
          status: finalStatus,
          runIds,
          subRuns,
          crossPlatform: deltas
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
      `回归任务 ${task.id}: ${finalStatus} · 子运行 ${subRuns.length} · pass ${totalPassed}/${totalCases}`
    );
  }
  return exitCode;
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
    return await suiteRunTask(runtime, flags, io, taskId, logcatCollector, iosLogCollector);
  }
  const runOptions = suiteRunOptions(flags, logcatCollector, iosLogCollector);
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
          ? coverageGateIssue(report.preflight, { strict: flags.bool("strict") })
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
  if (flags.bool("json")) {
    io.log(JSON.stringify(report, null, 2));
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
  const imported = isImportedTestsFile(testsPath);
  const issue = imported
    ? [artifactGateIssue(preflight), dataPolicyGateIssue(preflight)]
        .filter((entry): entry is string => entry !== null)
        .join("；") || null
    : coverageGateIssue(preflight, { strict: flags.bool("strict") });
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
          ok: issue === null,
          testsPath,
          imported,
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
  const flakeDocument = readTestsDocument(runtime.configDirAbs, { testsPath });
  if (flakeDocument === null) {
    io.errorLog(`无法读取用例文件：${testsPath}`);
    return 2;
  }
  const caseNames = new Map<string, string>();
  for (const record of flakeDocument.records) caseNames.set(record.id, record.name);
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
  const taskId = flags.get("task");
  if (taskId) {
    const report = await buildTaskRunReport(runtime, {
      taskId,
      outputDir: flags.get("out") ?? undefined,
      stamp: flags.get("stamp") ?? undefined,
      save: !flags.bool("no-save")
    });
    if (flags.bool("json")) {
      io.log(JSON.stringify(report, null, 2));
    } else {
      io.log(
        `任务报告: 共 ${report.total} · 通过 ${report.passed} · 失败 ${report.failed} · 待定 ${report.pending}`
      );
      if (report.saved) {
        io.log(`xlsx: ${report.saved.xlsx}`);
        io.log(`junit: ${report.saved.junit}`);
      }
      if (report.error) io.errorLog(report.error);
    }
    if (!report.ok) {
      return report.error?.includes("未找到回归任务") ? 2 : 1;
    }
    return 0;
  }
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

async function suiteTask(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  const action = flags.positional[1];
  if (action === "create") return await suiteTaskCreate(runtime, flags, io);
  if (action === "list") return await suiteTaskList(runtime, flags, io);
  if (action === "show") return await suiteTaskShow(runtime, flags, io);
  if (action === "release") return await suiteTaskRelease(runtime, flags, io);
  io.errorLog("用法: suite task create|list|show|release …（见 suite help）");
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
  const sets = await runtime.store.listCaseSets(runtime.project.rootDir, 50);
  const latest = latestFeatureRefs(sets);
  const resolved: ResolvedTaskRef[] = [];
  const missing: string[] = [];
  for (const key of refs) {
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
    return 2;
  }
  const platforms =
    flags.list("platform").length > 0 ? splitList(flags.list("platform")) : ["ios", "android"];
  const invalidPlatforms = platforms.filter(
    (platform) => platform !== "ios" && platform !== "android"
  );
  if (invalidPlatforms.length > 0) {
    io.errorLog(`非法 --platform：${invalidPlatforms.join("、")}（仅支持 ios/android）`);
    return 2;
  }
  const uniquePlatforms = [...new Set(platforms)];
  const rawBaseline = flags.get("baseline");
  if (rawBaseline !== null && rawBaseline !== "latest" && rawBaseline !== "none") {
    io.errorLog(`非法 --baseline：${rawBaseline}（仅支持 latest/none）`);
    return 2;
  }
  const baseline = rawBaseline === "none" ? "none" : "latest";
  const task = await runtime.store.createRegressionTask({
    rootPath: runtime.project.rootDir,
    refs: resolved.map((entry) => ({ caseSetId: entry.caseSetId, featureKey: entry.featureKey })),
    platforms: uniquePlatforms,
    baseline,
    createdBy: "cli"
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
  const sets = await runtime.store.listCaseSets(rootPath, 50);
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
    io.errorLog("runner 需要中心 PG（当前为内存存储）；请配置 MOBILE_TESTING_DATABASE_URL");
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
        ((argv) =>
          runSuiteCommand(argv, {
            buildRuntime,
            log: io.log,
            errorLog: io.errorLog,
            env,
            runnerName: name
          })),
      collectInventory: seam.collectInventory,
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
  const sets = await runtime.store.listCaseSets(runtime.project.rootDir, 50);
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

/** 回填扫描（只读产物 → 幂等重建登记）：PG 守卫 + 下界 + 报告输出。 */
async function suiteBackfill(
  runtime: Runtime,
  flags: ParsedFlags,
  io: { log: (line: string) => void; errorLog: (line: string) => void }
): Promise<number> {
  if (runtime.store.kind !== "postgres") {
    io.errorLog("backfill 需要中心 PG（当前为内存存储）；请配置 MOBILE_TESTING_DATABASE_URL");
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
  const sub = flags.positional[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSuiteUsage(log);
    return sub ? 0 : 2;
  }
  if (
    !["run", "check", "calibrate", "loop", "flake", "retention", "evidence", "api-errors", "baseline", "report", "feedback", "reconcile", "task", "runner", "schedule", "backfill"].includes(sub)
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
      return await suiteRun(
        built.runtime,
        flags,
        { log, errorLog, env: deps.env ?? process.env, runnerName: deps.runnerName ?? null },
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
    if (sub === "task") return await suiteTask(built.runtime, flags, { log, errorLog });
    if (sub === "schedule") return await suiteSchedule(built.runtime, flags, { log, errorLog });
    if (sub === "backfill") return await suiteBackfill(built.runtime, flags, { log, errorLog });
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
    errorLog(`suite ${sub} 失败: ${errorMessage(error)}`);
    return 1;
  } finally {
    if (built) await built.dispose();
  }
}
