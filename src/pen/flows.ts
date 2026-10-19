import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage, escapeHtml, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import {
  acceptanceItemOf,
  flowGraphWarnings,
  FLOWS_SCHEMA_VERSION,
  isAcceptanceLayerName,
  routeFor,
  type FlowEdge,
  type FlowElement,
  type FlowGraph,
  type FlowHint,
  type FlowWarning
} from "../figma/flows.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import {
  openVisionCapabilityCache,
  parseDeclaredVision,
  resolveVisionCapability,
  visionCacheTtlMsFromEnv,
  visionCapabilityKey,
  type VisionCapabilityCache,
  type VisionCapabilitySource
} from "../llm/vision-capability.js";
import { runVisionPass, type VisionNodeGeom, type VisionScreenInput } from "../design/vision.js";
import {
  candidateNameMatches,
  type FlowElementCoverage,
  type VisionCandidate
} from "../design/element-coverage.js";
import { confidenceFor, isAnnotationLayerName, type Confidence, type Provenance } from "../provenance.js";
import {
  pngDimensions,
  relativeScreenPath,
  screensEnabledFrom,
  SCREENSHOT_RENDER_UNAVAILABLE,
  SCREENSHOT_SKIPPED
} from "../design/screens.js";
import { type PenExecFn } from "./cli.js";
import { type PenEnsureFn } from "./install.js";
import { type PenScreenRenderInput, type PenScreenRenderResult } from "./render.js";
import { capturePenScreens } from "./screens.js";
import { loadPenDocument, penRelativePath, PEN_HINT, resolvePenTarget } from "./paths.js";
import { collectPenNodes, type PenDocument, type PenNode } from "./read.js";

export interface PenFlowScreen {
  id: string;
  name: string;
  suggestedRoute: string;
  childNames: string[];
  textHints: FlowHint[];
  sourceBoard: string;
  sourceFrameName: string;
  /** True when the name came from the (generic) layer name, not a screen label. */
  inferredName: boolean;
  /** State variants merged into this screen (label + frame id/name). */
  states: Array<{
    id: string;
    label: string;
    frameName: string;
    /** Vision element inventory for this variant (Task 5 接线). */
    elements?: FlowElement[];
    /** Variant-only edges (audit only; never merged into `result.edges`). */
    edges?: FlowEdge[];
    elementsCoverage?: FlowElementCoverage[];
  }>;
  /** Acceptance criteria from `Flow/AC*` groups or `AC:`-prefixed annotation texts. */
  acceptance?: string[];
  /** Vision element inventory (present only when the vision pass ran). */
  elements?: FlowElement[];
  /** Per-target candidate coverage (present only when the vision pass ran). */
  elementsCoverage?: FlowElementCoverage[];
  /** Evidence source (synthesis is always heuristic: inferred/low). */
  provenance: Provenance;
  confidence: Confidence;
}

export type PenFlowWarning = FlowWarning;

export interface PenFlowSynthesis {
  boards: string[];
  candidateFrames: number;
  genericNamed: number;
  labelFromFlowNote: number;
  labelFromText: number;
  labelFromLayerName: number;
  statesMerged: number;
  mainScreens: number;
  inferredEdges: number;
  /** Interaction-like signals found in the document (unparsed; synthesis is explicitly annotated). */
  interactionSignals: number;
}

export interface PenFlowResult {
  screens: PenFlowScreen[];
  edges: FlowEdge[];
  entryScreens: string[];
  warnings: PenFlowWarning[];
  synthesis: PenFlowSynthesis;
}

const SKIP_TEXT_PATTERNS = [
  /^\d{1,2}:\d{2}$/,
  /^(Frame|Group|Rectangle|Vector|Ellipse|Line|Path)\s*\d*$/i
];

