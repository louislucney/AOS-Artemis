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
import { resetIosApp } from "../device/ios-reset.js";
import { AdbLogcatCollector, type LogcatWindowResult } from "../device/logcat.js";
import { resetApp, type AppResetOutcome } from "../device/reset.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { preflightGeneratedTests, type PreflightReport } from "./preflight.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

/** Reset strategy per target: simulator UDIDs use the iOS backend. */
export function suiteResetFor(serial: string | null): typeof resetApp {
  return serial && classifyIosSerial(serial) ? resetIosApp : resetApp;
}

export interface SuiteCaseResult {
  caseId: string;
  name: string;
  status: "passed" | "failed" | "timeout" | "submit-error";
  traceId: string | null;
  error: string | null;
  testSummary: TaskStatus["testSummary"];
  failure: FailureClassification | null;
  apiErrors: ApiErrorObservation[];
  apiErrorsDegraded: string | null;
  evidence: {
    notesDir: string | null;
    stderrLog: string | null;
    stdoutLog: string | null;
  };
  reset: AppResetOutcome | null;
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
  stopOnFailure?: boolean;
  deviceSerial?: string;
  lockedAppPackage?: string;
  model?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  reset?: (request: { packageName: string; serial?: string | null }) => Promise<AppResetOutcome>;
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
}

interface GeneratedCaseLike {
  id: string;
  name: string;
  preconditions: string[];
  taskDesc: string;
}

function loadCases(file: string, maxCases?: number): GeneratedCaseLike[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      flows?: Array<{ id?: unknown; name?: unknown; preconditions?: unknown; taskDesc?: unknown }>;
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
        taskDesc: entry.taskDesc
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
  return {
    ok: false,
    reason: "force-stop-failed",
    message: errorMessage(error),
    serial,
    adb: { path: null, source: "missing" },
    commands: []
  };
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
  const cases = loadCases(testsPath, options.maxCases);
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

  const preflight = testsPath === defaultTestsPath ? preflightGeneratedTests(runtime.configDirAbs) : null;
  const serial = options.deviceSerial ?? null;
  const resetFn = options.reset ?? suiteResetFor(serial);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const apiCatalog = options.apiErrors === false ? null : loadApiErrorCatalog(runtime.configDirAbs);
  const collectLogcat =
    options.logcatCollector ?? ((request) => new AdbLogcatCollector().collect(request));

  const results: SuiteCaseResult[] = [];
  let submitted = 0;
  let firstSubmitError: string | null = null;

  for (const testCase of cases) {
    let reset: AppResetOutcome | null = null;
    if (options.lockedAppPackage) {
      try {
        reset = await resetFn({ packageName: options.lockedAppPackage, serial });
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
        traceId: null,
        error: message,
        testSummary: null,
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
        traceId: null,
        error: message,
        testSummary: null,
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
    await runtime.recordTaskSubmission({
      traceId,
      model: options.model ?? null,
      taskDesc: testCase.taskDesc,
      caseId: testCase.id,
      lockedAppPackage: options.lockedAppPackage ?? null
    });

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
      if (traceSerial && classifyIosSerial(traceSerial)) {
        apiErrorsDegraded = "ios-log-unsupported";
      } else if (apiCatalog.rules.size === 0) {
        apiErrorsDegraded = fs.existsSync(apiCatalog.file) ? "registry-empty" : "registry-missing";
      } else if (windowStartMs === null) {
        apiErrorsDegraded = "no-window";
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
              source: apiErrorsDegraded === null ? "logcat" : "none",
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
      traceId,
      error: forcedError ?? status?.error ?? (terminal ? null : "等待任务终态超时"),
      testSummary: status?.testSummary ?? null,
      failure:
        caseStatus === "passed"
          ? null
          : classifyFailure({
              status,
              crashes: crashesForTrace(runtime, traceId),
              reset,
              preconditions: testCase.preconditions,
              timedOut: !terminal,
              apiErrors: apiErrors.map((entry) => ({ code: entry.code, handled: entry.handled }))
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
