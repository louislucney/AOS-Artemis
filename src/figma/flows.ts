import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import { walk, type FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { errorMessage, escapeHtml, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import {
  figmaScreensDir,
  relativeScreenPath,
  screensEnabledFrom,
  SCREENSHOT_RENDER_UNAVAILABLE,
  SCREENSHOT_SKIPPED,
  storeScreenPng
} from "../design/screens.js";
import { captureFigmaScreens } from "./render.js";
import {
  confidenceFor,
  isAnnotationLayerName,
  resolveProvenance,
  type Confidence,
  type Provenance,
  type TextClass
} from "../provenance.js";

// ---------------------------------------------------------------------------
// Flow extraction (pure graph builder + tool)
// ---------------------------------------------------------------------------

/** `Flow/*` layer-name convention marking design annotations (shared by the
 * Figma ancestor walk and the pen subtree walk). */
export function isAcceptanceLayerName(name: unknown): boolean {
  return typeof name === "string" && /^Flow\/AC/i.test(name.trim());
}

/** Inline acceptance convention: annotation text `AC: …` / `验收标准：…`
 * (empty bodies are ignored — ambiguous criteria stay display-level; the
 * prefix vocabulary mirrors the Jira acceptance-criteria heuristic). */
export function acceptanceItemOf(text: string): string | null {
  const match =
    /^(?:AC|验收标准|验收条件|验收要求|验收|驗收標準|驗收條件|驗收要求|驗收)\s*[:：]\s*([\s\S]+)$/i.exec(
      text.trim()
    );
  const item = match?.[1]?.trim();
  return item ? item : null;
}

export interface FlowHint {
  text: string;
  textClass: TextClass;
  /** Source node identity (design node id) when known. */
  nodeId?: string;
  /** Source node bounds in design px (absolute file coordinates) when known. */
  bounds?: { x: number; y: number; width: number; height: number };
}

function validateBounds(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
    return null;
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number
  };
}

function boundsOf(node: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!node || typeof node !== "object") return null;
  return validateBounds((node as { absoluteBoundingBox?: unknown }).absoluteBoundingBox);
}

/** flows.json schema version written by extraction and required by consumers.
 * v3 adds `screens[].elements` (vision element inventory, ADR-0010): readers
 * that do not know a provenance value must not silently treat it as legacy
 * (the coverage gate would hard-flag it), hence the explicit version gate in
 * `normalizeFlowGraph`. */
export const FLOWS_SCHEMA_VERSION = 3;

/** Element recognized on a screen (currently vision-inferred, ADR-0010):
 * `class`/`intent` come from a controlled vocabulary, `label` is free text. */
export interface FlowElement {
  id: string;
  class: string;
  intent: string;
  label?: string;
  /** Design node the element was grounded onto (best geometry match). */
  nodeId?: string;
  /** Screen-local bounds in design px (render coordinate system, scale 1). */
  bbox?: { x: number; y: number; width: number; height: number };
  /** Render evidence (project-relative path). */
  evidence?: { render?: string };
  provenance: Provenance;
  confidence?: Confidence;
}

export interface FlowWarning {
  code: string;
  message: string;
  details?: string[];
}

export interface FlowScreen {
  id: string;
  name: string;
  suggestedRoute: string;
  /** 所属 Figma 页面名（可选增量字段；pen 通道不产出）。 */
  page?: string;
  /** Direct child layer names — used as visible-element hints for assertions. */
  childNames: string[];
  /** First classed TEXT contents found inside this screen. */
  textHints: FlowHint[];
  /** Screen frame bounds in design px (absolute file coordinates) when known. */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Acceptance criteria from design annotations (`Flow/AC*` groups or
   * `AC:`-prefixed annotation texts): the hard-assertion oracle (ticket 11). */
  acceptance?: string[];
  /** Vision element inventory (v3 artifacts; absent on earlier ones). */
  elements?: FlowElement[];
  /** Evidence source; absent = legacy-unknown (conservative). */
  provenance?: Provenance;
  confidence?: Confidence;
}

