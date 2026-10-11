import fs from "node:fs";
import path from "node:path";

import {
  API_ERRORS_ARTIFACT,
  matchApiErrors,
  type ApiErrorObservation,
  type loadApiErrorCatalog
} from "../artemis/api-errors.js";
import { classifyFailure, scriptProvenanceSignal } from "../artemis/failure-taxonomy.js";
import { resultPayload, taskStatusOf, traceIdOf } from "../artemis/task-result.js";
import { crashesForTrace } from "../crash/query.js";
import { TERMINAL_TASK_STATUSES } from "../db/types.js";
import type { IosDevice } from "../device/ios-actions.js";
import { classifyIosSerial } from "../device/ios.js";
import type { IosLogWindowRequest } from "../device/ios-log.js";
import { isIosTraceDir } from "../ios/trace-store.js";
import type { LogcatWindowResult } from "../device/logcat.js";
import type { AppResetOutcome } from "../device/reset.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { GeneratedCase } from "./design-store.js";
import type { SuiteCaseResult, SuiteResetFn } from "./suite-runner.js";

/** 套件执行核心（DESIGN §13.85）：一例 = 一次深调用——reset → 提交 → 轮询 →
 * api-errors 采集与产物 → 结果组装。编排（加载/筛选/聚合/对账摄取）留在 suite-runner。 */

export type ApiCatalog = ReturnType<typeof loadApiErrorCatalog> | null;

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

function emptyEvidence(): SuiteCaseResult["evidence"] {
  return { notesDir: null, stderrLog: null, stdoutLog: null };
}

export interface CaseRunContext {
  runtime: Runtime;
  model: string | null;
  deviceSerial: string | null;
  lockedAppPackage: string | null;
  quarantined: boolean;
  failOnApiErrors: boolean;
  apiCatalog: ApiCatalog;
  resetFn: SuiteResetFn;
  iosDeviceWda: IosDevice | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  collectLogcat: (request: {
    serial: string | null;
    windowStartMs: number;
    windowEndMs: number | null;
  }) => Promise<LogcatWindowResult>;
  collectIosLogs: (request: IosLogWindowRequest) => Promise<LogcatWindowResult>;
}

export interface CaseRunOutcome {
  result: SuiteCaseResult;
  submitted: boolean;
  /** 提交失败消息（调用方取首个作为报告 error）。 */
  submitError: string | null;
  terminal: boolean;
}

