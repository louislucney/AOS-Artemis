import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { makeIosDevice, type IosDevice } from "../device/ios-actions.js";
import { classifyIosSerial, listIosSimulators, type IosUiNode } from "../device/ios.js";
import {
  filterDeviceLogLines,
  IosDeviceLogTail,
  IosLogCollector,
  type IosLogWindowRequest
} from "../device/ios-log.js";
import type { LogcatWindowResult } from "../device/logcat.js";
import { makeChatFn, type ChatContent, type ChatFn, type ChatMessage } from "../llm/chat.js";
import { entryIssues, type LlmEntry } from "../llm/registry.js";
import { logWarn } from "../log.js";
import { isExploreKind, type StepKind } from "../provenance.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import {
  looksVisionCapable,
  pngDimensions,
  resolveVisionMode,
  resolveVisionTarget,
  type IosVisionMode,
  type VisionTarget
} from "./vision.js";
import { croppedScreenshotHash, digestLineForStep, screenSignature } from "./noop.js";
import { annotateOcclusionWarnings, computeOcclusions, screenAreaOf } from "./occlusion.js";
import { buildPerceptionPrompt, fuseVisionElements, parseVisionElements } from "./perception.js";
import { reconcileIosTrace, type DiskIosTrace, type IosTraceDeps } from "./trace-store.js";

const DEFAULT_MAX_STEPS = 30;
const MAX_WAIT_MS = 10_000;
const DEFAULT_HISTORY_STEPS = 8;
const MIN_HISTORY_STEPS = 4;
const MAX_HISTORY_STEPS = 20;
const HISTORY_DIGEST_MAX_CHARS = 800;
const PROMPT_MAX_ELEMENTS = 200;
const MIN_TEXT_ELEMENTS = 3;
const VISION_MAX_LINES = 30;

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
  perception?: "text" | "image" | "vision-text" | "text-degraded";
  noop?: boolean;
  /** 本条步骤观测时新命中的脚本断言序号（【AOS-EXPECT】，确定性核对）。 */
  scriptHits?: number[];
}

export interface IosScriptExpectation {
  index: number;
  screen: string | null;
  hints: string[];
  /** `explore` (deferred) steps are recorded but never gate adherence;
   * absent kind in the 【AOS-EXPECT】 payload = assert (legacy artifacts). */
  kind: StepKind;
}

export interface IosScriptPreflight {
  /** Screen the case expects the journey to start on. */
  screen: string;
  hints: string[];
  /** pending → matched/unmatched on first observation; unchecked when hints are empty. */
  status: "pending" | "matched" | "unmatched" | "unchecked";
  matchedAtStep: number | null;
}

export interface IosScriptPlan {
  /** Deterministic start-state check target (from the 【AOS-EXPECT】 block). */
  start: { screen: string; hints: string[] } | null;
  steps: IosScriptExpectation[];
}

export interface IosScriptAdherence {
  /** 可核对断言数（hints 非空，仅 assert 类）。 */
  checkable: number;
  /** 已命中（hints 全部在某个观测中出现）的可核对断言数。 */
  satisfied: number;
  /** 无 hints、无法确定性核对的断言数（仅 assert 类）。 */
  unchecked: number;
  /** 全程未出现过的可核对断言（仅 assert 类）。 */
  unresolved: Array<{ index: number; screen: string | null; hints: string[] }>;
  /** 探索（deferred）步骤：不参与门禁；`reached` 为目标屏名作为**完整可见标签**出现的条数。 */
  deferred: { total: number; reached: number };
}

const SCRIPT_EXPECT_MARKER = "【AOS-EXPECT】";

function scriptHintsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((hint): hint is string => typeof hint === "string" && hint.trim() !== "")
        .map((hint) => hint.trim())
    : [];
}

/** Parse the machine-readable plan block emitted by figma_generate_tests
 * (`【AOS-EXPECT】{"start":{screen,hints},"steps":[{index,screen,hints,kind?}]}`).
 * Returns null when the block is absent/invalid/empty. */
export function parseScriptPlan(taskDesc: string): IosScriptPlan | null {
  const line = taskDesc.split("\n").find((entry) => entry.includes(SCRIPT_EXPECT_MARKER));
  if (!line) return null;
  const raw = line.slice(line.indexOf(SCRIPT_EXPECT_MARKER) + SCRIPT_EXPECT_MARKER.length).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let start: IosScriptPlan["start"] = null;
  const startRaw = record.start;
  if (startRaw && typeof startRaw === "object" && !Array.isArray(startRaw)) {
    const startRecord = startRaw as Record<string, unknown>;
    const screen =
      typeof startRecord.screen === "string" && startRecord.screen.trim() !== ""
        ? startRecord.screen.trim()
        : "";
    if (screen) start = { screen, hints: scriptHintsOf(startRecord.hints) };
  }
  const expectations: IosScriptExpectation[] = [];
  const steps = record.steps;
  if (Array.isArray(steps)) {
    for (const entry of steps) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const stepRecord = entry as Record<string, unknown>;
      const index =
        typeof stepRecord.index === "number" && Number.isFinite(stepRecord.index)
          ? Math.floor(stepRecord.index)
          : expectations.length + 1;
      const screen =
        typeof stepRecord.screen === "string" && stepRecord.screen.trim() !== ""
          ? stepRecord.screen.trim()
          : null;
      expectations.push({
        index,
        screen,
        hints: scriptHintsOf(stepRecord.hints),
        kind: isExploreKind(stepRecord.kind) ? "explore" : "assert"
      });
    }
  }
  if (!start && expectations.length === 0) return null;
  return { start, steps: expectations };
}

