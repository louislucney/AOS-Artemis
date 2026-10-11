import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { IosDevice } from "../device/ios-actions.js";
import { classifyIosSerial, listIosSimulators } from "../device/ios.js";
import type { IosLogWindowRequest } from "../device/ios-log.js";
import type { LogcatWindowResult } from "../device/logcat.js";
import type { ChatFn } from "../llm/chat.js";
import { entryIssues, type LlmEntry } from "../llm/registry.js";
import type { Runtime } from "../runtime.js";
import { getIosTask, registerIosTask } from "./task-registry.js";
import { runLoop } from "./run-loop.js";
import {
  IOS_TRACE_PREFIX,
  reconcileIosTrace,
  type DiskIosTrace,
  type IosTraceDeps
} from "./trace-store.js";
import { persistRun, testSummaryFor, writeStatus } from "./trace-persist.js";
import type { IosTaskRecord, IosTaskStep, VerifierTarget } from "./types.js";
import { resolveVisionTarget, type VisionTarget } from "./vision.js";

export interface StartIosTaskDeps {
  device?: IosDevice;
  chat?: ChatFn;
  visionChat?: ChatFn;
  visionTarget?: VisionTarget | null;
  entry?: LlmEntry;
  maxSteps?: number;
  stepDelayMs?: number;
  settleMs?: number;
  listSimulators?: typeof listIosSimulators;
  installIpa?: (udid: string, ipaPath: string) => Promise<{ ok: boolean; error?: string }>;
  mainVision?: boolean;
  verifier?: VerifierTarget | null;
  env?: NodeJS.ProcessEnv;
  logTail?: { start(): void; stop(): void; snapshot(): string[] } | null;
  logCollector?: { collect(request: IosLogWindowRequest): Promise<LogcatWindowResult> };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonText(payload: unknown): CallToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

const TRACKED_PARAMS = [
  "model",
  "verification_level",
  "explorer_mode",
  "expected_output_desc",
  "conversation_id"
] as const;

const IGNORED_PARAM_ACTUALS: Record<string, string> = {
  verification_level: "unsupported-on-ios",
  explorer_mode: "unsupported-on-ios",
  expected_output_desc: "unsupported-on-ios",
  conversation_id: "poll-only"
};

interface IosWarning {
  code: "param_ignored";
  field: string;
  actual: string | null;
}

function iosWarnings(args: Record<string, unknown>, model: string | null): IosWarning[] {
  const warnings: IosWarning[] = [];
  for (const field of TRACKED_PARAMS) {
    if (args[field] === undefined || args[field] === null) continue;
    warnings.push({
      code: "param_ignored",
      field,
      actual: field === "model" ? model : IGNORED_PARAM_ACTUALS[field] ?? "unsupported-on-ios"
    });
  }
  return warnings;
}

/** Start the AOS-side iOS runner for `mobile_run_task` when the target serial
 * is a simulator UDID; returns null to keep the ARTEMIS path otherwise. */
export async function maybeIosRunTask(
  runtime: Runtime,
  args: Record<string, unknown>,
  deps: StartIosTaskDeps = {}
): Promise<CallToolResult | null> {
  const serial = typeof args.device_serial === "string" ? args.device_serial.trim() : "";
  const serialKind = classifyIosSerial(serial);
  if (!serial || !serialKind) return null;

  const taskDesc = typeof args.task_desc === "string" ? args.task_desc.trim() : "";
  const traceId = `${IOS_TRACE_PREFIX}${randomUUID()}`;
  const lockedAppPackage =
    typeof args.locked_app_package === "string" && args.locked_app_package.trim() !== ""
      ? args.locked_app_package.trim()
      : null;
  const failStart = (error: string, code?: string, model: string | null = null): CallToolResult => {
    void runtime.recordTaskResult({
      isError: true,
      taskDesc: taskDesc || null,
      model,
      lockedAppPackage
    });
    return jsonText({
      trace_id: traceId,
      status: "failed",
      device_serial: serial,
      ...(code ? { code } : {}),
      error,
      warnings: iosWarnings(args, model)
    });
  };
  if (!taskDesc) return failStart("task_desc 不能为空。");
  let appPath: string | null = null;
  if (typeof args.app_path === "string" && args.app_path.trim() !== "") {
    if (serialKind !== "device") {
      return failStart(
        "iOS 模拟器不支持 app_path（APK 预装语义）；请改用 locked_app_package 指向已安装应用。",
        "app_path_unsupported"
      );
    }
    const raw = args.app_path.trim();
    const resolved = path.isAbsolute(raw) ? raw : path.join(runtime.project.rootDir, raw);
    if (!fs.existsSync(resolved)) {
      return failStart(`app_path 指向的 .ipa 不存在：${resolved}`, "app_path_not_found");
    }
    appPath = resolved;
  }

  const entry = deps.entry ?? (await runtime.activeEntry());
  const issues = entry ? entryIssues(entry) : ["未配置 LLM"];
  if (!entry || issues.length > 0) {
    return failStart(
      `iOS 执行器需要可用的 active LLM：${issues.join("；")}。`,
      undefined,
      entry?.model ?? null
    );
  }

  if (serialKind === "simulator") {
    const listSimulators = deps.listSimulators ?? listIosSimulators;
    const listed = await listSimulators({});
    if (!listed.ok) {
      return failStart(`无法读取模拟器列表（${listed.error}）。`, undefined, entry.model);
    }
    const simulator = listed.simulators.find((item) => item.udid === serial);
    if (!simulator) return failStart(`未找到模拟器 ${serial}。`, undefined, entry.model);
    if (simulator.state !== "Booted") {
      return failStart(
        `模拟器 ${simulator.name || serial} 未启动（state=${simulator.state}）；请先执行 xcrun simctl boot ${serial}。`,
        undefined,
        entry.model
      );
    }
  }

  if (appPath !== null) {
    const install =
      deps.installIpa ?? ((udid: string, ipa: string) => runtime.iosWda().installIpa(udid, ipa));
    const installed = await install(serial, appPath);
    if (!installed.ok) {
      return failStart(`.ipa 安装失败：${installed.error ?? "unknown"}`, "install_failed", entry.model);
    }
  }

  const runDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });
  const layeredEnv = deps.env ?? runtime.iosEnvironment();
  const visionTarget =
    deps.visionTarget !== undefined
      ? deps.visionTarget
      : resolveVisionTarget(layeredEnv, await runtime.entries(), entry);
  const record: IosTaskRecord = {
    traceId,
    status: "running",
    taskDesc,
    udid: serial,
    model: entry.model,
    startedAtMs: Date.now(),
    finishedAtMs: null,
    steps: [],
    result: null,
    error: null,
    runDir,
    ownerPid: process.pid,
    ownerStartedAtMs: Date.now() - Math.round(process.uptime() * 1000),
    stopRequested: false,
    instruction: null,
    lockedAppPackage,
    vision: visionTarget ? { model: visionTarget.model, source: visionTarget.source } : null,
    visionDegraded: null,
    noopStreak: 0,
    digest: null,
    verification: null,
    failureLogs: null,
    visionDropped: null,
    scriptAdherence: null,
    preflight: null
  };
  registerIosTask(traceId, record);
  persistRun(record);
  writeStatus(record, "iOS 任务已启动（AOS 执行器）");
  void runtime.recordTaskResult({
    isError: false,
    traceId,
    model: entry.model,
    taskDesc,
    lockedAppPackage
  });
  void runLoop(runtime, record, entry, visionTarget, deps);

  return jsonText({
    trace_id: traceId,
    status: "running",
    device_serial: serial,
    model: entry.model,
    warnings: iosWarnings(args, entry.model),
    ...(record.vision ? { vision: record.vision } : {}),
    message:
      `iOS 任务已由 AOS 执行器接手（task='${taskDesc}'）。\n` +
      `Trace ID: ${traceId}\n` +
      "注意：iOS 任务没有主动唤醒通知，请用 mobile_manage_task(action=\"status\") 轮询。",
    run_dir: runDir,
    status_file: path.join(runDir, "status.json")
  });
}

