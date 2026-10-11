import type { IosUiNode } from "../device/ios.js";
import { digestLineForStep } from "./noop.js";
import { annotateOcclusionWarnings, computeOcclusions, screenAreaOf } from "./occlusion.js";
import { normalizeMatchText } from "./script-plan.js";
import type { IosTaskRecord, IosTaskStep } from "./types.js";

const DEFAULT_HISTORY_STEPS = 8;
const MIN_HISTORY_STEPS = 4;
const MAX_HISTORY_STEPS = 20;
const HISTORY_DIGEST_MAX_CHARS = 800;
export const PROMPT_MAX_ELEMENTS = 200;
const SCREEN_TEXT_MAX_ELEMENTS = 60;

export const IOS_SYSTEM_PROMPT = [
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

export function screenTextSummary(nodes: IosUiNode[]): string {
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

export function resolveHistorySteps(env: NodeJS.ProcessEnv): number {
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

export function updatePreflight(record: IosTaskRecord, screenText: string, step: number): void {
  const preflight = record.preflight;
  if (!preflight || preflight.status === "matched" || preflight.status === "unchecked") return;
  const normalized = normalizeMatchText(screenText);
  const matched = preflight.hints.every((hint) => normalized.includes(normalizeMatchText(hint)));
  preflight.status = matched ? "matched" : "unmatched";
  if (matched) preflight.matchedAtStep = step;
}

export function buildUserPrompt(
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
