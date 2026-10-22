import type { ChatFn } from "../llm/chat.js";
import {
  type FlowEdge,
  type FlowGraph,
  type FlowHint,
  type FlowScreen,
  type FlowWarning
} from "../figma/flows.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { walk } from "../vendor/design-context-bridge/figma-rest/resolve.js";

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
  /** 只解析该节点子树（与 figma_extract_flows 的 nodeId 对齐）。 */
  nodeId?: string;
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

function collectFrames(root: FigmaNode): FrameInfo[] {
  const frames: FrameInfo[] = [];
  let order = 0;
  const addFrame = (node: FigmaNode, pageName: string | null): void => {
    const bounds = boundsOf(node);
    if (!bounds) return;
    frames.push({
      node,
      id: node.id,
      name: node.name,
      bounds,
      page: pageName,
      order: order++
    });
  };
  if (root.type === "FRAME" || root.type === "SECTION") {
    addFrame(root, null);
    return frames;
  }
  const visitPage = (page: FigmaNode, pageName: string | null): void => {
    for (const node of childNodes(page)) {
      if (node.type !== "FRAME" && node.type !== "SECTION") continue;
      addFrame(node, pageName);
      if (frames.length >= MAX_FRAMES) return;
    }
  };
  const pages = childNodes(root).filter(
    (node) => node.type === "CANVAS" || node.type === "PAGE"
  );
  if (pages.length > 0) {
    for (const page of pages) visitPage(page, page.name);
  } else {
    visitPage(root, root.name);
  }
  return frames.sort((a, b) => a.order - b.order || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

function findNode(root: FigmaNode, nodeId: string): FigmaNode | null {
  let found: FigmaNode | null = null;
  walk(root, (node) => {
    if (node.id === nodeId) found = node;
  });
  return found;
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
  let scope = document;
  if (options.nodeId) {
    const found = findNode(document, options.nodeId);
    if (found) {
      scope = found;
    } else {
      warnings.push({
        code: "node-not-found",
        message: `节点 ${options.nodeId} 不在文件中，已按整份文件合成`,
        details: [options.nodeId]
      });
    }
  }
  const frames = collectFrames(scope).slice(0, options.maxScreens ?? MAX_FRAMES);
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

/** 从入口屏沿显式/已有边可达的屏幕 id 集合（无入口屏 → 空集）。 */
export function reachableScreenIds(graph: FlowGraph): Set<string> {
  const byName = new Map(graph.screens.map((screen) => [screen.name, screen.id]));
  const queue = graph.entryScreens
    .map((name) => byName.get(name))
    .filter((id): id is string => typeof id === "string");
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) {
      if (edge.from.id === id && edge.to && !reachable.has(edge.to.id)) queue.push(edge.to.id);
    }
  }
  return reachable;
}

export interface StaticEdgeMergeResult {
  graph: FlowGraph;
  added: number;
  /** 新增边的人类可读明细（`from → to（来源）`），供 warning details 截断展示。 */
  details: string[];
}

/** 混合稿补边：显式原型边保留；静态合成边只用于把入口不可达的屏接回主图，
 * 仍不可达的剩余屏按合成器画布顺序串链（inferred/low）。 */
export function mergeStaticEdges(
  explicit: FlowGraph,
  synthesized: FlowGraph
): StaticEdgeMergeResult {
  if (explicit.entryScreens.length === 0) return { graph: explicit, added: 0, details: [] };
  const byId = new Map(explicit.screens.map((screen) => [screen.id, screen]));
  const edges = [...explicit.edges];
  const pairs = new Set(edges.map((edge) => `${edge.from.id}->${edge.to?.id ?? ""}`));
  const details: string[] = [];
  const add = (edge: FlowEdge, reason: string): boolean => {
    if (!edge.to || edge.from.id === edge.to.id) return false;
    if (!byId.has(edge.from.id) || !byId.has(edge.to.id)) return false;
    const key = `${edge.from.id}->${edge.to.id}`;
    if (pairs.has(key)) return false;
    edges.push(edge);
    pairs.add(key);
    details.push(`${edge.from.name} → ${edge.to.name}（${reason}）`);
    return true;
  };

  let reachable = reachableScreenIds({ ...explicit, edges });
  const handled = new Set(reachable);
  for (const edge of synthesized.edges) {
    if (!edge.to) continue;
    if (handled.has(edge.from.id) && handled.has(edge.to.id)) continue;
    if (add(edge, "静态线索")) {
      handled.add(edge.from.id);
      handled.add(edge.to.id);
    }
  }
  reachable = reachableScreenIds({ ...explicit, edges });

  const order = synthesized.screens.map((screen) => screen.id).filter((id) => byId.has(id));
  let anchor: string | null = null;
  for (const id of order) {
    if (reachable.has(id)) {
      anchor = id;
      continue;
    }
    if (anchor === null) {
      anchor = order.find((candidate) => reachable.has(candidate)) ?? null;
      if (anchor === null) break;
    }
    const from = byId.get(anchor)!;
    const to = byId.get(id)!;
    const layoutEdge: FlowEdge = {
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      element: { id: `layout:${from.id}`, name: "画布顺序", type: "layout" },
      textHints: [],
      trigger: "INFERRED",
      actionType: "INFERRED",
      provenance: "inferred",
      confidence: "low"
    };
    if (!add(layoutEdge, "画布顺序")) continue;
    anchor = id;
    reachable = reachableScreenIds({ ...explicit, edges });
  }

  return { graph: { ...explicit, edges }, added: details.length, details };
}

// Keep the imported type referenced for declaration consumers.
export type { FigmaNode };
export type { Bounds };