interface StatusView {
  traceId: string;
  status: string;
  udid: string | null;
  taskDesc: string | null;
  model: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  steps: IosTaskStep[];
  result: { success: boolean; summary: string } | null;
  error: string | null;
  vision: IosTaskRecord["vision"];
  visionDegraded: string | null;
  runDir: string;
  testSummary: Record<string, unknown> | null;
}

function statusPayloadOf(view: StatusView, extras: Record<string, unknown> = {}): Record<string, unknown> {
  const last = view.steps[view.steps.length - 1];
  const elapsedSeconds =
    view.startedAtMs !== null
      ? Math.max(0, Math.round(((view.finishedAtMs ?? Date.now()) - view.startedAtMs) / 1000))
      : null;
  return {
    trace_id: view.traceId,
    status: view.status,
    device_serial: view.udid,
    task_desc: view.taskDesc,
    model: view.model,
    elapsed_seconds: elapsedSeconds,
    progress: {
      current_step: view.steps.length,
      last_thought: last?.thought ?? null,
      last_action: last ? { action: last.action, params: last.params, outcome: last.outcome } : null
    },
    recent_steps: view.steps.slice(-5),
    ...(view.testSummary ? { test_summary: view.testSummary } : {}),
    ...(view.vision ? { vision: view.vision } : {}),
    ...(view.visionDegraded ? { vision_degraded: view.visionDegraded } : {}),
    ...(view.result ? { result: view.result } : {}),
    ...(view.error ? { error: view.error } : {}),
    run_dir: view.runDir,
    ...extras
  };
}