const normalizeMatchText = (value: string): string => value.replace(/\s+/g, "");

function matchScriptExpectations(
  expectations: IosScriptExpectation[],
  satisfied: Set<number>,
  screenText: string
): number[] {
  const normalized = normalizeMatchText(screenText);
  const labels = new Set(
    screenText
      .split(" | ")
      .map((part) => normalizeMatchText(part))
      .filter((part) => part !== "")
  );
  const hits: number[] = [];
  for (const expectation of expectations) {
    if (satisfied.has(expectation.index)) continue;
    const hintMatch =
      expectation.hints.length > 0 &&
      expectation.hints.every((hint) => normalized.includes(normalizeMatchText(hint)));
    // Exploration targets match only as a complete visible label (never as a
    // loose substring), so short screen names cannot fake `reached`.
    const screenMatch =
      expectation.kind === "explore" &&
      expectation.screen !== null &&
      labels.has(normalizeMatchText(expectation.screen));
    if (hintMatch || screenMatch) {
      satisfied.add(expectation.index);
      hits.push(expectation.index);
    }
  }
  return hits;
}

function buildScriptAdherence(
  expectations: IosScriptExpectation[],
  satisfied: Set<number>
): IosScriptAdherence {
  const assertions = expectations.filter((expectation) => expectation.kind === "assert");
  const explorations = expectations.filter((expectation) => expectation.kind === "explore");
  const checkable = assertions.filter((expectation) => expectation.hints.length > 0);
  const unresolved = checkable
    .filter((expectation) => !satisfied.has(expectation.index))
    .map((expectation) => ({
      index: expectation.index,
      screen: expectation.screen,
      hints: expectation.hints
    }));
  return {
    checkable: checkable.length,
    satisfied: checkable.length - unresolved.length,
    unchecked: assertions.length - checkable.length,
    unresolved,
    deferred: {
      total: explorations.length,
      reached: explorations.filter((expectation) => satisfied.has(expectation.index)).length
    }
  };
}

function formatUnresolvedScriptItems(items: IosScriptAdherence["unresolved"]): string {
  return items
    .map(
      (item) =>
        `步骤${item.index}${item.screen ? `（${item.screen}）` : ""} 预期「${item.hints.join("」「")}」`
    )
    .join("；");
}

export interface IosVerificationItem {
  item_text: string;
  evidence: string;
  region?: unknown;
}

export interface IosVerification {
  status: "passed" | "failed" | "unavailable";
  model: string | null;
  reason: string;
  failedItems: IosVerificationItem[];
  stale: boolean;
}

export interface IosFailureLogs {
  status: "ok" | "skipped";
  source: "simctl-log" | "idevicesyslog" | "none";
  reason?: string;
  rel?: string;
  lines?: number;
}