export interface FlowEdge {
  from: { id: string; name: string };
  to: { id: string; name: string } | null;
  element: { id: string; name: string; type: string };
  /** First classed TEXT contents inside the tapped element (locator hints). */
  textHints: FlowHint[];
  trigger: string;
  triggerTimeoutMs?: number;
  navigation?: string;
  actionType: string;
  back?: boolean;
  /** Evidence source; absent = legacy-unknown (conservative). */
  provenance?: Provenance;
  confidence?: Confidence;
}

export interface FlowGraph {
  screens: FlowScreen[];
  edges: FlowEdge[];
  entryScreens: string[];
  unresolvedDestinations: string[];
  /** Nodes carrying prototype interactions within the extracted scope (set by Figma extraction; pen omits it and emits its own warnings). */
  interactionNodes?: number;
}

export interface FlowGraphWarning {
  code: "no-entry" | "unreachable-screens" | "unresolved-destinations" | "no-interactions";
  message: string;
  details?: string[];
}

/** Deterministic structural warnings: these are exactly the ways a flow graph
 * can fail to be an entry→terminal route set, so downstream coverage gates can
 * trust `entryScreens`/reachability. */
export function flowGraphWarnings(graph: FlowGraph): FlowGraphWarning[] {
  const warnings: FlowGraphWarning[] = [];
  if (graph.screens.length > 1 && graph.edges.length === 0) {
    const nodes = graph.interactionNodes ?? 0;
    warnings.push({
      code: "no-interactions",
      message:
        nodes === 0
          ? `${graph.screens.length} 个屏幕未检测到任何原型交互（连线）：无法提取跳转，流程缺少交互信息（需在设计稿补原型连线，或改用 pen / 手工产物）`
          : `检测到 ${nodes} 个节点携带原型交互，但未提取到任何可执行跳转（action 类型可能不受支持）：流程仍为孤岛图`,
      details: graph.screens.slice(0, 10).map((screen) => screen.name)
    });
  }
  if (graph.screens.length > 0 && graph.entryScreens.length === 0) {
    warnings.push({
      code: "no-entry",
      message:
        "原型未识别到入口屏（所有屏幕都有入边）：线性化将回退为任意屏起点（entryFallback），入口→终点路线无法保证"
    });
  }
  if (graph.entryScreens.length > 0) {
    const idByName = new Map(graph.screens.map((screen) => [screen.name, screen.id]));
    const reachable = new Set<string>();
    const queue = graph.entryScreens
      .map((name) => idByName.get(name))
      .filter((id): id is string => typeof id === "string");
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of graph.edges) {
        if (edge.from.id === id && edge.to) queue.push(edge.to.id);
      }
    }
    const unreachable = graph.screens
      .filter((screen) => !reachable.has(screen.id))
      .map((screen) => screen.name);
    if (unreachable.length > 0) {
      warnings.push({
        code: "unreachable-screens",
        message: `${unreachable.length} 个屏幕无法从入口屏到达：这些屏幕不会出现在任何完整流程里`,
        details: unreachable
      });
    }
  }
  if (graph.unresolvedDestinations.length > 0) {
    warnings.push({
      code: "unresolved-destinations",
      message: `${graph.unresolvedDestinations.length} 个跳转目标不在当前解析范围内（跨文件/跨页跳转？）：对应边无目的地`,
      details: [...graph.unresolvedDestinations]
    });
  }
  return warnings;
}

interface RawInteraction {
  trigger?: { type?: string; timeout?: number };
  actions?: Array<Record<string, unknown>>;
}

/** Same slug rules as design-context-bridge's toRoute (kept local: upstream
 * does not export it). */
export function routeFor(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean || clean === "home" || clean === "landing" || clean === "index") return "/";
  return `/${clean}`;
}