function statusPayload(record: IosTaskRecord): Record<string, unknown> {
  return statusPayloadOf({
    traceId: record.traceId,
    status: record.status,
    udid: record.udid,
    taskDesc: record.taskDesc,
    model: record.model,
    startedAtMs: record.startedAtMs,
    finishedAtMs: record.finishedAtMs,
    steps: record.steps,
    result: record.result,
    error: record.error,
    vision: record.vision,
    visionDegraded: record.visionDegraded,
    runDir: record.runDir,
    testSummary: testSummaryFor(record)
  });
}

function diskStatusPayload(trace: DiskIosTrace): Record<string, unknown> {
  return statusPayloadOf(
    {
      traceId: trace.traceId,
      status: trace.status,
      udid: trace.udid,
      taskDesc: trace.taskDesc,
      model: trace.model,
      startedAtMs: trace.startedAtMs,
      finishedAtMs: trace.finishedAtMs,
      steps: trace.steps,
      result: trace.result,
      error: trace.error,
      vision: trace.vision,
      visionDegraded: trace.visionDegraded,
      runDir: trace.runDir,
      testSummary: trace.testSummary
    },
    {
      source: "disk",
      ...(trace.pid !== null ? { pid: trace.pid } : {}),
      ...(trace.alive !== null ? { alive: trace.alive } : {}),
      ...(trace.stale ? { stale: true } : {}),
      ...(trace.note ? { note: trace.note } : {})
    }
  );
}

/** Route `mobile_manage_task` to the iOS runner: the in-process record first,
 * then the trace directory on disk (cross-process reads reconcile a `running`
 * trace whose owner process is gone into `orphaned`). Returns null to keep
 * the ARTEMIS passthrough otherwise. */
export function maybeIosManageTask(
  runtime: Runtime,
  args: Record<string, unknown>,
  deps: IosTraceDeps = {}
): CallToolResult | null {
  const traceId = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
  const action = typeof args.action === "string" ? args.action : "";
  const record = traceId ? getIosTask(traceId) : null;
  if (record) {
    switch (action) {
      case "status":
        return jsonText(statusPayload(record));
      case "stop": {
        record.stopRequested = true;
        const message =
          record.status === "running" ? "已请求停止（本轮动作完成后退出）。" : `任务已是终态（${record.status}）。`;
        return jsonText({ trace_id: record.traceId, status: record.status, message });
      }
      case "inject_instruction": {
        const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
        if (!instruction && args.release_loop !== true) {
          return jsonText({ trace_id: record.traceId, error: "inject_instruction 需要 instruction。" });
        }
        record.instruction = instruction || null;
        return jsonText({
          trace_id: record.traceId,
          status: record.status,
          message: instruction ? "指令已注入，将在下一轮生效。" : "已清除待注入指令。"
        });
      }
      default:
        return jsonText({
          trace_id: record.traceId,
          error: `iOS 执行器不支持 action=${action}（支持 status/stop/inject_instruction）。`
        });
    }
  }

  if (!traceId) return null;
  const trace = reconcileIosTrace(runtime.traceDir(traceId), traceId, deps);
  if (!trace) return null;
  switch (action) {
    case "status":
      return jsonText(diskStatusPayload(trace));
    case "stop": {
      if (trace.status === "running") {
        return jsonText({
          trace_id: trace.traceId,
          status: trace.status,
          message: `任务由进程 ${trace.pid ?? "?"} 执行，无法从此进程停止；请在其执行进程内操作或等待完成。`
        });
      }
      return jsonText({
        trace_id: trace.traceId,
        status: trace.status,
        message: `任务已是终态（${trace.status}）。`
      });
    }
    case "inject_instruction": {
      const instruction = typeof args.instruction === "string" ? args.instruction.trim() : "";
      if (!instruction && args.release_loop !== true) {
        return jsonText({ trace_id: trace.traceId, error: "inject_instruction 需要 instruction。" });
      }
      return jsonText({
        trace_id: trace.traceId,
        status: trace.status,
        message:
          trace.status === "running"
            ? "任务由其他进程执行，指令无法跨进程注入。"
            : `任务已是终态（${trace.status}），指令未注入。`
      });
    }
    default:
      return jsonText({
        trace_id: trace.traceId,
        error: `iOS 执行器不支持 action=${action}（支持 status/stop/inject_instruction）。`
      });
  }
}
