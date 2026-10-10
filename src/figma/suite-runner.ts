import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  API_ERRORS_ARTIFACT,
  loadApiErrorCatalog,
  matchApiErrors,
  type ApiErrorObservation
} from "../artemis/api-errors.js";
import {
  classifyFailure,
  scriptProvenanceSignal,
  type CrashSignal,
  type FailureClassification
} from "../artemis/failure-taxonomy.js";
import {
  resultPayload,
  taskStatusOf,
  traceIdOf,
  type TaskStatus
} from "../artemis/task-result.js";
import { TERMINAL_TASK_STATUSES } from "../db/types.js";
import { classifyIosSerial } from "../device/ios.js";
import { IosLogCollector, type IosLogWindowRequest } from "../device/ios-log.js";
import { resetIosApp } from "../device/ios-reset.js";
import { isIosTraceDir } from "../ios/trace-store.js";
import { logWarn } from "../log.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "../device/logcat.js";
import { resetApp, type AppResetOptions, type AppResetOutcome, type AppResetRequest } from "../device/reset.js";
import type { IosDevice } from "../device/ios-actions.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { isExploreKind, resolveProvenance, summarizeScriptProvenance } from "../provenance.js";
import {
  hitsFromRunSteps,
  ingestExplorationObservations,
  type ExploreStepSignal
} from "./reconciliation.js";
import { preflightGeneratedTests, type PreflightReport } from "./preflight.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

export type SuiteResetFn = (
  request: AppResetRequest,
  options?: { device?: IosDevice } & AppResetOptions
) => Promise<AppResetOutcome>;

/** Reset strategy per target: simulator/physical UDIDs use the iOS backend
 * (physical devices get the WDA device facade injected by the suite runner). */
export function suiteResetFor(serial: string | null): SuiteResetFn {
  if (serial && classifyIosSerial(serial)) return resetIosApp as unknown as SuiteResetFn;
  return resetApp as unknown as SuiteResetFn;
}

export interface SuiteCaseResult {
  caseId: string;
  name: string;
  status: "passed" | "failed" | "timeout" | "submit-error";
  traceId: string | null;
  error: string | null;
  testSummary: TaskStatus["testSummary"];
  failure: FailureClassification | null;
  /** Design-pipeline script provenance summary (tests.json expectations;
   * null for legacy artifacts without expectations). */
  scriptProvenance: { asserts: number; explores: number } | null;
  apiErrors: ApiErrorObservation[];
  apiErrorsDegraded: string | null;
  evidence: {
    notesDir: string | null;
    stderrLog: string | null;
    stdoutLog: string | null;
  };
  reset: AppResetOutcome | null;
  /** 在 `.artemis/design/quarantine.json` 中且未过期：如实标注，不计门禁。 */
  quarantined?: boolean;
  /** Present when `--retry` re-ran this non-passed case. Diagnosis only: the
   * first-run status still decides the gate (D3 口径：重跑转绿不计首跑门禁). */
  retry?: {
    attempts: number;
    finalStatus: "passed" | "failed" | "timeout" | "submit-error";
    finalTraceId: string | null;
    flaky: boolean;
  };
}

export interface SuiteRunReport {
  ok: boolean;
  testsPath: string;
  total: number;
  executed: number;
  skipped: number;
  passed: number;
  failed: number;
  preflight: PreflightReport | null;
  apiErrorCatalog: { file: string; rules: number; errors: string[] } | null;
  cases: SuiteCaseResult[];
  error?: string;
}

export interface SuiteRunOptions {
  testsPath?: string;
  maxCases?: number;
  /** Only run these generated case ids (used by `--retry` diagnostics). */
  caseIds?: string[];
  /** 隔离用例集合（quarantine.json 生效项）：结果如实标注，门禁由调用方排除。 */
  quarantinedCaseIds?: Set<string>;
  stopOnFailure?: boolean;
  deviceSerial?: string;
  lockedAppPackage?: string;
  model?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  reset?: SuiteResetFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Match collected device logs against `.artemis/design/error-codes.json` (default true). */
  apiErrors?: boolean;
  /** Treat unhandled API errors as a case failure (default false: evidence only). */
  failOnApiErrors?: boolean;
  logcatCollector?: (request: {
    serial: string | null;
    windowStartMs: number;
    windowEndMs: number | null;
  }) => Promise<LogcatWindowResult>;
  iosLogCollector?: (request: IosLogWindowRequest) => Promise<LogcatWindowResult>;
}

interface GeneratedCaseLike {
  id: string;
  name: string;
  preconditions: string[];
  taskDesc: string;
  screens: string[];
  /** Exploration steps (kind=explore with a target screen) for reconciliation. */
  exploreSteps: ExploreStepSignal[];
  /** Script provenance counts from tests.json expectations (null = legacy). */
  scriptProvenance: { asserts: number; explores: number } | null;
}