/** Build a prototype flow graph from a Figma document tree.
 * Consecutive actions are preserved: every interaction becomes an edge
 * labelled with its element, trigger and navigation. */
export function buildFlowGraph(root: FigmaNode, options: { nodeId?: string } = {}): FlowGraph {
  let scope: FigmaNode | null = null;
  if (options.nodeId) {
    walk(root, (node) => {
      if (node.id === options.nodeId) scope = node;
    });
    if (!scope) throw new Error(`节点 ${options.nodeId} 不在文件中`);
  } else {
    scope = root;
  }
  const scopeRoot: FigmaNode = scope;

  const byId = new Map<string, FigmaNode>();
  const parentOf = new Map<string, string>();
  walk(scopeRoot, (node) => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child.id, node.id);
  });

  const screenOf = (id: string): FigmaNode | null => {
    let current = byId.get(id);
    if (!current) return null;
    for (;;) {
      const parentId = parentOf.get(current.id);
      if (!parentId) return current.type === "PAGE" ? null : current;
      const parent = byId.get(parentId);
      if (!parent) return current;
      if (parent.type === "PAGE") return current;
      current = parent;
    }
  };

  const isAnnotationLayer = (nodeId: string): boolean => {
    let current: FigmaNode | undefined = byId.get(nodeId);
    while (current) {
      if (isAnnotationLayerName(current.name)) return true;
      const parentId = parentOf.get(current.id);
      current = parentId ? byId.get(parentId) : undefined;
    }
    return false;
  };

  const isAcceptanceLayer = (nodeId: string): boolean => {
    let current: FigmaNode | undefined = byId.get(nodeId);
    while (current) {
      if (isAcceptanceLayerName(current.name)) return true;
      const parentId = parentOf.get(current.id);
      current = parentId ? byId.get(parentId) : undefined;
    }
    return false;
  };

  const edges: FlowEdge[] = [];
  const unresolved = new Set<string>();
  const elementTextHints = new Map<string, FlowHint[]>();
  const sources: Array<{ node: FigmaNode; interactions: RawInteraction[] }> = [];
  walk(scopeRoot, (node) => {
    const interactions = (node as { interactions?: RawInteraction[] }).interactions;
    if (Array.isArray(interactions) && interactions.length > 0) {
      sources.push({ node, interactions });
      elementTextHints.set(node.id, collectTextHints(node, 3, isAnnotationLayer));
    }
  });

  for (const { node, interactions } of sources) {
    const fromScreen = screenOf(node.id);
    for (const interaction of interactions) {
      const trigger = interaction.trigger?.type ?? "UNKNOWN";
      const timeout =
        typeof interaction.trigger?.timeout === "number" ? interaction.trigger.timeout : undefined;
      for (const action of interaction.actions ?? []) {
        const actionType = String(action.type ?? "UNKNOWN");
        let to: FigmaNode | null = null;
        let navigation: string | undefined;
        let back = false;
        if (actionType === "NODE") {
          navigation = typeof action.navigation === "string" ? action.navigation : undefined;
          const destinationId =
            typeof action.destinationId === "string" ? action.destinationId : undefined;
          if (navigation === "BACK") {
            back = true;
            to = fromScreen;
          } else if (destinationId) {
            const destination = byId.get(destinationId);
            if (destination) to = screenOf(destination.id);
            else unresolved.add(destinationId);
          }
        }
        edges.push({
          from: fromScreen
            ? { id: fromScreen.id, name: fromScreen.name }
            : { id: node.id, name: node.name },
          to: to ? { id: to.id, name: to.name } : null,
          element: { id: node.id, name: node.name, type: node.type },
          textHints: elementTextHints.get(node.id) ?? [],
          trigger,
          ...(timeout !== undefined ? { triggerTimeoutMs: timeout } : {}),
          ...(navigation ? { navigation } : {}),
          ...(back ? { back: true } : {}),
          actionType,
          provenance: "explicit",
          confidence: confidenceFor("explicit")
        });
      }
    }
  }

  const screenNodes: FigmaNode[] = [];
  walk(scopeRoot, (node) => {
    if (node.type === "PAGE") screenNodes.push(...(node.children ?? []));
  });
  if (screenNodes.length === 0 && scopeRoot.type !== "DOCUMENT" && scopeRoot.type !== "PAGE") {
    screenNodes.push(scopeRoot);
  }

  const screenTextHints = new Map<string, FlowHint[]>();
  const screenAcceptance = new Map<string, string[]>();
  for (const node of byId.values()) {
    if (node.type !== "TEXT") continue;
    const characters = (node as { characters?: unknown }).characters;
    if (typeof characters !== "string" || characters.trim() === "") continue;
    const screen = screenOf(node.id);
    if (!screen) continue;
    const text = characters.trim();
    const list = screenTextHints.get(screen.id) ?? [];
    const textClass: TextClass = isAnnotationLayer(node.id) ? "annotation" : "runtime-text";
    const classCount = list.filter((hint) => hint.textClass === textClass).length;
    if (classCount < 3 && !list.some((hint) => hint.text === text)) {
      const bounds = boundsOf(node);
      list.push({
        text,
        textClass,
        ...(typeof node.id === "string" && node.id !== "" ? { nodeId: node.id } : {}),
        ...(bounds ? { bounds } : {})
      });
      screenTextHints.set(screen.id, list);
    }
    const acceptance = isAcceptanceLayer(node.id)
      ? text
      : textClass === "annotation"
        ? acceptanceItemOf(text)
        : null;
    if (acceptance) {
      const acceptanceList = screenAcceptance.get(screen.id) ?? [];
      if (acceptanceList.length < 5 && !acceptanceList.includes(acceptance)) {
        acceptanceList.push(acceptance);
        screenAcceptance.set(screen.id, acceptanceList);
      }
    }
  }

  const pageNameOf = (screenId: string): string | null => {
    let currentId = parentOf.get(screenId);
    while (currentId) {
      const current = byId.get(currentId);
      if (!current) return null;
      if (current.type === "PAGE") return current.name;
      currentId = parentOf.get(currentId);
    }
    return null;
  };

  const screens: FlowScreen[] = screenNodes.map((screen) => {
    const acceptance = screenAcceptance.get(screen.id) ?? [];
    const bounds = boundsOf(screen);
    const page = pageNameOf(screen.id);
    return {
      id: screen.id,
      name: screen.name,
      suggestedRoute: routeFor(screen.name),
      ...(page ? { page } : {}),
      childNames: (screen.children ?? []).slice(0, 10).map((child) => child.name),
      textHints: screenTextHints.get(screen.id) ?? [],
      ...(bounds ? { bounds } : {}),
      ...(acceptance.length > 0 ? { acceptance } : {}),
      provenance: "explicit",
      confidence: confidenceFor("explicit")
    };
  });

  const incoming = new Set(edges.filter((edge) => edge.to).map((edge) => edge.to!.id));
  return {
    screens,
    edges,
    entryScreens: screens.filter((screen) => !incoming.has(screen.id)).map((screen) => screen.name),
    unresolvedDestinations: [...unresolved],
    interactionNodes: sources.length
  };
}

