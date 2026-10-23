import os from "node:os";

import { compareRuns, type CompareCaseInput, type RunComparison } from "../tasks/run-compare.js";
import {
  baselineFor,
  platformOf,
  registerSuiteRun,
  resolveRunRefs
} from "../tasks/run-registry.js";
import { logWarn } from "../log.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import { loadQuarantine } from "./quarantine.js";
import { loadGeneratedCases, resolveCaseSelector } from "./design-store.js";
import {
  buildRunManifest,
  pruneRunManifests,
  runManifestMax,
  runManifestsEnabled,
  saveRunManifest,
  testsFingerprint,
  type RunManifestRegistration,
  type RunManifestSource
} from "./run-manifest.js";
import {
  runGeneratedTests,
  type SuiteCaseResult,
  type SuiteRunOptions,
  type SuiteRunReport
} from "./suite-runner.js";

/** 共享批次执行（DESIGN §13.95/§13.119）：`suite run`/`suite loop` 与
 * `design_to_test` 共用同一条执行+产物链——quarantine、批次清单、运行登记。
 * CLI 只负责参数解析与展示；执行语义（退出码/门禁/落盘）在此单一实现。 */

export interface SuiteBatchIo {
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  runnerName?: string | null;
}

export interface SuiteBatchRequest {
  options: SuiteRunOptions;
  source: RunManifestSource;
  /** 默认 load：读 `.artemis/design/quarantine.json` 并传给执行器。 */
  quarantine?: "load" | "skip";
  startedAtMs?: number;
  retry?: number;
  resolveCoverageIssue?: (report: SuiteRunReport) => string | null;
  strict?: boolean;
  failOnUncovered?: boolean;
  registration?: RunManifestRegistration;
  /** 默认 true：写批次清单并登记 suite_runs。 */
  persist?: boolean;
  /** CLI 的 --json 模式跳过登记摘要行；默认 true。 */
  logRegistration?: boolean;
  trigger?: string;
  execute?: (runtime: Runtime, options: SuiteRunOptions) => Promise<SuiteRunReport>;
}

export interface SuiteBatchResult {
  report: SuiteRunReport;
  startedAtMs: number;
  coverageIssue: string | null;
  exitCode: number;
  quarantinedCaseIds: Set<string> | undefined;
  quarantineMessages: string[];
  manifestPath: string | null;
  runId: string | null;
  comparison: RunComparison | null;
}

export function loadSuiteQuarantine(
  runtime: Runtime,
  disabled = false,
  testsPath?: string
): { ids: Set<string> | undefined; messages: string[] } {
  if (disabled) return { ids: undefined, messages: [] };
  const load = loadQuarantine(runtime.configDirAbs);
  if (!load.exists) return { ids: undefined, messages: [] };
  const messages: string[] = [];
  const cases = loadGeneratedCases(runtime.configDirAbs, testsPath ? { testsPath } : {});
  const resolvedIds = new Set<string>();
  for (const selector of load.active.keys()) {
    if (cases === null || cases.some((testCase) => testCase.id === selector)) {
      resolvedIds.add(selector);
      continue;
    }
    const resolved = resolveCaseSelector(selector, cases);
    if (resolved.ok) {
      resolvedIds.add(resolved.caseId);
    } else if (resolved.reason === "ambiguous") {
      messages.push(
        `quarantine 选择器歧义，未隔离: ${selector}（候选：${resolved.candidates.join("、")}）`
      );
    } else {
      resolvedIds.add(selector);
      messages.push(`quarantine 选择器未匹配当前用例，按原值保留: ${selector}`);
    }
  }
  if (resolvedIds.size > 0) {
    messages.push(`quarantine: ${resolvedIds.size} 条生效（失败不计门禁）`);
  }
  for (const entry of load.stale) {
    messages.push(`quarantine 已过期、恢复门禁: ${entry.caseId}（owner=${entry.owner}）`);
  }
  for (const message of load.invalid) {
    messages.push(`quarantine 无效忽略: ${message}`);
  }
  return { ids: resolvedIds.size > 0 ? resolvedIds : undefined, messages };
}