function exploreStepsOf(raw: unknown): ExploreStepSignal[] {
  if (!Array.isArray(raw)) return [];
  const steps: ExploreStepSignal[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { index?: unknown; screen?: unknown; kind?: unknown; provenance?: unknown };
    if (!isExploreKind(record.kind)) continue;
    if (typeof record.screen !== "string" || record.screen.trim() === "") continue;
    const index =
      typeof record.index === "number" && Number.isFinite(record.index)
        ? Math.floor(record.index)
        : steps.length + 1;
    steps.push({
      index,
      screen: record.screen.trim(),
      provenance: resolveProvenance(record.provenance)
    });
  }
  return steps;
}

function loadCases(file: string, maxCases?: number): GeneratedCaseLike[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      flows?: Array<{
        id?: unknown;
        name?: unknown;
        preconditions?: unknown;
        taskDesc?: unknown;
        screens?: unknown;
        expectations?: unknown;
      }>;
    };
    const cases: GeneratedCaseLike[] = [];
    for (const entry of parsed.flows ?? []) {
      if (!entry || typeof entry.id !== "string" || typeof entry.taskDesc !== "string") continue;
      cases.push({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        preconditions: Array.isArray(entry.preconditions)
          ? entry.preconditions.filter((item): item is string => typeof item === "string")
          : [],
        taskDesc: entry.taskDesc,
        screens: Array.isArray(entry.screens)
          ? entry.screens.filter((screen): screen is string => typeof screen === "string")
          : [],
        exploreSteps: exploreStepsOf(entry.expectations),
        scriptProvenance: summarizeScriptProvenance(entry.expectations)
      });
    }
    return maxCases && maxCases > 0 ? cases.slice(0, maxCases) : cases;
  } catch {
    return null;
  }
}

function crashesForTrace(runtime: Runtime, traceId: string): CrashSignal[] {
  try {
    return runtime.crashStore
      .list({ limit: 100 })
      .records.filter((record) => record.traceIds.includes(traceId))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        package: record.package,
        exceptionClass: record.exceptionClass
      }));
  } catch {
    return [];
  }
}

function isTerminal(status: string | null | undefined): boolean {
  return (
    typeof status === "string" &&
    (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)
  );
}

function resetFailure(error: unknown, serial: string | null): AppResetOutcome {
  const ios = serial !== null && classifyIosSerial(serial) !== null;
  return {
    ok: false,
    reason: ios ? "launch-failed" : "force-stop-failed",
    message: errorMessage(error),
    serial,
    adb: { path: null, source: "missing" },
    commands: []
  };
}

function isIosTrace(runtime: Runtime, traceId: string): boolean {
  return isIosTraceDir(runtime.traceDir(traceId), traceId);
}

function emptyEvidence(): SuiteCaseResult["evidence"] {
  return { notesDir: null, stderrLog: null, stdoutLog: null };
}