function textOf(node: PenNode): string | null {
  if (node.type !== "text" || typeof node.content !== "string") return null;
  const text = node.content.trim();
  if (!text || SKIP_TEXT_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return text;
}

function firstTextIn(node: PenNode): string | null {
  let found: string | null = null;
  const visit = (current: PenNode): void => {
    if (found) return;
    found = textOf(current);
    if (found) return;
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return found;
}

function firstFlowAnnotation(node: PenNode): string | null {
  let found: string | null = null;
  const visit = (current: PenNode): void => {
    if (found) return;
    if (typeof current.name === "string" && current.name.startsWith("Flow/")) {
      found = firstTextIn(current);
      if (found) return;
    }
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return found;
}

function numberProp(node: PenNode, key: string): number | null {
  const value = node[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const INTERACTION_SIGNAL_KEYS = [
  "interactions",
  "interaction",
  "prototype",
  "reactions",
  "onTap",
  "onClick",
  "onPress",
  "hotspot"
] as const;
const INTERACTION_METADATA_RE = /interact|prototype|tap|click|link|navigat/i;

function isSignalValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/** Deterministic scan for interaction-like data in a .pen document.
 * .pen v2.20 has no prototype field: the schema-level link is a text `href`;
 * node keys and metadata types are checked so a future format carrying
 * interactions is never silently synthesized over. */
function detectPenInteractionSignals(doc: PenDocument): {
  count: number;
  details: string[];
} {
  let count = 0;
  const details: string[] = [];
  const visit = (node: PenNode): void => {
    const label = `${node.id ?? "?"}${typeof node.name === "string" && node.name ? ` ${node.name}` : ""}`;
    if (isSignalValue(node.href)) {
      count += 1;
      details.push(`href @ ${label}`);
    }
    for (const key of INTERACTION_SIGNAL_KEYS) {
      if (isSignalValue(node[key])) {
        count += 1;
        details.push(`${key} @ ${label}`);
      }
    }
    const metadata = node.metadata;
    if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      const type = (metadata as Record<string, unknown>).type;
      if (typeof type === "string" && INTERACTION_METADATA_RE.test(type)) {
        count += 1;
        details.push(`metadata:${type} @ ${label}`);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of doc.children ?? []) visit(child);
  return { count, details };
}

function isGenericLayerName(name: string): boolean {
  return /^(Frame|Group|Rectangle|Vector|Ellipse|Line|Path)\s*\d*$/i.test(name.trim());
}

function isScreenCandidate(node: PenNode): boolean {
  if (node.type !== "frame") return false;
  const name = typeof node.name === "string" ? node.name : "";
  if (name.startsWith("Flow/")) return false;
  const width = numberProp(node, "width");
  const height = numberProp(node, "height");
  if (width !== null && width < 200) return false;
  if (height !== null && height < 200) return false;
  return true;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function baseOf(label: string): string {
  const cut = label.search(/[-–—－(（]/);
  return (cut > 0 ? label.slice(0, cut) : label).trim();
}

interface Candidate {
  frame: PenNode;
  id: string;
  frameName: string;
  label: string;
  labelSource: "flow-note" | "text" | "layer-name";
  generic: boolean;
  boardIndex: number;
  orderIndex: number;
}

function boardOrdinal(name: string): number | null {
  const match = /^\s*(\d+)/.exec(name);
  return match ? Number(match[1]) : null;
}

function orderBoardChildren(children: PenNode[]): PenNode[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const child of children) {
    const x = numberProp(child, "x");
    const y = numberProp(child, "y");
    if (x !== null) xs.push(x);
    if (y !== null) ys.push(y);
  }
  const spread = (values: number[]): number =>
    values.length < 2 ? 0 : Math.max(...values) - Math.min(...values);
  const horizontal = spread(xs) >= spread(ys);
  return [...children].sort((left, right) => {
    const lx = numberProp(left, "x") ?? 0;
    const ly = numberProp(left, "y") ?? 0;
    const rx = numberProp(right, "x") ?? 0;
    const ry = numberProp(right, "y") ?? 0;
    return horizontal ? lx - rx || ly - ry : ly - ry || lx - rx;
  });
}

/** 从 .pen 文档合成流程图（离线）：屏幕标签命名 + 状态归并 + 画板排布推断边。 */
export function synthesizePenFlows(
  doc: PenDocument,
  options: { maxScreens?: number } = {}
): PenFlowResult {
  const maxScreens = options.maxScreens ?? 200;
  const interactionSignals = detectPenInteractionSignals(doc);
  const topFrames = (doc.children ?? []).filter(
    (child): child is PenNode => Boolean(child) && typeof child === "object" && child.type === "frame"
  );
  const boards = [...topFrames].sort((left, right) => {
    const leftOrdinal = boardOrdinal(String(left.name ?? ""));
    const rightOrdinal = boardOrdinal(String(right.name ?? ""));
    if (leftOrdinal !== null && rightOrdinal !== null && leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }
    const ly = numberProp(left, "y") ?? 0;
    const ry = numberProp(right, "y") ?? 0;
    const lx = numberProp(left, "x") ?? 0;
    const rx = numberProp(right, "x") ?? 0;
    return ly - ry || lx - rx;
  });

  const candidates: Candidate[] = [];
  let genericNamed = 0;
  let labelFromFlowNote = 0;
  let labelFromText = 0;
  let labelFromLayerName = 0;
  boards.forEach((board, boardIndex) => {
    const screens = (board.children ?? []).filter(isScreenCandidate);
    orderBoardChildren(screens).forEach((frame, orderIndex) => {
      const frameName = typeof frame.name === "string" ? frame.name : "";
      const generic = isGenericLayerName(frameName);
      if (generic) genericNamed += 1;
      const flowNote = firstFlowAnnotation(frame);
      const rawText = firstTextIn(frame);
      let label: string;
      let labelSource: Candidate["labelSource"];
      if (flowNote) {
        label = flowNote;
        labelSource = "flow-note";
        labelFromFlowNote += 1;
      } else if (rawText) {
        label = rawText;
        labelSource = "text";
        labelFromText += 1;
      } else {
        label = frameName;
        labelSource = "layer-name";
        labelFromLayerName += 1;
      }
      candidates.push({
        frame,
        id: typeof frame.id === "string" && frame.id.length > 0 ? frame.id : `pen-${boardIndex}-${orderIndex}`,
        frameName,
        label: normalizeLabel(label),
        labelSource,
        generic,
        boardIndex,
        orderIndex
      });
    });
  });

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const base = baseOf(candidate.label) || candidate.label;
    const list = groups.get(base) ?? [];
    list.push(candidate);
    groups.set(base, list);
  }

  interface BuiltScreen {
    screen: PenFlowScreen;
    boardIndex: number;
    orderIndex: number;
  }
  const built: BuiltScreen[] = [];
  let statesMerged = 0;
  const mergeNotes: string[] = [];
  for (const [base, members] of groups) {
    const exact = members.filter((member) => member.label === base);
    const pool = exact.length > 0 ? exact : members;
    const sorted = [...pool].sort(
      (left, right) =>
        left.label.length - right.label.length ||
        left.boardIndex - right.boardIndex ||
        left.orderIndex - right.orderIndex
    );
    const main = sorted[0]!;
    const states = members
      .filter((member) => member !== main)
      .map((member) => ({ id: member.id, label: member.label, frameName: member.frameName }));
    if (states.length > 0) {
      statesMerged += states.length;
      mergeNotes.push(`${base} ← ${states.map((state) => state.label).join("、")}`);
    }
    const texts = collectTextHints(main.frame, 4);
    const acceptance = collectAcceptance(main.frame);
    const screenBounds = penBounds(main.frame);
    const screen: PenFlowScreen = {
      id: main.id,
      name: base,
      suggestedRoute: routeFor(base),
      childNames: (main.frame.children ?? []).slice(0, 10).map((child) => String(child.name ?? "")),
      textHints: texts,
      ...(screenBounds ? { bounds: screenBounds } : {}),
      ...(acceptance.length > 0 ? { acceptance } : {}),
      sourceBoard: String(boards[main.boardIndex]?.name ?? ""),
      sourceFrameName: main.frameName,
      inferredName: main.labelSource === "layer-name",
      states,
      provenance: "inferred",
      confidence: confidenceFor("inferred")
    };
    built.push({ screen, boardIndex: main.boardIndex, orderIndex: main.orderIndex });
  }

  built.sort(
    (left, right) =>
      left.boardIndex - right.boardIndex || left.orderIndex - right.orderIndex
  );
  const truncated = built.length > maxScreens;
  const kept = truncated ? built.slice(0, maxScreens) : built;
  const screens = kept.map((entry) => entry.screen);

  const edges: FlowEdge[] = [];
  let inferredEdges = 0;
  const chain = (from: PenFlowScreen, to: PenFlowScreen): void => {
    inferredEdges += 1;
    edges.push({
      from: { id: from.id, name: from.name },
      to: { id: to.id, name: to.name },
      element: { id: `inferred-${inferredEdges}`, name: "推断跳转（按画板排布）", type: "INFERRED" },
      textHints: [],
      trigger: "INFERRED",
      actionType: "INFERRED",
      provenance: "inferred",
      confidence: confidenceFor("inferred")
    });
  };
  for (let index = 0; index + 1 < kept.length; index += 1) {
    const current = kept[index]!;
    const next = kept[index + 1]!;
    chain(current.screen, next.screen);
  }

  const graph: FlowGraph = {
    screens: screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      suggestedRoute: screen.suggestedRoute,
      childNames: screen.childNames,
      textHints: screen.textHints
    })),
    edges,
    entryScreens: screens.length > 0 ? [screens[0]!.name] : [],
    unresolvedDestinations: []
  };

  const warnings: PenFlowWarning[] =
    interactionSignals.count > 0
      ? [
          {
            code: "pen-interactions-present",
            message: `检测到 ${interactionSignals.count} 处交互线索但当前未解析：合成仍按画板排布推断（非静默），交互解析待支持`,
            details: interactionSignals.details.slice(0, 10)
          }
        ]
      : [
          {
            code: "pen-no-interactions",
            message:
              "设计文件未包含原型/交互数据（.pen v2.20 无原型交互字段）：跳转由画板排布推断（trigger=INFERRED），需人工复核"
          }
        ];
  if (genericNamed > 0) {
    warnings.push({
      code: "pen-generic-names",
      message: `${genericNamed} 个屏使用默认图层名（Frame NNNN），已优先用屏内标签/Flow 标注命名`,
      details: candidates
        .filter((candidate) => candidate.generic)
        .slice(0, 10)
        .map((candidate) => `${candidate.id} ${candidate.frameName} → ${candidate.label}`)
    });
  }
  if (statesMerged > 0) {
    warnings.push({
      code: "pen-state-merges",
      message: `状态归并：${statesMerged} 个变体合并进 ${mergeNotes.length} 个主屏（启发式，需复核）`,
      details: mergeNotes.slice(0, 10)
    });
  }
  if (labelFromLayerName > 0) {
    warnings.push({
      code: "pen-missing-labels",
      message: `${labelFromLayerName} 个屏无可用标签，使用图层名（名称不可信）`
    });
  }
  if (truncated) {
    warnings.push({
      code: "pen-screen-cap",
      message: `屏幕数超过 maxScreens=${maxScreens}，已截断（共 ${built.length}）`
    });
  }
  warnings.push(
    ...(flowGraphWarnings(graph).map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.details ? { details: warning.details } : {})
    })) as PenFlowWarning[])
  );

  return {
    screens,
    edges,
    entryScreens: graph.entryScreens,
    warnings,
    synthesis: {
      boards: boards.map((board) => String(board.name ?? "")),
      candidateFrames: candidates.length,
      genericNamed,
      labelFromFlowNote,
      labelFromText,
      labelFromLayerName,
      statesMerged,
      mainScreens: screens.length,
      inferredEdges,
      interactionSignals: interactionSignals.count
    }
  };
}