export async function executeCase(
  testCase: GeneratedCase,
  context: CaseRunContext
): Promise<CaseRunOutcome> {
  const { runtime, sleep, now } = context;
  let reset: AppResetOutcome | null = null;
  if (context.lockedAppPackage) {
    try {
      reset = await context.resetFn(
        { packageName: context.lockedAppPackage, serial: context.deviceSerial },
        context.iosDeviceWda !== null ? { device: context.iosDeviceWda } : {}
      );
    } catch (error) {
      reset = resetFailure(error, context.deviceSerial);
    }
  }

  const submitArgs: Record<string, unknown> = { task_desc: testCase.taskDesc };
  if (context.model) submitArgs.model = context.model;
  if (context.deviceSerial) submitArgs.device_serial = context.deviceSerial;
  if (context.lockedAppPackage) submitArgs.locked_app_package = context.lockedAppPackage;

  let result: import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  try {
    result = await runtime.proxy.callTool("mobile_run_task", submitArgs);
  } catch (error) {
    const message = errorMessage(error);
    await runtime.recordTaskSubmission({
      traceId: null,
      model: context.model,
      status: "failed",
      taskDesc: testCase.taskDesc,
      caseId: testCase.id,
      lockedAppPackage: context.lockedAppPackage
    });
    return {
      submitted: false,
      submitError: message,
      terminal: false,
      result: {
        caseId: testCase.id,
        name: testCase.name,
        status: "submit-error",
        ...(context.quarantined ? { quarantined: true } : {}),
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
      }
    };
  }

  const traceId = result.isError === true ? null : traceIdOf(result);
  const submitStatus = taskStatusOf(resultPayload(result));
  if (!traceId) {
    const message =
      result.isError === true
        ? submitStatus?.error ?? submitStatus?.message ?? "上游拒绝了任务提交"
        : "mobile_run_task 未返回 trace_id";
    await runtime.recordTaskSubmission({
      traceId: null,
      model: context.model,
      status: "failed",
      taskDesc: testCase.taskDesc,
      caseId: testCase.id,
      lockedAppPackage: context.lockedAppPackage
    });
    return {
      submitted: false,
      submitError: message,
      terminal: false,
      result: {
        caseId: testCase.id,
        name: testCase.name,
        status: "submit-error",
        ...(context.quarantined ? { quarantined: true } : {}),
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
      }
    };
  }

  if (!isIosTraceDir(runtime.traceDir(traceId), traceId)) {
    await runtime.recordTaskSubmission({
      traceId,
      model: context.model,
      taskDesc: testCase.taskDesc,
      caseId: testCase.id,
      lockedAppPackage: context.lockedAppPackage
    });
  }

  const deadline = now() + context.pollTimeoutMs;
  let status = await runtime.traceStatus(traceId);
  while (!isTerminal(status?.status) && now() < deadline) {
    await sleep(context.pollIntervalMs);
    status = await runtime.traceStatus(traceId);
  }
  await runtime.syncTaskStatuses();
  await runtime.flushCrashScans();

  const terminal = isTerminal(status?.status);
  const windowStartMs = status?.startTimeMs ?? null;
  const windowEndMs = status?.endTimeMs ?? (terminal ? now() : null);
  const traceSerial = context.deviceSerial ?? status?.deviceSerial ?? null;
  let apiErrors: ApiErrorObservation[] = [];
  let apiErrorsDegraded: string | null = null;
  if (terminal && context.apiCatalog) {
    const serialKind = traceSerial !== null ? classifyIosSerial(traceSerial) : null;
    const iosTarget = serialKind !== null;
    if (context.apiCatalog.rules.size === 0) {
      apiErrorsDegraded = fs.existsSync(context.apiCatalog.file) ? "registry-empty" : "registry-missing";
    } else if (windowStartMs === null) {
      apiErrorsDegraded = "no-window";
    } else if (iosTarget) {
      const processName = context.lockedAppPackage
        ? context.lockedAppPackage.split(".").pop() ?? null
        : null;
      try {
        const collected = await context.collectIosLogs({
          serial: traceSerial,
          windowStartMs,
          windowEndMs: windowEndMs ?? now(),
          processName
        });
        if (collected.status === "ok") {
          apiErrors = matchApiErrors(collected.text, context.apiCatalog.rules);
        } else {
          apiErrorsDegraded = collected.reason ?? "ios-log-unsupported";
        }
      } catch (error) {
        apiErrorsDegraded = `collector-error: ${errorMessage(error)}`;
      }
    } else {
      try {
        const collected = await context.collectLogcat({
          serial: traceSerial,
          windowStartMs,
          windowEndMs: windowEndMs ?? now()
        });
        if (collected.status === "ok") {
          apiErrors = matchApiErrors(collected.text, context.apiCatalog.rules);
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
            source:
              apiErrorsDegraded !== null
                ? "none"
                : iosTarget
                  ? serialKind === "device"
                    ? "idevicesyslog"
                    : "simctl-log"
                  : "logcat",
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
  if (context.failOnApiErrors && unhandledApiErrors.length > 0 && caseStatus === "passed") {
    caseStatus = "failed";
    forcedError = `检测到未处理的 API 错误：${unhandledApiErrors.map((entry) => entry.code).join("、")}`;
  }
  const caseResult: SuiteCaseResult = {
    caseId: testCase.id,
    name: testCase.name,
    status: caseStatus,
    ...(context.quarantined ? { quarantined: true } : {}),
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

  return { result: caseResult, submitted: true, submitError: null, terminal };
}