export async function runGeneratedTests(
  runtime: Runtime,
  options: SuiteRunOptions = {}
): Promise<SuiteRunReport> {
  const defaultTestsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  const testsPath = options.testsPath
    ? path.resolve(runtime.project.rootDir, options.testsPath)
    : defaultTestsPath;
  let cases = loadCases(testsPath, options.maxCases);
  if (!cases) {
    return {
      ok: false,
      testsPath,
      total: 0,
      executed: 0,
      skipped: 0,
      passed: 0,
      failed: 0,
      preflight: null,
      apiErrorCatalog: null,
      cases: [],
      error: `无法读取用例文件：${testsPath}`
    };
  }
  if (options.caseIds && options.caseIds.length > 0) {
    const wanted = new Set(options.caseIds);
    cases = cases.filter((testCase) => wanted.has(testCase.id));
  }

  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath });
  const serial = options.deviceSerial ?? null;
  const serialKind = serial !== null ? classifyIosSerial(serial) : null;
  const resetFn = options.reset ?? suiteResetFor(serial);
  let iosDeviceWda: IosDevice | null = null;
  if (serialKind === "device" && options.reset === undefined) {
    try {
      iosDeviceWda = await runtime.iosWda().device(serial!);
    } catch {
      iosDeviceWda = null;
    }
  }
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const apiCatalog = options.apiErrors === false ? null : loadApiErrorCatalog(runtime.configDirAbs);
  const collectLogcat =
    options.logcatCollector ?? ((request) => new AdbLogcatCollector().collect(request));
  const collectIosLogs =
    options.iosLogCollector ?? ((request) => new IosLogCollector().collect(request));

  const results: SuiteCaseResult[] = [];
  let submitted = 0;
  let firstSubmitError: string | null = null;

  for (const testCase of cases) {
    const quarantined = options.quarantinedCaseIds?.has(testCase.id) === true;
    let reset: AppResetOutcome | null = null;
    if (options.lockedAppPackage) {
      try {
        reset = await resetFn(
          { packageName: options.lockedAppPackage, serial },
          iosDeviceWda !== null ? { device: iosDeviceWda } : {}
        );
      } catch (error) {
        reset = resetFailure(error, serial);
      }
    }

    const submitArgs: Record<string, unknown> = { task_desc: testCase.taskDesc };
    if (options.model) submitArgs.model = options.model;
    if (options.deviceSerial) submitArgs.device_serial = options.deviceSerial;
    if (options.lockedAppPackage) submitArgs.locked_app_package = options.lockedAppPackage;

    let result: CallToolResult;
    try {
      result = await runtime.proxy.callTool("mobile_run_task", submitArgs);
    } catch (error) {
      const message = errorMessage(error);
      if (!firstSubmitError) firstSubmitError = message;
      await runtime.recordTaskSubmission({
        traceId: null,
        model: options.model ?? null,
        status: "failed",
        taskDesc: testCase.taskDesc,
        caseId: testCase.id,
        lockedAppPackage: options.lockedAppPackage ?? null
      });
      results.push({
        caseId: testCase.id,
        name: testCase.name,
        status: "submit-error",
        ...(quarantined ? { quarantined: true } : {}),
        traceId: null,
        error: message,
        testSummary: null,
        scriptProvenance: testCase.scriptProvenance,
        failure: classifyFailure({
          submitError: message,
          reset,
          preconditions: testCase.preconditions
        }),
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: emptyEvidence(),
        reset
      });
      if (options.stopOnFailure) break;
      continue;
    }

    const traceId = result.isError === true ? null : traceIdOf(result);
    const submitStatus = taskStatusOf(resultPayload(result));
    if (!traceId) {
      const message =
        result.isError === true
          ? submitStatus?.error ?? submitStatus?.message ?? "上游拒绝了任务提交"
          : "mobile_run_task 未返回 trace_id";
      if (!firstSubmitError) firstSubmitError = message;
      await runtime.recordTaskSubmission({
        traceId: null,
        model: options.model ?? null,
        status: "failed",
        taskDesc: testCase.taskDesc,
        caseId: testCase.id,
        lockedAppPackage: options.lockedAppPackage ?? null
      });
      results.push({
        caseId: testCase.id,
        name: testCase.name,
        status: "submit-error",
        ...(quarantined ? { quarantined: true } : {}),
        traceId: null,
        error: message,
        testSummary: null,
        scriptProvenance: testCase.scriptProvenance,
        failure: classifyFailure({
          submitError: message,
          reset,
          preconditions: testCase.preconditions
        }),
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: emptyEvidence(),
        reset
      });
      if (options.stopOnFailure) break;
      continue;
    }

    submitted += 1;
    if (!isIosTrace(runtime, traceId)) {
      await runtime.recordTaskSubmission({
        traceId,
        model: options.model ?? null,
        taskDesc: testCase.taskDesc,
        caseId: testCase.id,
        lockedAppPackage: options.lockedAppPackage ?? null
      });
    }

    const deadline = now() + pollTimeoutMs;
    let status = await runtime.traceStatus(traceId);
    while (!isTerminal(status?.status) && now() < deadline) {
      await sleep(pollIntervalMs);
      status = await runtime.traceStatus(traceId);
    }
    await runtime.syncTaskStatuses();
    await runtime.flushCrashScans();

    const terminal = isTerminal(status?.status);
    const windowStartMs = status?.startTimeMs ?? null;
    const windowEndMs = status?.endTimeMs ?? (terminal ? now() : null);
    const traceSerial = options.deviceSerial ?? status?.deviceSerial ?? null;
    let apiErrors: ApiErrorObservation[] = [];
    let apiErrorsDegraded: string | null = null;
    if (terminal && apiCatalog) {
      const iosTarget = traceSerial !== null && classifyIosSerial(traceSerial) !== null;
      if (apiCatalog.rules.size === 0) {
        apiErrorsDegraded = fs.existsSync(apiCatalog.file) ? "registry-empty" : "registry-missing";
      } else if (windowStartMs === null) {
        apiErrorsDegraded = "no-window";
      } else if (iosTarget) {
        const processName = options.lockedAppPackage
          ? options.lockedAppPackage.split(".").pop() ?? null
          : null;
        try {
          const collected = await collectIosLogs({
            serial: traceSerial,
            windowStartMs,
            windowEndMs: windowEndMs ?? now(),
            processName
          });
          if (collected.status === "ok") {
            apiErrors = matchApiErrors(collected.text, apiCatalog.rules);
          } else {
            apiErrorsDegraded = collected.reason ?? "ios-log-unsupported";
          }
        } catch (error) {
          apiErrorsDegraded = `collector-error: ${errorMessage(error)}`;
        }
      } else {
        try {
          const collected = await collectLogcat({
            serial: traceSerial,
            windowStartMs,
            windowEndMs: windowEndMs ?? now()
          });
          if (collected.status === "ok") {
            apiErrors = matchApiErrors(collected.text, apiCatalog.rules);
          } else {
            apiErrorsDegraded = collected.reason ?? "collect-failed";
          }
        } catch (error) {
          apiErrorsDegraded = `collector-error: ${errorMessage(error)}`;
        }
      }
      try {
        const artifactDir = runtime.traceDir(traceId);
        fs.mkdirSync(artifactDir, { recursive: true });
        writeFileAtomic(
          path.join(artifactDir, API_ERRORS_ARTIFACT),
          `${JSON.stringify(
            {
              traceId,
              serial: traceSerial,
              window:
                windowStartMs === null
                  ? null
                  : { startMs: windowStartMs, endMs: windowEndMs ?? now() },
              source: apiErrorsDegraded !== null ? "none" : iosTarget ? "simctl-log" : "logcat",
              degraded: apiErrorsDegraded,
              errors: apiErrors
            },
            null,
            2
          )}\n`
        );
      } catch {
        apiErrorsDegraded = [apiErrorsDegraded, "artifact-write-failed"]
          .filter((value): value is string => value !== null)
          .join("；");
      }
    }

    const unhandledApiErrors = apiErrors.filter((entry) => entry.handled === false);
    let caseStatus: SuiteCaseResult["status"] = !terminal
      ? "timeout"
      : status!.status === "completed"
        ? "passed"
        : "failed";
    let forcedError: string | null = null;
    if (options.failOnApiErrors === true && unhandledApiErrors.length > 0 && caseStatus === "passed") {
      caseStatus = "failed";
      forcedError = `检测到未处理的 API 错误：${unhandledApiErrors.map((entry) => entry.code).join("、")}`;
    }
    const caseResult: SuiteCaseResult = {
      caseId: testCase.id,
      name: testCase.name,
      status: caseStatus,
      ...(quarantined ? { quarantined: true } : {}),
      traceId,
      error: forcedError ?? status?.error ?? (terminal ? null : "等待任务终态超时"),
      testSummary: status?.testSummary ?? null,
      scriptProvenance: testCase.scriptProvenance,
      failure:
        caseStatus === "passed"
          ? null
          : classifyFailure({
              status,
              crashes: crashesForTrace(runtime, traceId),
              reset,
              preconditions: testCase.preconditions,
              timedOut: !terminal,
              apiErrors: apiErrors.map((entry) => ({ code: entry.code, handled: entry.handled })),
              scriptProvenance: scriptProvenanceSignal(
                testCase.scriptProvenance,
                status?.testSummary?.adherence ?? null
              )
            }),
      apiErrors,
      apiErrorsDegraded,
      evidence: {
        notesDir: status?.notesDir ?? null,
        stderrLog: status?.stderrLog ?? null,
        stdoutLog: status?.stdoutLog ?? null
      },
      reset
    };
    results.push(caseResult);
    if (terminal && testCase.exploreSteps.length > 0 && isIosTrace(runtime, traceId)) {
      try {
        const runText = fs.readFileSync(path.join(runtime.traceDir(traceId), "run.json"), "utf-8");
        const hitIndexes = hitsFromRunSteps(JSON.parse(runText));
        ingestExplorationObservations({
          configDirAbs: runtime.configDirAbs,
          traceId,
          at: new Date(now()).toISOString(),
          screens: testCase.screens,
          exploreSteps: testCase.exploreSteps,
          hitIndexes
        });
      } catch (error) {
        logWarn(`对账摄取失败（${traceId}）：${errorMessage(error)}`);
      }
    }
    if (options.stopOnFailure && caseResult.status !== "passed") break;
  }

  const passed = results.filter((entry) => entry.status === "passed").length;
  const failed = results.length - passed;
  const ok = submitted > 0;
  const report: SuiteRunReport = {
    ok,
    testsPath,
    total: cases.length,
    executed: results.length,
    skipped: cases.length - results.length,
    passed,
    failed,
    preflight,
    apiErrorCatalog: apiCatalog
      ? { file: apiCatalog.file, rules: apiCatalog.rules.size, errors: apiCatalog.errors }
      : null,
    cases: results
  };
  if (!ok && firstSubmitError) report.error = firstSubmitError;
  return report;
}