function collectAcceptance(node: PenNode): string[] {
  const items: string[] = [];
  const visit = (current: PenNode, underAcceptance: boolean, underFlow: boolean): void => {
    if (items.length >= 5) return;
    const acceptanceLayer = underAcceptance || isAcceptanceLayerName(current.name);
    const flow = underFlow || (typeof current.name === "string" && current.name.startsWith("Flow/"));
    const text = textOf(current);
    if (text) {
      const item = acceptanceLayer ? text : flow ? acceptanceItemOf(text) : null;
      if (item && !items.includes(item)) items.push(item);
    }
    for (const child of current.children ?? []) visit(child, acceptanceLayer, flow);
  };
  visit(node, isAcceptanceLayerName(node.name), false);
  return items;
}

function penBounds(node: PenNode): { x: number; y: number; width: number; height: number } | null {
  const x = numberProp(node, "x");
  const y = numberProp(node, "y");
  const width = numberProp(node, "width");
  const height = numberProp(node, "height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function collectTextHints(node: PenNode, perClassLimit: number): FlowHint[] {
  const hints: FlowHint[] = [];
  const visit = (current: PenNode, underFlow: boolean): void => {
    const annotation = underFlow || isAnnotationLayerName(current.name);
    const text = textOf(current);
    if (text && !hints.some((hint) => hint.text === text)) {
      const textClass = annotation ? "annotation" : "runtime-text";
      if (hints.filter((hint) => hint.textClass === textClass).length < perClassLimit) {
        const bounds = penBounds(current);
        hints.push({
          text,
          textClass,
          ...(typeof current.id === "string" && current.id !== "" ? { nodeId: current.id } : {}),
          ...(bounds ? { bounds } : {})
        });
      }
    }
    for (const child of current.children ?? []) visit(child, annotation);
  };
  visit(node, isAnnotationLayerName(node.name));
  return hints;
}

export function renderPenFlowMap(input: {
  file: string;
  generatedAt: string;
  result: PenFlowResult;
  /** screen id → md 相对引用（`screens/...`，与 md 同级）；可选。 */
  images?: Map<string, string>;
}): string {
  const { result } = input;
  const signals = result.synthesis.interactionSignals;
  const note =
    signals > 0
      ? `> 说明：检测到 ${signals} 处交互线索但尚未解析；跳转仍由画板排布推断，需人工复核。`
      : "> 说明：设计文件无原型交互数据；跳转由画板排布推断，状态由标签归并，均需人工复核。";
  const lines: string[] = [
    "# Pen 交互地图（合成 · inferred）",
    "",
    `> 来源: ${input.file}`,
    `> 生成时间: ${input.generatedAt}`,
    note,
    ""
  ];
  lines.push("## 画板（主流程顺序）", "");
  const byBoard = new Map<string, PenFlowScreen[]>();
  for (const screen of result.screens) {
    const list = byBoard.get(screen.sourceBoard) ?? [];
    list.push(screen);
    byBoard.set(screen.sourceBoard, list);
  }
  let boardIndex = 0;
  for (const board of result.synthesis.boards) {
    boardIndex += 1;
    const screens = byBoard.get(board) ?? [];
    const heading = /^\s*\d+[.、]/.test(board) ? board : `${boardIndex}. ${board}`;
    lines.push(`### ${heading}`, "");
    for (const screen of screens) {
      const stateLabels = [...new Set(screen.states.map((state) => state.label))];
      const states = stateLabels.length > 0 ? `（状态：${stateLabels.join("、")}）` : "";
      lines.push(`- ${screen.name}${states}`);
      const image = input.images?.get(screen.id);
      if (image) {
        lines.push(`  - <img src="${image}" alt="${escapeHtml(screen.name)}" height="200">`);
      }
    }
    lines.push("");
  }
  lines.push("## 推断主链", "");
  lines.push(
    result.screens.length > 0
      ? result.screens.map((screen) => screen.name).join(" → ")
      : "（无屏幕）",
    ""
  );
  const withElements = result.screens.filter((screen) => (screen.elements?.length ?? 0) > 0);
  if (withElements.length > 0) {
    lines.push("## 视觉识别（vision-inferred）", "");
    for (const screen of withElements) {
      lines.push(`- ${screen.name}`);
      for (const element of screen.elements ?? []) {
        const grounded = element.nodeId ? ` → ${element.nodeId}` : "";
        lines.push(`  - [${element.class}/${element.intent}] ${element.label ?? "（无标签）"}${grounded}`);
      }
    }
    lines.push("");
  }
  lines.push("## 警告与碎片度", "");
  for (const warning of result.warnings) {
    lines.push(`- [${warning.code}] ${warning.message}`);
    for (const detail of warning.details ?? []) lines.push(`  - ${detail}`);
  }
  lines.push("", "## 统计", "");
  const synthesis = result.synthesis;
  lines.push(
    `- 画板 ${synthesis.boards.length} · 候选屏 ${synthesis.candidateFrames} · 主屏 ${synthesis.mainScreens} · 状态归并 ${synthesis.statesMerged}`,
    `- 命名来源：Flow 标注 ${synthesis.labelFromFlowNote} / 屏内文本 ${synthesis.labelFromText} / 图层名 ${synthesis.labelFromLayerName}（默认名 ${synthesis.genericNamed}）`,
    `- 推断跳转 ${synthesis.inferredEdges}（全部 inferred）`
  );
  return lines.join("\n") + "\n";
}

export interface PenExtractFlowsArgs {
  path?: string;
  save?: boolean;
  maxScreens?: number;
  /** Vision element recognition: "auto" (default; runs when the active LLM is
   * vision-capable), true (attempt even when the heuristic says no) or false. */
  vision?: boolean | "auto";
  /** 渲染屏幕截图并嵌入 flow-map.md（默认 true；`AOS_SCREENS=0` 全局关闭）。 */
  screens?: boolean;
}

export interface PenFlowsDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
  chat?: ChatFn;
  render?: (input: PenScreenRenderInput) => Promise<PenScreenRenderResult>;
}