/** Normalize persisted hints (string entries from v1 artifacts, classed
 * objects from v2) into classed records. Legacy strings count as runtime text
 * and unknown classes downgrade to annotation (display-only, never silently
 * promoted into assertions). */
export function normalizeFlowHints(raw: unknown): FlowHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: FlowHint[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text !== "") hints.push({ text, textClass: "runtime-text" });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as { text?: unknown; textClass?: unknown; nodeId?: unknown; bounds?: unknown };
      if (typeof record.text !== "string" || record.text.trim() === "") continue;
      const textClass: TextClass =
        record.textClass === "runtime-text" ||
        record.textClass === "layer-name" ||
        record.textClass === "annotation"
          ? record.textClass
          : "annotation";
      const bounds = validateBounds(record.bounds);
      hints.push({
        text: record.text.trim(),
        textClass,
        ...(typeof record.nodeId === "string" && record.nodeId !== "" ? { nodeId: record.nodeId } : {}),
        ...(bounds ? { bounds } : {})
      });
    }
  }
  return hints;
}

function normalizeFlowElements(raw: unknown): FlowElement[] {
  if (!Array.isArray(raw)) return [];
  const elements: FlowElement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id !== "" ? record.id : null;
    if (!id) continue;
    const provenance = resolveProvenance(record.provenance);
    const bbox = validateBounds(record.bbox);
    const evidenceRaw =
      record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence)
        ? (record.evidence as { render?: unknown })
        : null;
    const render = evidenceRaw && typeof evidenceRaw.render === "string" ? evidenceRaw.render : null;
    elements.push({
      id,
      class: typeof record.class === "string" && record.class !== "" ? record.class : "other",
      intent: typeof record.intent === "string" && record.intent !== "" ? record.intent : "other",
      ...(typeof record.label === "string" && record.label !== "" ? { label: record.label } : {}),
      ...(typeof record.nodeId === "string" && record.nodeId !== "" ? { nodeId: record.nodeId } : {}),
      ...(bbox ? { bbox } : {}),
      ...(render ? { evidence: { render } } : {}),
      provenance,
      confidence: confidenceFor(provenance)
    });
  }
  return elements;
}

