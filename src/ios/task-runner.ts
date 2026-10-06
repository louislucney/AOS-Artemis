import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { makeIosDevice, type IosDevice } from "../device/ios-actions.js";
import { classifyIosSerial, listIosSimulators, type IosUiNode } from "../device/ios.js";
import { makeChatFn, type ChatContent, type ChatFn, type ChatMessage } from "../llm/chat.js";
import { entryIssues, type LlmEntry } from "../llm/registry.js";
import { logWarn } from "../log.js";
import type { Runtime } from "../runtime.js";
import { errorMessage } from "../util.js";
import {
  pngDimensions,
  resolveVisionTarget,
  visionAlwaysEnabled,
  type VisionTarget
} from "./vision.js";

const DEFAULT_MAX_STEPS = 30;
const MAX_WAIT_MS = 10_000;
const HISTORY_STEPS = 6;
const PROMPT_MAX_ELEMENTS = 200;
const MIN_TEXT_ELEMENTS = 3;

export interface IosTaskStep {
  step: number;
  thought: string;
  action: string;
  params: Record<string, unknown>;
  outcome: string;
  shot?: string;
  perception?: "text" | "image" | "text-degraded";
}

export interface IosTaskRecord {
  traceId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  taskDesc: string;
  udid: string;
  model: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  steps: IosTaskStep[];
  result: { success: boolean; summary: string } | null;
  error: string | null;
  runDir: string;
  stopRequested: boolean;
  instruction: string | null;
  lockedAppPackage: string | null;
  vision: { model: string; source: VisionTarget["source"] } | null;
  visionDegraded: string | null;
}

const tasks = new Map<string, IosTaskRecord>();

export function getIosTask(traceId: string): IosTaskRecord | null {
  return tasks.get(traceId) ?? null;
}

export function __resetIosTasks(): void {
  tasks.clear();
}

export interface StartIosTaskDeps {
  device?: IosDevice;
  chat?: ChatFn;
  visionChat?: ChatFn;
  visionTarget?: VisionTarget | null;
  entry?: LlmEntry;
  maxSteps?: number;
  stepDelayMs?: number;
  listSimulators?: typeof listIosSimulators;
}