interface VisionMerge {
  requested: "auto" | "on" | "off";
  active: boolean;
  model?: string;
  reason?: string;
  warnings: FlowWarning[];
  edges: FlowEdge[];
  unresolvedDestinations: string[];
  elementsByScreen: Map<string, FlowElement[]>;
  stats?: {
    screensRequested: number;
    screensSkipped: number;
    screensProcessed: number;
    elements: number;
    navigationalEdges: number;
    invalidItems: number;
    failures: number;
  };
}

function skippedVision(
  requested: VisionMerge["requested"],
  reason: string,
  warnings: FlowWarning[] = []
): VisionMerge {
  return {
    requested,
    active: false,
    reason,
    warnings,
    edges: [],
    unresolvedDestinations: [],
    elementsByScreen: new Map()
  };
}

function visionEnvFlag(dotenv: Record<string, string>): string {
  return (dotenv.AOS_VISION ?? process.env.AOS_VISION ?? "").trim();
}

/** 默认视觉 target 上限：覆盖常见设计文件全量主屏+变体，同时给多模态调用成本留闸。 */
const DEFAULT_VISION_MAX_TARGETS = 50;

function parseVisionTargetCap(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "all" || normalized === "unlimited") {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VISION_MAX_TARGETS;
}

/** `AOS_VISION_MAX_TARGETS` 为首选名（含变体），`AOS_VISION_MAX_SCREENS` 兼容旧配置。 */
export function visionMaxScreens(dotenv: Record<string, string>): number {
  const preferred = (dotenv.AOS_VISION_MAX_TARGETS ?? process.env.AOS_VISION_MAX_TARGETS ?? "").trim();
  if (preferred !== "") return parseVisionTargetCap(preferred);
  const legacy = (dotenv.AOS_VISION_MAX_SCREENS ?? process.env.AOS_VISION_MAX_SCREENS ?? "").trim();
  if (legacy !== "") return parseVisionTargetCap(legacy);
  return DEFAULT_VISION_MAX_TARGETS;
}

