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
import { errorMessage, writeFileAtomic } from "../util.js";
import {
  pngDimensions,
  resolveVisionTarget,
  visionAlwaysEnabled,
  type VisionTarget
} from "./vision.js";
import { reconcileIosTrace, type DiskIosTrace, type IosTraceDeps } from "./trace-store.js";

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
  postShot?: string;
  screen?: string;
  scale?: number;
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
  ownerPid: number;
  ownerStartedAtMs: number;
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
  settleMs?: number;
  listSimulators?: typeof listIosSimulators;
  installIpa?: (udid: string, ipaPath: string) => Promise<{ ok: boolean; error?: string }>;
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

function resolveMaxSteps(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return Math.max(1, Math.min(200, Math.floor(override)));
  const raw = Number.parseInt(env.AOS_IOS_MAX_STEPS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_STEPS;
  return Math.max(1, Math.min(200, raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_SETTLE_MS = 200;
const MAX_SETTLE_MS = 2_000;
const SCREEN_TEXT_MAX_ELEMENTS = 60;

function resolveSettleMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined) return Math.max(0, Math.min(MAX_SETTLE_MS, Math.floor(override)));
  const raw = Number.parseInt(env.AOS_IOS_SETTLE_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_SETTLE_MS;
  return Math.max(0, Math.min(MAX_SETTLE_MS, raw));
}

function screenTextSummary(nodes: IosUiNode[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const text = node.label.trim() || node.value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
    if (parts.length >= SCREEN_TEXT_MAX_ELEMENTS) break;
  }
  return parts.join(" | ").slice(0, 4_000);
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
  params: Record<string, unknown>,
  lockedAppPackage: string | null
): Promise<ActionOutcome> {
  const bundleId = typeof params.bundleId === "string" ? params.bundleId : null;
  const bundleAllowed = (): boolean =>
    lockedAppPackage === null || bundleId === lockedAppPackage;
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
      if (bundleId === null) return { kind: "step", text: "参数错误：launch 需要 bundleId" };
      if (!bundleAllowed()) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：拒绝 launch ${bundleId}（仅允许 ${lockedAppPackage}）。`
        };
      }
      await device.launch(bundleId);
      return { kind: "step", text: "ok" };
    }
    case "terminate": {
      if (bundleId === null) return { kind: "step", text: "参数错误：terminate 需要 bundleId" };
      if (!bundleAllowed()) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：拒绝 terminate ${bundleId}（仅允许 ${lockedAppPackage}）。`
        };
      }
      const ok = await device.terminate(bundleId);
      return { kind: "step", text: ok ? "ok" : "终止失败（应用可能未在运行）" };
    }
    case "openUrl": {
      if (typeof params.url !== "string") return { kind: "step", text: "参数错误：openUrl 需要 url" };
      if (lockedAppPackage !== null) {
        return {
          kind: "step",
          text: `已被 locked_app_package 限制：禁止 openUrl（仅允许目标应用 ${lockedAppPackage} 内的操作）。`
        };
      }
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
  writeFileAtomic(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function processStartedAtIso(record: IosTaskRecord): string {
  return new Date(record.ownerStartedAtMs).toISOString();
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
      pid: record.ownerPid,
      process_started_at: processStartedAtIso(record),
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
    synthesized: true,
    failed_items: [{ item_text: record.result.summary, evidence: record.result.summary }]
  };
}

function writeStatus(record: IosTaskRecord, message: string): void {
  try {
    writeJson(path.join(record.runDir, "status.json"), {
      trace_id: record.traceId,
      status: record.status,
      platform: "ios",
      device_serial: record.udid,
      task_desc: record.taskDesc,
      model: record.model,
      pid: record.ownerPid,
      process_started_at: processStartedAtIso(record),
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
  step: number,
  kind: "pre" | "post"
): Promise<{ rel: string; bytes: Buffer } | null> {
  try {
    const png = await device.screenshot();
    const shotsDir = path.join(record.runDir, "shots");
    fs.mkdirSync(shotsDir, { recursive: true });
    const name = kind === "post" ? `step-${step}-post.png` : `step-${step}.png`;
    const file = path.join(shotsDir, name);
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
  const device =
    deps.device ??
    (classifyIosSerial(record.udid) === "device"
      ? await runtime.iosWda().device(record.udid)
      : makeIosDevice(record.udid));
  const chat =
    deps.chat ??
    makeChatFn({ baseUrl: entry.baseUrl ?? "", apiKey: entry.apiKey ?? "", model: entry.model });
  const visionChat = deps.visionChat ?? (visionTarget ? makeChatFn(visionTarget.chat) : null);
  const visionAlways = visionAlwaysEnabled(process.env);
  const maxSteps = resolveMaxSteps(process.env, deps.maxSteps);
  const stepDelayMs = deps.stepDelayMs ?? 300;
  const settleMs = resolveSettleMs(process.env, deps.settleMs);
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
      const shot = await captureStepShot(device, record, step, "pre");
      const screen = screenTextSummary(nodes);
      const shotDims = shot ? pngDimensions(shot.bytes) : null;
      const scale = shotDims && size && size.width > 0 ? shotDims.width / size.width : null;
      const instruction = record.instruction;
      record.instruction = null;

      const wantsImage =
        visionChat !== null && shot !== null && (visionAlways || visibleElementCount(nodes) < MIN_TEXT_ELEMENTS);
      let visionContext: string | null = null;
      if (wantsImage && shot) {
        visionContext = shotDims
          ? `本轮附有截图：${shotDims.width}x${shotDims.height} px${
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
          ...(screen ? { screen } : {}),
          ...(scale !== null ? { scale } : {}),
          perception
        });
        persistRun(record);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        continue;
      }

      let outcome: ActionOutcome;
      try {
        outcome = await executeAction(device, parsed.action, parsed.params, record.lockedAppPackage);
      } catch (error) {
        outcome = { kind: "step", text: `执行失败: ${errorMessage(error)}` };
      }
      if (outcome.kind === "done") {
        if (settleMs > 0) await sleep(settleMs);
        const donePost = await captureStepShot(device, record, step, "post");
        record.steps.push({
          step,
          thought: parsed.thought,
          action: parsed.action,
          params: parsed.params,
          outcome: outcome.success ? "done" : "fail",
          ...(shot ? { shot: shot.rel } : {}),
          ...(donePost ? { postShot: donePost.rel } : {}),
          ...(screen ? { screen } : {}),
          ...(scale !== null ? { scale } : {}),
          perception
        });
        finalize(outcome.success ? "completed" : "failed", outcome.summary);
        return;
      }
      if (settleMs > 0) await sleep(settleMs);
      const post = await captureStepShot(device, record, step, "post");
      record.steps.push({
        step,
        thought: parsed.thought,
        action: parsed.action,
        params: parsed.params,
        outcome: outcome.text,
        ...(shot ? { shot: shot.rel } : {}),
        ...(post ? { postShot: post.rel } : {}),
        ...(screen ? { screen } : {}),
        ...(scale !== null ? { scale } : {}),
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
    ownerPid: process.pid,
    ownerStartedAtMs: Date.now() - Math.round(process.uptime() * 1000),
    stopRequested: false,
    instruction: null,
    lockedAppPackage,
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
