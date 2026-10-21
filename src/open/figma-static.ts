import type { ChatFn } from "../llm/chat.js";
import {
  type FlowEdge,
  type FlowGraph,
  type FlowHint,
  type FlowScreen,
  type FlowWarning
} from "../figma/flows.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";

type Bounds = { x: number; y: number; width: number; height: number };

interface FrameInfo {
  node: FigmaNode;
  id: string;
  name: string;
  bounds: Bounds;
  page: string | null;
  order: number;
}

export interface StaticSynthesisResult {
  graph: FlowGraph;
  warnings: FlowWarning[];
}

export interface StaticSynthesisOptions {
  chat?: ChatFn;
  maxScreens?: number;
}

const MAX_FRAMES = 200;
const NEAR_PX = 160;

function boundsOf(node: unknown): Bounds | null {
  if (!node || typeof node !== "object") return null;
  const box = (node as { absoluteBoundingBox?: unknown }).absoluteBoundingBox;
  if (!box || typeof box !== "object") return null;
  const record = box as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number
  };
}

function childNodes(node: FigmaNode): FigmaNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function textOf(node: FigmaNode): string | null {
  const value = (node as { characters?: unknown }).characters;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function center(bounds: Bounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distanceToBounds(point: { x: number; y: number }, bounds: Bounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

function slug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "/screen" : `/${cleaned}`;
}

function normalizedName(name: string): string {
  return name
    .replace(/(页面|界面|屏幕|页)$/g, "")
    .replace(/[\s_\-—·]+/g, "")
    .toLowerCase();
}

function collectFrames(document: FigmaNode): FrameInfo[] {
  const frames: FrameInfo[] = [];
  let order = 0;
  const visitPage = (page: FigmaNode, pageName: string | null): void => {
    for (const node of childNodes(page)) {
      if (node.type !== "FRAME" && node.type !== "SECTION") continue;
      const bounds = boundsOf(node);
      if (!bounds) continue;
      frames.push({
        node,
        id: node.id,
        name: node.name,
        bounds,
        page: pageName,
        order: order++
      });
      if (frames.length >= MAX_FRAMES) return;
    }
  };
  const pages = childNodes(document).filter(
    (node) => node.type === "CANVAS" || node.type === "PAGE"
  );
  if (pages.length > 0) {
    for (const page of pages) visitPage(page, page.name);
  } else {
    visitPage(document, document.name);
  }
  return frames.sort((a, b) => a.order - b.order || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function collectHints(frame: FigmaNode): FlowHint[] {
  const hints: FlowHint[] = [];
  const visit = (node: FigmaNode): void => {
    const text = textOf(node);
    if (text !== null && node.type === "TEXT" && !hints.some((hint) => hint.text === text)) {
      const bounds = boundsOf(node);
      hints.push({
        text,
        textClass: "runtime-text",
        ...(bounds ? { bounds } : {})
      });
    }
    for (const child of childNodes(node)) visit(child);
  };
  for (const child of childNodes(frame)) visit(child);
  return hints.slice(0, 10);
}

function nearestFrame(point: { x: number; y: number }, frames: FrameInfo[]): FrameInfo | null {
  let best: FrameInfo | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = distanceToBounds(point, frame.bounds);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = frame;
    }
  }
  return bestDistance <= NEAR_PX ? best : null;
}

function frameByName(target: string, frames: FrameInfo[], source: FrameInfo | null): FrameInfo | null {
  const needle = normalizedName(target);
  if (needle === "") return null;
  const matches = frames.filter((frame) => {
    const name = normalizedName(frame.name);
    return name === needle || name.includes(needle) || needle.includes(name);
  });
  if (matches.length === 0) return null;
  if (source !== null) {
    const forward = matches.find((frame) => frame.order > source.order);
    if (forward) return forward;
  }
  return matches[0]!;
}

function arrowEdge(
  node: FigmaNode,
  frames: FrameInfo[]
): { from: FrameInfo; to: FrameInfo; name: string } | null {
  const name = node.name ?? "";
  const isLine = node.type === "LINE" || /(箭头|arrow|连线|flow|引导)/i.test(name);
  if (!isLine) return null;
  const bounds = boundsOf(node);
  if (!bounds) return null;
  const horizontal = bounds.width >= bounds.height;
  const start = horizontal
    ? { x: bounds.x, y: bounds.y + bounds.height / 2 }
    : { x: bounds.x + bounds.width / 2, y: bounds.y };
  const end = horizontal
    ? { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
    : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  const first = nearestFrame(start, frames);
  const second = nearestFrame(end, frames);
  if (!first || !second || first.id === second.id) return null;
  const backwards = /(返回|反向|back)/i.test(name);
  return backwards
    ? { from: second, to: first, name: name || "引导线" }
    : { from: first, to: second, name: name || "引导线" };
}

function parseAnnotation(text: string): { action: string; target: string } | null {
  const normalized = text.replace(/[「」『』“”"']/g, "").trim();
  const match =
    /^(.*?(?:点击|单击|输入|选择|进入|打开|跳转).*?)[，,、;；]?\s*(?:→|->|=>|进入|跳转到|跳转|打开)\s*(.+)$/.exec(
      normalized
    );
  if (!match) return null;
  const action = match[1]?.trim() ?? "";
  const target = match[2]?.trim() ?? "";
  if (action === "" || target === "") return null;
  return { action, target };
}

async function llmAnnotation(
  text: string,
  frames: FrameInfo[],
  chat: ChatFn
): Promise<{ action: string; target: string } | null> {
  const names = frames.map((frame) => frame.name).join("、");
  const reply = await chat([
    {
      role: "system",
      content:
        "你是设计稿注释解析器。把注释解析为 JSON：{\"action\":\"用户动作\",\"target\":\"目标画板名\"}。" +
        "target 必须来自给定画板名；无法判断时输出 null。只输出 JSON。"
    },
    { role: "user", content: `画板：${names}\n注释：${text}` }
  ]);
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { action?: unknown; target?: unknown };
    if (typeof parsed.action !== "string" || typeof parsed.target !== "string") return null;
    return { action: parsed.action, target: parsed.target };
  } catch {
    return null;
  }
}

/** 静态 Figma 稿 → 流程：原型边优先（调用方判断），否则按箭头/注释/画布顺序推断。 */
export async function synthesizeStaticFlows(
  file: unknown,
  options: StaticSynthesisOptions = {}
): Promise<StaticSynthesisResult> {
  const document = (file as { document?: FigmaNode } | null)?.document ?? (file as FigmaNode);
  const warnings: FlowWarning[] = [];
  if (!document || typeof document !== "object") {
    warnings.push({ code: "no-screens", message: "设计文件没有 document 数据" });
    return { graph: { screens: [], edges: [], entryScreens: [], unresolvedDestinations: [] }, warnings };
  }
  const frames = collectFrames(document).slice(0, options.maxScreens ?? MAX_FRAMES);
  if (frames.length === 0) {
    warnings.push({ code: "no-screens", message: "未找到顶层画板（FRAME），无法合成流程" });
    return { graph: { screens: [], edges: [], entryScreens: [], unresolvedDestinations: [] }, warnings };
  }

  const edges: FlowEdge[] = [];
  const edgeKeys = new Set<string>();
  const pushEdge = (
    from: FrameInfo,
    to: FrameInfo,
    element: FlowEdge["element"],
    hintText: string | null
  ): void => {
    const key = `${from.id}->${to.id}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      element,
      textHints: hintText === null ? [] : [{ text: hintText, textClass: "annotation" }],
      trigger: "ON_CLICK",
      actionType: "NAVIGATE",
      provenance: "inferred",
      confidence: "low"
    });
  };

  const frameIds = new Set(frames.map((frame) => frame.id));
  const insideFrame = new Set<string>();
  for (const frame of frames) {
    const visit = (node: FigmaNode): void => {
      insideFrame.add(node.id);
      for (const child of childNodes(node)) visit(child);
    };
    for (const child of childNodes(frame.node)) visit(child);
  }

  const outerNodes: FigmaNode[] = [];
  const collectOuter = (node: FigmaNode): void => {
    if (!frameIds.has(node.id) && !insideFrame.has(node.id)) outerNodes.push(node);
    for (const child of childNodes(node)) collectOuter(child);
  };
  collectOuter(document);

  let arrowCount = 0;
  for (const node of outerNodes) {
    const arrow = arrowEdge(node, frames);
    if (!arrow) continue;
    arrowCount += 1;
    pushEdge(arrow.from, arrow.to, { id: node.id, name: arrow.name, type: "line" }, null);
  }

  let annotationCount = 0;
  for (const node of outerNodes) {
    const text = textOf(node);
    if (text === null || node.type !== "TEXT") continue;
    const bounds = boundsOf(node);
    if (!bounds) continue;
    const source = nearestFrame(center(bounds), frames);
    if (!source) continue;
    const parsed = parseAnnotation(text) ?? (options.chat ? await llmAnnotation(text, frames, options.chat) : null);
    if (!parsed) {
      warnings.push({ code: "annotation-unparsed", message: `注释无法解析：${text}` });
      continue;
    }
    const target = frameByName(parsed.target, frames, source);
    if (!target) {
      warnings.push({
        code: "annotation-unparsed",
        message: `注释未匹配到画板：${text}`,
        details: [parsed.target]
      });
      continue;
    }
    annotationCount += 1;
    pushEdge(
      source,
      target,
      { id: node.id, name: parsed.action || "注释", type: "annotation" },
      text
    );
  }

  if (arrowCount === 0 && annotationCount === 0) {
    for (let index = 0; index < frames.length - 1; index += 1) {
      const from = frames[index]!;
      const to = frames[index + 1]!;
      if (edges.some((edge) => edge.from.id === from.id)) continue;
      pushEdge(from, to, { id: `layout:${from.id}`, name: "画布顺序", type: "layout" }, null);
    }
    if (edges.length > 0) {
      warnings.push({
        code: "layout-fallback",
        message: "未检测到箭头/注释：流程按画布顺序推断，需复核"
      });
    }
  } else {
    warnings.push({
      code: "static-flow-inferred",
      message: "静态稿：流程由箭头/文字注释推断（INFERRED），需复核"
    });
  }

  const screens: FlowScreen[] = frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    suggestedRoute: slug(frame.name),
    ...(frame.page ? { page: frame.page } : {}),
    childNames: childNodes(frame.node)
      .slice(0, 10)
      .map((child) => child.name),
    textHints: collectHints(frame.node),
    bounds: frame.bounds,
    provenance: "inferred",
    confidence: "low"
  }));
  const incoming = new Set(edges.map((edge) => edge.to?.id).filter((id): id is string => Boolean(id)));
  const entryScreens = frames.filter((frame) => !incoming.has(frame.id)).map((frame) => frame.name);
  return {
    graph: {
      screens,
      edges,
      entryScreens: entryScreens.length > 0 ? entryScreens : [frames[0]!.name],
      unresolvedDestinations: [],
      interactionNodes: 0
    },
    warnings
  };
}

// Keep the imported type referenced for declaration consumers.
export type { FigmaNode };
export type { Bounds };