const CANDIDATE_NODE_LIMIT = 200;
const GROUNDING_NODE_LIMIT = 300;
const CANDIDATE_TEXT_LIMIT = 3;

export interface CollectedVisionExclusion {
  screenId: string;
  screenName: string;
  state: string | null;
  reason: "frame-missing" | "no-geometry";
  candidates: VisionCandidate[];
  designNodes: number;
}

export interface CollectedVision {
  /** 主屏在前，变体在后。 */
  targets: VisionScreenInput[];
  excluded: CollectedVisionExclusion[];
  duplicateIds: string[];
  candidatesTruncated: number;
  groundingTruncated: number;
}

function isFlowLayer(node: PenNode): boolean {
  return typeof node.name === "string" && node.name.startsWith("Flow/");
}

function candidateTextHints(node: PenNode): string[] {
  const hints: string[] = [];
  const visit = (current: PenNode): void => {
    if (hints.length >= CANDIDATE_TEXT_LIMIT) return;
    if (isFlowLayer(current)) return;
    const text = textOf(current);
    if (text && !hints.includes(text)) hints.push(text);
    for (const child of current.children ?? []) {
      if (hints.length >= CANDIDATE_TEXT_LIMIT) return;
      visit(child);
    }
  };
  visit(node);
  return hints;
}

interface InspectedFrame {
  candidates: VisionCandidate[];
  candidateMatches: number;
  nodes: VisionNodeGeom[];
  designNodes: number;
  groundingTruncated: number;
}

/** 候选与 grounding 节点一次采集：候选（最外层）优先、叶子优先、容器兜底。 */
function inspectFrameNode(frame: PenNode, state: string | null): InspectedFrame {
  const candidates: VisionCandidate[] = [];
  const geoms: Array<VisionNodeGeom & { container: boolean; candidate: boolean }> = [];
  let candidateMatches = 0;

  const visit = (node: PenNode, ox: number, oy: number): void => {
    if (isFlowLayer(node)) return;
    const x = numberProp(node, "x");
    const y = numberProp(node, "y");
    const ax = ox + (x ?? 0);
    const ay = oy + (y ?? 0);
    const name = typeof node.name === "string" ? node.name : "";
    const id = typeof node.id === "string" && node.id !== "" ? node.id : null;
    const width = numberProp(node, "width");
    const height = numberProp(node, "height");
    const matches = id !== null && name !== "" && candidateNameMatches(name);

    if (matches) {
      candidateMatches += 1;
      if (candidates.length < CANDIDATE_NODE_LIMIT) {
        candidates.push({
          id,
          name,
          type: String(node.type ?? ""),
          ...(x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0
            ? { bbox: { x: ax, y: ay, width, height } }
            : {}),
          textHints: candidateTextHints(node),
          state
        });
      }
    }

    if (id !== null && width !== null && height !== null && width > 0 && height > 0) {
      const container = (node.children ?? []).some(
        (child) => numberProp(child, "width") !== null && numberProp(child, "height") !== null
      );
      geoms.push({
        id,
        name,
        type: String(node.type ?? ""),
        x: ax,
        y: ay,
        width,
        height,
        container,
        candidate: matches
      });
    }

    if (matches) return;
    for (const child of node.children ?? []) visit(child, ax, ay);
  };
  for (const child of frame.children ?? []) visit(child, 0, 0);

  const rank = (entry: { container: boolean; candidate: boolean }): number =>
    (entry.candidate ? 0 : 2) + (entry.container ? 1 : 0);
  const ordered = [...geoms].sort((left, right) => rank(left) - rank(right));
  const nodes = ordered.slice(0, GROUNDING_NODE_LIMIT).map((entry) => ({
    id: entry.id,
    name: entry.name,
    type: entry.type,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height
  }));
  return {
    candidates,
    candidateMatches,
    nodes,
    designNodes: geoms.length,
    groundingTruncated: Math.max(0, geoms.length - GROUNDING_NODE_LIMIT)
  };
}

interface VisionTargetSpec {
  id: string;
  name: string;
  screenName: string;
  stateOf: string | null;
  stateName: string | null;
}

/** Screen inputs for the vision pass: main screens first, then merged state
 * variants; candidate geometry (child x/y accumulated from the frame root)
 * only exists when all of x/y/w/h are numeric.
 *
 * Auto-layout frames often carry `fill_container` / `fit_content` widths and
 * no height at all (the layout engine resolves them). Those screens still
 * render, so the rendered PNG's IHDR size is the authoritative fallback —
 * rendering is scale 1 in the design coordinate system. */
export function collectVisionScreens(
  doc: PenDocument,
  screens: PenFlowScreen[],
  sizeFor?: (screenId: string) => { width: number; height: number } | null
): CollectedVision {
  const byId = new Map<string, PenNode>();
  const duplicateIds: string[] = [];
  const seenIds = new Set<string>();
  for (const node of collectPenNodes(doc)) {
    if (typeof node.id !== "string" || node.id === "") continue;
    if (seenIds.has(node.id)) {
      if (!duplicateIds.includes(node.id)) duplicateIds.push(node.id);
    } else {
      seenIds.add(node.id);
    }
    byId.set(node.id, node);
  }

  const specs: VisionTargetSpec[] = [];
  for (const screen of screens) {
    specs.push({
      id: screen.id,
      name: screen.name,
      screenName: screen.name,
      stateOf: null,
      stateName: null
    });
  }
  for (const screen of screens) {
    for (const state of screen.states) {
      specs.push({
        id: state.id,
        name: state.label,
        screenName: screen.name,
        stateOf: screen.id,
        stateName: state.label
      });
    }
  }

  const targets: VisionScreenInput[] = [];
  const excluded: CollectedVisionExclusion[] = [];
  let candidatesTruncated = 0;
  let groundingTruncated = 0;
  for (const spec of specs) {
    const frame = byId.get(spec.id);
    if (!frame) {
      excluded.push({
        screenId: spec.id,
        screenName: spec.screenName,
        state: spec.stateName,
        reason: "frame-missing",
        candidates: [],
        designNodes: 0
      });
      continue;
    }
    const inspected = inspectFrameNode(frame, spec.stateName);
    candidatesTruncated += inspected.candidateMatches - inspected.candidates.length;
    groundingTruncated += inspected.groundingTruncated;
    const fallback = sizeFor ? sizeFor(spec.id) : null;
    const width = numberProp(frame, "width") ?? fallback?.width ?? null;
    const height = numberProp(frame, "height") ?? fallback?.height ?? null;
    if (width === null || height === null || width <= 0 || height <= 0) {
      excluded.push({
        screenId: spec.id,
        screenName: spec.screenName,
        state: spec.stateName,
        reason: "no-geometry",
        candidates: inspected.candidates,
        designNodes: inspected.designNodes
      });
      continue;
    }
    targets.push({
      id: spec.id,
      name: spec.name,
      width,
      height,
      nodes: inspected.nodes,
      ...(spec.stateOf !== null && spec.stateName !== null
        ? { stateOf: spec.stateOf, stateName: spec.stateName }
        : {}),
      candidates: inspected.candidates
    });
  }
  return { targets, excluded, duplicateIds, candidatesTruncated, groundingTruncated };
}

