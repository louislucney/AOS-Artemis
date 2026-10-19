import type { ChatFn, ChatMessage } from "../llm/chat.js";
import { classifyModalityRejection } from "../llm/vision-capability.js";
import { confidenceFor } from "../provenance.js";
import type { FlowEdge, FlowElement, FlowWarning } from "../figma/flows.js";
import {
  coverageWarnings,
  evaluateCandidateCoverage,
  type FlowElementCoverage,
  type VisionCandidate
} from "./element-coverage.js";
import { errorMessage } from "../util.js";

/** Controlled vocabulary for recognized interactive elements (ADR-0010).
 * Free-form text belongs to `label`, never to `class`/`intent`. */
export const VISION_ELEMENT_CLASSES = [
  "tab",
  "back",
  "cart-entry",
  "search-entry",
  "menu-entry",
  "cta",
  "link",
  "input",
  "toggle",
  "other"
] as const;
export type VisionElementClass = (typeof VISION_ELEMENT_CLASSES)[number];

export const VISION_INTENTS = ["navigate", "submit", "input", "toggle", "other"] as const;
export type VisionIntent = (typeof VISION_INTENTS)[number];

interface VisionBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node that carries geometry, already resolved to screen-local px. */
export interface VisionNodeGeom {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionScreenInput {
  id: string;
  name: string;
  width: number;
  height: number;
  nodes: VisionNodeGeom[];
  stateOf?: string | null;
  stateName?: string | null;
  candidates?: VisionCandidate[];
  /** 渲染图倍率；默认 1。`width/height` 在非 1 时表示**渲染图像像素**，
   * 识别 bbox（归一化）先乘图像尺寸再除以 `renderScale` 得到设计 px。 */
  renderScale?: number;
  /** 采集到的设计节点总数（`nodes` 可能因 grounding 上限被截断）。 */
  designNodes?: number;
}

export interface VisionStats {
  screensRequested: number;
  screensSkipped: number;
  screensProcessed: number;
  elements: number;
  navigationalEdges: number;
  invalidItems: number;
  failures: number;
  screensInput: number;
  screensNoGeometry: number;
  screensFrameMissing: number;
  screensCapped: number;
  screensFailed: number;
  truncatedItems: number;
  groundedElements: number;
  ungroundedElements: number;
  candidateNodes: number;
  coveredCandidates: number;
  uncoveredCandidates: number;
  unverifiableCandidates: number;
  notEvaluatedCandidates: number;
  targetsRequested: number;
  statesRequested: number;
  statesInput: number;
  statesProcessed: number;
  statesSkipped: number;
  statesFailed: number;
  statesCapped: number;
  statesNoGeometry: number;
  statesFrameMissing: number;
}

/** Target excluded before the pass (frame missing or no geometry); candidates
 * still feed `not-evaluated` coverage so the omission stays visible. */
export interface VisionExcludedTarget {
  screenId: string;
  screenName: string;
  state: string | null;
  reason: "frame-missing" | "no-geometry";
  candidates?: VisionCandidate[];
  designNodes?: number;
}

export interface VisionAccounting {
  ok: boolean;
  screensInput: number;
  statesInput: number;
  targetsRequested: number;
  screensRequested: number;
  statesRequested: number;
  elements: number;
  rawElements: number;
  /** 采集期因每屏上限 200 被截断的候选（含被排除/被 cap 的 target）；不参与守恒公式。 */
  candidatesTruncated: number;
  /** grounding 节点超过 300 上限的累计数；不参与守恒公式。 */
  groundingTruncated: number;
  formulas: {
    screensInput: boolean;
    statesInput: boolean;
    targetsRequested: boolean;
    screensRequested: boolean;
    statesRequested: boolean;
    elements: boolean;
    rawElements: boolean;
  };
  mismatches: string[];
}

export interface VisionPassResult {
  elementsByScreen: Map<string, FlowElement[]>;
  edges: FlowEdge[];
  /** Variant-only edges (audit only; never merged into `result.edges`). */
  stateEdges: FlowEdge[];
  unresolvedDestinations: string[];
  warnings: FlowWarning[];
  /** 首个「模型不接受图片」的拒绝（400/415/422 类）；命中即中止后续屏幕。 */
  rejected: { screen: string; detail: string } | null;
  stats: VisionStats;
  coverageByTarget: Map<string, FlowElementCoverage>;
  cappedTargets: VisionScreenInput[];
  accounting: VisionAccounting;
}

interface RawVisionItem {
  className: VisionElementClass;
  intent: VisionIntent;
  label: string | null;
  bbox: VisionBBox;
  confidence: number | null;
}

/** Model-name heuristic for vision-capable chat models —— 已迁至
 * `src/llm/vision-capability.ts`（判定链的一环：声明 → 缓存 → 启发式 → 未知即尝试），
 * 此处保留 re-export 以兼容既有导入。 */
export { isVisionCapableModel } from "../llm/vision-capability.js";

export function buildVisionMessages(screen: VisionScreenInput, imageDataUrl: string): ChatMessage[] {
  const instruction =
    `屏幕「${screen.name}」（设计尺寸 ${screen.width}x${screen.height}px）。` +
    "识别图中所有视觉上可判断为可交互的元素（图标按钮、底部标签栏、返回箭头、购物袋/购物车入口、" +
    "搜索入口、菜单入口、主按钮、链接、输入框、开关等）；装饰性图形不要报告。" +
    "只输出 JSON，不要解释。格式：" +
    `{"elements":[{"class":"<${VISION_ELEMENT_CLASSES.join("|")}>",` +
    `"intent":"<${VISION_INTENTS.join("|")}>",` +
    '"label":"元素上的文字或简短中文名","bbox":{"x":0.0,"y":0.0,"width":0.0,"height":0.0},"confidence":0.0}]}。' +
    "bbox 为该元素在整图中的归一化坐标（0-1，相对左上角）。没有可识别元素时输出 {\"elements\":[]}。";
  return [
    { role: "system", content: "你是移动 UI 交互元素识别器，只输出 JSON。" },
    {
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    }
  ];
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseBBox(value: unknown): VisionBBox | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  const bbox = { x: record.x as number, y: record.y as number, width: record.width as number, height: record.height as number };
  if (bbox.width <= 0 || bbox.height <= 0) return null;
  if (bbox.x < -0.05 || bbox.y < -0.05 || bbox.x > 1.05 || bbox.y > 1.05) return null;
  return bbox;
}

export function parseVisionReply(content: string): {
  items: RawVisionItem[];
  invalid: number;
  truncated: number;
} {
  const parsed = extractJsonObject(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { items: [], invalid: 0, truncated: 0 };
  }
  const rawElements = (parsed as { elements?: unknown }).elements;
  if (!Array.isArray(rawElements)) return { items: [], invalid: 0, truncated: 0 };
  const items: RawVisionItem[] = [];
  let invalid = 0;
  for (const entry of rawElements.slice(0, 40)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const bbox = parseBBox(record.bbox);
    if (!bbox) {
      invalid += 1;
      continue;
    }
    const rawClass = typeof record.class === "string" ? record.class.trim().toLowerCase() : "";
    const rawIntent = typeof record.intent === "string" ? record.intent.trim().toLowerCase() : "";
    const className = (VISION_ELEMENT_CLASSES as readonly string[]).includes(rawClass)
      ? (rawClass as VisionElementClass)
      : "other";
    const intent = (VISION_INTENTS as readonly string[]).includes(rawIntent)
      ? (rawIntent as VisionIntent)
      : "other";
    items.push({
      className,
      intent,
      label: typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim().slice(0, 60) : null,
      bbox,
      confidence:
        typeof record.confidence === "number" && Number.isFinite(record.confidence)
          ? Math.min(Math.max(record.confidence, 0), 1)
          : null
    });
  }
  return { items, invalid, truncated: Math.max(0, rawElements.length - 40) };
}

const GROUND_IOU_THRESHOLD = 0.2;

function bboxInPx(bbox: VisionBBox, screen: VisionScreenInput): VisionBBox {
  const scale =
    typeof screen.renderScale === "number" && Number.isFinite(screen.renderScale) && screen.renderScale > 0
      ? screen.renderScale
      : 1;
  return {
    x: (bbox.x * screen.width) / scale,
    y: (bbox.y * screen.height) / scale,
    width: (bbox.width * screen.width) / scale,
    height: (bbox.height * screen.height) / scale
  };
}

export function groundNodeId(bboxPx: VisionBBox, screen: VisionScreenInput): string | undefined {
  let bestId: string | undefined;
  let bestIou = GROUND_IOU_THRESHOLD;
  for (const node of screen.nodes) {
    const ix = Math.max(bboxPx.x, node.x);
    const iy = Math.max(bboxPx.y, node.y);
    const ix2 = Math.min(bboxPx.x + bboxPx.width, node.x + node.width);
    const iy2 = Math.min(bboxPx.y + bboxPx.height, node.y + node.height);
    const overlap = Math.max(ix2 - ix, 0) * Math.max(iy2 - iy, 0);
    if (overlap <= 0) continue;
    const union = bboxPx.width * bboxPx.height + node.width * node.height - overlap;
    const iou = union > 0 ? overlap / union : 0;
    if (iou > bestIou) {
      bestIou = iou;
      bestId = node.id;
    }
  }
  return bestId;
}

function emptyVisionStats(): VisionStats {
  return {
    screensRequested: 0,
    screensSkipped: 0,
    screensProcessed: 0,
    elements: 0,
    navigationalEdges: 0,
    invalidItems: 0,
    failures: 0,
    screensInput: 0,
    screensNoGeometry: 0,
    screensFrameMissing: 0,
    screensCapped: 0,
    screensFailed: 0,
    truncatedItems: 0,
    groundedElements: 0,
    ungroundedElements: 0,
    candidateNodes: 0,
    coveredCandidates: 0,
    uncoveredCandidates: 0,
    unverifiableCandidates: 0,
    notEvaluatedCandidates: 0,
    targetsRequested: 0,
    statesRequested: 0,
    statesInput: 0,
    statesProcessed: 0,
    statesSkipped: 0,
    statesFailed: 0,
    statesCapped: 0,
    statesNoGeometry: 0,
    statesFrameMissing: 0
  };
}

function targetStateOf(target: VisionScreenInput): string | null {
  if (typeof target.stateName === "string" && target.stateName.trim() !== "") return target.stateName;
  if (typeof target.stateOf === "string" && target.stateOf.trim() !== "") return target.name;
  return null;
}

/** D7 守恒公式；任一不成立即返回 mismatch 明细（消息带数字）。 */
export function visionAccounting(
  stats: VisionStats,
  extras: { candidatesTruncated?: number; groundingTruncated?: number; rawElements?: number } = {}
): VisionAccounting {
  const rawElements = extras.rawElements ?? stats.elements + stats.invalidItems + stats.truncatedItems;
  const formulas: VisionAccounting["formulas"] = {
    screensInput:
      stats.screensInput ===
      stats.screensProcessed +
        stats.screensSkipped +
        stats.screensFailed +
        stats.screensCapped +
        stats.screensNoGeometry +
        stats.screensFrameMissing,
    statesInput:
      stats.statesInput ===
      stats.statesProcessed +
        stats.statesSkipped +
        stats.statesFailed +
        stats.statesCapped +
        stats.statesNoGeometry +
        stats.statesFrameMissing,
    targetsRequested: stats.targetsRequested === stats.screensRequested + stats.statesRequested,
    screensRequested:
      stats.screensRequested === stats.screensProcessed + stats.screensSkipped + stats.screensFailed,
    statesRequested:
      stats.statesRequested === stats.statesProcessed + stats.statesSkipped + stats.statesFailed,
    elements: stats.elements === stats.groundedElements + stats.ungroundedElements,
    rawElements: rawElements === stats.elements + stats.invalidItems + stats.truncatedItems
  };
  const mismatches: string[] = [];
  if (!formulas.screensInput) {
    mismatches.push(
      `screensInput ${stats.screensInput} ≠ processed ${stats.screensProcessed} + skipped ${stats.screensSkipped} + failed ${stats.screensFailed} + capped ${stats.screensCapped} + noGeometry ${stats.screensNoGeometry} + frameMissing ${stats.screensFrameMissing}`
    );
  }
  if (!formulas.statesInput) {
    mismatches.push(
      `statesInput ${stats.statesInput} ≠ processed ${stats.statesProcessed} + skipped ${stats.statesSkipped} + failed ${stats.statesFailed} + capped ${stats.statesCapped} + noGeometry ${stats.statesNoGeometry} + frameMissing ${stats.statesFrameMissing}`
    );
  }
  if (!formulas.targetsRequested) {
    mismatches.push(
      `targetsRequested ${stats.targetsRequested} ≠ screensRequested ${stats.screensRequested} + statesRequested ${stats.statesRequested}`
    );
  }
  if (!formulas.screensRequested) {
    mismatches.push(
      `screensRequested ${stats.screensRequested} ≠ processed ${stats.screensProcessed} + skipped ${stats.screensSkipped} + failed ${stats.screensFailed}`
    );
  }
  if (!formulas.statesRequested) {
    mismatches.push(
      `statesRequested ${stats.statesRequested} ≠ processed ${stats.statesProcessed} + skipped ${stats.statesSkipped} + failed ${stats.statesFailed}`
    );
  }
  if (!formulas.elements) {
    mismatches.push(
      `elements ${stats.elements} ≠ grounded ${stats.groundedElements} + ungrounded ${stats.ungroundedElements}`
    );
  }
  if (!formulas.rawElements) {
    mismatches.push(
      `rawElements ${rawElements} ≠ elements ${stats.elements} + invalid ${stats.invalidItems} + truncated ${stats.truncatedItems}`
    );
  }
  return {
    ok: mismatches.length === 0,
    screensInput: stats.screensInput,
    statesInput: stats.statesInput,
    targetsRequested: stats.targetsRequested,
    screensRequested: stats.screensRequested,
    statesRequested: stats.statesRequested,
    elements: stats.elements,
    rawElements,
    candidatesTruncated: extras.candidatesTruncated ?? 0,
    groundingTruncated: extras.groundingTruncated ?? 0,
    formulas,
    mismatches
  };
}

export function accountingWarnings(accounting: VisionAccounting): FlowWarning[] {
  if (accounting.ok) return [];
  return [
    {
      code: "vision-accounting-mismatch",
      message: `视觉识别会计不平：${accounting.mismatches.join("；")}`
    }
  ];
}

/** Advance a vision pass over rendered screens. `chat` and the image lookup
 * are injected so tests (and future Figma support) share this module without
 * touching the network or the pen CLI.
 *
 * Main screens are processed before state variants; the cap truncates
 * variants first (main screens are only capped when they alone exceed it).
 * Every input target lands in exactly one bucket: frameMissing → noGeometry →
 * capped → skipped → failed → processed. */
export async function runVisionPass(input: {
  chat: ChatFn;
  screens: VisionScreenInput[];
  imageFor: (screenId: string) => string | null;
  renderPath: (screenId: string) => string | null;
  maxScreens?: number;
  excluded?: VisionExcludedTarget[];
  candidatesTruncated?: number;
  groundingTruncated?: number;
}): Promise<VisionPassResult> {
  const warnings: FlowWarning[] = [];
  const elementsByScreen = new Map<string, FlowElement[]>();
  const edges: FlowEdge[] = [];
  const stateEdges: FlowEdge[] = [];
  const unresolvedDestinations: string[] = [];
  const coverageByTarget = new Map<string, FlowElementCoverage>();
  const cappedTargets: VisionScreenInput[] = [];
  const stats = emptyVisionStats();
  let rawElementsSeen = 0;

  const mains = input.screens.filter((screen) => targetStateOf(screen) === null);
  const states = input.screens.filter((screen) => targetStateOf(screen) !== null);
  const excluded = input.excluded ?? [];
  const excludedMains = excluded.filter((entry) => entry.state === null);
  const excludedStates = excluded.filter((entry) => entry.state !== null);
  stats.screensInput = mains.length + excludedMains.length;
  stats.statesInput = states.length + excludedStates.length;

  const parentNames = new Map<string, string>();
  for (const screen of mains) parentNames.set(screen.id, screen.name);
  const scopeName = (target: VisionScreenInput): string => {
    if (targetStateOf(target) === null) return target.name;
    const parent = target.stateOf ? parentNames.get(target.stateOf) : undefined;
    return parent ?? target.name;
  };
  const describeTarget = (target: VisionScreenInput): string => {
    const state = targetStateOf(target);
    return state === null
      ? `屏幕「${target.name}」`
      : `屏幕「${scopeName(target)}」·状态「${state}」`;
  };
  const labelOf = (target: VisionScreenInput): string => {
    const state = targetStateOf(target);
    return state === null ? target.name : `${scopeName(target)}·${state}`;
  };
  const evaluateNotEvaluated = (
    target: VisionScreenInput,
    reason: "capped" | "render-missing" | "rejected" | "failed"
  ): FlowElementCoverage =>
    evaluateCandidateCoverage({
      state: targetStateOf(target),
      designNodes: target.designNodes ?? target.nodes.length,
      candidates: target.candidates ?? [],
      elements: [],
      notEvaluatedReason: reason
    });

  for (const entry of excluded) {
    const isState = entry.state !== null;
    if (entry.reason === "frame-missing") {
      if (isState) stats.statesFrameMissing += 1;
      else stats.screensFrameMissing += 1;
    } else if (isState) {
      stats.statesNoGeometry += 1;
    } else {
      stats.screensNoGeometry += 1;
    }
    const coverage = evaluateCandidateCoverage({
      state: entry.state,
      designNodes: entry.designNodes ?? 0,
      candidates: entry.candidates ?? [],
      elements: [],
      notEvaluatedReason: entry.reason
    });
    coverageByTarget.set(entry.screenId, coverage);
    warnings.push(...coverageWarnings(entry.screenName, [coverage]));
  }

  const ordered = [...mains, ...states];
  const cap = input.maxScreens ?? ordered.length;
  const keepCount = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : ordered.length;
  const kept = ordered.slice(0, keepCount);
  const capped = ordered.slice(keepCount);
  cappedTargets.push(...capped);
  if (capped.length > 0) {
    const cappedMains = capped.filter((target) => targetStateOf(target) === null).length;
    const cappedStates = capped.length - cappedMains;
    stats.screensCapped = cappedMains;
    stats.statesCapped = cappedStates;
    for (const target of capped) {
      const coverage = evaluateNotEvaluated(target, "capped");
      coverageByTarget.set(target.id, coverage);
      warnings.push(...coverageWarnings(scopeName(target), [coverage]));
    }
    warnings.push({
      code: "vision-screen-cap",
      message:
        `视觉识别目标数超过上限 ${keepCount}，已截断 ${capped.length} 个` +
        `（主屏 ${cappedMains} / 变体 ${cappedStates}；如需全量请设 AOS_VISION_MAX_SCREENS=0）`,
      details: capped.map(labelOf)
    });
  }

  let rejected: VisionPassResult["rejected"] = null;
  for (let index = 0; index < kept.length; index += 1) {
    const target = kept[index]!;
    const isState = targetStateOf(target) !== null;
    const markSkipped = (reason: "render-missing" | "rejected"): void => {
      if (isState) stats.statesSkipped += 1;
      else stats.screensSkipped += 1;
      const coverage = evaluateNotEvaluated(target, reason);
      coverageByTarget.set(target.id, coverage);
      warnings.push(...coverageWarnings(scopeName(target), [coverage]));
    };
    const image = input.imageFor(target.id);
    if (!image) {
      markSkipped("render-missing");
      warnings.push({
        code: "vision-render-no-output",
        message: `${describeTarget(target)}无可渲染图，已跳过视觉识别`
      });
      continue;
    }
    let content: string;
    try {
      content = await input.chat(buildVisionMessages(target, image));
    } catch (error) {
      stats.failures += 1;
      const rejection = classifyModalityRejection(error);
      if (rejection) {
        rejected = { screen: describeTarget(target), detail: rejection };
        const remaining = kept.slice(index);
        for (const entry of remaining) {
          const entryIsState = targetStateOf(entry) !== null;
          if (entryIsState) stats.statesSkipped += 1;
          else stats.screensSkipped += 1;
          const coverage = evaluateNotEvaluated(entry, "rejected");
          coverageByTarget.set(entry.id, coverage);
          warnings.push(...coverageWarnings(scopeName(entry), [coverage]));
        }
        const names = remaining.map(labelOf);
        warnings.push({
          code: "vision-model-rejected",
          message:
            `模型拒绝图片输入（${describeTarget(target)}）：${rejection}；` +
            `当前及其后 ${remaining.length} 个目标未识别（${names.slice(0, 10).join("、")}${
              names.length > 10 ? " 等" : ""
            }）`,
          details: names.slice(0, 10)
        });
        break;
      }
      if (isState) stats.statesFailed += 1;
      else stats.screensFailed += 1;
      const coverage = evaluateNotEvaluated(target, "failed");
      coverageByTarget.set(target.id, coverage);
      warnings.push(...coverageWarnings(scopeName(target), [coverage]));
      warnings.push({
        code: "vision-call-failed",
        message: `${describeTarget(target)}视觉识别调用失败：${errorMessage(error)}`
      });
      continue;
    }

    if (isState) stats.statesProcessed += 1;
    else stats.screensProcessed += 1;
    const parsed = parseVisionReply(content);
    rawElementsSeen += parsed.items.length + parsed.invalid + parsed.truncated;
    if (parsed.invalid > 0) {
      stats.invalidItems += parsed.invalid;
      warnings.push({
        code: "vision-invalid-items",
        message: `${describeTarget(target)}识别结果 ${parsed.invalid} 条无效（坐标/结构不合法），已丢弃`
      });
    }
    if (parsed.truncated > 0) {
      stats.truncatedItems += parsed.truncated;
      warnings.push({
        code: "vision-response-truncated",
        message: `${describeTarget(target)}识别结果 ${parsed.truncated} 条超出单次上限 40，已截断（覆盖判定不完整）`
      });
    }

    const state = targetStateOf(target);
    const renderPath = input.renderPath(target.id);
    const elements: FlowElement[] = [];
    for (const item of parsed.items) {
      const bboxPx = bboxInPx(item.bbox, target);
      const nodeId = groundNodeId(bboxPx, target);
      const element: FlowElement = {
        id: `vision-${target.id}-${elements.length + 1}`,
        class: item.className,
        intent: item.intent,
        ...(item.label ? { label: item.label } : {}),
        ...(nodeId ? { nodeId } : {}),
        bbox: bboxPx,
        ...(renderPath ? { evidence: { render: renderPath } } : {}),
        ...(state !== null ? { state } : {}),
        provenance: "vision-inferred",
        confidence: confidenceFor("vision-inferred")
      };
      elements.push(element);
      if (item.intent === "navigate") {
        stats.navigationalEdges += 1;
        const name = item.label ?? item.className;
        const edge: FlowEdge = {
          from: { id: target.id, name: target.name },
          to: null,
          element: { id: element.id, name, type: "VISION" },
          textHints: [],
          trigger: "VISION",
          actionType: "VISION",
          ...(state !== null ? { state } : {}),
          provenance: "vision-inferred",
          confidence: confidenceFor("vision-inferred")
        };
        if (state === null) {
          edges.push(edge);
          unresolvedDestinations.push(`${target.name} · ${name}`);
        } else {
          stateEdges.push(edge);
        }
      }
    }
    elementsByScreen.set(target.id, elements);
    const coverage = evaluateCandidateCoverage({
      state,
      designNodes: target.designNodes ?? target.nodes.length,
      candidates: target.candidates ?? [],
      elements
    });
    coverageByTarget.set(target.id, coverage);
    warnings.push(...coverageWarnings(scopeName(target), [coverage]));
    if (elements.length === 0 && parsed.invalid === 0) {
      warnings.push({
        code: "vision-no-elements",
        message: `${describeTarget(target)}未识别到可交互元素（若与预期不符请复核渲染图/模型能力）`,
        details: [content.slice(0, 200)]
      });
    }
  }

  stats.screensRequested = stats.screensProcessed + stats.screensSkipped + stats.screensFailed;
  stats.statesRequested = stats.statesProcessed + stats.statesSkipped + stats.statesFailed;
  stats.targetsRequested = stats.screensRequested + stats.statesRequested;
  for (const coverage of coverageByTarget.values()) {
    stats.candidateNodes += coverage.candidateNodes;
    stats.coveredCandidates += coverage.coveredCandidates;
    stats.uncoveredCandidates += coverage.uncoveredCandidates;
    stats.unverifiableCandidates += coverage.unverifiableCandidates;
    stats.notEvaluatedCandidates += coverage.notEvaluatedCandidates;
  }
  for (const elements of elementsByScreen.values()) {
    for (const element of elements) {
      if (element.nodeId) stats.groundedElements += 1;
      else stats.ungroundedElements += 1;
    }
  }
  stats.elements = stats.groundedElements + stats.ungroundedElements;

  const accounting = visionAccounting(stats, {
    candidatesTruncated: input.candidatesTruncated,
    groundingTruncated: input.groundingTruncated,
    rawElements: rawElementsSeen
  });
  warnings.push(...accountingWarnings(accounting));

  return {
    elementsByScreen,
    edges,
    stateEdges,
    unresolvedDestinations,
    warnings,
    stats,
    rejected,
    coverageByTarget,
    cappedTargets,
    accounting
  };
}