export interface IosVisionDropped {
  invalid: number;
  noScale: number;
  duplicate: number;
  overflow: number;
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
  noopStreak: number;
  digest: string | null;
  verification: IosVerification | null;
  failureLogs: IosFailureLogs | null;
  visionDropped: IosVisionDropped | null;
  scriptAdherence: IosScriptAdherence | null;
  preflight: IosScriptPreflight | null;
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
  mainVision?: boolean;
  verifier?: VerifierTarget | null;
  env?: NodeJS.ProcessEnv;
  logTail?: { start(): void; stop(): void; snapshot(): string[] } | null;
  logCollector?: { collect(request: IosLogWindowRequest): Promise<LogcatWindowResult> };
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
  "6. 若本轮附有截图，可用截图辅助判断；坐标仍输出逻辑点（元素 Center，或截图坐标 ÷ scale）。",
  "7. 出现系统权限/系统弹窗时，优先用 alerts（accept/dismiss）处理后再继续任务。",
  "8. 元素列表中带「(模型视觉，可能有误)」的行是视觉补充：优先使用可访问性元素；两者冲突时以可访问性元素为准。",
  "9. 任务中标注「探索」（deferred，推断跳转）的步骤不参与 PASS/FAIL（覆盖规则 5）：找不到入口或未达成时记录实际路径后继续或 done，不要用 fail 中止整个任务。"
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

export function formatScreenForPrompt(
  nodes: IosUiNode[],
  maxLines = PROMPT_MAX_ELEMENTS,
  size: { width: number; height: number } | null = null
): string {
  const lines: string[] = [];
  const lineIndexByNode = new Map<IosUiNode, number>();
  let processed = 0;
  for (const node of nodes) {
    const label = node.label.trim();
    const value = node.value.trim();
    if (!label && !value) continue;
    processed += 1;
    if (lines.length >= maxLines) continue;
    lineIndexByNode.set(node, lines.length + 1);
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
  const items = nodes.map((node) => ({
    rect: node.rect,
    type: node.type,
    hasText: Boolean(node.label.trim() || node.value.trim()),
    lineIndex: lineIndexByNode.get(node) ?? null
  }));
  const occlusions = computeOcclusions(items, screenAreaOf(nodes, size));
  return annotateOcclusionWarnings(lines, occlusions).join("\n");
}

function resolveHistorySteps(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_IOS_HISTORY_STEPS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_HISTORY_STEPS;
  return Math.max(MIN_HISTORY_STEPS, Math.min(MAX_HISTORY_STEPS, raw));
}

export function buildHistorySections(
  steps: IosTaskStep[],
  historySteps: number,
  maxChars = HISTORY_DIGEST_MAX_CHARS
): { recent: string[]; digest: string } {
  const recent = steps
    .slice(-historySteps)
    .map((step) => `- [${step.step}] ${digestLineForStep(step)}`);
  const older = steps.slice(0, Math.max(0, steps.length - historySteps));
  if (older.length === 0) return { recent, digest: "" };
  const lines: string[] = [];
  older.forEach((step, index) => {
    let line = `${step.step}) ${digestLineForStep(step)}`;
    const previous = index > 0 ? older[index - 1]! : null;
    const screenHead = (step.screen ?? "").trim().slice(0, 60);
    const previousHead = (previous?.screen ?? "").trim().slice(0, 60);
    if (screenHead && screenHead !== previousHead) line += `（屏幕: ${screenHead}）`;
    lines.push(line);
  });
  let digest = lines.join("\n");
  if (digest.length > maxChars) {
    const head = lines.slice(0, 2);
    const tail = lines.slice(-4);
    const omitted = Math.max(0, lines.length - head.length - tail.length);
    digest = [...head, `…（中间 ${omitted} 步略，动作链已压缩）…`, ...tail].join("\n");
    if (digest.length > maxChars * 2) digest = digest.slice(0, maxChars * 2);
  }
  return { recent, digest };
}

function noopHintFor(record: IosTaskRecord): string | null {
  if (record.noopStreak >= 3) {
    return "注意：已连续多步界面没有变化，建议换一个策略（先返回上一屏、关闭弹窗/键盘、滑动列表），否则可能持续无进展。";
  }
  if (record.noopStreak >= 1) {
    return "注意：上一步后界面没有变化：请核对元素列表，考虑先滑动/等待/收起键盘后重试。";
  }
  return null;
}

function sameActionHint(record: IosTaskRecord): string | null {
  const steps = record.steps;
  if (steps.length < 2) return null;
  const last = steps[steps.length - 1]!;
  const previous = steps[steps.length - 2]!;
  if (last.action === "invalid") return null;
  if (
    last.action === previous.action &&
    JSON.stringify(last.params) === JSON.stringify(previous.params)
  ) {
    return "注意：检测到连续相同动作；如果界面没有响应，请换一种操作方式。";
  }
  return null;
}

function preflightHintFor(record: IosTaskRecord): string | null {
  const preflight = record.preflight;
  if (!preflight || preflight.status !== "unmatched") return null;
  return `起始屏核对未通过：任务要求停留在「${preflight.screen}」页（应出现「${preflight.hints.join("」「")}」）。请先导航到该页再执行用例步骤。`;
}

function updatePreflight(record: IosTaskRecord, screenText: string, step: number): void {
  const preflight = record.preflight;
  if (!preflight || preflight.status === "matched" || preflight.status === "unchecked") return;
  const normalized = normalizeMatchText(screenText);
  const matched = preflight.hints.every((hint) => normalized.includes(normalizeMatchText(hint)));
  preflight.status = matched ? "matched" : "unmatched";
  if (matched) preflight.matchedAtStep = step;
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
  visionContext: string | null,
  visionLines: string[],
  historySteps: number
): string {
  const screen = formatScreenForPrompt(nodes, PROMPT_MAX_ELEMENTS, size);
  const { recent, digest } = buildHistorySections(record.steps, historySteps);
  record.digest = digest || null;
  const hints = [noopHintFor(record), sameActionHint(record), preflightHintFor(record)].filter(
    (hint): hint is string => hint !== null
  );
  return [
    `任务：${record.taskDesc}`,
    `进度：第 ${step}/${maxSteps} 步`,
    `屏幕逻辑尺寸：${size ? `${size.width}x${size.height} pt` : "未知（以元素 Center 为准）"}`,
    ...(visionContext ? [visionContext] : []),
    ...hints.map((hint) => `⚠ ${hint}`),
    "",
    "当前屏幕元素：",
    screen || "(当前没有可读元素；可先 swipe/wait 再观察，或结合截图判断)",
    ...(visionLines.length > 0 ? ["", "视觉感知补充（模型视觉，可能有误）：", ...visionLines] : []),
    "",
    "历史动作：",
    ...(digest ? ["[更早步骤摘要]", digest] : []),
    ...(recent.length > 0 ? recent : ["(无)"]),
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
      vision_degraded: record.visionDegraded,
      ...(record.digest ? { digest: record.digest } : {}),
      ...(record.verification ? { verification: verificationPayload(record.verification) } : {}),
      ...(record.failureLogs ? { failure_logs: record.failureLogs } : {}),
      ...(record.visionDropped ? { vision_dropped: record.visionDropped } : {}),
      ...(record.scriptAdherence ? { script_adherence: record.scriptAdherence } : {}),
      ...(record.preflight ? { preflight: record.preflight } : {})
    });
  } catch (error) {
    logWarn(`iOS 任务 run.json 写入失败（${record.traceId}）: ${errorMessage(error)}`);
  }
}