const IOS_SYSTEM_PROMPT = [
  "你是 iOS 模拟器 UI 自动化操作员，目标是完成用户给出的移动端任务。",
  "",
  "每一轮你会收到：任务、当前屏幕的元素列表（含逻辑点坐标）、最近动作历史。",
  "你必须只输出一个 JSON 对象（不要 markdown 代码块，不要任何多余文字）：",
  '{"thought":"简要推理","action":"tap","x":123,"y":456}',
  "",
  "可用 action 及参数：",
  "- tap: x, y —— 坐标必须来自列表元素的 Center（整数逻辑点）",
  "- swipe: x1, y1, x2, y2, durationMs",
  "- text: text, 可选 x, y —— ASCII 直接输入；含中文等非 ASCII 时必须给出输入框坐标",
  "- launch / terminate: bundleId",
  "- openUrl: url",
  '- alerts: mode —— "accept" 或 "dismiss"，处理系统弹窗',
  "- wait: ms —— 等待界面加载（上限 10000）",
  "- done: success(true/false), summary —— 任务完成时输出",
  "- fail: reason —— 确认无法完成时输出",
  "",
  "规则：",
  "1. 坐标只能取自元素列表的 Center，不要猜测；列表为空的先 swipe 或 wait 再观察。",
  "2. iOS 没有系统返回键（back 不可用）；需要返回时点击界面上的返回控件。",
  "3. 每步只做一个动作；完成任务立即输出 done，不要多余动作。",
  "4. 输入非 ASCII 文本（中文等）必须带输入框坐标。",
  "5. 如果连续多步没有进展，换一个思路或输出 fail 并说明原因。",
  "6. 若本轮附有截图，可用截图辅助判断；坐标仍输出逻辑点（元素 Center，或截图坐标 ÷ scale）。"
].join("\n");

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function jsonText(payload: unknown): CallToolResult {
  return textResult(JSON.stringify(payload, null, 2));
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resolveMaxSteps(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return Math.max(1, Math.min(200, Math.floor(override)));
  const raw = Number.parseInt(env.AOS_IOS_MAX_STEPS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(200, raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatScreenForPrompt(nodes: IosUiNode[], maxLines = PROMPT_MAX_ELEMENTS): string {
  const lines: string[] = [];
  let processed = 0;
  for (const node of nodes) {
    const label = node.label.trim();
    const value = node.value.trim();
    if (!label && !value) continue;
    processed += 1;
    if (lines.length >= maxLines) continue;
    const centerX = Math.round(node.rect.x + node.rect.width / 2);
    const centerY = Math.round(node.rect.y + node.rect.height / 2);
    const right = Math.round(node.rect.x + node.rect.width);
    const bottom = Math.round(node.rect.y + node.rect.height);
    const parts = [`[${lines.length + 1}] ${node.type || "Element"}`];
    if (label) parts.push(`Text: '${label}'`);
    if (value && value !== label) parts.push(`Value: '${value}'`);
    parts.push(
      `Center: (${centerX},${centerY})`,
      `Bounds: [${Math.round(node.rect.x)},${Math.round(node.rect.y)}][${right},${bottom}]`
    );
    lines.push(parts.join(" | "));
  }
  const truncated = processed - lines.length;
  if (truncated > 0) lines.push(`... (${truncated} 个元素被省略)`);
  return lines.join("\n");
}

function visibleElementCount(nodes: IosUiNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.label.trim() || node.value.trim()) count += 1;
  }
  return count;
}

function buildUserPrompt(
  record: IosTaskRecord,
  nodes: IosUiNode[],
  size: { width: number; height: number } | null,
  step: number,
  maxSteps: number,
  instruction: string | null,
  visionContext: string | null
): string {
  const screen = formatScreenForPrompt(nodes);
  const history = record.steps
    .slice(-HISTORY_STEPS)
    .map((item) => `- [${item.step}] ${item.action}(${JSON.stringify(item.params)}) → ${item.outcome}`)
    .join("\n");
  return [
    `任务：${record.taskDesc}`,
    `进度：第 ${step}/${maxSteps} 步`,
    `屏幕逻辑尺寸：${size ? `${size.width}x${size.height} pt` : "未知（以元素 Center 为准）"}`,
    ...(visionContext ? [visionContext] : []),
    "",
    "当前屏幕元素：",
    screen || "(当前没有可读元素；可先 swipe/wait 再观察，或结合截图判断)",
    "",
    "最近动作：",
    history || "(无)",
    instruction ? `\n最新人工指令（优先遵守）：${instruction}` : "",
    "",
    "请输出下一个动作 JSON（只输出 JSON）。"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function extractJson(content: string): { thought: string; action: string; params: Record<string, unknown> } | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.action !== "string" || record.action.trim() === "") return null;
  const { thought, action, ...params } = record;
  return {
    thought: typeof thought === "string" ? thought : "",
    action: action.trim(),
    params
  };
}

type ActionOutcome = { kind: "step"; text: string } | { kind: "done"; success: boolean; summary: string };

async function executeAction(
  device: IosDevice,
  action: string,
  params: Record<string, unknown>
): Promise<ActionOutcome> {
  switch (action) {
    case "tap": {
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      if (x === null || y === null) return { kind: "step", text: "参数错误：tap 需要数字 x/y" };
      await device.tap(x, y);
      return { kind: "step", text: "ok" };
    }
    case "swipe": {
      const x1 = asNumber(params.x1);
      const y1 = asNumber(params.y1);
      const x2 = asNumber(params.x2);
      const y2 = asNumber(params.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) {
        return { kind: "step", text: "参数错误：swipe 需要数字 x1/y1/x2/y2" };
      }
      await device.swipe(x1, y1, x2, y2, asNumber(params.durationMs) ?? 300);
      return { kind: "step", text: "ok" };
    }
    case "text": {
      if (typeof params.text !== "string") return { kind: "step", text: "参数错误：text 需要字符串 text" };
      const x = asNumber(params.x);
      const y = asNumber(params.y);
      const result = await device.inputText(params.text, x !== null && y !== null ? { x, y } : undefined);
      return { kind: "step", text: `输入完成（${result.mode}）` };
    }
    case "launch": {
      if (typeof params.bundleId !== "string") return { kind: "step", text: "参数错误：launch 需要 bundleId" };
      await device.launch(params.bundleId);
      return { kind: "step", text: "ok" };
    }
    case "terminate": {
      if (typeof params.bundleId !== "string") return { kind: "step", text: "参数错误：terminate 需要 bundleId" };
      const ok = await device.terminate(params.bundleId);
      return { kind: "step", text: ok ? "ok" : "终止失败（应用可能未在运行）" };
    }
    case "openUrl": {
      if (typeof params.url !== "string") return { kind: "step", text: "参数错误：openUrl 需要 url" };
      await device.openUrl(params.url);
      return { kind: "step", text: "ok" };
    }
    case "alerts": {
      const mode = params.mode === "dismiss" ? "dismiss" : params.mode === "keep" ? "keep" : "accept";
      const result = await device.handleAlerts({ mode });
      return { kind: "step", text: `处理弹窗 ${result.handled} 个` };
    }
    case "wait": {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, asNumber(params.ms) ?? 1000));
      await sleep(ms);
      return { kind: "step", text: `等待 ${ms}ms` };
    }
    case "back":
      return {
        kind: "step",
        text: "iOS 无系统返回键（capabilities.back=none）；请点击界面上的返回控件"
      };
    case "done": {
      const summary = typeof params.summary === "string" && params.summary.trim() !== ""
        ? params.summary.trim()
        : "任务完成";
      return { kind: "done", success: params.success !== false, summary };
    }
    case "fail": {
      const reason = typeof params.reason === "string" && params.reason.trim() !== ""
        ? params.reason.trim()
        : "模型判定无法完成";
      return { kind: "done", success: false, summary: reason };
    }
    default:
      return { kind: "step", text: `未知动作 ${action}（已忽略）` };
  }
}

