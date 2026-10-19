import type { ChatFn, ChatMessage } from "../llm/chat.js";
import { classifyModalityRejection } from "../llm/vision-capability.js";
import { confidenceFor } from "../provenance.js";
import type { FlowEdge, FlowElement, FlowWarning } from "../figma/flows.js";
import type { VisionCandidate } from "./element-coverage.js";
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
  /** 渲染倍率；默认 1。非 1 时 bbox 先除以它再进入设计 px 判定。 */
  renderScale?: number;
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

export interface VisionPassResult {
  elementsByScreen: Map<string, FlowElement[]>;
  edges: FlowEdge[];
  unresolvedDestinations: string[];
  warnings: FlowWarning[];
  /** 首个「模型不接受图片」的拒绝（400/415/422 类）；命中即中止后续屏幕。 */
  rejected: { screen: string; detail: string } | null;
  stats: VisionStats;
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

/** Advance a vision pass over rendered screens. `chat` and the image lookup
 * are injected so tests (and future Figma support) share this module without
 * touching the network or the pen CLI. */
export async function runVisionPass(input: {
  chat: ChatFn;
  screens: VisionScreenInput[];
  imageFor: (screenId: string) => string | null;
  renderPath: (screenId: string) => string | null;
  maxScreens?: number;
}): Promise<VisionPassResult> {
  const warnings: FlowWarning[] = [];
  const elementsByScreen = new Map<string, FlowElement[]>();
  const edges: FlowEdge[] = [];
  const unresolvedDestinations: string[] = [];
  const stats: VisionStats = {
    screensRequested: input.screens.length,
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
  const cap = input.maxScreens ?? input.screens.length;
  const kept = input.screens.slice(0, Math.max(cap, 0));
  if (kept.length < input.screens.length) {
    warnings.push({
      code: "vision-screen-cap",
      message: `视觉识别屏幕数超过上限 ${cap}，已截断（共 ${input.screens.length}）`
    });
  }

  let rejected: VisionPassResult["rejected"] = null;
  for (let index = 0; index < kept.length; index += 1) {
    const screen = kept[index]!;
    const image = input.imageFor(screen.id);
    if (!image) {
      stats.screensSkipped += 1;
      warnings.push({
        code: "vision-render-no-output",
        message: `屏幕「${screen.name}」无可渲染图，已跳过视觉识别`
      });
      continue;
    }
    let content: string;
    try {
      content = await input.chat(buildVisionMessages(screen, image));
    } catch (error) {
      stats.failures += 1;
      const rejection = classifyModalityRejection(error);
      if (rejection) {
        rejected = { screen: screen.name, detail: rejection };
        stats.screensSkipped += kept.length - (index + 1);
        warnings.push({
          code: "vision-model-rejected",
          message: `模型拒绝图片输入（屏幕「${screen.name}」）：${rejection}`
        });
        break;
      }
      warnings.push({
        code: "vision-call-failed",
        message: `屏幕「${screen.name}」视觉识别调用失败：${errorMessage(error)}`
      });
      continue;
    }
    const parsed = parseVisionReply(content);
    if (parsed.items.length === 0) {
      stats.screensProcessed += 1;
      if (parsed.invalid > 0) {
        stats.invalidItems += parsed.invalid;
        warnings.push({
          code: "vision-invalid-items",
          message: `屏幕「${screen.name}」识别结果 ${parsed.invalid} 条无效（坐标/结构不合法），已丢弃`
        });
      } else {
        warnings.push({
          code: "vision-no-elements",
          message: `屏幕「${screen.name}」未识别到可交互元素（若与预期不符请复核渲染图/模型能力）`,
          details: [content.slice(0, 200)]
        });
      }
      continue;
    }
    if (parsed.invalid > 0) {
      stats.invalidItems += parsed.invalid;
      warnings.push({
        code: "vision-invalid-items",
        message: `屏幕「${screen.name}」识别结果 ${parsed.invalid} 条无效（坐标/结构不合法），已丢弃`
      });
    }
    const renderPath = input.renderPath(screen.id);
    const elements: FlowElement[] = [];
    for (const item of parsed.items) {
      const bboxPx = bboxInPx(item.bbox, screen);
      const nodeId = groundNodeId(bboxPx, screen);
      const element: FlowElement = {
        id: `vision-${screen.id}-${elements.length + 1}`,
        class: item.className,
        intent: item.intent,
        ...(item.label ? { label: item.label } : {}),
        ...(nodeId ? { nodeId } : {}),
        bbox: bboxPx,
        ...(renderPath ? { evidence: { render: renderPath } } : {}),
        provenance: "vision-inferred",
        confidence: confidenceFor("vision-inferred")
      };
      elements.push(element);
      if (item.intent === "navigate") {
        stats.navigationalEdges += 1;
        const name = item.label ?? item.className;
        unresolvedDestinations.push(`${screen.name} · ${name}`);
        edges.push({
          from: { id: screen.id, name: screen.name },
          to: null,
          element: { id: element.id, name, type: "VISION" },
          textHints: [],
          trigger: "VISION",
          actionType: "VISION",
          provenance: "vision-inferred",
          confidence: confidenceFor("vision-inferred")
        });
      }
    }
    stats.elements += elements.length;
    stats.screensProcessed += 1;
    elementsByScreen.set(screen.id, elements);
  }

  return { elementsByScreen, edges, unresolvedDestinations, warnings, stats, rejected };
}