/** Normalize a persisted flow graph (v1 artifacts lack provenance/text
 * classes): missing evidence fields become legacy-unknown/low, string hints
 * become runtime-text records. Unknown future fields are dropped. A
 * `schemaVersion` newer than `FLOWS_SCHEMA_VERSION` fails loud instead of
 * degrading every unknown provenance value to legacy-unknown (which the
 * coverage gate treats as hard). */
export function normalizeFlowGraph(raw: unknown): FlowGraph {
  const versionSource = (raw ?? {}) as { schemaVersion?: unknown };
  if (
    typeof versionSource.schemaVersion === "number" &&
    versionSource.schemaVersion > FLOWS_SCHEMA_VERSION
  ) {
    throw new Error(
      `flows.json schemaVersion ${versionSource.schemaVersion} 高于本版本支持范围 ${FLOWS_SCHEMA_VERSION}：请升级 AOS 后重试`
    );
  }
  const source = (raw ?? {}) as {
    screens?: unknown;
    edges?: unknown;
    entryScreens?: unknown;
    unresolvedDestinations?: unknown;
    interactionNodes?: unknown;
  };
  const screensRaw = Array.isArray(source.screens) ? source.screens : [];
  const edgesRaw = Array.isArray(source.edges) ? source.edges : [];

  const screens: FlowScreen[] = screensRaw.map((entry) => {
    const screen = (entry ?? {}) as Record<string, unknown>;
    const name = typeof screen.name === "string" ? screen.name : "";
    const provenance = resolveProvenance(screen.provenance);
    const screenBounds = validateBounds(screen.bounds);
    return {
      id: typeof screen.id === "string" ? screen.id : "",
      name,
      suggestedRoute:
        typeof screen.suggestedRoute === "string" ? screen.suggestedRoute : routeFor(name),
      ...(() => {
        const page = typeof screen.page === "string" ? screen.page.trim() : "";
        return page !== "" ? { page } : {};
      })(),
      childNames: Array.isArray(screen.childNames)
        ? screen.childNames.filter((child): child is string => typeof child === "string")
        : [],
      textHints: normalizeFlowHints(screen.textHints),
      ...(() => {
        const elements = normalizeFlowElements(screen.elements);
        return elements.length > 0 ? { elements } : {};
      })(),
      ...(screenBounds ? { bounds: screenBounds } : {}),
      ...(() => {
        if (!Array.isArray(screen.acceptance)) return {};
        const acceptance = [
          ...new Set(
            screen.acceptance
              .filter((item): item is string => typeof item === "string" && item.trim() !== "")
              .map((item) => item.trim())
          )
        ].slice(0, 5);
        return acceptance.length > 0 ? { acceptance } : {};
      })(),
      provenance,
      confidence: confidenceFor(provenance)
    };
  });

  const pickRef = (value: unknown): { id: string; name: string } => {
    if (value && typeof value === "object") {
      const record = value as { id?: unknown; name?: unknown };
      return {
        id: typeof record.id === "string" ? record.id : "",
        name: typeof record.name === "string" ? record.name : ""
      };
    }
    return { id: "", name: "" };
  };
  const pickOptionalRef = (value: unknown): { id: string; name: string } | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as { id?: unknown; name?: unknown };
    if (typeof record.name !== "string" || record.name === "") return null;
    return { id: typeof record.id === "string" ? record.id : "", name: record.name };
  };

  const edges: FlowEdge[] = edgesRaw.map((entry) => {
    const edge = (entry ?? {}) as Record<string, unknown>;
    const provenance = resolveProvenance(edge.provenance);
    const elementRaw = (edge.element ?? {}) as { id?: unknown; name?: unknown; type?: unknown };
    return {
      from: pickRef(edge.from),
      to: pickOptionalRef(edge.to),
      element: {
        id: typeof elementRaw.id === "string" ? elementRaw.id : "",
        name: typeof elementRaw.name === "string" ? elementRaw.name : "",
        type: typeof elementRaw.type === "string" ? elementRaw.type : "UNKNOWN"
      },
      textHints: normalizeFlowHints(edge.textHints),
      trigger: typeof edge.trigger === "string" ? edge.trigger : "UNKNOWN",
      ...(typeof edge.triggerTimeoutMs === "number" ? { triggerTimeoutMs: edge.triggerTimeoutMs } : {}),
      ...(typeof edge.navigation === "string" ? { navigation: edge.navigation } : {}),
      ...(edge.back === true ? { back: true } : {}),
      actionType: typeof edge.actionType === "string" ? edge.actionType : "UNKNOWN",
      provenance,
      confidence: confidenceFor(provenance)
    };
  });

  return {
    screens,
    edges,
    entryScreens: Array.isArray(source.entryScreens)
      ? source.entryScreens.filter((name): name is string => typeof name === "string")
      : [],
    unresolvedDestinations: Array.isArray(source.unresolvedDestinations)
      ? source.unresolvedDestinations.filter(
          (destination): destination is string => typeof destination === "string"
        )
      : [],
    ...(typeof source.interactionNodes === "number"
      ? { interactionNodes: source.interactionNodes }
      : {})
  };
}