function writeJson(file: string, payload: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function persistRun(record: IosTaskRecord): void {
  try {
    writeJson(path.join(record.runDir, "run.json"), {
      schema_version: 1,
      trace_id: record.traceId,
      platform: "ios",
      device_serial: record.udid,
      task_desc: record.taskDesc,
      model: record.model,
      status: record.status,
      started_at: new Date(record.startedAtMs).toISOString(),
      finished_at: record.finishedAtMs ? new Date(record.finishedAtMs).toISOString() : null,
      steps: record.steps,
      result: record.result,
      error: record.error,
      vision: record.vision,
      vision_degraded: record.visionDegraded
    });
  } catch (error) {
    logWarn(`iOS 任务 run.json 写入失败（${record.traceId}）: ${errorMessage(error)}`);
  }
}

function testSummaryFor(record: IosTaskRecord): Record<string, unknown> | null {
  if (record.status !== "failed" || !record.result) return null;
  return {
    task_status: "failed",
    passed: 0,
    failed: 1,
    inconclusive: 0,
    unchecked: 0,
    failed_items: [{ item_text: record.result.summary, evidence: record.result.summary }]
  };
}

function writeStatus(record: IosTaskRecord, message: string): void {
  try {
    writeJson(path.join(record.runDir, "status.json"), {
      trace_id: record.traceId,
      status: record.status,
      device_serial: record.udid,
      task_desc: record.taskDesc,
      model: record.model,
      message,
      ...(record.error ? { error: record.error } : {}),
      ...(testSummaryFor(record) ? { test_summary: testSummaryFor(record) } : {}),
      start_time: record.startedAtMs / 1000,
      end_time: record.finishedAtMs ? record.finishedAtMs / 1000 : null
    });
  } catch (error) {
    logWarn(`iOS 任务 status.json 写入失败（${record.traceId}）: ${errorMessage(error)}`);
  }
}

function finish(record: IosTaskRecord, status: IosTaskRecord["status"], summary: string): void {
  record.status = status;
  record.finishedAtMs = Date.now();
  if (status === "completed") record.result = { success: true, summary };
  if (status === "failed") record.result = { success: false, summary };
  if (status === "cancelled") record.result = { success: false, summary };
  if (status === "failed") record.error = record.error ?? summary;
  persistRun(record);
  writeStatus(record, summary);
}

async function captureStepShot(
  device: IosDevice,
  record: IosTaskRecord,
  step: number
): Promise<{ rel: string; bytes: Buffer } | null> {
  try {
    const png = await device.screenshot();
    const shotsDir = path.join(record.runDir, "shots");
    fs.mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `step-${step}.png`);
    fs.writeFileSync(file, png);
    return { rel: path.relative(record.runDir, file), bytes: png };
  } catch {
    return null;
  }
}