function verificationPayload(verification: IosVerification): Record<string, unknown> {
  return {
    status: verification.status,
    model: verification.model,
    reason: verification.reason,
    stale: verification.stale,
    failed_items: verification.failedItems
  };
}

function synthesisSummary(record: IosTaskRecord): Record<string, unknown> | null {
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

function adherencePayload(adherence: IosScriptAdherence | null): Record<string, unknown> {
  if (!adherence) return {};
  if (adherence.checkable + adherence.unchecked === 0 && adherence.deferred.total === 0) return {};
  return {
    adherence: {
      checkable: adherence.checkable,
      satisfied: adherence.satisfied,
      unchecked: adherence.unchecked,
      ...(adherence.deferred.total > 0
        ? { deferred: { total: adherence.deferred.total, reached: adherence.deferred.reached } }
        : {}),
      ...(adherence.unresolved.length > 0
        ? {
            unresolved: adherence.unresolved.map(
              (item) =>
                `步骤${item.index}${item.screen ? ` ${item.screen}` : ""}：${item.hints.join("、")}`
            )
          }
        : {})
    }
  };
}

function preflightPayload(preflight: IosScriptPreflight | null): Record<string, unknown> {
  if (!preflight) return {};
  return {
    preflight: {
      screen: preflight.screen,
      status: preflight.status,
      ...(preflight.matchedAtStep !== null ? { matched_at_step: preflight.matchedAtStep } : {})
    }
  };
}

function testSummaryFor(record: IosTaskRecord): Record<string, unknown> | null {
  const verification = record.verification;
  const adherence = adherencePayload(record.scriptAdherence);
  const preflight = preflightPayload(record.preflight);
  if (record.status === "failed") {
    if (verification && verification.status === "failed" && verification.failedItems.length > 0) {
      return {
        task_status: "failed",
        passed: 0,
        failed: Math.max(1, verification.failedItems.length),
        inconclusive: 0,
        unchecked: 0,
        synthesized: false,
        verification: "model-final",
        ...(verification.model ? { verification_model: verification.model } : {}),
        ...adherence,
        ...preflight,
        failed_items: verification.failedItems
      };
    }
    const synthesized = synthesisSummary(record);
    if (!synthesized) return null;
    return verification
      ? {
          ...synthesized,
          verification: verification.status,
          ...(verification.model ? { verification_model: verification.model } : {}),
          ...adherence,
          ...preflight
        }
      : { ...synthesized, ...adherence, ...preflight };
  }
  if (record.status === "completed" && verification) {
    if (verification.status === "passed") {
      return {
        task_status: "completed",
        passed: 1,
        failed: 0,
        inconclusive: 0,
        unchecked: 0,
        synthesized: false,
        verification: "model-final",
        ...(verification.model ? { verification_model: verification.model } : {}),
        ...adherence,
        ...preflight
      };
    }
    if (verification.status === "unavailable") {
      return {
        task_status: "completed",
        passed: 1,
        failed: 0,
        inconclusive: 0,
        unchecked: 0,
        synthesized: true,
        verification: "unavailable",
        ...(verification.reason ? { note: verification.reason } : {}),
        ...adherence,
        ...preflight
      };
    }
  }
  return null;
}

function writeStatus(record: IosTaskRecord, message: string): void {
  const testSummary = testSummaryFor(record);
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
      ...(testSummary ? { test_summary: testSummary } : {}),
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

interface VerifierTarget {
  chat: ChatFn;
  model: string;
  vision: boolean;
}

function resolveVerifyMode(env: NodeJS.ProcessEnv): "final" | "off" {
  const raw = env.AOS_IOS_VERIFY?.trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no" ? "off" : "final";
}

function resolveLogFeedback(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_IOS_LOG_FEEDBACK?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

function resolveVerifier(
  env: NodeJS.ProcessEnv,
  entries: LlmEntry[],
  main: VerifierTarget
): VerifierTarget {
  const entryName = env.AOS_IOS_VERIFY_LLM?.trim();
  if (!entryName) return main;
  const entry = entries.find((item) => item.name === entryName);
  if (entry && entryIssues(entry).length === 0 && entry.apiKey && entry.baseUrl) {
    return {
      chat: makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model }),
      model: entry.model,
      vision: looksVisionCapable(entry.model)
    };
  }
  logWarn(`AOS_IOS_VERIFY_LLM 条目不可用（${entryName}），验证回退主模型。`);
  return main;
}

function buildVerificationPrompt(
  taskDesc: string,
  claimedSummary: string,
  screen: string,
  stale: boolean,
  scriptUnresolved: IosScriptAdherence["unresolved"] = [],
  scriptDeferredCount = 0,
  preflightUnmatched: IosScriptPreflight | null = null
): string {
  return [
    "你是移动端测试验证器。只依据下面的最终界面证据判断任务是否真正完成；不要采信执行器的自称。",
    `任务：${taskDesc}`,
    `执行器自称：${claimedSummary}`,
    ...(stale ? ["注意：层级补采失败，当前元素快照可能过时，请主要依据截图判断。"] : []),
    ...(scriptUnresolved.length > 0
      ? [
          "",
          "脚本断言核对（确定性，执行全程从未出现的预期）：",
          ...scriptUnresolved.map(
            (item) =>
              `- 步骤${item.index}${item.screen ? ` 应进入「${item.screen}」` : ""}，预期出现「${item.hints.join("」「")}」但从未出现`
          ),
          "若执行路径合理且任务确实完成可忽略；若确为缺失步骤，请写入 failed_items。"
        ]
      : []),
    ...(scriptDeferredCount > 0
      ? [
          "",
          `另有 ${scriptDeferredCount} 步探索（推断跳转，deferred）：不参与本次判定，请勿因此写入 failed_items。`
        ]
      : []),
    ...(preflightUnmatched
      ? [
          "",
          `起始屏核对（确定性）：执行全程未观察到预期起始页「${preflightUnmatched.screen}」（应出现「${preflightUnmatched.hints.join("」「")}」）。若执行路径合理且任务确实完成可忽略；若说明用例起点被跳过，请写入 failed_items。`
        ]
      : []),
    "",
    "当前屏幕元素：",
    screen || "(无可用元素；若附有截图请依据截图判断)",
    "",
    '输出 JSON（不要 markdown 代码块）：{"pass":true|false,"reason":"简要理由","failed_items":[{"item_text":"未满足的要求","evidence":"界面证据","region":[l,t,r,b]}]}',
    "规则：pass=false 时必须列出至少一个具体 failed_items（含证据）；无法指出具体不符项时输出 pass=true。"
  ].join("\n");
}

function parseVerification(
  raw: string
): { pass: boolean; reason: string; failedItems: IosVerificationItem[] } | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.pass !== "boolean") return null;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const failedItems: IosVerificationItem[] = [];
  if (Array.isArray(record.failed_items)) {
    for (const entry of record.failed_items) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const text =
        typeof item.item_text === "string" && item.item_text.trim() !== ""
          ? item.item_text.trim()
          : typeof item.text === "string"
            ? item.text.trim()
            : "";
      const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
      if (!text && !evidence) continue;
      failedItems.push({
        item_text: text || evidence,
        evidence: evidence || text,
        ...(item.region !== undefined ? { region: item.region } : {})
      });
    }
  }
  return { pass: record.pass, reason, failedItems };
}

