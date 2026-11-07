import fs from "node:fs";
import path from "node:path";

import {
  API_ERRORS_ARTIFACT,
  matchApiErrors,
  type ApiErrorObservation,
  type loadApiErrorCatalog
} from "../artemis/api-errors.js";
import { classifyFailure, scriptProvenanceSignal } from "../artemis/failure-taxonomy.js";
import { resultPayload, taskStatusOf, traceIdOf, type TaskStatus } from "../artemis/task-result.js";
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

/** Artemis 子进程异常退出时可能只把错误写到 stderr，status.json 仍保持 running；
 * 套件轮询必须把这个终态信号当成 failed，否则会白等完整超时。 */
export function traceTerminalError(traceDir: string): string | null {
  for (const name of ["stderr.log", "stdout.log"]) {
    try {
      const filePath = path.join(traceDir, name);
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;
      const start = Math.max(0, stat.size - 8192);
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const text = buffer.toString("utf-8");
        const critical = /CRITICAL ERROR during task execution:\s*([^\r\n]+)/i.exec(text);
        if (critical) return `Artemis 执行失败：${critical[1].trim()}`;
        const llm = /((?:LLMExhaustedError|openai\.APIConnectionError):[^\r\n]+)/i.exec(text);
        if (llm) return `Artemis 执行失败：${llm[1].trim()}`;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* trace 尚未落盘或不可读：继续轮询 */
    }
  }
  return null;
}

/** 套件执行核心（DESIGN §13.85）：一例 = 一次深调用——reset → 提交 → 轮询 →
 * api-errors 采集与产物 → 结果组装。编排（加载/筛选/聚合/对账摄取）留在 suite-runner。 */

export type ApiCatalog = ReturnType<typeof loadApiErrorCatalog> | null;

/** iOS 执行器的确定性断言块只对 AOS iOS 执行器有意义；Android/ARTEMIS 提交前剔除，避免噪声。 */
export function stripIosExpectation(taskDesc: string): string {
  return taskDesc
    .split("\n")
    .filter((line) => !line.includes("【AOS-EXPECT】"))
    .join("\n");
}

/** AOS iOS 执行器（模拟器/真机）保留确定性断言块；Android/ARTEMIS 提交前剔除。 */
export function taskDescForTarget(taskDesc: string, deviceSerial: string | null): string {
  const iosTarget = deviceSerial !== null && classifyIosSerial(deviceSerial) !== null;
  return iosTarget ? taskDesc : stripIosExpectation(taskDesc);
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

function emptyEvidence(): SuiteCaseResult["evidence"] {
  return { notesDir: null, stderrLog: null, stdoutLog: null };
}

export interface CaseRunContext {
  runtime: Runtime;
  model: string | null;
  deviceSerial: string | null;
  lockedAppPackage: string | null;
  /** 可选 APK/IPA 路径或 URL；透传 mobile_run_task.app_path（由 Artemis 安装）。 */
  appPath?: string | null;
  /** 回归任务 id；用于失败证据上传，手动 suite run 可为空。 */
  regressionTaskId?: string | null;
  quarantined: boolean;
  failOnApiErrors: boolean;
  apiCatalog: ApiCatalog;
  resetFn: SuiteResetFn;
  iosDeviceWda: IosDevice | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** 停止请求：轮询期间检查，命中即停止等待并尝试终止 Artemis 子进程。 */
  shouldAbort?: () => boolean;
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

function uploadFailureEvidence(
  context: CaseRunContext,
  caseId: string,
  traceId: string
): void {
  const taskId = context.regressionTaskId ?? null;
  const upload = context.runtime.store.uploadTaskEvidence;
  if (taskId === null || upload === undefined) return;
  const files: Array<{ name: string; contentBase64: string }> = [];
  for (const name of ["status.json", "stderr.log", "stdout.log"]) {
    try {
      const buffer = fs.readFileSync(path.join(context.runtime.traceDir(traceId), name));
      if (buffer.length <= 256 * 1024) {
        files.push({ name, contentBase64: buffer.toString("base64") });
      }
    } catch {
      /* 缺文件不阻断 */
    }
  }
  if (files.length === 0) return;
  void upload
    .call(context.runtime.store, {
      rootPath: context.runtime.project.rootDir,
      taskId,
      caseId,
      traceId,
      files
    })
    .catch(() => undefined);
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

  const taskDesc = taskDescForTarget(testCase.taskDesc, context.deviceSerial);
  const submitArgs: Record<string, unknown> = { task_desc: taskDesc };
  if (context.model) submitArgs.model = context.model;
  if (context.deviceSerial) submitArgs.device_serial = context.deviceSerial;
  if (context.lockedAppPackage) submitArgs.locked_app_package = context.lockedAppPackage;
  if (context.appPath) submitArgs.app_path = context.appPath;

  let result: import("@modelcontextprotocol/sdk/types.js").CallToolResult;
  try {
    result = await runtime.proxy.callTool("mobile_run_task", submitArgs);
  } catch (error) {
    const message = errorMessage(error);
    await runtime.recordTaskSubmission({
      traceId: null,
      model: context.model,
      status: "failed",
      taskDesc,
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
      taskDesc,
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
      taskDesc,
      caseId: testCase.id,
      lockedAppPackage: context.lockedAppPackage
    });
  }

  const deadline = now() + context.pollTimeoutMs;
  const traceDir = runtime.traceDir(traceId);
  let status = await runtime.traceStatus(traceId);
  let terminalError =
    isTerminal(status?.status) === true
      ? null
      : status?.error?.trim() || traceTerminalError(traceDir);
  while (!isTerminal(status?.status) && terminalError === null && now() < deadline) {
    if (context.shouldAbort?.() === true) {
      terminalError = "任务已取消，停止等待 Artemis 终态";
      await context.runtime.proxy.markForRestart().catch(() => undefined);
      break;
    }
    await sleep(context.pollIntervalMs);
    status = await runtime.traceStatus(traceId);
    if (!isTerminal(status?.status)) {
      terminalError = status?.error?.trim() || traceTerminalError(traceDir);
    }
  }
  if (terminalError !== null) {
    status = {
      ...(status ?? {
        traceId,
        status: null,
        deviceSerial: context.deviceSerial,
        error: null,
        message: null,
        testSummary: null,
        notesDir: null,
        stderrLog: null,
        stdoutLog: null,
        startTimeMs: null,
        endTimeMs: null
      }),
      status: "failed",
      error: terminalError
    } satisfies TaskStatus;
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

  if (caseResult.status !== "passed") {
    uploadFailureEvidence(context, testCase.id, traceId);
  }
  return { result: caseResult, submitted: true, submitError: null, terminal };
}