function collectTextHints(
  node: FigmaNode,
  perClassLimit: number,
  isAnnotation: (id: string) => boolean
): FlowHint[] {
  const hints: FlowHint[] = [];
  const countOf = (textClass: TextClass): number =>
    hints.filter((hint) => hint.textClass === textClass).length;
  walk(node, (candidate) => {
    if (candidate.type !== "TEXT") return;
    const characters = (candidate as { characters?: unknown }).characters;
    if (typeof characters !== "string") return;
    const text = characters.trim();
    if (text === "" || hints.some((hint) => hint.text === text)) return;
    const textClass: TextClass = isAnnotation(candidate.id) ? "annotation" : "runtime-text";
    if (countOf(textClass) >= perClassLimit) return;
    const bounds = boundsOf(candidate);
    hints.push({
      text,
      textClass,
      ...(typeof candidate.id === "string" && candidate.id !== "" ? { nodeId: candidate.id } : {}),
      ...(bounds ? { bounds } : {})
    });
  });
  return hints;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const TOKEN_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或调用 aos_configure 携带 figmaToken）。";

export interface ExtractFlowsArgs {
  url: string;
  nodeId?: string;
  save?: boolean;
  /** 渲染屏幕截图并嵌入 flow-map.md（默认 true；`AOS_SCREENS=0` 全局关闭）。 */
  screens?: boolean;
}

export interface FigmaFlowsDeps {
  /** 渲染重试等待（测试注入；默认真实等待）。 */
  sleep?: (ms: number) => Promise<void>;
}

interface FigmaScreensResult {
  imagePaths: Map<string, string>;
  warnings: FlowWarning[];
  summary: { dir: string; rendered: number; skipped: number; skippedScreens: string[] };
}

/** 批量渲染屏幕 → 原子入库 `design/screens/figma-<fileKey>/`；失败逐屏/通道级降级。 */
async function captureAndStoreFigmaScreens(
  runtime: Runtime,
  fileKey: string,
  screens: FlowScreen[],
  deps: FigmaFlowsDeps
): Promise<FigmaScreensResult> {
  const capture = await captureFigmaScreens(fileKey, screens.map((screen) => screen.id), deps);
  const targetDir = figmaScreensDir(runtime.configDirAbs, fileKey);
  const imagePaths = new Map<string, string>();
  for (const [id, png] of capture.pngById) {
    const stored = storeScreenPng(targetDir, id, png);
    if (stored.status !== "invalid") imagePaths.set(id, stored.path);
  }
  const skipped = screens.map((screen) => screen.id).filter((id) => !imagePaths.has(id));
  const warnings: FlowWarning[] = [];
  if (capture.channelError !== null) {
    warnings.push({
      code: SCREENSHOT_RENDER_UNAVAILABLE,
      message: `截图已跳过：Figma 渲染不可用（${capture.channelError}）`
    });
  } else if (imagePaths.size === 0 && skipped.length > 0) {
    warnings.push({
      code: SCREENSHOT_RENDER_UNAVAILABLE,
      message: "截图已跳过：Figma 未产出渲染图"
    });
  } else if (skipped.length > 0) {
    warnings.push({
      code: SCREENSHOT_SKIPPED,
      message: `截图降级：${skipped.length} 屏未产出渲染（${skipped.slice(0, 5).join("、")}${
        skipped.length > 5 ? " 等" : ""
      }）`
    });
  }
  return {
    imagePaths,
    warnings,
    summary: {
      dir: relativeScreenPath(path.join(runtime.configDirAbs, "design"), targetDir),
      rendered: imagePaths.size,
      skipped: skipped.length,
      skippedScreens: skipped
    }
  };
}

/** Figma 交互地图 md（design-screenshots T3）：屏幕（含缩略图）/跳转/入口/未决/警告/统计。 */
export function renderFigmaFlowMap(input: {
  fileKey: string;
  fileName: string | null;
  generatedAt: string;
  graph: FlowGraph;
  warnings: FlowWarning[];
  images?: Map<string, string>;
}): string {
  const lines: string[] = [
    "# Figma 交互地图",
    "",
    `> 来源: figma:${input.fileKey}${input.fileName ? ` (${input.fileName})` : ""}`,
    `> 生成时间: ${input.generatedAt}`,
    ""
  ];
  lines.push("## 屏幕（含缩略图）", "");
  for (const screen of input.graph.screens) {
    const route = screen.suggestedRoute ? `（${screen.suggestedRoute}）` : "";
    lines.push(`- ${screen.name}${route}`);
    const image = input.images?.get(screen.id);
    if (image) {
      lines.push(`  - <img src="${image}" alt="${escapeHtml(screen.name)}" height="200">`);
    }
  }
  lines.push("");
  lines.push("## 跳转", "");
  if (input.graph.edges.length === 0) {
    lines.push("（无连线）");
  } else {
    for (const edge of input.graph.edges) {
      const to = edge.to ? edge.to.name : "（未决）";
      const trigger = edge.trigger ? ` [${edge.trigger}]` : "";
      const element = edge.element?.name ? ` · ${edge.element.name}` : "";
      lines.push(`- ${edge.from.name} → ${to}${trigger}${element}`);
    }
  }
  lines.push("");
  lines.push("## 入口屏", "");
  lines.push(
    input.graph.entryScreens.length > 0
      ? input.graph.entryScreens.map((name) => `- ${name}`).join("\n")
      : "（无）"
  );
  lines.push("");
  if (input.graph.unresolvedDestinations.length > 0) {
    lines.push("## 未决目的地", "");
    for (const id of input.graph.unresolvedDestinations) lines.push(`- ${id}`);
    lines.push("");
  }
  lines.push("## 警告", "");
  if (input.warnings.length === 0) {
    lines.push("（无）");
  } else {
    for (const warning of input.warnings) {
      lines.push(`- [${warning.code}] ${warning.message}`);
      for (const detail of warning.details ?? []) lines.push(`  - ${detail}`);
    }
  }
  lines.push("", "## 统计", "");
  lines.push(
    `- 屏幕 ${input.graph.screens.length} · 跳转 ${input.graph.edges.length} · 入口 ${input.graph.entryScreens.length} · 交互节点 ${input.graph.interactionNodes ?? 0}`
  );
  return lines.join("\n") + "\n";
}

export async function figmaExtractFlows(
  runtime: Runtime,
  args: ExtractFlowsArgs,
  deps: FigmaFlowsDeps = {}
): Promise<CallToolResult> {
  try {
    const { fileKey } = parseFigmaUrl(args.url);
    const file = (await fetchFile(fileKey)) as {
      name?: string;
      version?: unknown;
      lastModified?: unknown;
      document?: FigmaNode;
    };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);

    const graph = buildFlowGraph(file.document, { nodeId: args.nodeId });
    const dotenv = runtime.project.dotenvValues ?? {};
    const wantScreens = screensEnabledFrom({ ...process.env, ...dotenv }, args.screens);
    const screens = wantScreens
      ? await captureAndStoreFigmaScreens(runtime, fileKey, graph.screens, deps)
      : null;
    const warnings: FlowWarning[] = [...flowGraphWarnings(graph), ...(screens?.warnings ?? [])];
    const fileVersion = typeof file.version === "string" ? file.version : null;
    const lastModified = typeof file.lastModified === "string" ? file.lastModified : null;
    const payload: Record<string, unknown> = {
      ok: true,
      schemaVersion: FLOWS_SCHEMA_VERSION,
      fileKey,
      fileName: file.name ?? null,
      ...(fileVersion !== null ? { fileVersion } : {}),
      ...(lastModified !== null ? { lastModified } : {}),
      counts: {
        screens: graph.screens.length,
        edges: graph.edges.length,
        entryScreens: graph.entryScreens.length,
        unresolved: graph.unresolvedDestinations.length,
        interactionNodes: graph.interactionNodes ?? 0,
        warnings: warnings.length
      },
      warnings,
      ...(screens ? { screenshots: screens.summary } : {}),
      ...graph
    };

    if (args.save !== false) {
      const designDirAbs = path.join(runtime.configDirAbs, "design");
      const jsonPath = path.join(designDirAbs, "flows.json");
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      const imageRefs = new Map<string, string>();
      for (const [screenId, filePath] of screens?.imagePaths ?? []) {
        imageRefs.set(screenId, relativeScreenPath(designDirAbs, filePath));
      }
      const markdownPath = path.join(designDirAbs, "flow-map.md");
      writeFileAtomic(
        markdownPath,
        renderFigmaFlowMap({
          fileKey,
          fileName: file.name ?? null,
          generatedAt: new Date().toISOString(),
          graph,
          warnings,
          images: imageRefs
        })
      );
      payload.savedTo = { json: jsonPath, markdown: markdownPath };
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `流程图解析失败: ${errorMessage(error)}`, hint: TOKEN_HINT }, true);
  }
}