async function runVerification(
  verifier: VerifierTarget,
  record: IosTaskRecord,
  device: IosDevice,
  fallbackNodes: IosUiNode[],
  claimedSummary: string,
  screenshot: Buffer | null,
  scriptUnresolved: IosScriptAdherence["unresolved"] = [],
  scriptDeferredCount = 0,
  preflightUnmatched: IosScriptPreflight | null = null
): Promise<IosVerification> {
  let nodes = fallbackNodes;
  let stale = false;
  try {
    nodes = await device.nodes();
  } catch {
    stale = true;
  }
  if (stale && !verifier.vision) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "层级补采失败且验证模型不支持截图。",
      failedItems: [],
      stale
    };
  }
  const screen = formatScreenForPrompt(nodes, PROMPT_MAX_ELEMENTS, null);
  const prompt = buildVerificationPrompt(
    record.taskDesc,
    claimedSummary,
    screen,
    stale,
    scriptUnresolved,
    scriptDeferredCount,
    preflightUnmatched
  );
  const messages: ChatMessage[] = [
    { role: "system", content: "你是严格的移动端测试验证器，只输出 JSON。" },
    {
      role: "user",
      content:
        verifier.vision && screenshot
          ? [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${screenshot.toString("base64")}` }
              }
            ]
          : prompt
    }
  ];
  let content: string;
  try {
    content = await verifier.chat(messages);
  } catch (error) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: `验证调用失败：${errorMessage(error)}`,
      failedItems: [],
      stale
    };
  }
  const parsed = parseVerification(content);
  if (!parsed) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "验证响应不可解析。",
      failedItems: [],
      stale
    };
  }
  if (!parsed.pass && parsed.failedItems.length === 0) {
    return {
      status: "unavailable",
      model: verifier.model,
      reason: "验证判定失败但未给出具体失效项。",
      failedItems: [],
      stale
    };
  }
  if (parsed.pass) {
    return { status: "passed", model: verifier.model, reason: parsed.reason, failedItems: [], stale };
  }
  return {
    status: "failed",
    model: verifier.model,
    reason: parsed.reason || "验证判定任务未完成。",
    failedItems: parsed.failedItems,
    stale
  };
}

function persistFailureLogs(
  runDir: string,
  source: "simctl-log" | "idevicesyslog",
  lines: string[],
  clockWarning: boolean
): IosFailureLogs {
  try {
    const rel = "logs/device.log";
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
    const header = `# iOS 设备日志（来源 ${source}${clockWarning ? "，时间窗口近似" : ""}）\n`;
    writeFileAtomic(path.join(runDir, rel), `${header}${lines.join("\n")}\n`);
    return { status: "ok", source, rel, lines: lines.length };
  } catch (error) {
    return { status: "skipped", source, reason: `write-failed: ${errorMessage(error)}` };
  }
}

async function collectFailureLogs(
  runtime: Runtime,
  record: IosTaskRecord,
  tail: { start(): void; stop(): void; snapshot(): string[] } | null,
  deps: StartIosTaskDeps
): Promise<IosFailureLogs> {
  const processName = record.lockedAppPackage
    ? record.lockedAppPackage.split(".").pop() ?? null
    : null;
  const endMs = Date.now();
  if (tail) {
    try {
      tail.stop();
    } catch {
      /* 停止失败不阻塞失败收尾 */
    }
    const filtered = filterDeviceLogLines(tail.snapshot(), {
      windowStartMs: record.startedAtMs,
      windowEndMs: endMs,
      processName,
      nowMs: endMs
    });
    if (filtered.lines.length === 0) {
      return {
        status: "skipped",
        source: "idevicesyslog",
        reason: filtered.windowElapsed ? "window-elapsed-live-tail" : "log-empty"
      };
    }
    return persistFailureLogs(record.runDir, "idevicesyslog", filtered.lines, filtered.approximateEnd);
  }
  if (classifyIosSerial(record.udid) !== "simulator") {
    return { status: "skipped", source: "none", reason: "no-collector" };
  }
  const collector = deps.logCollector ?? new IosLogCollector({ env: runtime.iosEnvironment() });
  let result: LogcatWindowResult;
  try {
    result = await collector.collect({
      serial: record.udid,
      windowStartMs: record.startedAtMs,
      windowEndMs: endMs,
      processName: processName ?? ""
    });
  } catch (error) {
    return { status: "skipped", source: "simctl-log", reason: `collector-error: ${errorMessage(error)}` };
  }
  if (result.status !== "ok") {
    return { status: "skipped", source: "simctl-log", reason: result.reason };
  }
  const lines = result.text.split("\n").filter((line) => line !== "");
  return persistFailureLogs(record.runDir, "simctl-log", lines, Boolean(result.clockWarning));
}

async function runLoop(
  runtime: Runtime,
  record: IosTaskRecord,
  entry: LlmEntry,
  visionTarget: VisionTarget | null,
  deps: StartIosTaskDeps
): Promise<void> {
  const env = deps.env ?? runtime.iosEnvironment();
  const device =
    deps.device ??
    (classifyIosSerial(record.udid) === "device"
      ? await runtime.iosWda().device(record.udid)
      : makeIosDevice(record.udid));
  const chat =
    deps.chat ??
    makeChatFn({ baseUrl: entry.baseUrl ?? "", apiKey: entry.apiKey ?? "", model: entry.model });
  const visionChat = deps.visionChat ?? (visionTarget ? makeChatFn(visionTarget.chat) : null);
  const mode: IosVisionMode = resolveVisionMode(env);
  const mainVision = deps.mainVision ?? looksVisionCapable(entry.model);
  const maxSteps = resolveMaxSteps(env, deps.maxSteps);
  const stepDelayMs = deps.stepDelayMs ?? 300;
  const settleMs = resolveSettleMs(env, deps.settleMs);
  const historySteps = resolveHistorySteps(env);
  const verifier =
    resolveVerifyMode(env) === "final"
      ? deps.verifier !== undefined
        ? deps.verifier
        : resolveVerifier(env, await runtime.entries(), {
            chat,
            model: entry.model,
            vision: mainVision
          })
      : null;
  const feedbackEnabled = resolveLogFeedback(env);
  const tail =
    feedbackEnabled && classifyIosSerial(record.udid) === "device"
      ? deps.logTail !== undefined
        ? deps.logTail
        : new IosDeviceLogTail({ serial: record.udid, env })
      : null;
  if (tail) {
    try {
      tail.start();
    } catch (error) {
      logWarn(`iOS 设备日志缓冲启动失败（${record.traceId}）: ${errorMessage(error)}`);
    }
  }
  if (mode === "auto" && !mainVision && !visionChat) {
    record.visionDegraded =
      record.visionDegraded ??
      "自动视觉不可用：active 模型不支持截图且未配置 AOS_IOS_VISION_LLM；已按纯文本执行。";
  }
  const messages: ChatMessage[] = [{ role: "system", content: IOS_SYSTEM_PROMPT }];
  let lastSignature: string | null = null;
  let lastShotHash: string | null = null;
  let previousAction: string | null = null;
  const scriptPlan = parseScriptPlan(record.taskDesc);
  const scriptExpectations = scriptPlan?.steps ?? null;
  const scriptSatisfied = new Set<number>();
  if (scriptPlan?.start) {
    record.preflight = {
      screen: scriptPlan.start.screen,
      hints: scriptPlan.start.hints,
      status: scriptPlan.start.hints.length > 0 ? "pending" : "unchecked",
      matchedAtStep: null
    };
  }

  const finalize = async (
    status: "completed" | "failed" | "cancelled",
    summary: string
  ): Promise<void> => {
    let finalSummary = summary;
    if (status === "failed" && feedbackEnabled) {
      const logs = await collectFailureLogs(runtime, record, tail, deps);
      record.failureLogs = logs;
      if (logs.status === "ok" && logs.lines) {
        finalSummary = `${summary}\n设备日志已采集（${logs.lines} 行，来源 ${logs.source}）。`;
      }
    } else if (tail) {
      try {
        tail.stop();
      } catch {
        /* ignore */
      }
    }
    finish(record, status, finalSummary);
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
        await finalize("failed", `启动应用 ${record.lockedAppPackage} 失败: ${errorMessage(error)}`);
        return;
      }
    }
    for (let step = 1; step <= maxSteps; step += 1) {
      if (record.stopRequested) {
        await finalize("cancelled", "任务已被停止");
        return;
      }
      let nodes: IosUiNode[];
      try {
        nodes = await device.nodes();
      } catch (error) {
        await finalize("failed", `观察屏幕失败: ${errorMessage(error)}`);
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
      updatePreflight(record, screen, step);
      const scriptHits =
        scriptExpectations !== null
          ? matchScriptExpectations(scriptExpectations, scriptSatisfied, screen)
          : [];
      const shotDims = shot ? pngDimensions(shot.bytes) : null;
      const scale = shotDims && size && size.width > 0 ? shotDims.width / size.width : null;
      const instruction = record.instruction;
      record.instruction = null;

      const signature = screenSignature(nodes, size?.height ?? null);
      const shotHash = shot ? croppedScreenshotHash(shot.bytes) : null;
      const comparable = step > 1 && previousAction !== "wait";
      let noop = false;
      if (comparable && lastSignature !== null && signature === lastSignature) {
        const shotSame =
          shotHash !== null && lastShotHash !== null ? shotHash === lastShotHash : true;
        if (shotSame) {
          record.noopStreak += 1;
          noop = true;
        } else {
          record.noopStreak = 0;
        }
      } else if (step > 1) {
        record.noopStreak = 0;
      }
      lastSignature = signature;
      lastShotHash = shotHash;

      const wantsImage = mode !== "off" && mainVision && shot !== null;
      const wantsPerception =
        mode !== "off" &&
        !mainVision &&
        visionChat !== null &&
        shot !== null &&
        (mode === "auto" || visibleElementCount(nodes) < MIN_TEXT_ELEMENTS);
      let visionLines: string[] = [];
      let visionContext: string | null = null;
      let perception: IosTaskStep["perception"] = "text";
      if (wantsImage && shot) {
        visionContext = shotDims
          ? `本轮附有截图：${shotDims.width}x${shotDims.height} px${
              size ? `（逻辑 ${size.width}x${size.height} pt${scale ? `，scale≈${scale.toFixed(2)}` : ""}）` : ""
            }；坐标以元素 Center 为准，若从截图估计请先除以 scale。`
          : "本轮附有截图；坐标以元素 Center 为准。";
      } else if (wantsPerception && shot) {
        if (shotDims === null || scale === null || !size) {
          record.visionDegraded = record.visionDegraded ?? "视觉感知跳过：截图尺寸或逻辑尺寸未知。";
          perception = "text-degraded";
        } else {
          try {
            const content = await visionChat!([
              {
                role: "user",
                content: [
                  { type: "text", text: buildPerceptionPrompt(shotDims.width, shotDims.height) },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/png;base64,${shot.bytes.toString("base64")}` }
                  }
                ]
              }
            ]);
            const parsedVision = parseVisionElements(content);
            if (parsedVision === null) {
              record.visionDegraded = record.visionDegraded ?? "视觉感知响应不可解析。";
              perception = "text-degraded";
            } else {
              const fused = fuseVisionElements({
                elements: parsedVision.elements,
                scale,
                width: size.width,
                height: size.height,
                existing: nodes,
                maxLines: VISION_MAX_LINES
              });
              record.visionDropped = record.visionDropped ?? {
                invalid: 0,
                noScale: 0,
                duplicate: 0,
                overflow: 0
              };
              record.visionDropped.invalid += fused.droppedInvalid + parsedVision.dropped;
              record.visionDropped.noScale += fused.droppedNoScale;
              record.visionDropped.duplicate += fused.droppedDuplicate;
              record.visionDropped.overflow += fused.droppedOverflow;
              visionLines = fused.lines;
              visionContext =
                fused.lines.length > 0
                  ? `本轮视觉感知补充 ${fused.lines.length} 个元素（像素坐标已换算逻辑点，可能有误）。`
                  : "本轮视觉感知未发现可补充元素。";
              perception = "vision-text";
            }
          } catch (error) {
            record.visionDegraded = record.visionDegraded ?? `视觉调用失败：${errorMessage(error)}`;
            logWarn(`iOS 视觉降级为纯文本（${record.traceId}）: ${errorMessage(error)}`);
            perception = "text-degraded";
          }
        }
      }

      const textPrompt = buildUserPrompt(
        record,
        nodes,
        size,
        step,
        maxSteps,
        instruction,
        visionContext,
        visionLines,
        historySteps
      );

      let content: string;
      if (wantsImage && shot) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: textPrompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${shot.bytes.toString("base64")}` } }
          ] satisfies ChatContent
        });
        try {
          content = await chat(messages);
          perception = "image";
        } catch (error) {
          record.visionDegraded = record.visionDegraded ?? `多模态决策调用失败：${errorMessage(error)}`;
          logWarn(`iOS 多模态降级为纯文本（${record.traceId}）: ${errorMessage(error)}`);
          messages[messages.length - 1] = { role: "user", content: textPrompt };
          perception = "text-degraded";
          try {
            content = await chat(messages);
          } catch (fallbackError) {
            await finalize("failed", `LLM 调用失败: ${errorMessage(fallbackError)}`);
            return;
          }
        }
        // 历史中不保留旧截图，避免每步重传（对齐 Android 的中间截图裁剪）。
        messages[messages.length - 1] = { role: "user", content: textPrompt };
      } else {
        messages.push({ role: "user", content: textPrompt });
        try {
          content = await chat(messages);
        } catch (error) {
          await finalize("failed", `LLM 调用失败: ${errorMessage(error)}`);
          return;
        }
      }
      messages.push({ role: "assistant", content });

      const parsed = extractJson(content);
      if (!parsed) {
        previousAction = "invalid";
        record.steps.push({
          step,
          thought: "",
          action: "invalid",
          params: { raw: content.slice(0, 200) },
          outcome: "模型输出不是合法动作 JSON",
          ...(shot ? { shot: shot.rel } : {}),
          ...(screen ? { screen } : {}),
          ...(scale !== null ? { scale } : {}),
          ...(noop ? { noop: true } : {}),
          ...(scriptHits.length > 0 ? { scriptHits } : {}),
          perception
        });
        persistRun(record);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        continue;
      }
      previousAction = parsed.action;

      let outcome: ActionOutcome;
      try {
        outcome = await executeAction(device, parsed.action, parsed.params, record.lockedAppPackage);
      } catch (error) {
        outcome = { kind: "step", text: `执行失败: ${errorMessage(error)}` };
      }
      if (outcome.kind === "done") {
        if (settleMs > 0) await sleep(settleMs);
        const donePost = await captureStepShot(device, record, step, "post");
        let doneNodes: IosUiNode[] | null = null;
        if (scriptExpectations !== null) {
          try {
            doneNodes = await device.nodes();
          } catch {
            doneNodes = null;
          }
        }
        const doneHits =
          doneNodes && scriptExpectations
            ? matchScriptExpectations(scriptExpectations, scriptSatisfied, screenTextSummary(doneNodes))
            : [];
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
          ...(noop ? { noop: true } : {}),
          ...(scriptHits.length + doneHits.length > 0
            ? { scriptHits: [...scriptHits, ...doneHits] }
            : {}),
          perception
        });
        const scriptAdherence = scriptExpectations
          ? buildScriptAdherence(scriptExpectations, scriptSatisfied)
          : null;
        record.scriptAdherence = scriptAdherence;
        if (outcome.success && verifier) {
          record.verification = await runVerification(
            verifier,
            record,
            device,
            doneNodes ?? nodes,
            outcome.summary,
            donePost ? donePost.bytes : null,
            scriptAdherence?.unresolved ?? [],
            scriptAdherence?.deferred.total ?? 0,
            record.preflight?.status === "unmatched" ? record.preflight : null
          );
          persistRun(record);
        }
        const adherenceNote =
          scriptAdherence && scriptAdherence.unresolved.length > 0
            ? `\n⚠ 脚本断言未出现（确定性核对）：${formatUnresolvedScriptItems(scriptAdherence.unresolved)}`
            : "";
        const preflightNote =
          record.preflight && record.preflight.status === "unmatched"
            ? `\n⚠ 起始屏核对未通过：未观察到「${record.preflight.screen}」页预期文本「${record.preflight.hints.join("」「")}」`
            : "";
        const auditNote = `${adherenceNote}${preflightNote}`;
        if (outcome.success && record.verification?.status === "failed") {
          await finalize("failed", `验证未通过：${record.verification.reason}${auditNote}`);
          return;
        }
        await finalize(
          outcome.success ? "completed" : "failed",
          `${outcome.summary}${auditNote}`
        );
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
        ...(noop ? { noop: true } : {}),
        ...(scriptHits.length > 0 ? { scriptHits } : {}),
        perception
      });
      persistRun(record);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }
    await finalize("failed", `超出步数上限（${maxSteps}），任务未完成`);
  } catch (error) {
    await finalize("failed", `执行器异常: ${errorMessage(error)}`);
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