interface PenScreenAssets {
  channelError: string | null;
  /** screenId → 已入库的最终 PNG 绝对路径（仅成功入库的屏）。 */
  imagePaths: Map<string, string>;
  skipped: string[];
  warnings: FlowWarning[];
  summary: {
    dir: string;
    /** 主屏数量（与 `states` 相加 = rendered + skipped）。 */
    screens: number;
    /** 变体数量。 */
    states: number;
    rendered: number;
    skipped: number;
    skippedScreens: string[];
  };
}

function requestedScreenIds(screens: PenFlowScreen[]): {
  ids: string[];
  screens: number;
  states: number;
} {
  const unique = (values: string[]): string[] => {
    const out: string[] = [];
    for (const value of values) {
      if (value.trim() === "" || out.includes(value)) continue;
      out.push(value);
    }
    return out;
  };
  const mainIds = unique(screens.map((screen) => screen.id));
  const stateIds = unique(
    screens.flatMap((screen) => screen.states.map((state) => state.id))
  ).filter((id) => !mainIds.includes(id));
  return { ids: [...mainIds, ...stateIds], screens: mainIds.length, states: stateIds.length };
}

/** 一次渲染两用（design-screenshots T2）：截图与 vision 共享同一批渲染；
 * 渲染到私有临时目录 → 逐张校验后原子入库 `screens/pen-<slug>/` → 清理临时目录。 */
function screenAssetLoader(
  runtime: Runtime,
  target: string,
  screens: PenFlowScreen[],
  deps: PenFlowsDeps,
  dotenv: Record<string, string>
): () => Promise<PenScreenAssets> {
  let pending: Promise<PenScreenAssets> | null = null;
  return () => {
    pending ??= renderAndImportPenScreens(runtime, target, screens, deps, dotenv);
    return pending;
  };
}

async function renderAndImportPenScreens(
  runtime: Runtime,
  target: string,
  screens: PenFlowScreen[],
  deps: PenFlowsDeps,
  dotenv: Record<string, string>
): Promise<PenScreenAssets> {
  const requested = requestedScreenIds(screens);
  const capture = await capturePenScreens({
    configDirAbs: runtime.configDirAbs,
    target,
    screenIds: requested.ids,
    dotenv,
    deps: { render: deps.render, exec: deps.exec, ensure: deps.ensure }
  });
  const warnings: FlowWarning[] = [];
  if (capture.channelError !== null) {
    warnings.push({
      code: SCREENSHOT_RENDER_UNAVAILABLE,
      message: `截图已跳过：pen 渲染不可用（${capture.channelError}）`
    });
  } else if (capture.imagePaths.size === 0 && capture.skipped.length > 0) {
    warnings.push({
      code: SCREENSHOT_RENDER_UNAVAILABLE,
      message: "截图已跳过：pen 渲染不可用（CLI 未产出渲染图）"
    });
  } else if (capture.skipped.length > 0) {
    warnings.push({
      code: SCREENSHOT_SKIPPED,
      message: `截图降级：${capture.skipped.length} 屏未产出渲染（${capture.skipped.slice(0, 5).join("、")}${
        capture.skipped.length > 5 ? " 等" : ""
      }）`
    });
  }
  return {
    channelError: capture.channelError,
    imagePaths: capture.imagePaths,
    skipped: capture.skipped,
    warnings,
    summary: {
      dir: relativeScreenPath(path.join(runtime.configDirAbs, "design"), capture.dir),
      screens: requested.screens,
      states: requested.states,
      rendered: capture.imagePaths.size,
      skipped: capture.skipped.length,
      skippedScreens: capture.skipped
    }
  };
}

/** 渲染尺寸兜底（scale 1，与设计坐标同系）：auto-layout 屏的 `fill_container`
 * 宽/缺省高由布局引擎解析，PNG IHDR 是唯一权威尺寸；读取失败按无兜底处理。 */
function renderedSizeResolver(
  assets: PenScreenAssets
): (screenId: string) => { width: number; height: number } | null {
  const cache = new Map<string, { width: number; height: number } | null>();
  return (screenId) => {
    if (cache.has(screenId)) return cache.get(screenId) ?? null;
    const file = assets.imagePaths.get(screenId);
    let size: { width: number; height: number } | null = null;
    if (file) {
      try {
        size = pngDimensions(fs.readFileSync(file));
      } catch {
        size = null;
      }
    }
    cache.set(screenId, size);
    return size;
  };
}