async function applyRetryDiagnostics(
  runtime: Runtime,
  report: SuiteRunReport,
  retryCount: number,
  runOptions: SuiteRunOptions
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

export interface PersistSuiteRunManifestInput {
  source: RunManifestSource;
  startedAtMs: number;
  exitCode: number;
  coverageIssue: string | null;
  strict: boolean;
  failOnUncovered: boolean;
  retry: number;
  options: SuiteRunOptions;
  quarantinedCaseIds?: Set<string>;
  registration?: RunManifestRegistration;
}

/** 批次清单一等实体（DESIGN §13.95）：best-effort，写失败仅 WARN、不影响退出码。 */
export async function persistSuiteRunManifest(
  runtime: Runtime,
  report: SuiteRunReport,
  io: SuiteBatchIo,
  input: PersistSuiteRunManifestInput
): Promise<string | null> {
  const env = io.env ?? process.env;
  if (!runManifestsEnabled(env)) return null;
  try {
    const fingerprint = testsFingerprint(report.testsPath);
    const manifest = buildRunManifest({
      report,
      source: input.source,
      startedAtMs: input.startedAtMs,
      finishedAtMs: Date.now(),
      exitCode: input.exitCode,
      coverageIssue: input.coverageIssue,
      testsPath: report.testsPath,
      testsSha256: fingerprint.sha256,
      testsGeneratedAt: fingerprint.generatedAt,
      options: {
        deviceSerial: input.options.deviceSerial ?? null,
        lockedAppPackage: input.options.lockedAppPackage ?? null,
        model: input.options.model ?? null,
        maxCases: input.options.maxCases ?? null,
        stopOnFailure: input.options.stopOnFailure === true,
        apiErrors: input.options.apiErrors !== false,
        failOnApiErrors: input.options.failOnApiErrors === true,
        strict: input.strict,
        failOnUncovered: input.failOnUncovered,
        retry: input.retry,
        quarantinedCaseIds: [...(input.quarantinedCaseIds ?? [])].sort()
      },
      ...(input.registration ? { registration: input.registration } : {})
    });
    const manifestPath = saveRunManifest(runtime.configDirAbs, manifest);
    pruneRunManifests(runtime.configDirAbs, runManifestMax(env));
    return manifestPath;
  } catch (error) {
    logWarn(`批次清单写入失败: ${errorMessage(error)}`);
    return null;
  }
}

export function outcomeCasesOf(report: SuiteRunReport): CompareCaseInput[] {
  return report.cases.map((entry) => ({
    caseId: entry.caseId,
    name: entry.name,
    outcome: entry.status === "passed" ? "passed" : "failed"
  }));
}

async function registerRunBestEffort(
  runtime: Runtime,
  report: SuiteRunReport,
  input: {
    runOptions: SuiteRunOptions;
    exitCode: number;
    startedAtMs: number;
    trigger: string;
    runnerName?: string | null;
    manifestPath?: string | null;
  }
): Promise<{ runId: string; comparison: RunComparison | null } | null> {
  const refs = await resolveRunRefs(runtime, report.testsPath);
  const platform = platformOf(input.runOptions.deviceSerial ?? null);
  const comparison = refs
    ? compareRuns(
        await baselineFor(runtime, {
          caseSetId: refs.caseSetId,
          featureKey: refs.featureKey,
          platform
        }),
        outcomeCasesOf(report)
      )
    : null;
  const runId = await registerSuiteRun(runtime, {
    report,
    trigger: input.trigger,
    regressionTaskId: null,
    caseSetId: refs?.caseSetId ?? null,
    featureKey: refs?.featureKey ?? null,
    featureName: refs?.featureName ?? null,
    platform,
    device: input.runOptions.deviceSerial ?? null,
    runner: input.runnerName ?? null,
    exitCode: input.exitCode,
    startedAtMs: input.startedAtMs,
    finishedAtMs: Date.now(),
    manifestPath: input.manifestPath ?? null,
    comparison
  });
  return runId ? { runId, comparison } : null;
}

export function suiteRegistrationLine(registration: {
  runId: string;
  comparison: RunComparison | null;
}): string {
  const comparison = registration.comparison;
  return (
    `登记: run ${registration.runId}` +
    (comparison
      ? ` · 对比 修复${comparison.fixed}/回归${comparison.regressed}` +
        (comparison.baseline === "established" ? "（基准建立）" : "")
      : "")
  );
}

export async function executeSuiteBatch(
  runtime: Runtime,
  request: SuiteBatchRequest,
  io: SuiteBatchIo
): Promise<SuiteBatchResult> {
  const startedAtMs = request.startedAtMs ?? Date.now();
  const quarantine = loadSuiteQuarantine(
    runtime,
    request.quarantine === "skip",
    request.options.testsPath
  );
  const options: SuiteRunOptions = {
    ...request.options,
    ...(quarantine.ids !== undefined ? { quarantinedCaseIds: quarantine.ids } : {})
  };
  const execute = request.execute ?? runGeneratedTests;
  const report = await execute(runtime, options);
  const retry = request.retry ?? 0;
  if (retry > 0 && !options.stopOnFailure) {
    await applyRetryDiagnostics(runtime, report, retry, options);
  }
  const coverageIssue = request.resolveCoverageIssue ? request.resolveCoverageIssue(report) : null;
  const quarantinedFailures = report.cases.filter(
    (entry) => entry.quarantined === true && entry.status !== "passed"
  ).length;
  const exitCode =
    !report.ok ? 2 : coverageIssue !== null ? 2 : report.failed - quarantinedFailures === 0 ? 0 : 1;

  let manifestPath: string | null = null;
  let runId: string | null = null;
  let comparison: RunComparison | null = null;
  if (request.persist !== false) {
    const registration: RunManifestRegistration = {
      ...(request.registration ?? {}),
      runner: request.registration?.runner ?? io.runnerName ?? os.hostname(),
      testsPath: request.registration?.testsPath ?? report.testsPath
    };
    manifestPath = await persistSuiteRunManifest(runtime, report, io, {
      source: request.source,
      startedAtMs,
      exitCode,
      coverageIssue,
      strict: request.strict === true,
      failOnUncovered: request.failOnUncovered === true,
      retry,
      options,
      ...(quarantine.ids !== undefined ? { quarantinedCaseIds: quarantine.ids } : {}),
      registration
    });
    const registered = await registerRunBestEffort(runtime, report, {
      runOptions: options,
      exitCode,
      startedAtMs,
      trigger: request.trigger ?? "cli",
      runnerName: io.runnerName ?? null,
      manifestPath
    });
    runId = registered?.runId ?? null;
    comparison = registered?.comparison ?? null;
    if (request.logRegistration !== false) {
      io.log(registered ? suiteRegistrationLine(registered) : "登记降级: suite run 未入库（见日志）");
    }
  }

  return {
    report,
    startedAtMs,
    coverageIssue,
    exitCode,
    quarantinedCaseIds: quarantine.ids,
    quarantineMessages: quarantine.messages,
    manifestPath,
    runId,
    comparison
  };
}