async function runLoop(
  runtime: Runtime,
  record: IosTaskRecord,
  entry: LlmEntry,
  visionTarget: VisionTarget | null,
  deps: StartIosTaskDeps
): Promise<void> {
  const device = deps.device ?? makeIosDevice(record.udid);
  const chat =
    deps.chat ??
    makeChatFn({ baseUrl: entry.baseUrl ?? "", apiKey: entry.apiKey ?? "", model: entry.model });
  const visionChat = deps.visionChat ?? (visionTarget ? makeChatFn(visionTarget.chat) : null);
  const visionAlways = visionAlwaysEnabled(process.env);
  const maxSteps = resolveMaxSteps(process.env, deps.maxSteps);
  const stepDelayMs = deps.stepDelayMs ?? 300;
  const messages: ChatMessage[] = [{ role: "system", content: IOS_SYSTEM_PROMPT }];

  const finalize = (status: "completed" | "failed" | "cancelled", summary: string): void => {
    finish(record, status, summary);
    if (runtime.crashCaptureEnabled()) {
      const processName = record.lockedAppPackage
        ? record.lockedAppPackage.split(".").pop() ?? null
        : null;
      void runtime.captureIosCrashes({
        traceId: record.traceId,
        udid: record.udid,
        processName,
        startMs: record.startedAtMs,
        endMs: record.finishedAtMs ?? Date.now()
      });
    }
  };

  try {
    if (record.lockedAppPackage) {
      try {
        await device.launch(record.lockedAppPackage);
        await sleep(1000);
      } catch (error) {
        finalize("failed", `启动应用 ${record.lockedAppPackage} 失败: ${errorMessage(error)}`);
        return;
      }
    }
    for (let step = 1; step <= maxSteps; step += 1) {
      if (record.stopRequested) {
        finalize("cancelled", "任务已被停止");
        return;
      }
      let nodes: IosUiNode[];
      try {
        nodes = await device.nodes();
      } catch (error) {
        finalize("failed", `观察屏幕失败: ${errorMessage(error)}`);
        return;
      }
      let size: { width: number; height: number } | null = null;
      try {
        size = await device.size();
      } catch {
        size = null;
      }
      const shot = await captureStepShot(device, record, step);
      const instruction = record.instruction;
      record.instruction = null;

      const wantsImage =
        visionChat !== null && shot !== null && (visionAlways || visibleElementCount(nodes) < MIN_TEXT_ELEMENTS);
      let visionContext: string | null = null;
      if (wantsImage && shot) {
        const dims = pngDimensions(shot.bytes);
        const scale = dims && size && size.width > 0 ? dims.width / size.width : null;
        visionContext = dims
          ? `本轮附有截图：${dims.width}x${dims.height} px${
              size ? `（逻辑 ${size.width}x${size.height} pt${scale ? `，scale≈${scale.toFixed(2)}` : ""}）` : ""
            }；坐标以元素 Center 为准，若从截图估计请先除以 scale。`
          : "本轮附有截图；坐标以元素 Center 为准。";
      }
      const textPrompt = buildUserPrompt(record, nodes, size, step, maxSteps, instruction, visionContext);

      let content: string;
      let perception: IosTaskStep["perception"] = "text";
      if (wantsImage && visionChat && shot) {
        const imageParts: ChatContent = [
          { type: "text", text: textPrompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${shot.bytes.toString("base64")}` } }
        ];
        messages.push({ role: "user", content: imageParts });
        try {
          content = await visionChat(messages);
          perception = "image";
        } catch (error) {
          record.visionDegraded = record.visionDegraded ?? `视觉调用失败：${errorMessage(error)}`;
          logWarn(`iOS 视觉降级为纯文本（${record.traceId}）: ${errorMessage(error)}`);
          messages[messages.length - 1] = { role: "user", content: textPrompt };
          perception = "text-degraded";
          try {
            content = await chat(messages);
          } catch (fallbackError) {
            finalize("failed", `LLM 调用失败: ${errorMessage(fallbackError)}`);
            return;
          }
        }
      } else {
        messages.push({ role: "user", content: textPrompt });
        try {
          content = await chat(messages);
        } catch (error) {
          finalize("failed", `LLM 调用失败: ${errorMessage(error)}`);
          return;
        }
      }
      messages.push({ role: "assistant", content });

      const parsed = extractJson(content);
      if (!parsed) {
        record.steps.push({
          step,
          thought: "",
          action: "invalid",
          params: { raw: content.slice(0, 200) },
          outcome: "模型输出不是合法动作 JSON",
          ...(shot ? { shot: shot.rel } : {}),
          perception
        });
        persistRun(record);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        continue;
      }

      let outcome: ActionOutcome;
      try {
        outcome = await executeAction(device, parsed.action, parsed.params);
      } catch (error) {
        outcome = { kind: "step", text: `执行失败: ${errorMessage(error)}` };
      }
      if (outcome.kind === "done") {
        record.steps.push({
          step,
          thought: parsed.thought,
          action: parsed.action,
          params: parsed.params,
          outcome: outcome.success ? "done" : "fail",
          ...(shot ? { shot: shot.rel } : {}),
          perception
        });
        finalize(outcome.success ? "completed" : "failed", outcome.summary);
        return;
      }
      record.steps.push({
        step,
        thought: parsed.thought,
        action: parsed.action,
        params: parsed.params,
        outcome: outcome.text,
        ...(shot ? { shot: shot.rel } : {}),
        perception
      });
      persistRun(record);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }
    finalize("failed", `超出步数上限（${maxSteps}），任务未完成`);
  } catch (error) {
    finalize("failed", `执行器异常: ${errorMessage(error)}`);
  }
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
  const traceId = `ios-${randomUUID()}`;
  const failStart = (error: string): CallToolResult =>
    jsonText({ trace_id: traceId, status: "failed", device_serial: serial, error });
  if (!taskDesc) return failStart("task_desc 不能为空。");

  const entry = deps.entry ?? (await runtime.activeEntry());
  const issues = entry ? entryIssues(entry) : ["未配置 LLM"];
  if (!entry || issues.length > 0) {
    return failStart(`iOS 执行器需要可用的 active LLM：${issues.join("；")}。`);
  }

  if (serialKind === "simulator") {
    const listSimulators = deps.listSimulators ?? listIosSimulators;
    const listed = await listSimulators({});
    if (!listed.ok) return failStart(`无法读取模拟器列表（${listed.error}）。`);
    const simulator = listed.simulators.find((item) => item.udid === serial);
    if (!simulator) return failStart(`未找到模拟器 ${serial}。`);
    if (simulator.state !== "Booted") {
      return failStart(`模拟器 ${simulator.name || serial} 未启动（state=${simulator.state}）；请先执行 xcrun simctl boot ${serial}。`);
    }
  }

  const runDir = runtime.traceDir(traceId);
  fs.mkdirSync(path.join(runDir, "shots"), { recursive: true });
  const visionTarget =
    deps.visionTarget !== undefined
      ? deps.visionTarget
      : resolveVisionTarget(process.env, await runtime.entries(), entry);
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
    stopRequested: false,
    instruction: null,
    lockedAppPackage:
      typeof args.locked_app_package === "string" && args.locked_app_package.trim() !== ""
        ? args.locked_app_package.trim()
        : null,
    vision: visionTarget ? { model: visionTarget.model, source: visionTarget.source } : null,
    visionDegraded: null
  };
  tasks.set(traceId, record);
  persistRun(record);
  writeStatus(record, "iOS 任务已启动（AOS 执行器）");
  void runtime.recordTaskResult({
    isError: false,
    traceId,
    model: entry.model,
    taskDesc,
    lockedAppPackage: typeof args.locked_app_package === "string" ? args.locked_app_package : null
  });
  void runLoop(runtime, record, entry, visionTarget, deps);

  return jsonText({
    trace_id: traceId,
    status: "running",
    device_serial: serial,
    model: entry.model,
    ...(record.vision ? { vision: record.vision } : {}),
    message:
      `iOS 任务已由 AOS 执行器接手（task='${taskDesc}'）。\n` +
      `Trace ID: ${traceId}\n` +
      "注意：iOS 任务没有主动唤醒通知，请用 mobile_manage_task(action=\"status\") 轮询。",
    run_dir: runDir,
    status_file: path.join(runDir, "status.json")
  });
}

function statusPayload(record: IosTaskRecord): Record<string, unknown> {
  const last = record.steps[record.steps.length - 1];
  return {
    trace_id: record.traceId,
    status: record.status,
    device_serial: record.udid,
    task_desc: record.taskDesc,
    model: record.model,
    elapsed_seconds: Math.round(((record.finishedAtMs ?? Date.now()) - record.startedAtMs) / 1000),
    progress: {
      current_step: record.steps.length,
      last_thought: last?.thought ?? null,
      last_action: last ? { action: last.action, params: last.params, outcome: last.outcome } : null
    },
    recent_steps: record.steps.slice(-5),
    ...(testSummaryFor(record) ? { test_summary: testSummaryFor(record) } : {}),
    ...(record.vision ? { vision: record.vision } : {}),
    ...(record.visionDegraded ? { vision_degraded: record.visionDegraded } : {}),
    ...(record.result ? { result: record.result } : {}),
    ...(record.error ? { error: record.error } : {}),
    run_dir: record.runDir
  };
}

/** Route `mobile_manage_task` to the in-process iOS runner for iOS trace ids;
 * returns null to keep the ARTEMIS passthrough otherwise. */
export function maybeIosManageTask(args: Record<string, unknown>): CallToolResult | null {
  const traceId = typeof args.trace_id === "string" ? args.trace_id.trim() : "";
  const record = traceId ? getIosTask(traceId) : null;
  if (!record) return null;
  const action = typeof args.action === "string" ? args.action : "";
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