async function applyVision(
  runtime: Runtime,
  args: PenExtractFlowsArgs,
  doc: PenDocument,
  result: PenFlowResult,
  deps: PenFlowsDeps,
  loadAssets: () => Promise<PenScreenAssets>
): Promise<VisionMerge | null> {
  const requested: VisionMerge["requested"] =
    args.vision === true ? "on" : args.vision === false ? "off" : "auto";
  if (requested === "off") return null;

  const dotenv = runtime.project.dotenvValues ?? {};
  if (visionEnvFlag(dotenv) === "0") {
    return skippedVision(requested, "AOS_VISION=0", [
      { code: "vision-disabled-by-env", message: "视觉识别已跳过：AOS_VISION=0（环境禁用）" }
    ]);
  }

  let chat: ChatFn | null = deps.chat ?? null;
  let model: string | undefined;
  let preWarnings: FlowWarning[] = [];
  let capabilitySource: VisionCapabilitySource | "override" = "unknown";
  let capabilityKey = "";
  let capabilityCache: VisionCapabilityCache | null = null;
  if (!chat) {
    const entry = await runtime.activeEntry();
    model = entry?.model ?? undefined;
    if (!entry || !entry.model || !entry.baseUrl || !entry.apiKey) {
      return skippedVision(requested, "无可用 active LLM", [
        {
          code: "vision-unavailable",
          message: "视觉识别已跳过：无可用 active LLM（缺 model/baseUrl/key，用 aos_configure 配置）"
        }
      ]);
    }
    const env = { ...process.env, ...dotenv };
    capabilityKey = visionCapabilityKey(entry.baseUrl, entry.model);
    capabilityCache = openVisionCapabilityCache(path.join(runtime.configDirAbs, "llm-capabilities.json"));
    if (requested === "on") {
      capabilitySource = "override";
      preWarnings = [
        {
          code: "vision-model-unverified",
          message: `模型「${entry.model}」按 vision:true 显式强制尝试（不查声明与缓存）`
        }
      ];
    } else {
      const resolution = resolveVisionCapability({
        model: entry.model,
        baseUrl: entry.baseUrl,
        declared: parseDeclaredVision(env),
        cached: capabilityCache.get(capabilityKey),
        ttlMs: visionCacheTtlMsFromEnv(env)
      });
      capabilitySource = resolution.source;
      if (resolution.capable === false) {
        const message =
          resolution.source === "declared"
            ? `视觉识别已跳过：AOS_LLM_VISION 声明 active 模型「${entry.model}」无视觉能力（可 vision:true 强制尝试或切换视觉模型）`
            : `视觉识别已跳过：已记录 active 模型「${entry.model}」不接受图片输入（缓存期内不再尝试；可 vision:true 覆盖或切换视觉模型）`;
        return skippedVision(requested, `模型「${entry.model}」无视觉能力（${resolution.source}）`, [
          { code: "vision-unavailable", message }
        ]);
      }
      if (resolution.capable === "unknown") {
        preWarnings = [
          {
            code: "vision-model-unverified",
            message: `模型「${entry.model}」未判定为视觉能力，按尝试处理（若拒绝图片将自动记录并跳过）`
          }
        ];
      }
    }
    chat = makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model });
  }

  let assets: PenScreenAssets;
  try {
    assets = await loadAssets();
  } catch (error) {
    return skippedVision(requested, "渲染通道失败", [
      { code: "vision-render-unavailable", message: `视觉识别已跳过：设计渲染失败（${errorMessage(error)}）` }
    ]);
  }
  if (assets.channelError !== null) {
    return skippedVision(requested, "渲染通道失败", [
      {
        code: "vision-render-unavailable",
        message: `视觉识别已跳过：设计渲染失败（${assets.channelError}）`
      }
    ]);
  }

  const collected = collectVisionScreens(doc, result.screens, renderedSizeResolver(assets));
  const screens = collected.targets;
  const labelOf = (entry: CollectedVisionExclusion): string =>
    entry.state === null ? entry.screenName : `${entry.screenName}·${entry.state}`;
  const dropped = collected.excluded.filter((entry) => entry.reason === "no-geometry");
  if (dropped.length > 0) {
    preWarnings = [
      ...preWarnings,
      {
        code: "vision-screen-no-geometry",
        message: `${dropped.length} 屏缺尺寸且无渲染图，已跳过视觉识别（${dropped
          .slice(0, 5)
          .map(labelOf)
          .join("、")}${dropped.length > 5 ? " 等" : ""}）`
      }
    ];
  }
  const missingFrames = collected.excluded.filter((entry) => entry.reason === "frame-missing");
  if (missingFrames.length > 0) {
    preWarnings = [
      ...preWarnings,
      {
        code: "vision-screen-frame-missing",
        message: `${missingFrames.length} 屏在文档中找不到对应帧（id 缺失或悬空），已跳过视觉识别（${missingFrames
          .slice(0, 5)
          .map(labelOf)
          .join("、")}${missingFrames.length > 5 ? " 等" : ""}）`
      }
    ];
  }
  if (collected.duplicateIds.length > 0) {
    preWarnings = [
      ...preWarnings,
      {
        code: "vision-duplicate-screen-ids",
        message: `设计文档存在 ${collected.duplicateIds.length} 个重复节点 id，视觉识别按文档中最后出现的帧解析，需修正设计文件`,
        details: collected.duplicateIds.slice(0, 10)
      }
    ];
  }
  if (collected.candidatesTruncated > 0) {
    preWarnings = [
      ...preWarnings,
      {
        code: "vision-candidate-cap",
        message: `候选交互元素超过每屏上限 ${CANDIDATE_NODE_LIMIT}，${collected.candidatesTruncated} 个已截断（覆盖判定按已采集候选）`
      }
    ];
  }
  if (screens.length === 0) {
    return skippedVision(requested, "无可用屏幕几何", preWarnings);
  }

  const imageCache = new Map<string, string | null>();
  const imageFor = (screenId: string): string | null => {
    if (imageCache.has(screenId)) return imageCache.get(screenId) ?? null;
    const file = assets.imagePaths.get(screenId);
    let data: string | null = null;
    if (file) {
      try {
        data = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
      } catch {
        data = null;
      }
    }
    imageCache.set(screenId, data);
    return data;
  };
  const renderPathOf = (screenId: string): string | null => {
    const file = assets.imagePaths.get(screenId);
    return file ? penRelativePath(runtime, file) : null;
  };

  const pass = await runVisionPass({
    chat,
    screens,
    imageFor,
    renderPath: renderPathOf,
    maxScreens: visionMaxScreens(dotenv)
  });
  if (pass.rejected && pass.stats.screensProcessed === 0) {
    capabilityCache?.set(capabilityKey, false);
    return {
      requested,
      active: false,
      ...(model ? { model } : {}),
      reason: `模型「${model}」不接受图片输入`,
      warnings: [
        ...preWarnings,
        ...pass.warnings,
        {
          code: "vision-unavailable",
          message: `视觉识别已中止：active 模型「${model}」不接受图片输入（已记录，缓存期内不再尝试；可 vision:true 覆盖或切换视觉模型）`
        }
      ],
      edges: [],
      unresolvedDestinations: [],
      elementsByScreen: new Map()
    };
  }
  if (pass.rejected) {
    preWarnings = [
      ...preWarnings,
      {
        code: "vision-unavailable",
        message: `视觉识别部分中止：active 模型「${model}」在后续屏幕拒绝图片输入（已完成屏幕结果保留）`
      }
    ];
  } else if (
    pass.stats.screensProcessed > 0 &&
    (capabilitySource === "unknown" || capabilitySource === "override")
  ) {
    capabilityCache?.set(capabilityKey, true);
  }
  return {
    requested,
    active: true,
    ...(model ? { model } : {}),
    warnings: [...preWarnings, ...pass.warnings],
    edges: pass.edges,
    unresolvedDestinations: pass.unresolvedDestinations,
    elementsByScreen: pass.elementsByScreen,
    stats: pass.stats
  };
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penExtractFlows(
  runtime: Runtime,
  args: PenExtractFlowsArgs,
  deps: PenFlowsDeps = {}
): Promise<CallToolResult> {
  try {
    const designDir = path.join(runtime.configDirAbs, "design");
    const target = resolvePenTarget(runtime, args.path);
    if (!target) {
      return jsonResult(
        { ok: false, error: "没有找到 .pen 文件（.artemis/design 下无 *.pen）", hint: PEN_HINT },
        true
      );
    }
    const doc = loadPenDocument(target);
    const result = synthesizePenFlows(doc, { maxScreens: args.maxScreens });
    const dotenv = runtime.project.dotenvValues ?? {};
    const wantScreens = screensEnabledFrom({ ...process.env, ...dotenv }, args.screens);
    const loadAssets = screenAssetLoader(runtime, target, result.screens, deps, dotenv);
    let screenAssets: PenScreenAssets | null = null;
    if (wantScreens) {
      try {
        screenAssets = await loadAssets();
        result.warnings.push(...screenAssets.warnings);
      } catch (error) {
        result.warnings.push({
          code: SCREENSHOT_RENDER_UNAVAILABLE,
          message: `截图已跳过：设计渲染失败（${errorMessage(error)}）`
        });
      }
    }
    const vision = await applyVision(runtime, args, doc, result, deps, loadAssets);
    if (vision) {
      for (const screen of result.screens) {
        const elements = vision.elementsByScreen.get(screen.id);
        if (elements && elements.length > 0) screen.elements = elements;
      }
      result.edges.push(...vision.edges);
      result.warnings.push(...vision.warnings);
    }
    const visionElements = vision?.active ? vision.stats?.elements ?? 0 : 0;
    const visionEdges = vision?.active ? vision.edges.length : 0;
    const payload: Record<string, unknown> = {
      ok: true,
      schemaVersion: FLOWS_SCHEMA_VERSION,
      source: `pen:${penRelativePath(runtime, target)}`,
      counts: {
        boards: result.synthesis.boards.length,
        screens: result.screens.length,
        states: result.synthesis.statesMerged,
        edges: result.edges.length,
        inferredEdges: result.synthesis.inferredEdges,
        interactionSignals: result.synthesis.interactionSignals,
        visionElements,
        visionEdges,
        warnings: result.warnings.length
      },
      synthesis: result.synthesis,
      vision: vision
        ? {
            requested: vision.requested,
            active: vision.active,
            ...(vision.model ? { model: vision.model } : {}),
            ...(vision.reason ? { reason: vision.reason } : {}),
            ...(vision.stats ? vision.stats : {})
          }
        : { requested: "off", active: false },
      warnings: result.warnings,
      ...(screenAssets ? { screenshots: screenAssets.summary } : {}),
      screens: result.screens.slice(0, 30),
      edges: result.edges.slice(0, 40),
      entryScreens: result.entryScreens,
      hint:
        "跳转默认全部为 inferred（画板排布推断）；flows.json（schemaVersion 3）可直接供 figma_generate_tests / suite check 使用；" +
        "复核 flow-map.md 后按需修正标签/顺序再生成用例。"
    };
    if (args.save !== false) {
      fs.mkdirSync(designDir, { recursive: true });
      const flowsPath = path.join(designDir, "flows.json");
      const mapPath = path.join(designDir, "flow-map.md");
      writeFileAtomic(
        flowsPath,
        JSON.stringify(
          {
            ...payload,
            screens: result.screens,
            edges: result.edges,
            entryScreens: result.entryScreens,
            unresolvedDestinations: vision?.unresolvedDestinations ?? []
          },
          null,
          2
        ) + "\n"
      );
      const imageRefs = new Map<string, string>();
      for (const [screenId, file] of screenAssets?.imagePaths ?? []) {
        imageRefs.set(screenId, relativeScreenPath(designDir, file));
      }
      writeFileAtomic(
        mapPath,
        renderPenFlowMap({
          file: penRelativePath(runtime, target),
          generatedAt: new Date().toISOString(),
          result,
          images: imageRefs
        })
      );
      payload.savedTo = { json: flowsPath, markdown: mapPath };
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `pen 流程合成失败: ${errorMessage(error)}`, hint: PEN_HINT },
      true
    );
  }
}
