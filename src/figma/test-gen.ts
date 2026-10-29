import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { computeClassifiedCoverage, type CoverageClass } from "./coverage.js";
import {
  buildFlowGraph,
  flowGraphWarnings,
  normalizeFlowGraph,
  normalizeFlowHints,
  type FlowEdge,
  type FlowGraph
} from "./flows.js";
import { loadApiErrorCatalog } from "../artemis/api-errors.js";
import {
  mergeWarnings,
  normalizeWarnings,
  readFlowsWarnings,
  summarizeWarnings,
  type DesignWarning
} from "../design/warnings.js";
import { deriveCasePreconditions } from "./preconditions.js";
import { REAL_DATA_CLAUSE } from "./data-policy.js";
import { applyReconciliationToGraph, loadReconciliation } from "./reconciliation.js";
import { loadScreenMap, normalizeElementLabel } from "../diff/screen-map.js";
import { canonicalizePlaceholders, normalizedText } from "./strings.js";
import {
  renderTestsWorkbook,
  updateWorkbookApiReview,
  upsertApiReviewMarkdown
} from "./test-xlsx.js";
import {
  expectedResultLines,
  openQuestionLines,
  summarizeCases,
  testDataLines
} from "./case-view.js";
import { readFlowDocumentMeta } from "./design-store.js";
import { designFlowsPath } from "./design-source.js";
import { caseSetStem, caseSetsDir, saveCaseSetFiles } from "./case-sets.js";
import {
  applyIdentity,
  assignCaseFeature,
  nameFeatures,
  splitFeatures,
  type FeatureGroup,
  type FeatureWarning,
  type PriorFeature
} from "./features.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import { testsFingerprint } from "./run-manifest.js";
import { captureFigmaScreens } from "./render.js";
import {
  existingScreenPath,
  figmaScreensDir,
  penScreensDir,
  relativeScreenPath,
  screensEnabledFrom,
  SCREENSHOT_MAPPING_MISSING,
  SCREENSHOT_RENDER_UNAVAILABLE,
  SCREENSHOT_SKIPPED,
  SCREENSHOT_DISABLED,
  SCREENSHOT_EMBED_MISMATCH,
  storeScreenPng
} from "../design/screens.js";
import { capturePenScreens } from "../pen/screens.js";
import type { PenExecFn } from "../pen/cli.js";
import type { PenEnsureFn } from "../pen/install.js";
import type { PenScreenRenderInput, PenScreenRenderResult } from "../pen/render.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { DesignRuntimeLike } from "./design-runtime.js";
import {
  collectCaseDefectFeedback,
  type CaseDefectFeedback
} from "./generation-feedback.js";
import {
  confidenceFor,
  isHardCoverageValue,
  isUnconfirmedProvenance,
  resolveProvenance,
  type Confidence,
  type Provenance,
  type StepKind
} from "../provenance.js";

export interface StepExpectation {
  /** Target screen (design name) the step should land on; null when the edge has no destination. */
  screen: string | null;
  /** Design text hints expected on the destination screen (best-effort deterministic match). */
  hints: string[];
  /** Evidence source of the driving edge (legacy-unknown for v1 artifacts). */
  provenance: Provenance;
  confidence: Confidence;
  /** `explore` for unconfirmed evidence: executable but never gating. */
  kind: StepKind;
  /** Where the assertion hints come from: reviewed acceptance criteria or the
   * destination screen's runtime text (absent for exploration steps). */
  hintsSource?: "acceptance" | "runtime-text";
}

export interface CasePreflight {
  /** Screen the case expects to start on (journey entry). */
  screen: string;
  /** Design text hints expected on the start screen; empty = not deterministically checkable. */
  hints: string[];
}

export interface GeneratedTest {
  id: string;
  name: string;
  screens: string[];
  /** 人类可读屏幕名；仅展示，不参与截图映射/caseId。 */
  displayScreens?: string[];
  /** 人类可读用例名；仅展示，不参与 caseId。 */
  displayName?: string;
  /** 执行器步骤（含设计元素/a11y/i18n 等 grounding 信息；caseId 哈希依据）。 */
  steps: string[];
  /** 人类层步骤（净化后）；仅用于 Excel/Markdown 展示。 */
  humanSteps?: string[];
  /** 人类标签回退统计；用于在文档中暴露“按钮 ×3”式降级。 */
  humanization?: {
    elements: number;
    fallbacks: number;
    fallbackLabels: string[];
    density: number;
  };
  /** Explicit data/launch assumptions the case relies on (deterministic). */
  preconditions: string[];
  /** Ready-to-run mobile_run_task description. */
  taskDesc: string;
  /** True when the journey continues from a maxDepth cut (prelude reaches the start). */
  continuation: boolean;
  /** Screen where this case's own (asserted) steps begin. */
  startScreen: string;
  /** Navigation-only steps from the entry to `startScreen`; empty unless continuation. */
  prelude: string[];
  /** 人类层前导导航；仅展示。 */
  humanPrelude?: string[];
  /** Per-step destination expectations, aligned with `steps` (deterministic audit). */
  expectations: StepExpectation[];
  /** Deterministic start-state check: the executor verifies the journey entry screen. */
  preflight: CasePreflight;
  /** 功能段 key（回归服务 §5.1；生成接线后填充）。 */
  feature?: string;
  /** 可读编号（TC_xxxxxx）；与机器身份 id 分离，展示/沟通用。 */
  displayId?: string;
  /** 跨端语义身份：只由 neutral 屏幕/人类步骤/预期派生，Android/iOS 同源应一致。 */
  semanticId?: string;
  /** 功能名；生成接线后填充，缺失展示为「未分组」。 */
  module?: string;
  /** 用例入口屏 / 人工覆盖的 Section。 */
  section?: string;
  /** 人工提供的测试数据（原样“键：值”文本）。 */
  testData?: string[];
  /** 关联用例（同产物内的 displayId）。 */
  relatedCases?: string[];
  /** 设计引用：屏幕名与节点 id。 */
  designRefs?: {
    screens: string[];
    nodeIds: string[];
    route?: string;
  };
  /** 待确认项（人工 acceptance questions）。 */
  openQuestions?: string[];
  /** 人类验收检查点；视觉来自设计文本提示，功能来自步骤目标屏，接口来自 API 说明（可空）。 */
  checkpoints?: {
    visual: string[];
    functional: string[];
    interface: string[];
  };
  /** 作用域命中本用例的设计警告（P2）。 */
  designWarnings?: DesignWarning[];
  /** 变体标记（P1）。 */
  variant?: {
    group: string;
    label: string;
    expected?: string[];
  };
}

export interface LinearizeStats {
  maxFlows: number;
  maxDepth: number;
  entryFallback: boolean;
  exploredPaths: number;
  keptPaths: number;
  droppedPaths: number;
  /** Kept cases that start mid-journey because a longer path hit maxDepth. */
  depthSplits: number;
  truncated: boolean;
}

export interface FlowCoverage extends CoverageClass {
  truncated: boolean;
  entryFallback: boolean;
  /** Exploration-only coverage (inferred evidence): reported, never gates. */
  explore: CoverageClass;
}

/** Deterministic route coverage of the generated cases against the flow graph.
 * Hard targets (explicit/observed/confirmed/legacy evidence) gate
 * `requireFullCoverage`; inferred targets are reported under `explore` only.
 * Backed by `computeClassifiedCoverage` (single implementation shared with
 * preflight). */
export function computeFlowCoverage(
  graph: FlowGraph,
  cases: GeneratedTest[],
  stats?: Pick<LinearizeStats, "truncated" | "entryFallback"> | null
): FlowCoverage {
  const split = computeClassifiedCoverage(
    graph.screens.map((screen) => ({
      name: screen.name,
      hard: isHardCoverageValue(screen.provenance)
    })),
    graph.edges.map((edge) => ({
      from: edge.from.name,
      to: edge.to ? edge.to.name : null,
      hard: isHardCoverageValue(edge.provenance)
    })),
    cases
  );
  const truncated = stats?.truncated ?? false;
  return {
    complete:
      split.hard.uncoveredScreens.length === 0 &&
      split.hard.uncoveredEdges.length === 0 &&
      !truncated,
    uncoveredScreens: split.hard.uncoveredScreens,
    uncoveredEdges: split.hard.uncoveredEdges,
    truncated,
    entryFallback: stats?.entryFallback ?? false,
    explore: {
      uncoveredScreens: split.explore.uncoveredScreens,
      uncoveredEdges: split.explore.uncoveredEdges,
      complete:
        split.explore.uncoveredScreens.length === 0 && split.explore.uncoveredEdges.length === 0
    }
  };
}

/** Expand the flow graph into concrete execution paths (entry → … → terminal /
 * back edge), bounded by count and depth. Selection is coverage-greedy with
 * longest-first ordering: long continuous journeys win, redundant fragments
 * that add no new screen/transition coverage are dropped. Hitting maxDepth
 * never drops the tail: the journey continues as a follow-up segment that
 * starts where the capped path ended (visited set inherited: no cycles).
 * `prefixes[i]` is the navigation prefix (entry → segment start) of
 * `paths[i]`, empty for non-continuation cases; the follow-up segment must
 * replay it to be self-contained at execution time. */
export function linearizeFlowsWithStats(
  graph: FlowGraph,
  options: { maxFlows?: number; maxDepth?: number } = {}
): { paths: FlowEdge[][]; prefixes: FlowEdge[][]; stats: LinearizeStats } {
  const maxFlows = options.maxFlows ?? 10;
  const maxDepth = options.maxDepth ?? 30;

  const outgoingByScreen = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoingByScreen.get(edge.from.id) ?? [];
    list.push(edge);
    outgoingByScreen.set(edge.from.id, list);
  }

  const entryIds = new Set(
    graph.screens.filter((screen) => graph.entryScreens.includes(screen.name)).map((s) => s.id)
  );
  const startIds = entryIds.size > 0 ? [...entryIds] : graph.screens.map((s) => s.id);

  interface ExploreNode {
    screenId: string;
    path: FlowEdge[];
    /** Navigation edges from the journey entry to this node's journey (replayable). */
    prefix: FlowEdge[];
    visited: Set<string>;
    /** Path began at a maxDepth cut instead of an entry screen. */
    continuation: boolean;
  }
  const flows: FlowEdge[][] = [];
  const continuationFlows = new WeakSet<FlowEdge[]>();
  const prefixByFlow = new WeakMap<FlowEdge[], FlowEdge[]>();
  const pushFlow = (flow: FlowEdge[], continuation: boolean, prefix: FlowEdge[]): void => {
    flows.push(flow);
    if (continuation) continuationFlows.add(flow);
    prefixByFlow.set(flow, prefix);
  };
  let guard = 0;
  const guardLimit = Math.min(
    20_000,
    Math.max(500, graph.screens.length * 20 + graph.edges.length * 4)
  );
  const stack: ExploreNode[] = startIds.map((id) => ({
    screenId: id,
    path: [],
    prefix: [],
    visited: new Set([id]),
    continuation: false
  }));
  while (stack.length > 0 && flows.length < maxFlows * 4 && guard < guardLimit) {
    guard += 1;
    const { screenId, path, prefix, visited, continuation } = stack.pop()!;
    const outgoing = outgoingByScreen.get(screenId) ?? [];
    if (outgoing.length === 0) {
      if (path.length > 0) pushFlow(path, continuation, prefix);
      continue;
    }
    if (path.length >= maxDepth) {
      pushFlow(path, continuation, prefix);
      /* 到深度上限不丢尾：把当前屏作为续段新起点（visited 继承防环），长流程
       * 按 maxDepth 拆成首尾相接的连续用例，覆盖缺口留到后续段补齐。续段携带
       * 从入口到切点的完整前缀，执行时可重放导航（自包含，不依赖上段状态）。 */
      stack.push({
        screenId,
        path: [],
        prefix: [...prefix, ...path],
        visited,
        continuation: true
      });
      continue;
    }
    for (const edge of outgoing) {
      const nextPath = [...path, edge];
      if (!edge.to || visited.has(edge.to.id)) {
        pushFlow(nextPath, continuation, prefix); // terminate at dead ends, back edges and self loops
        continue;
      }
      stack.push({
        screenId: edge.to.id,
        path: nextPath,
        prefix,
        visited: new Set([...visited, edge.to.id]),
        continuation
      });
    }
  }

  const signatureOf = (flow: FlowEdge[]): string =>
    flow.map((edge) => `${edge.element.id}->${edge.to?.id ?? "?"}:${edge.trigger}`).join("|");
  const seen = new Set<string>();
  const deduped = flows.filter((flow) => {
    const signature = signatureOf(flow);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });

  const screensOf = (flow: FlowEdge[]): string[] => {
    const list = [flow[0]!.from.name];
    for (const edge of flow) {
      const name = edge.to?.name;
      if (name && name !== list[list.length - 1]) list.push(name);
    }
    return list;
  };
  const pairsOf = (flow: FlowEdge[]): string[] => {
    const pairs = new Set<string>();
    for (const edge of flow) {
      if (!edge.to || edge.from.name === edge.to.name) continue;
      pairs.add(`${edge.from.name} → ${edge.to.name}`);
    }
    return [...pairs];
  };

  /* 覆盖贪心 + 长路径优先：先选覆盖增量最大的连续路径（同增量比长度、再比签名），
   * 直到没有候选能新增屏幕/跳转/未决探索覆盖为止——避免"探索序前 N 条"产生大量
   * 共享前缀的短用例。未决目的地边（to:null）不计入硬/探索覆盖目标（coverage.ts
   * 口径），但每条只探索一次的用例需要被保留，否则视觉识别/未决交互永远不会被
   * 执行（对账也就拿不到真机观测）。 */
  const unresolvedOf = (flow: FlowEdge[]): string[] => {
    const ids = new Set<string>();
    for (const edge of flow) {
      if (!edge.to) ids.add(`${edge.from.id}|${edge.element.id}`);
    }
    return [...ids];
  };
  const candidates = deduped.map((flow) => ({
    flow,
    signature: signatureOf(flow),
    screens: screensOf(flow),
    pairs: pairsOf(flow),
    unresolved: unresolvedOf(flow)
  }));
  const coveredScreens = new Set<string>();
  const coveredPairs = new Set<string>();
  const coveredUnresolved = new Set<string>();
  const gainOf = (candidate: (typeof candidates)[number]): number =>
    candidate.screens.filter((screen) => !coveredScreens.has(screen)).length +
    candidate.pairs.filter((pair) => !coveredPairs.has(pair)).length +
    candidate.unresolved.filter((id) => !coveredUnresolved.has(id)).length;
  const remaining = [...candidates];
  const kept: FlowEdge[][] = [];
  while (kept.length < maxFlows && remaining.length > 0) {
    let bestIndex = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      if (gainOf(candidate) === 0) continue;
      if (bestIndex === -1) {
        bestIndex = index;
        continue;
      }
      const best = remaining[bestIndex]!;
      const gain = gainOf(candidate);
      const bestGain = gainOf(best);
      if (
        gain > bestGain ||
        (gain === bestGain &&
          (candidate.flow.length > best.flow.length ||
            (candidate.flow.length === best.flow.length && candidate.signature < best.signature)))
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex === -1) break;
    const [picked] = remaining.splice(bestIndex, 1);
    kept.push(picked.flow);
    for (const screen of picked.screens) coveredScreens.add(screen);
    for (const pair of picked.pairs) coveredPairs.add(pair);
    for (const id of picked.unresolved) coveredUnresolved.add(id);
  }

  const explorationStopped = guard >= guardLimit || flows.length >= maxFlows * 4;
  const droppedCoverage = remaining.some((candidate) => gainOf(candidate) > 0);
  const truncatedAtCap = kept.length >= maxFlows && droppedCoverage;
  const allScreensCovered = graph.screens.every((screen) => coveredScreens.has(screen.name));
  const allPairsCovered = graph.edges.every((edge) => {
    if (!edge.to || edge.from.name === edge.to.name) return true;
    return coveredPairs.has(`${edge.from.name} → ${edge.to.name}`);
  });
  const allUnresolvedCovered = graph.edges.every((edge) =>
    edge.to ? true : coveredUnresolved.has(`${edge.from.id}|${edge.element.id}`)
  );
  const knownGap =
    !allScreensCovered || !allPairsCovered || !allUnresolvedCovered || droppedCoverage;
  const truncated = knownGap && (explorationStopped || truncatedAtCap);
  return {
    paths: kept,
    prefixes: kept.map((flow) => prefixByFlow.get(flow) ?? []),
    stats: {
      maxFlows,
      maxDepth,
      entryFallback: entryIds.size === 0,
      exploredPaths: flows.length,
      keptPaths: kept.length,
      droppedPaths: Math.max(0, deduped.length - kept.length),
      depthSplits: kept.filter((flow) => continuationFlows.has(flow)).length,
      truncated
    }
  };
}

export function linearizeFlows(
  graph: FlowGraph,
  options: { maxFlows?: number; maxDepth?: number } = {}
): FlowEdge[][] {
  return linearizeFlowsWithStats(graph, options).paths;
}

/** Assertion candidates: runtime text only — annotations and layer names are
 * display-level evidence and never feed assertions. */
function runtimeHintTexts(raw: unknown): string[] {
  return normalizeFlowHints(raw)
    .filter((hint) => hint.textClass === "runtime-text")
    .map((hint) => hint.text);
}

function expectationFor(graph: FlowGraph, edge: FlowEdge): StepExpectation {
  const provenance = resolveProvenance(edge.provenance);
  const confidence = confidenceFor(provenance);
  const kind: StepKind = isUnconfirmedProvenance(provenance) ? "explore" : "assert";
  if (!edge.to) return { screen: null, hints: [], provenance, confidence, kind };
  const screen = graph.screens.find((candidate) => candidate.id === edge.to!.id);
  if (kind === "explore") {
    return { screen: edge.to.name, hints: [], provenance, confidence, kind };
  }
  const acceptance = (screen?.acceptance ?? [])
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (acceptance.length > 0) {
    return {
      screen: edge.to.name,
      hints: acceptance.slice(0, 5),
      provenance,
      confidence,
      kind,
      hintsSource: "acceptance"
    };
  }
  return {
    screen: edge.to.name,
    hints: runtimeHintTexts(screen?.textHints).slice(0, 3),
    provenance,
    confidence,
    kind,
    hintsSource: "runtime-text"
  };
}

function assertionFor(graph: FlowGraph, edge: FlowEdge): string {
  const { hints } = expectationFor(graph, edge);
  return hints.length > 0 ? `（页面应出现「${hints.join("」「")}」等）` : "";
}

function lookupI18nKey(text: string | undefined, i18nKeys: Map<string, string> | undefined): string | null {
  if (!text || !i18nKeys || i18nKeys.size === 0) return null;
  const canonical = normalizedText(canonicalizePlaceholders(text).canonicalText);
  return i18nKeys.get(canonical) ?? i18nKeys.get(normalizedText(text)) ?? null;
}

import { identifierFromLayerName } from "../design/identifiers.js";
import { scanCodeIdentifierHints } from "./code-identifiers.js";

export { identifierFromLayerName };

/** 从 flows 图预挖：交互元素图层名像标识时，把它与元素运行期文本关联。
 * screen-map 的观测结果优先（调用方先写入）。 */
export function identifierSuggestionsFromGraph(graph: FlowGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const edge of graph.edges) {
    const identifier = identifierFromLayerName(edge.element.name);
    if (identifier === null) continue;
    for (const text of runtimeHintTexts(edge.textHints)) {
      const key = normalizeElementLabel(text);
      if (key !== "" && !map.has(key)) map.set(key, identifier);
    }
  }
  return map;
}

/** Element-level identifier suggestions (screen-map elements; best-hit first,
 * keyed by normalized text — same text on several screens suggests the same
 * identifier, which is the conventional cross-screen behavior). */
function loadIdentifierSuggestions(
  runtime: DesignRuntimeLike,
  graph: FlowGraph
): Map<string, string> {
  const map = new Map<string, string>();
  const elements = [...loadScreenMap(runtime.configDirAbs).elements].sort(
    (a, b) => b.hits - a.hits || a.text.localeCompare(b.text)
  );
  for (const element of elements) {
    const key = normalizeElementLabel(element.text);
    if (key !== "" && !map.has(key)) map.set(key, element.identifier);
  }
  if (process.env.AOS_CODE_IDENTIFIERS !== "0") {
    const code = scanCodeIdentifierHints(runtime.project.rootDir);
    for (const hint of code.hints) {
      const key = normalizeElementLabel(hint.text);
      if (key !== "" && !map.has(key)) map.set(key, hint.identifier);
    }
  }
  for (const [key, identifier] of identifierSuggestionsFromGraph(graph)) {
    if (!map.has(key)) map.set(key, identifier);
  }
  return map;
}

const TECHNICAL_SCREEN_NAME = /^(Frame|Group|Rectangle|Component(?: Set)?|Vector|Ellipse|Image|Layer|Line|Boolean|Union|Subtract|Intersect|Exclude|Star|Polygon|Slice|Text)[\s_-]*\d*$/i;
const GENERIC_ELEMENT_PREFIX = /^(icons?|images?|frames?|groups?|components?|component set|vectors?|rectangles?|ellipses?|layers?|app)\b[\s_/-]*/i;
const GENERIC_ELEMENT_SUFFIX = /[\s_/-]*\b(button|btn|text|label|input|field|view|container|icon|image|frame|group)\b$/i;

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function genericElementLabel(type: string, rawName: string): string {
  const kind = type.toUpperCase();
  if (kind.includes("BUTTON") || kind.includes("INSTANCE") || kind.includes("COMPONENT")) return "按钮";
  if (kind.includes("INPUT") || kind.includes("TEXT_FIELD") || kind.includes("TEXTFIELD")) return "输入框";
  if (kind.includes("SWITCH") || kind.includes("TOGGLE")) return "开关";
  if (kind.includes("TAB")) return "标签页";
  if (kind.includes("IMAGE")) return "图片";
  if (kind.includes("TEXT")) return "文字";
  if (/^icons?[\\/]/i.test(rawName.trim())) return "图标";
  return "可点击区域";
}

function visionElementLabel(edge: FlowEdge, graph: FlowGraph): string | null {
  const screen = graph.screens.find((entry) => entry.name === edge.from.name);
  const element = screen?.elements?.find(
    (entry) => entry.nodeId === edge.element.id || entry.id === edge.element.id
  );
  const label = element?.label?.trim();
  return label !== undefined && label !== "" ? label : null;
}

/** 人类层元素标签：可见文本 → grounded vision label → 去掉通用词后的图层名 → 通用控件名。 */
export function humanElementLabel(edge: FlowEdge, graph?: FlowGraph): {
  label: string;
  fallback: boolean;
  raw: string;
} {
  const hint = runtimeHintTexts(edge.textHints)[0]?.trim();
  if (hint) return { label: hint, fallback: false, raw: edge.element.name };
  const visionLabel = graph === undefined ? null : visionElementLabel(edge, graph);
  if (visionLabel !== null) {
    return { label: visionLabel, fallback: false, raw: edge.element.name };
  }
  const raw = edge.element.name.trim();
  const generic = genericElementLabel(edge.element.type, raw);
  let cleaned = raw.replace(GENERIC_ELEMENT_PREFIX, "").replace(GENERIC_ELEMENT_SUFFIX, "").trim();
  cleaned = cleaned.replace(/^[\s_/.-]+|[\s_/.-]+$/g, "");
  if (cleaned !== "" && hasCjk(cleaned) && cleaned.length <= 30) {
    return { label: cleaned, fallback: false, raw };
  }
  if (
    cleaned !== "" &&
    /^[A-Za-z0-9 &'.,:-]+$/.test(cleaned) &&
    cleaned.length <= 48 &&
    cleaned.split(/\s+/).filter(Boolean).length >= 2
  ) {
    return { label: `${cleaned}${generic === "可点击区域" ? "" : generic}`, fallback: false, raw };
  }
  return { label: generic, fallback: true, raw };
}

function humanScreenLabel(name: string, hints: string[]): string {
  const trimmed = name.trim();
  const readable =
    trimmed !== "" &&
    !TECHNICAL_SCREEN_NAME.test(trimmed) &&
    !/[\\/]/.test(trimmed) &&
    !/[a-z][A-Z]/.test(trimmed);
  if (readable) return trimmed;
  const hint = hints.map((entry) => entry.trim()).find((entry) => entry !== "" && !/[\\/]/.test(entry));
  return hint !== undefined && hint.length <= 30 ? hint : "未命名页面";
}

function humanScreenLabels(graph: FlowGraph): Map<string, string> {
  const labels = new Map<string, string>();
  const used = new Map<string, number>();
  for (const screen of graph.screens) {
    const base = humanScreenLabel(screen.name, runtimeHintTexts(screen.textHints));
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    labels.set(screen.name, count === 1 ? base : `${base} (${count})`);
  }
  return labels;
}

function humanStepFor(
  graph: FlowGraph,
  edge: FlowEdge,
  labels: Map<string, string>
): { text: string; fallback: boolean; label: string } {
  const provenance = resolveProvenance(edge.provenance);
  const displayName = (name: string): string => labels.get(name) ?? name;
  if (isUnconfirmedProvenance(provenance)) {
    if (edge.trigger === "AFTER_TIMEOUT") {
      const seconds = ((edge.triggerTimeoutMs ?? 0) / 1000).toFixed(1).replace(/\.0$/, "");
      const destination = edge.to ? `「${displayName(edge.to.name)}」` : "下一屏";
      return {
        text: `等待 ${seconds} 秒后确认到达${destination}（来源未确认；记录实际页面变化，不参与断言判定）`,
        fallback: false,
        label: destination
      };
    }
    if (edge.back) {
      return {
        text: "探索返回上一屏（来源未确认）：记录实际页面变化；不参与断言判定",
        fallback: false,
        label: "上一屏"
      };
    }
    if (edge.to) {
      return {
        text: `探索到达「${displayName(edge.to.name)}」（来源未确认）：自行尝试触发通往该页的交互，记录实际路径与页面变化；不参与断言判定`,
        fallback: false,
        label: displayName(edge.to.name)
      };
    }
    const label = humanElementLabel(edge, graph);
    return {
      text: `探索未知跳转「${label.label}」（来源未确认）：尝试触发该元素并记录实际页面变化；不参与断言判定`,
      fallback: label.fallback,
      label: label.label
    };
  }
  const element = humanElementLabel(edge, graph);
  const target = edge.to ? `「${displayName(edge.to.name)}」` : null;
  const assertion = assertionFor(graph, edge);
  const label = `「${element.label}」`;
  if (edge.trigger === "AFTER_TIMEOUT") {
    const seconds = ((edge.triggerTimeoutMs ?? 0) / 1000).toFixed(1).replace(/\.0$/, "");
    return {
      text: `等待 ${seconds} 秒${target ? `，页面应自动进入${target}${assertion}` : ""}`,
      fallback: false,
      label: target ?? "自动跳转"
    };
  }
  if (edge.back) {
    return {
      text: `点击${label}返回上一页${target ? `（应回到${target}${assertion}）` : ""}`,
      fallback: element.fallback,
      label: element.label
    };
  }
  if (edge.trigger === "ON_DRAG") {
    return {
      text: `在${label}上执行拖拽操作${target ? `，验证进入${target}${assertion}` : ""}`,
      fallback: element.fallback,
      label: element.label
    };
  }
  if (edge.trigger.startsWith("ON_")) {
    return {
      text: `点击${label}${target ? `，验证进入${target}${assertion}` : "（应停留在本页不产生跳转）"}`,
      fallback: element.fallback,
      label: element.label
    };
  }
  return {
    text: `触发${label}（${edge.trigger}）${target ? `，验证进入${target}${assertion}` : ""}`,
    fallback: element.fallback,
    label: element.label
  };
}

function stepFor(
  graph: FlowGraph,
  edge: FlowEdge,
  i18nKeys?: Map<string, string>,
  identifiers?: Map<string, string>
): string {
  const provenance = resolveProvenance(edge.provenance);
  if (isUnconfirmedProvenance(provenance)) {
    if (edge.trigger === "AFTER_TIMEOUT") {
      const seconds = ((edge.triggerTimeoutMs ?? 0) / 1000).toFixed(1).replace(/\.0$/, "");
      const destination = edge.to ? `「${edge.to.name}」` : "下一屏";
      return `等待 ${seconds} 秒后确认到达${destination}（来源未确认；记录实际页面变化，不参与断言判定）`;
    }
    if (edge.back) {
      return "探索返回上一屏（来源未确认）：记录实际页面变化；不参与断言判定";
    }
    if (edge.to) {
      return `探索到达「${edge.to.name}」（来源未确认）：自行尝试触发通往该页的交互，记录实际路径与页面变化；不参与断言判定`;
    }
    return `探索未知跳转「${edge.element.name}」（来源未确认）：尝试触发该元素并记录实际页面变化；不参与断言判定`;
  }
  const target = edge.to ? `「${edge.to.name}」` : null;
  const assertion = assertionFor(graph, edge);
  const elementHint = runtimeHintTexts(edge.textHints)[0];
  const label = elementHint ? `「${elementHint}」` : `「${edge.element.name}」`;
  const i18nKey = lookupI18nKey(elementHint, i18nKeys);
  const identifier = elementHint ? identifiers?.get(normalizeElementLabel(elementHint)) : undefined;
  const elementNote = elementHint
    ? `（设计元素：${edge.element.name}${i18nKey ? `；i18n: ${i18nKey}` : ""}${identifier ? `；a11y: ${identifier}` : ""}）`
    : "";

  if (edge.trigger === "AFTER_TIMEOUT") {
    const seconds = ((edge.triggerTimeoutMs ?? 0) / 1000).toFixed(1).replace(/\.0$/, "");
    return `等待 ${seconds} 秒${target ? `，页面应自动进入${target}${assertion}` : ""}`;
  }
  if (edge.back) {
    return `点击${label}返回上一页${target ? `（应回到${target}${assertion}）` : ""}`;
  }
  if (edge.trigger === "ON_DRAG") {
    return `在${label}${elementNote}上执行拖拽操作${target ? `，验证进入${target}${assertion}` : ""}`;
  }
  if (edge.trigger.startsWith("ON_")) {
    return `点击${label}${elementNote}${
      target ? `，验证进入${target}${assertion}` : "（应停留在本页不产生跳转）"
    }`;
  }
  return `触发${label}${elementNote}（${edge.trigger}）${target ? `，验证进入${target}${assertion}` : ""}`;
}

function caseIdFor(name: string, screens: string[], steps: string[]): string {
  const basis = JSON.stringify([name, screens, steps]);
  return `case-${createHash("sha256").update(basis).digest("hex").slice(0, 12)}`;
}

/** 同一路径骨架出现多次时追加稳定序号（不依赖 locator/测试数据）。 */
export function disambiguateSemanticIds(cases: Array<{ semanticId?: string }>): void {
  const seen = new Map<string, number>();
  for (const testCase of cases) {
    const base = testCase.semanticId;
    if (!base) continue;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    if (occurrence > 1) testCase.semanticId = `${base}-${occurrence}`;
  }
}

/** 跨平台语义身份：不包含 taskDesc/i18n/a11y/模块名；只依赖 canonical 路径骨架。 */
function semanticIdFor(input: {
  screens: string[];
  edges: Array<Pick<FlowEdge, "from" | "to" | "trigger" | "back">>;
}): string {
  // 纯路径骨架：只保留 canonical 页面序列与交互类型；不吸收
  // reconciliation/acceptance/i18n/a11y 等会因项目或运行历史变化的内容。
  const basis = JSON.stringify({
    screens: input.screens,
    edges: input.edges.map((edge) => ({
      from: edge.from.name,
      to: edge.to?.name ?? null,
      trigger: edge.trigger,
      back: edge.back === true
    }))
  });
  return `sem-${createHash("sha256").update(basis).digest("hex").slice(0, 12)}`;
}

/** Manual acceptance overrides (`.artemis/design/acceptance.json`):
 * `{screens: {"<屏名>": ["条目", …]}}` plus optional `data/questions/section`
 * maps. Human-confirmed criteria replace the screen's annotation-derived
 * acceptance. Invalid files/entries are ignored with a visible warning. */
export interface AcceptanceVariant {
  screen: string;
  label: string;
  data: string[];
  expected: string[];
}

export interface AcceptanceDetails {
  screens: Map<string, string[]>;
  data: Map<string, string[]>;
  questions: Map<string, string[]>;
  section: Map<string, string>;
  variants: AcceptanceVariant[];
  warnings: DesignWarning[];
}

function emptyAcceptanceDetails(): AcceptanceDetails {
  return {
    screens: new Map(),
    data: new Map(),
    questions: new Map(),
    section: new Map(),
    variants: [],
    warnings: []
  };
}

function pushDesignWarning(
  warnings: DesignWarning[],
  code: string,
  message: string,
  screens?: string[]
): void {
  warnings.push({
    code,
    message,
    ...(screens !== undefined && screens.length > 0 ? { scope: { screens } } : {})
  });
}

function readStringList(
  value: unknown,
  limit: number,
  label: string,
  warnings: DesignWarning[],
  scopeScreen?: string
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    pushDesignWarning(
      warnings,
      "acceptance-details-invalid",
      `acceptance.json 的 ${label} 不是数组，已忽略`,
      scopeScreen !== undefined ? [scopeScreen] : undefined
    );
    return [];
  }
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (list.length > limit) {
    pushDesignWarning(
      warnings,
      "acceptance-details-truncated",
      `acceptance.json 的 ${label} 超过 ${limit} 条，已截断`,
      scopeScreen !== undefined ? [scopeScreen] : undefined
    );
  }
  return [...new Set(list)].slice(0, limit);
}

function readStringListMap(
  value: unknown,
  limit: number,
  label: string,
  warnings: DesignWarning[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (value === undefined) return map;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push({
      code: "acceptance-details-invalid",
      message: `acceptance.json 的 ${label} 不是对象，已忽略`
    });
    return map;
  }
  for (const [rawName, items] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (name === "") continue;
    const list = readStringList(items, limit, `${label}.${name}`, warnings, name);
    if (list.length === 0) continue;
    map.set(name, list);
  }
  return map;
}

function readVariants(value: unknown, warnings: DesignWarning[]): AcceptanceVariant[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    pushDesignWarning(
      warnings,
      "acceptance-details-invalid",
      "acceptance.json 的 variants 不是数组，已忽略"
    );
    return [];
  }
  const variants: AcceptanceVariant[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      pushDesignWarning(
        warnings,
        "acceptance-details-invalid",
        `acceptance.json 的 variants[${index}] 不是对象，已忽略`
      );
      return;
    }
    const record = raw as Record<string, unknown>;
    const screen = typeof record.screen === "string" ? record.screen.trim() : "";
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (screen === "" || label === "") {
      pushDesignWarning(
        warnings,
        "acceptance-details-invalid",
        `acceptance.json 的 variants[${index}] 缺 screen/label，已忽略`,
        screen !== "" ? [screen] : undefined
      );
      return;
    }
    const key = `${screen}\u0000${label}`;
    if (seen.has(key)) {
      pushDesignWarning(
        warnings,
        "acceptance-details-invalid",
        `acceptance.json 的 variants[${index}] 重复（screen/label），已忽略`,
        [screen]
      );
      return;
    }
    seen.add(key);
    variants.push({
      screen,
      label: label.slice(0, 80),
      data: readStringList(record.data, 20, `variants[${index}].data`, warnings, screen),
      expected: readStringList(record.expected, 20, `variants[${index}].expected`, warnings, screen)
    });
  });
  if (variants.length > 20) {
    pushDesignWarning(
      warnings,
      "acceptance-details-truncated",
      "acceptance.json 的 variants 超过 20 条，已截断"
    );
    return variants.slice(0, 20);
  }
  return variants;
}

function readSectionMap(value: unknown, warnings: DesignWarning[]): Map<string, string> {
  const map = new Map<string, string>();
  if (value === undefined) return map;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push({
      code: "acceptance-details-invalid",
      message: "acceptance.json 的 section 不是对象，已忽略"
    });
    return map;
  }
  for (const [rawName, rawSection] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (name === "") continue;
    if (typeof rawSection !== "string") {
      pushDesignWarning(
        warnings,
        "acceptance-details-invalid",
        `acceptance.json 的 section.${name} 不是字符串，已忽略`,
        [name]
      );
      continue;
    }
    const section = rawSection.trim();
    if (section === "") {
      pushDesignWarning(
        warnings,
        "acceptance-details-invalid",
        `acceptance.json 的 section.${name} 为空，已忽略`,
        [name]
      );
      continue;
    }
    map.set(name, section.slice(0, 40));
  }
  return map;
}

function loadAcceptanceDetails(runtime: DesignRuntimeLike): AcceptanceDetails {
  const details = emptyAcceptanceDetails();
  try {
    const file = path.join(runtime.configDirAbs, "design", "acceptance.json");
    if (!fs.existsSync(file)) return details;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      details.warnings.push({
        code: "acceptance-details-invalid",
        message: "acceptance.json 顶层不是对象，已忽略"
      });
      return details;
    }
    const record = parsed as Record<string, unknown>;
    details.screens = readStringListMap(record.screens, 5, "screens", details.warnings);
    details.data = readStringListMap(record.data, 20, "data", details.warnings);
    details.questions = readStringListMap(record.questions, 20, "questions", details.warnings);
    details.section = readSectionMap(record.section, details.warnings);
    details.variants = readVariants(record.variants, details.warnings);
  } catch (error) {
    details.warnings.push({
      code: "acceptance-details-invalid",
      message: `acceptance.json 读取失败，已忽略：${errorMessage(error)}`
    });
  }
  return details;
}

function applyAcceptanceOverrides(graph: FlowGraph, overrides: Map<string, string[]>): FlowGraph {
  if (overrides.size === 0) return graph;
  return {
    ...graph,
    screens: graph.screens.map((screen) =>
      overrides.has(screen.name) ? { ...screen, acceptance: overrides.get(screen.name) } : screen
    )
  };
}

export interface GenerateTestCasesOptions {
  maxFlows?: number;
  maxDepth?: number;
  i18nKeys?: Map<string, string>;
  /** Element identifier suggestions keyed by normalized text (screen-map). */
  identifiers?: Map<string, string>;
  /** 人工测试数据（屏幕 → 文本），按用例屏幕顺序收集。 */
  testDataByScreen?: Map<string, string[]>;
  /** 人工待确认项（屏幕 → 文本）。 */
  questionsByScreen?: Map<string, string[]>;
  /** 人工 Section 覆盖（入口屏 → Section 名）。 */
  sectionByScreen?: Map<string, string>;
  onStats?: (stats: LinearizeStats) => void;
}

/** Turn flow paths into test cases with artemis-ready task descriptions.
 * `i18nKeys` maps canonical source text → frozen i18n key (strings.json) so
 * generated steps can prefer resource keys over locale-dependent literals. */
export function generateTestCases(
  graph: FlowGraph,
  options: GenerateTestCasesOptions = {}
): GeneratedTest[] {
  const { paths, prefixes, stats } = linearizeFlowsWithStats(graph, {
    maxFlows: options.maxFlows ?? 10,
    maxDepth: options.maxDepth
  });
  options.onStats?.(stats);
  const screenLabels = humanScreenLabels(graph);
  const cases = paths.map((flowPath, pathIndex) => {
    const prefix = prefixes[pathIndex] ?? [];
    const continuation = prefix.length > 0;
    const first = flowPath[0]!;
    const screens: string[] = [];
    const pushScreen = (screenName: string | null | undefined): void => {
      if (screenName && screenName !== screens[screens.length - 1]) screens.push(screenName);
    };
    pushScreen(prefix.length > 0 ? prefix[0]!.from.name : first.from.name);
    for (const edge of prefix) pushScreen(edge.to?.name);
    pushScreen(first.from.name);
    for (const edge of flowPath) pushScreen(edge.to?.name);
    const steps = flowPath.map((edge) => stepFor(graph, edge, options.i18nKeys, options.identifiers));
    const prelude = prefix.map((edge) => stepFor(graph, edge, options.i18nKeys, options.identifiers));
    const humanSteps = flowPath.map((edge) => humanStepFor(graph, edge, screenLabels).text);
    const humanPrelude = prefix.map((edge) => humanStepFor(graph, edge, screenLabels).text);
    const humanizationEdges = [...prefix, ...flowPath].map((edge) => humanStepFor(graph, edge, screenLabels));
    const humanFallbacks = humanizationEdges.filter((entry) => entry.fallback);
    const expectations = flowPath.map((edge) => expectationFor(graph, edge));
    const exploreCount = [...prefix, ...flowPath].filter((edge) =>
      isUnconfirmedProvenance(resolveProvenance(edge.provenance))
    ).length;
    const displayScreens = screens.map((screen) => screenLabels.get(screen) ?? screen);
    const machineBaseName =
      screens.length <= 4 ? screens.join(" → ") : `${screens.slice(0, 4).join(" → ")} → …`;
    const idName = continuation ? `${machineBaseName}（续段）` : machineBaseName;
    const baseName =
      displayScreens.length <= 4
        ? displayScreens.join(" → ")
        : `${displayScreens.slice(0, 4).join(" → ")} → …`;
    const name = continuation ? `${baseName}（续段）` : baseName;
    const preconditions = deriveCasePreconditions(displayScreens, {
      entryFallback: stats.entryFallback
    });
    const entryScreen = screens[0]!;
    const entryScreenObj = graph.screens.find((candidate) => candidate.name === entryScreen);
    const preflight: CasePreflight = {
      screen: entryScreen,
      hints: runtimeHintTexts(entryScreenObj?.textHints).slice(0, 3)
    };
    const testData = collectScreenValues(screens, options.testDataByScreen ?? new Map(), 12);
    const openQuestions = collectScreenValues(screens, options.questionsByScreen ?? new Map(), 10);
    const section = options.sectionByScreen?.get(entryScreen) ?? screenLabels.get(entryScreen) ?? entryScreen;
    const expectationLine = `脚本断言（供 iOS 执行器自动核对，执行时无需处理）：【AOS-EXPECT】${JSON.stringify(
      {
        ...(preflight.hints.length > 0
          ? { start: { screen: preflight.screen, hints: preflight.hints } }
          : {}),
        steps: expectations.map((expectation, index) => ({
          index: index + 1,
          screen: expectation.screen,
          hints: expectation.hints,
          provenance: expectation.provenance,
          confidence: expectation.confidence,
          kind: expectation.kind,
          ...(expectation.hintsSource ? { hintsSource: expectation.hintsSource } : {})
        }))
      }
    )}`;
    const taskDesc = [
      `【设计流程端到端验证】${name}`,
      ...(continuation
        ? [
            `本篇为长流程接续段：先按「前导导航」到达起点「${first.from.name}」，前导步骤仅用于到达起点，不计入断言。`
          ]
        : []),
      `开始前：打开应用并确保停留在「${entryScreen}」页（如不在该页，先导航过去）。`,
      `前置假设：${preconditions.join("；")}。若数据不满足，请停止并报告数据不满足。`,
      REAL_DATA_CLAUSE,
      ...(testData.length > 0 ? ["【测试数据】", ...testData.map((item) => `- ${item}`)] : []),
      ...(openQuestions.length > 0
        ? ["【待确认】", ...openQuestions.map((item) => `- ${item}`)]
        : []),
      ...(exploreCount > 0
        ? [
            `本用例含 ${exploreCount} 步探索（来源未确认）：探索步骤记录实际路径即可，不参与 PASS/FAIL。`
          ]
        : []),
      ...(continuation
        ? [
            "前导导航（仅到达起点，不计入断言）：",
            ...prelude.map((step, index) => `P${index + 1}) ${step}`),
            "用例步骤："
          ]
        : []),
      ...steps.map((step, index) => `${index + 1}) ${step}`),
      "每步完成后报告当前页面标题与可见关键文本；任一步失败则停止，报告失败步骤、屏幕上的关键文本并截屏；全部通过后输出 PASS/FAIL 摘要。",
      expectationLine
    ].join("\n");
    return {
      id: caseIdFor(idName, screens, steps),
      semanticId: semanticIdFor({
        screens,
        edges: [...prefix, ...flowPath]
      }),
      name,
      screens,
      displayScreens,
      displayName: name,
      steps,
      humanSteps,
      humanization: {
        elements: humanizationEdges.length,
        fallbacks: humanFallbacks.length,
        fallbackLabels: [...new Set(humanFallbacks.map((entry) => entry.label))],
        density:
          humanizationEdges.length === 0
            ? 0
            : Number((humanFallbacks.length / humanizationEdges.length).toFixed(2))
      },
      preconditions,
      taskDesc,
      continuation,
      startScreen: first.from.name,
      prelude,
      humanPrelude,
      expectations,
      preflight,
      checkpoints: {
        visual: [...new Set([...preflight.hints, ...expectations.flatMap((entry) => entry.hints)])].slice(0, 12),
        functional: expectations
          .flatMap((entry, index) => (entry.screen === null ? [] : [`步骤 ${index + 1} → ${entry.screen}`]))
          .slice(0, 12),
        interface: []
      },
      section,
      testData,
      openQuestions
    };
  });
  disambiguateSemanticIds(cases);
  return cases;
}

export function renderMarkdown(
  cases: GeneratedTest[],
  meta: { source: string; generatedAt: string },
  options: {
    images?: Map<string, string[]>;
    feedback?: CaseDefectFeedback;
    designWarnings?: DesignWarning[];
    apiReview?: ApiReview | null;
  } = {}
): string {
  const lines: string[] = [
    "# 设计流程测试用例",
    "",
    `> 来源: ${meta.source}`,
    `> 生成时间: ${meta.generatedAt}`,
    ""
  ];
  if (options.apiReview !== undefined && options.apiReview !== null) {
    const review = options.apiReview;
    const label =
      review.status === "provided"
        ? "已提供 API 说明"
        : review.status === "pending"
          ? "待补充 API 说明（先生成，相关执行前需补齐）"
          : review.status === "not-applicable"
            ? "无 API 变更"
            : "API 变更未确认";
    lines.push(`> **API 变更：${label}**${review.carriedForward ? "（沿用上次说明，请复核）" : ""}`, "");
    if (review.apiSpec !== null && review.apiSpec.trim() !== "") {
      lines.push("<details>", "<summary>API 说明</summary>", "", "```text", review.apiSpec, "```", "", "</details>", "");
    }
  }
  if (options.designWarnings && options.designWarnings.length > 0) {
    lines.push("## 警告（设计源与生成期，不阻断生成）", "");
    for (const warning of options.designWarnings) {
      lines.push(`- \`${warning.code}\`：${warning.message}`);
      if (warning.details && warning.details.length > 0) {
        lines.push(`  - 明细：${warning.details.join("、")}`);
      }
    }
    lines.push("");
  }
  cases.forEach((testCase, index) => {
    const displayId = testCase.displayId ?? "—";
    const module = testCase.module ?? "未分组";
    const section = testCase.section ?? "未指定";
    lines.push(`## ${index + 1}. ${displayId} · ${module} / ${section} — ${testCase.name}`, "");
    if (testCase.continuation) {
      const startDisplay =
        testCase.displayScreens?.[testCase.screens.indexOf(testCase.startScreen)] ??
        testCase.startScreen;
      lines.push(`> 接续段：先按前导导航到「${startDisplay}」（不计断言）`, "");
    }
    const refs = [...new Set(options.images?.get(testCase.id) ?? [])];
    if (refs.length > 0) {
      const shown = refs.slice(0, 8);
      lines.push(shown.map((ref) => `<img src="${ref}" height="160">`).join(" "));
      if (refs.length > shown.length) lines.push(`…（共 ${refs.length} 屏）`);
      lines.push("");
    }
    if ((testCase.preconditions ?? []).length > 0) {
      lines.push(`- 前置假设：${testCase.preconditions.join("；")}`, "");
    }
    const testData = testDataLines(testCase);
    if (testData.length > 0) {
      lines.push("测试数据：", ...testData.map((line) => `  ${line}`), "");
    }
    if (testCase.checkpoints !== undefined) {
      const cp = testCase.checkpoints;
      lines.push(
        "- 检查点：",
        `  - 视觉：${cp.visual.length > 0 ? cp.visual.join("、") : "未提供"}`,
        `  - 功能：${cp.functional.length > 0 ? cp.functional.join("；") : "未提供"}`,
        `  - 接口：${cp.interface.length > 0 ? cp.interface.join("；") : options.apiReview?.status === "provided" ? "见 API 说明" : "未提供"}`,
        ""
      );
    }
    const humanPrelude = testCase.humanPrelude ?? testCase.prelude ?? [];
    if (humanPrelude.length > 0) {
      lines.push("- 前导导航（仅到达起点）：");
      humanPrelude.forEach((step, stepIndex) => {
        lines.push(`  - [ ] P${stepIndex + 1}) ${step}`);
      });
      lines.push("");
    }
    (testCase.humanSteps ?? testCase.steps).forEach((step, stepIndex) => {
      lines.push(`- [ ] ${stepIndex + 1}) ${step}`);
    });
    const humanization = testCase.humanization;
    if (
      humanization !== undefined &&
      (humanization.fallbacks >= 3 || humanization.density > 0.2)
    ) {
      lines.push(
        "",
        `> 人类层降级：${humanization.fallbacks}/${humanization.elements} 个元素回退为通用名称（${humanization.fallbackLabels.join("、") || "—"}），请结合设计图核对。`
      );
    }
    const expected = expectedResultLines(testCase);
    if (expected.length > 0) {
      lines.push("", "预期结果：", ...expected.map((line) => `- ${line}`));
    }
    const questions = openQuestionLines(testCase);
    if (questions.length > 0) {
      lines.push("", "待确认：", ...questions.map((line) => `  ${line}`));
    }
    const scopedWarnings = testCase.designWarnings ?? [];
    if (scopedWarnings.length > 0) {
      lines.push(
        "",
        "设计警告：",
        ...scopedWarnings.map((warning) => `- \`${warning.code}\`：${warning.message}`)
      );
    }
    lines.push(
      "",
      "<details>",
      "<summary>执行器指令（agent 读取）</summary>",
      "",
      "```text",
      testCase.taskDesc,
      "```",
      "",
      "</details>",
      ""
    );
  });
  if (options.feedback && options.feedback.byFeature.length > 0) {
    lines.push("## 上轮案例问题修订提示（裁决反馈）", "");
    for (const feature of options.feedback.byFeature) {
      const name = feature.featureName ?? feature.featureKey;
      const items = feature.cases
        .map(
          (entry) =>
            `（${entry.caseId}「${entry.name}」${entry.note !== null && entry.note !== "" ? `；备注：${entry.note}` : ""}）`
        )
        .join("");
      lines.push(`- 功能「${name}」：${feature.count} 条${items}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}


const API_SPEC_MAX_BYTES = 64 * 1024;

export type ApiChange = "none" | "new" | "modified" | "unknown";
export type ApiReviewStatus = "not-applicable" | "provided" | "pending" | "unknown";

export interface ApiReview {
  change: ApiChange;
  status: ApiReviewStatus;
  /** 内联接口说明；受 64 KiB 上限约束。 */
  apiSpec: string | null;
  apiSpecSha256: string | null;
  /** 用于判断 carriedForward 是否跨设计源。 */
  designFingerprint: string | null;
  carriedForward?: boolean;
  designChanged?: boolean;
  updatedAt: string;
}

export interface GenerateTestsArgs {
  url?: string;
  flowsPath?: string;
  maxFlows?: number;
  maxDepth?: number;
  save?: boolean;
  apiChange?: ApiChange;
  apiSpec?: string;
  apiSpecPath?: string;
  /** 次级产物开关（tests.json 在 save!==false 时始终落盘）。 */
  saveArtifacts?: {
    markdown?: boolean;
    xlsx?: boolean;
    caseSets?: boolean;
  };
  excelPath?: string;
  excelTemplate?: string;
  requireFullCoverage?: boolean;
  /** 按用例嵌入屏幕截图到 tests.md（默认 true；`AOS_SCREENS=0` 全局关闭）。 */
  screens?: boolean;
}

function optionalFileFingerprint(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** 设计内容指纹：只哈希会影响流程/断言的稳定字段，不吸收生成参数或对账状态。 */
export function flowGraphFingerprint(graph: FlowGraph): string {
  const canonical = {
    screens: graph.screens.map((screen) => ({
      id: screen.id,
      name: screen.name,
      suggestedRoute: screen.suggestedRoute,
      page: screen.page ?? null,
      childNames: screen.childNames,
      textHints: screen.textHints,
      bounds: screen.bounds ?? null,
      acceptance: screen.acceptance ?? null,
      elements: screen.elements ?? null,
      provenance: screen.provenance ?? null,
      confidence: screen.confidence ?? null
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      element: edge.element,
      textHints: edge.textHints,
      trigger: edge.trigger,
      triggerTimeoutMs: edge.triggerTimeoutMs ?? null,
      navigation: edge.navigation ?? null,
      actionType: edge.actionType,
      back: edge.back === true,
      state: edge.state ?? null,
      provenance: edge.provenance ?? null,
      confidence: edge.confidence ?? null
    })),
    entryScreens: graph.entryScreens,
    unresolvedDestinations: graph.unresolvedDestinations,
    interactionNodes: graph.interactionNodes ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function designFingerprintFor(
  runtime: DesignRuntimeLike,
  input: { flowsPath: string; url?: string; graph?: FlowGraph }
): string {
  if (input.graph !== undefined) {
    const content = flowGraphFingerprint(input.graph);
    return typeof input.url === "string" && input.url.trim() !== ""
      ? createHash("sha256").update(`figma:${input.url.trim()}\n${content}`).digest("hex")
      : content;
  }
  if (typeof input.url === "string" && input.url.trim() !== "") {
    return createHash("sha256").update(`figma:${input.url.trim()}`).digest("hex");
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(input.flowsPath, "utf-8")) as unknown;
    return flowGraphFingerprint(normalizeFlowGraph(parsed));
  } catch {
    try {
      return createHash("sha256").update(fs.readFileSync(input.flowsPath)).digest("hex");
    } catch {
      return createHash("sha256").update(path.resolve(input.flowsPath)).digest("hex");
    }
  }
}

function priorApiReview(runtime: DesignRuntimeLike): ApiReview | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runtime.configDirAbs, "design", "tests.json"), "utf-8")
    ) as { apiReview?: unknown };
    const value = parsed.apiReview;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const change =
      record.change === "none" ||
      record.change === "new" ||
      record.change === "modified" ||
      record.change === "unknown"
        ? record.change
        : "unknown";
    const status =
      record.status === "not-applicable" ||
      record.status === "provided" ||
      record.status === "pending" ||
      record.status === "unknown"
        ? record.status
        : "unknown";
    return {
      change,
      status,
      apiSpec: typeof record.apiSpec === "string" ? record.apiSpec : null,
      apiSpecSha256: typeof record.apiSpecSha256 === "string" ? record.apiSpecSha256 : null,
      designFingerprint:
        typeof record.designFingerprint === "string" ? record.designFingerprint : null,
      carriedForward: record.carriedForward === true,
      designChanged: record.designChanged === true,
      updatedAt:
        typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function resolveApiSpec(
  runtime: DesignRuntimeLike,
  args: Pick<GenerateTestsArgs, "apiSpec" | "apiSpecPath">
): { spec: string | null; warning: string | null } {
  if (args.apiSpec !== undefined && args.apiSpecPath !== undefined) {
    throw new Error("apiSpec 与 apiSpecPath 互斥：只提供一种接口说明");
  }
  if (args.apiSpecPath !== undefined && args.apiSpecPath.trim() !== "") {
    const root = path.resolve(runtime.project.rootDir);
    const abs = path.resolve(root, args.apiSpecPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("apiSpecPath 必须位于项目根目录内");
    }
    let spec: string;
    try {
      spec = fs.readFileSync(abs, "utf-8");
    } catch (error) {
      throw new Error(`apiSpecPath 不可读：${errorMessage(error)}`);
    }
    if (Buffer.byteLength(spec, "utf8") > API_SPEC_MAX_BYTES) {
      throw new Error(`apiSpec 超过 ${API_SPEC_MAX_BYTES} 字节上限`);
    }
    return { spec, warning: null };
  }
  if (args.apiSpec !== undefined) {
    if (Buffer.byteLength(args.apiSpec, "utf8") > API_SPEC_MAX_BYTES) {
      throw new Error(`apiSpec 超过 ${API_SPEC_MAX_BYTES} 字节上限`);
    }
    return { spec: args.apiSpec, warning: null };
  }
  return { spec: null, warning: null };
}

/** 从自由文本 apiSpec 提取确定性线索：错误码/HTTP 路径/状态码（仅提示，不解析业务语义）。 */
export function apiSpecHints(spec: string): {
  codes: string[];
  paths: string[];
  statuses: string[];
} {
  const codes = [
    ...new Set(
      (spec.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? []).filter(
        (code) => !["HTTP", "HTTPS", "API", "REST", "JSON", "URL"].includes(code)
      )
    )
  ];
  const paths = [
    ...new Set(
      (spec.match(/(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s,，。;；]+)/g) ?? []).map(
        (entry) => entry.trim()
      )
    )
  ];
  const statuses = [...new Set(spec.match(/\b[1-5]\d{2}\b/g) ?? [])];
  return { codes, paths, statuses };
}

function apiSpecCatalogWarnings(configDirAbs: string, spec: string): DesignWarning[] {
  const hints = apiSpecHints(spec);
  const required = hints.codes.length > 0 ? hints.codes : hints.paths;
  if (required.length === 0) return [];
  const catalog = loadApiErrorCatalog(configDirAbs);
  const unmatched = required.filter(
    (hint) => ![...catalog.rules.values()].some((rule) => rule.match.test(hint))
  );
  if (catalog.rules.size > 0 && unmatched.length === 0) return [];
  const context = [
    hints.paths.length > 0 ? `路径 ${hints.paths.join("、")}` : null,
    hints.statuses.length > 0 ? `HTTP ${hints.statuses.join("、")}` : null
  ]
    .filter((entry): entry is string => entry !== null)
    .join("；");
  return [
    {
      code: catalog.rules.size === 0 ? "api-spec-error-codes-missing" : "api-spec-error-codes-gap",
      message:
        catalog.rules.size === 0
          ? `API 说明包含错误码/路径 ${required.join("、")}，但项目未配置 error-codes.json；运行期 api-errors 将无法归类，请补 .artemis/design/error-codes.json`
          : `API 说明中的错误码/路径 ${unmatched.join("、")} 在 error-codes.json 中无匹配规则；请补对应 match 规则`,
      details: [context].filter((entry) => entry !== "")
    }
  ];
}

export function resolveApiReview(
  runtime: DesignRuntimeLike,
  args: Pick<GenerateTestsArgs, "apiChange" | "apiSpec" | "apiSpecPath">,
  designFingerprint: string,
  now = new Date()
): { review: ApiReview; warnings: DesignWarning[] } {
  const { spec } = resolveApiSpec(runtime, args);
  const explicit =
    args.apiChange ?? (spec !== null && args.apiChange === undefined ? "new" : undefined);
  const prior = priorApiReview(runtime);
  const warnings: DesignWarning[] = [];
  const updatedAt = now.toISOString();
  if (explicit === "none") {
    return {
      review: {
        change: "none",
        status: "not-applicable",
        apiSpec: null,
        apiSpecSha256: null,
        designFingerprint,
        updatedAt
      },
      warnings
    };
  }
  if (explicit === "new" || explicit === "modified") {
    if (spec === null) {
      return {
        review: {
          change: explicit,
          status: "pending",
          apiSpec: null,
          apiSpecSha256: null,
          designFingerprint,
          updatedAt
        },
        warnings
      };
    }
    warnings.push(...apiSpecCatalogWarnings(runtime.configDirAbs, spec));
    return {
      review: {
        change: explicit,
        status: "provided",
        apiSpec: spec,
        apiSpecSha256: createHash("sha256").update(spec).digest("hex"),
        designFingerprint,
        updatedAt
      },
      warnings
    };
  }
  if (prior !== null) {
    const designChanged =
      prior.designFingerprint !== null && prior.designFingerprint !== designFingerprint;
    if (designChanged) {
      warnings.push({
        code: "apiReview-design-changed",
        message: "沿用上次 API 说明，但设计源指纹已变化；请复核接口说明是否仍适用"
      });
    } else if (prior.status === "provided") {
      warnings.push({
        code: "apiReview-carried-forward",
        message: "沿用上次 API 说明；请复核是否仍适用"
      });
    }
    if (prior.apiSpec !== null && prior.apiSpec.trim() !== "") {
      warnings.push(...apiSpecCatalogWarnings(runtime.configDirAbs, prior.apiSpec));
    }
    return {
      review: {
        ...prior,
        carriedForward: true,
        designChanged,
        designFingerprint,
        updatedAt
      },
      warnings
    };
  }
  return {
    review: {
      change: "unknown",
      status: "unknown",
      apiSpec: null,
      apiSpecSha256: null,
      designFingerprint,
      updatedAt
    },
    warnings
  };
}

export interface GenerateTestsDeps {
  /** pen 通道渲染注入（测试）。 */
  render?: (input: PenScreenRenderInput) => Promise<PenScreenRenderResult>;
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
  /** 渲染重试等待注入（测试）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 功能命名 LLM 注入（测试；缺省解析 active LLM）。 */
  chat?: ChatFn | null;
  /** 本请求的 Figma token（缺省回退 FIGMA_ACCESS_TOKEN；open 服务必须显式传）。 */
  figmaToken?: string | null;
  /** 归档时间戳注入（测试）。 */
  now?: () => Date;
}

interface CaseScreensResult {
  caseRefs: Map<string, string[]>;
  warnings: Array<{ code: string; message: string }>;
  summary: {
    channel: "figma" | "pen";
    dir: string;
    rendered: number;
    /** 复用已落盘 PNG 的屏数（不重新请求/渲染）。 */
    reused: number;
    skipped: number;
    skippedScreens: string[];
  } | null;
}

function screenshotEmbedWarning(
  markdown: string,
  refs: Map<string, string[]>
): DesignWarning | null {
  // renderMarkdown 每个用例最多嵌入 3 张图；期望值须按同一上限计算。
  const expected = [...refs.values()].reduce(
    (sum, list) => sum + Math.min(new Set(list).size, 8),
    0
  );
  if (expected === 0) return null;
  const actual = (markdown.match(/<img\s/gi) ?? []).length;
  if (actual >= expected) return null;
  return {
    code: SCREENSHOT_EMBED_MISMATCH,
    message: `截图嵌入不完整：映射 ${expected} 张，Markdown 实际 ${actual} 张`
  };
}

function screenCaptureWarnings(
  channelLabel: string,
  channelError: string | null,
  rendered: number,
  skipped: string[]
): Array<{ code: string; message: string }> {
  if (channelError !== null) {
    return [
      {
        code: SCREENSHOT_RENDER_UNAVAILABLE,
        message: `截图已跳过：${channelLabel} 渲染不可用（${channelError}）`
      }
    ];
  }
  if (rendered === 0 && skipped.length > 0) {
    return [
      { code: SCREENSHOT_RENDER_UNAVAILABLE, message: `截图已跳过：${channelLabel} 未产出渲染图` }
    ];
  }
  if (skipped.length > 0) {
    return [{ code: SCREENSHOT_SKIPPED, message: `截图降级：${skipped.length} 屏未产出渲染` }];
  }
  return [];
}

/** 按已落盘 PNG 分区：可复用的直接返回路径，缺失/损坏的交给渲染通道。 */
function partitionExistingScreens(
  ids: string[],
  targetDir: string
): { reused: Map<string, string>; missing: string[] } {
  const reused = new Map<string, string>();
  const missing: string[] = [];
  for (const id of ids) {
    const existing = existingScreenPath(targetDir, id);
    if (existing !== null) reused.set(id, existing);
    else missing.push(id);
  }
  return { reused, missing };
}

/** 按用例收集屏幕截图（design-screenshots T4）：flows 来源（fileKey/pen source）决定通道，
 * 屏幕名 → nodeId 映射后一次批量渲染；映射缺失/渲染失败逐级降级，不阻断。 */
async function captureCaseScreens(
  runtime: DesignRuntimeLike,
  input: {
    flowsPath: string;
    fromUrlFileKey: string | null;
    graph: FlowGraph;
    cases: GeneratedTest[];
    deps: GenerateTestsDeps;
    dotenv: Record<string, string>;
  }
): Promise<CaseScreensResult> {
  const warnings: Array<{ code: string; message: string }> = [];
  const meta =
    input.fromUrlFileKey !== null
      ? {
          fileKey: input.fromUrlFileKey,
          penPath: null as string | null,
          screenIdsByName: new Map(input.graph.screens.map((screen) => [screen.name, screen.id]))
        }
      : readFlowDocumentMeta(runtime.configDirAbs, { flowsPath: input.flowsPath });
  if (meta === null || (meta.fileKey === null && meta.penPath === null)) {
    warnings.push({
      code: SCREENSHOT_MAPPING_MISSING,
      message: "截图已跳过：flows 缺少来源信息（fileKey/pen source），无法映射屏幕截图"
    });
    return { caseRefs: new Map(), warnings, summary: null };
  }

  const perCaseIds = new Map<string, string[]>();
  const screenIds = new Set<string>();
  let unmappedCases = 0;
  for (const testCase of input.cases) {
    const ids: string[] = [];
    for (const name of testCase.screens) {
      const id = meta.screenIdsByName.get(name);
      if (id) {
        ids.push(id);
        screenIds.add(id);
      }
    }
    if (testCase.screens.length > 0 && ids.length === 0) unmappedCases += 1;
    perCaseIds.set(testCase.id, ids);
  }
  if (unmappedCases > 0) {
    warnings.push({
      code: SCREENSHOT_MAPPING_MISSING,
      message: `截图降级：${unmappedCases} 条用例无法映射屏幕（flows 屏幕名缺失）`
    });
  }
  if (screenIds.size === 0) return { caseRefs: new Map(), warnings, summary: null };
  const ids = [...screenIds];

  const designDirAbs = path.join(runtime.configDirAbs, "design");
  let imagePaths: Map<string, string>;
  let skipped: string[];
  let reusedCount = 0;
  let channel: "figma" | "pen";
  let dir: string;
  if (meta.fileKey !== null) {
    channel = "figma";
    const targetDir = figmaScreensDir(runtime.configDirAbs, meta.fileKey);
    const { reused, missing } = partitionExistingScreens(ids, targetDir);
    reusedCount = reused.size;
    const capture =
      missing.length > 0
        ? await captureFigmaScreens(meta.fileKey, missing, {
            sleep: input.deps.sleep,
            figmaToken: input.deps.figmaToken
          })
        : { pngById: new Map<string, Buffer>(), skipped: missing, channelError: null };
    imagePaths = new Map(reused);
    for (const [id, png] of capture.pngById) {
      const stored = storeScreenPng(targetDir, id, png);
      if (stored.status !== "invalid") imagePaths.set(id, stored.path);
    }
    skipped = ids.filter((id) => !imagePaths.has(id));
    dir = targetDir;
    warnings.push(...screenCaptureWarnings("Figma", capture.channelError, imagePaths.size, skipped));
  } else {
    channel = "pen";
    const target = path.resolve(runtime.project.rootDir, meta.penPath!);
    const targetDir = penScreensDir(runtime.configDirAbs, target);
    const { reused, missing } = partitionExistingScreens(ids, targetDir);
    reusedCount = reused.size;
    const capture =
      missing.length > 0
        ? await capturePenScreens({
            configDirAbs: runtime.configDirAbs,
            target,
            screenIds: missing,
            dotenv: input.dotenv,
            deps: { render: input.deps.render, exec: input.deps.exec, ensure: input.deps.ensure }
          })
        : { dir: targetDir, imagePaths: new Map<string, string>(), skipped: missing, channelError: null };
    imagePaths = new Map([...reused, ...capture.imagePaths]);
    skipped = ids.filter((id) => !imagePaths.has(id));
    dir = capture.dir;
    warnings.push(...screenCaptureWarnings("pen", capture.channelError, imagePaths.size, skipped));
  }

  const caseRefs = new Map<string, string[]>();
  for (const testCase of input.cases) {
    const refs: string[] = [];
    for (const id of perCaseIds.get(testCase.id) ?? []) {
      const file = imagePaths.get(id);
      if (file) refs.push(relativeScreenPath(designDirAbs, file));
    }
    caseRefs.set(testCase.id, refs);
  }
  return {
    caseRefs,
    warnings,
    summary: {
      channel,
      dir: relativeScreenPath(designDirAbs, dir),
      rendered: imagePaths.size,
      reused: reusedCount,
      skipped: skipped.length,
      skippedScreens: skipped
    }
  };
}

/** Load the frozen text→key mapping produced by figma_import_strings (M6b). */
function loadI18nKeys(runtime: DesignRuntimeLike): Map<string, string> {
  const stringsPath = path.join(runtime.configDirAbs, "design", "strings.json");
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(stringsPath, "utf-8")) as {
      entries?: Array<{ canonicalText?: unknown; key?: unknown; lifecycle?: unknown }>;
    };
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.canonicalText !== "string" || typeof entry.key !== "string") continue;
      if (entry.lifecycle === "unused") continue;
      if (!map.has(entry.canonicalText)) map.set(entry.canonicalText, entry.key);
    }
  } catch {
    /* no strings.json yet: literal-only descriptions */
  }
  return map;
}

async function resolveNamingChat(runtime: DesignRuntimeLike): Promise<ChatFn | null> {
  if (!runtime.activeEntry) return null;
  const entry = await runtime.activeEntry();
  if (!entry || !entry.model || !entry.baseUrl || !entry.apiKey) return null;
  return makeChatFn({ baseUrl: entry.baseUrl, apiKey: entry.apiKey, model: entry.model });
}

async function resolveDesignName(
  runtime: DesignRuntimeLike,
  figmaToken?: string | null
): Promise<string | null> {
  const meta = readFlowDocumentMeta(runtime.configDirAbs, {
    flowsPath: designFlowsPath(runtime)
  });
  if (!meta) return null;
  if (meta.penPath) {
    const name = path.basename(meta.penPath, ".pen");
    return name !== "" ? name : null;
  }
  if (!meta.fileKey) return null;
  try {
    const file = (await fetchFile(meta.fileKey, 1, figmaToken ?? undefined)) as { name?: string };
    return typeof file.name === "string" && file.name.trim() !== "" ? file.name : null;
  } catch {
    return null;
  }
}

function parseFlowFeatures(raw: unknown): PriorFeature[] {
  if (!Array.isArray(raw)) return [];
  const features: PriorFeature[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.trim() === "") continue;
    if (typeof record.name !== "string" || record.name.trim() === "") continue;
    const screens = Array.isArray(record.screens)
      ? record.screens.filter((screen): screen is string => typeof screen === "string")
      : [];
    if (screens.length === 0) continue;
    features.push({ key: record.key, name: record.name, screens });
  }
  return features;
}

function loadFlowFeatures(flowsPath: string | null): PriorFeature[] {
  if (flowsPath === null) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as { features?: unknown };
    return parseFlowFeatures(parsed.features);
  } catch {
    return [];
  }
}

function persistFlowFeatures(
  flowsPath: string,
  groups: FeatureGroup[]
): FeatureWarning | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as Record<string, unknown>;
    const next = groups.map((group) => ({
      key: group.key,
      name: group.name,
      screens: [...group.screens]
    }));
    const prior = parseFlowFeatures(parsed.features);
    const normalizedScreens = (screens: string[]): string[] => [...screens].sort();
    const same = (a: PriorFeature[], b: PriorFeature[]): boolean =>
      a.length === b.length &&
      a.every((feature) => {
        const other = b.find((entry) => entry.key === feature.key);
        return (
          other !== undefined &&
          other.name === feature.name &&
          JSON.stringify(normalizedScreens(other.screens)) ===
            JSON.stringify(normalizedScreens(feature.screens))
        );
      });
    if (same(prior, next)) return null;
    parsed.features = next;
    writeFileAtomic(flowsPath, JSON.stringify(parsed, null, 2) + "\n");
    return null;
  } catch (error) {
    return {
      code: "feature-persist-failed",
      message: `功能身份写回 flows.json 失败（不影响生成）：${errorMessage(error)}`
    };
  }
}

async function loadPriorFeatures(
  runtime: DesignRuntimeLike,
  flowsPath: string | null = null
): Promise<{ features: PriorFeature[]; warnings: FeatureWarning[] }> {
  const flowFeatures = loadFlowFeatures(flowsPath);
  try {
    const records = await runtime.store.listCaseSets(runtime.project.rootDir);
    const features: PriorFeature[] = [...flowFeatures];
    const keys = new Set(features.map((feature) => feature.key));
    for (const record of records) {
      if (record.source.startsWith("imported:")) continue;
      for (const feature of record.features) {
        if (keys.has(feature.key)) continue;
        keys.add(feature.key);
        features.push({ key: feature.key, name: feature.name, screens: [...feature.screens] });
      }
    }
    return { features, warnings: [] };
  } catch (error) {
    return {
      features: flowFeatures,
      warnings: [
        {
          code: "case-set-registry-unavailable",
          message: `用例集登记不可用（功能身份继承跳过）：${errorMessage(error)}`
        }
      ]
    };
  }
}

async function assignFeatures(
  runtime: DesignRuntimeLike,
  graph: FlowGraph,
  cases: GeneratedTest[],
  deps: GenerateTestsDeps,
  designNameHint: string | null,
  flowsPath: string | null = null
): Promise<{ groups: FeatureGroup[]; warnings: FeatureWarning[]; designName: string | null }> {
  const split = splitFeatures({
    screens: graph.screens.map((screen) => ({
      name: screen.name,
      ...(screen.page ? { page: screen.page } : {})
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from.name, to: edge.to ? edge.to.name : null }))
  });
  const designName = designNameHint ?? (await resolveDesignName(runtime, deps.figmaToken));
  for (const group of split) {
    if (group.signal === "fallback" && group.candidateName === null && designName) {
      group.candidateName = designName;
    }
  }
  const named = await nameFeatures(split, { chat: deps.chat ?? (await resolveNamingChat(runtime)) });
  const prior = await loadPriorFeatures(runtime, flowsPath);
  const identity = applyIdentity(named.groups, prior.features);
  for (const testCase of cases) {
    testCase.feature = assignCaseFeature(testCase.screens, identity.groups) ?? undefined;
  }
  return {
    groups: identity.groups,
    warnings: [...named.warnings, ...prior.warnings, ...identity.warnings],
    designName
  };
}

export interface EnrichCasesInput {
  groups: FeatureGroup[];
  graph: FlowGraph;
  data: Map<string, string[]>;
  questions: Map<string, string[]>;
  section: Map<string, string>;
}

function collectScreenValues(
  screens: string[],
  source: Map<string, string[]>,
  limit: number
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const screen of screens) {
    for (const value of source.get(screen) ?? []) {
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function sharedScreenCount(left: GeneratedTest, right: GeneratedTest): number {
  const screens = new Set(left.screens);
  let count = 0;
  for (const screen of right.screens) {
    if (screens.has(screen)) count += 1;
  }
  return count;
}

/** 把带 screens/caseIds 作用域的设计警告挂到命中的用例；无作用域警告保持全局。 */
export function attachDesignWarningsToCases(
  cases: GeneratedTest[],
  warnings: DesignWarning[]
): void {
  for (const testCase of cases) {
    const matched = warnings.filter((warning) => {
      const scope = warning.scope;
      if (scope === undefined) return false;
      if (scope.caseIds !== undefined && scope.caseIds.includes(testCase.id)) return true;
      return (scope.screens ?? []).some((screen) => testCase.screens.includes(screen));
    });
    if (matched.length > 0) testCase.designWarnings = matched;
  }
}

/** 同一产物范围内的关联用例：同 module 或共享至少 1 屏；共享屏数降序 → displayId 升序，取前 3。 */
export function assignRelatedCases(cases: GeneratedTest[]): void {
  for (const testCase of cases) {
    const module = testCase.module ?? "未分组";
    const related = cases
      .filter((candidate) => candidate !== testCase)
      .map((candidate) => ({
        displayId: candidate.displayId?.trim() ?? "",
        shared: sharedScreenCount(testCase, candidate),
        sameModule: (candidate.module ?? "未分组") === module
      }))
      .filter((entry) => entry.displayId !== "" && (entry.sameModule || entry.shared > 0))
      .sort(
        (left, right) =>
          right.shared - left.shared || left.displayId.localeCompare(right.displayId)
      )
      .slice(0, 3)
      .map((entry) => entry.displayId);
    testCase.relatedCases = [...new Set(related)];
  }
}

const MAX_VARIANT_CLONES = 20;

function uniqueStrings(values: string[], limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = value.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function appendVariantTaskDesc(taskDesc: string, variant: AcceptanceVariant): string {
  const block = [`【变体：${variant.label}】`];
  for (const item of variant.data) block.push(`- 数据：${item}`);
  for (const item of variant.expected) block.push(`- 预期：${item}`);
  if (block.length === 1) block.push("- 无额外数据/预期");
  const marker = "【AOS-EXPECT】";
  const index = taskDesc.indexOf(marker);
  const text = block.join("\n");
  return index === -1
    ? `${taskDesc}\n${text}`
    : `${taskDesc.slice(0, index)}${text}\n${taskDesc.slice(index)}`;
}

function cloneVariant(
  base: GeneratedTest,
  variant: AcceptanceVariant,
  existing: GeneratedTest[]
): GeneratedTest {
  const variantKey = JSON.stringify([variant.screen, variant.label]);
  const semanticId = `sem-${createHash("sha256")
    .update(`${base.semanticId ?? base.id}|variant:${variantKey}`)
    .digest("hex")
    .slice(0, 12)}`;
  const used = new Set(
    existing
      .map((testCase) => testCase.displayId)
      .filter((value): value is string => typeof value === "string" && value !== "")
  );
  const code = semanticId.slice(-6);
  let displayId = `TC_${code}`;
  let suffix = 2;
  while (used.has(displayId)) {
    displayId = `TC_${code}-${suffix}`;
    suffix += 1;
  }
  return {
    ...base,
    id: caseIdFor(`${base.name} [variant:${variantKey}]`, base.screens, base.steps),
    semanticId,
    displayId,
    name: `${base.name}（变体：${variant.label}）`,
    displayName: `${base.displayName ?? base.name}（变体：${variant.label}）`,
    testData: uniqueStrings([...(base.testData ?? []), ...variant.data], 12),
    relatedCases: [],
    variant: {
      group: variant.screen,
      label: variant.label,
      ...(variant.expected.length > 0 ? { expected: [...variant.expected] } : {})
    },
    taskDesc: appendVariantTaskDesc(base.taskDesc, variant)
  };
}

/** 按 acceptance.variants 克隆命中屏幕的基准用例；不重写 steps/expectations。 */
export function applyAcceptanceVariants(
  cases: GeneratedTest[],
  variants: AcceptanceVariant[],
  warnings: DesignWarning[]
): void {
  if (variants.length === 0) return;
  const clones: GeneratedTest[] = [];
  for (const variant of variants) {
    const bases = cases.filter((testCase) => testCase.screens.includes(variant.screen));
    if (bases.length === 0) {
      warnings.push({
        code: "variant-screen-unmatched",
        message: `acceptance.variants 的屏幕「${variant.screen}」未命中任何用例（${variant.label}）`,
        scope: { screens: [variant.screen] }
      });
      continue;
    }
    if (bases.length > MAX_VARIANT_CLONES) {
      warnings.push({
        code: "variant-clone-truncated",
        message: `变体「${variant.label}」命中 ${bases.length} 条用例，仅克隆前 ${MAX_VARIANT_CLONES} 条`,
        scope: { screens: [variant.screen] }
      });
    }
    for (const base of bases.slice(0, MAX_VARIANT_CLONES)) {
      clones.push(cloneVariant(base, variant, [...cases, ...clones]));
    }
  }
  cases.push(...clones);
}

/** 生成后按功能段与人工 acceptance 补齐展示字段：displayId/module/section/
 * testData/openQuestions/designRefs。放在 assignFeatures 之后，因为 module 依赖功能命名。 */
export function enrichGeneratedCases(cases: GeneratedTest[], input: EnrichCasesInput): void {
  const featureNames = new Map(input.groups.map((group) => [group.key, group.name]));
  const screenByName = new Map(input.graph.screens.map((screen) => [screen.name, screen]));
  const used = new Map<string, number>();
  for (const testCase of cases) {
    const base = `TC_${(testCase.semanticId ?? testCase.id).replace(/^(case-|sem-)/, "").slice(-6)}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    testCase.displayId = count === 1 ? base : `${base}-${count}`;
    testCase.module =
      testCase.feature !== undefined ? featureNames.get(testCase.feature) ?? "未分组" : "未分组";
    const entry = testCase.preflight?.screen ?? testCase.startScreen ?? testCase.screens[0] ?? "";
    const section = input.section.get(entry) ?? entry;
    testCase.section = section.trim() === "" ? "未指定" : section;
    testCase.testData = collectScreenValues(testCase.screens, input.data, 12);
    testCase.openQuestions = collectScreenValues(testCase.screens, input.questions, 10);
    const route = screenByName.get(entry)?.suggestedRoute?.trim() ?? "";
    testCase.designRefs = {
      screens: [...testCase.screens],
      nodeIds: testCase.screens.map((screen) => screenByName.get(screen)?.id ?? ""),
      ...(route !== "" ? { route } : {})
    };
  }
}

export async function updateTestsApiReview(
  runtime: DesignRuntimeLike,
  args: Pick<GenerateTestsArgs, "apiChange" | "apiSpec" | "apiSpecPath">
): Promise<{ review: ApiReview; updatedArtifacts: string[]; warnings: DesignWarning[] }> {
  const testsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  if (!fs.existsSync(testsPath)) {
    throw new Error(`未找到 ${testsPath}：先运行生成，再补 API 说明`);
  }
  const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as Record<string, unknown>;
  const prior =
    parsed.apiReview && typeof parsed.apiReview === "object" && !Array.isArray(parsed.apiReview)
      ? (parsed.apiReview as Record<string, unknown>)
      : null;
  const priorFingerprint =
    prior !== null && typeof prior.designFingerprint === "string"
      ? prior.designFingerprint
      : null;
  const fingerprint =
    priorFingerprint ??
    designFingerprintFor(runtime, {
      flowsPath: path.join(runtime.configDirAbs, "design", "flows.json")
    });
  const { review, warnings } = resolveApiReview(runtime, args, fingerprint);
  parsed.apiReview = review;
  if (typeof parsed.generatedAt !== "string") parsed.generatedAt = review.updatedAt;
  writeFileAtomic(testsPath, JSON.stringify(parsed, null, 2) + "\n");
  const updatedArtifacts = [testsPath];

  const markdownPath = path.join(runtime.configDirAbs, "design", "tests.md");
  if (fs.existsSync(markdownPath)) {
    writeFileAtomic(
      markdownPath,
      upsertApiReviewMarkdown(fs.readFileSync(markdownPath, "utf-8"), review)
    );
    updatedArtifacts.push(markdownPath);
  }
  const excelPath = path.join(runtime.configDirAbs, "design", "tests.xlsx");
  if (await updateWorkbookApiReview(excelPath, review)) updatedArtifacts.push(excelPath);

  const setsDir = caseSetsDir(runtime.configDirAbs);
  try {
    for (const name of fs.readdirSync(setsDir)) {
      if (!name.endsWith(".json")) continue;
      const jsonPath = path.join(setsDir, name);
      let caseSet: Record<string, unknown>;
      try {
        caseSet = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const savedTo = caseSet.savedTo;
      const savedJson =
        savedTo && typeof savedTo === "object" && !Array.isArray(savedTo)
          ? (savedTo as Record<string, unknown>).json
          : null;
      if (typeof savedJson !== "string" || path.resolve(savedJson) !== testsPath) continue;
      caseSet.apiReview = review;
      writeFileAtomic(jsonPath, JSON.stringify(caseSet, null, 2) + "\n");
      updatedArtifacts.push(jsonPath);
      const stem = name.slice(0, -".json".length);
      const setMd = path.join(setsDir, `${stem}.md`);
      if (fs.existsSync(setMd)) {
        writeFileAtomic(setMd, upsertApiReviewMarkdown(fs.readFileSync(setMd, "utf-8"), review));
        updatedArtifacts.push(setMd);
      }
      const setXlsx = path.join(setsDir, `${stem}.xlsx`);
      if (await updateWorkbookApiReview(setXlsx, review)) updatedArtifacts.push(setXlsx);
    }
  } catch {
    /* case-set 目录不可读：live 三件套已更新 */
  }
  return { review, updatedArtifacts, warnings };
}

export async function figmaGenerateTests(
  runtime: DesignRuntimeLike,
  args: GenerateTestsArgs,
  deps: GenerateTestsDeps = {}
): Promise<CallToolResult> {
  try {
    const defaultFlowsPath = designFlowsPath(runtime);
    const flowsPath = args.flowsPath
      ? path.resolve(runtime.project.rootDir, args.flowsPath)
      : defaultFlowsPath;

    let graph: FlowGraph;
    let source: string;
    let fromUrlFileKey: string | null = null;
    let designNameHint: string | null = null;
    let designSourceWarnings: DesignWarning[] = [];
    let designWarningSource: "flows" | "generated" = "flows";
    let designWarningsSnapshotAt: string | null = null;
    if (args.url) {
      const { fileKey } = parseFigmaUrl(args.url);
      fromUrlFileKey = fileKey;
      const file = (await fetchFile(fileKey, undefined, deps.figmaToken ?? undefined)) as { name?: string; document?: FigmaNode };
      if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
      graph = buildFlowGraph(file.document);
      designSourceWarnings = flowGraphWarnings(graph);
      designWarningSource = "generated";
      designNameHint = typeof file.name === "string" && file.name.trim() !== "" ? file.name : null;
      source = `figma:${fileKey}${file.name ? ` (${file.name})` : ""}`;
    } else {
      if (!fs.existsSync(flowsPath)) {
        throw new Error(`未找到 ${flowsPath}：先运行 figma_extract_flows（或直接传 url）`);
      }
      const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as FlowGraph & {
        warnings?: unknown;
      };
      if (!Array.isArray(parsed.screens) || !Array.isArray(parsed.edges)) {
        throw new Error(`${flowsPath} 格式不正确（缺少 screens/edges）`);
      }
      if (path.resolve(flowsPath) === path.resolve(defaultFlowsPath)) {
        const read = readFlowsWarnings(runtime.configDirAbs);
        designSourceWarnings = read.warnings;
        designWarningsSnapshotAt = read.snapshotAt;
      } else {
        designSourceWarnings = normalizeWarnings(parsed.warnings);
        designWarningsSnapshotAt = fs.statSync(flowsPath).mtime.toISOString();
      }
      graph = normalizeFlowGraph(parsed);
      source = flowsPath;
    }

    const designFingerprint = designFingerprintFor(runtime, {
      flowsPath,
      ...(args.url ? { url: args.url } : {}),
      graph
    });
    const flowsFingerprint = flowGraphFingerprint(graph);

    const reconciliationApplied = applyReconciliationToGraph(
      graph,
      loadReconciliation(runtime.configDirAbs)
    );
    const acceptance = loadAcceptanceDetails(runtime);
    graph = applyAcceptanceOverrides(reconciliationApplied.graph, acceptance.screens);

    const generationRef: { stats: LinearizeStats | null } = { stats: null };
    const cases = generateTestCases(graph, {
      maxFlows: args.maxFlows ?? 10,
      maxDepth: args.maxDepth,
      i18nKeys: loadI18nKeys(runtime),
      identifiers: loadIdentifierSuggestions(runtime, graph),
      testDataByScreen: acceptance.data,
      questionsByScreen: acceptance.questions,
      sectionByScreen: acceptance.section,
      onStats: (stats) => {
        generationRef.stats = stats;
      }
    });
    const generation = generationRef.stats;
    const generatedAt = new Date().toISOString();
    const apiReviewResult = resolveApiReview(runtime, args, designFingerprint, new Date(generatedAt));
    const apiReview = apiReviewResult.review;
    const apiReviewWarnings = apiReviewResult.warnings;
    const coverage = computeFlowCoverage(graph, cases, generation);
    if (args.requireFullCoverage === true && !coverage.complete) {
      const reasons: string[] = [];
      if (coverage.uncoveredScreens.length > 0) {
        reasons.push(`未硬覆盖屏幕：${coverage.uncoveredScreens.join("、")}`);
      }
      if (coverage.uncoveredEdges.length > 0) {
        reasons.push(`未硬覆盖跳转：${coverage.uncoveredEdges.join("、")}`);
      }
      if (coverage.truncated) {
        reasons.push("路径探索被截断（maxFlows 上限或深度限制），可能有流程被丢弃");
      }
      if (!coverage.explore.complete) {
        reasons.push(
          `探索覆盖缺口（inferred，仅报告）：屏幕 ${coverage.explore.uncoveredScreens.length} · 跳转 ${coverage.explore.uncoveredEdges.length}`
        );
      }
      throw new Error(
        `流程覆盖不完整，未落盘：${reasons.join("；")}。可提高 maxFlows、补原型连线；` +
          "或去掉 requireFullCoverage 仅生成并查看 coverage。"
      );
    }
    const featureAssignment = await assignFeatures(
      runtime,
      graph,
      cases,
      deps,
      designNameHint,
      args.url ? null : flowsPath
    );
    if (args.save !== false && !args.url && fs.existsSync(flowsPath)) {
      const persistWarning = persistFlowFeatures(flowsPath, featureAssignment.groups);
      if (persistWarning !== null) featureAssignment.warnings.push(persistWarning);
    }
    enrichGeneratedCases(cases, {
      groups: featureAssignment.groups,
      graph,
      data: acceptance.data,
      questions: acceptance.questions,
      section: acceptance.section
    });
    applyAcceptanceVariants(cases, acceptance.variants, acceptance.warnings);
    assignRelatedCases(cases);
    const counts = { cases: cases.length, screens: graph.screens.length, edges: graph.edges.length };
    const featurePayload = featureAssignment.groups.map((group) => ({
      key: group.key,
      name: group.name,
      screens: [...group.screens],
      caseIds: cases
        .filter((testCase) => testCase.feature === group.key)
        .map((testCase) => testCase.id)
    }));
    const caseDefectFeedback = await collectCaseDefectFeedback(runtime);
    const featureKeys = new Set(featurePayload.map((entry) => entry.key));
    const matchedFeedback = (caseDefectFeedback?.byFeature ?? []).filter((entry) =>
      featureKeys.has(entry.featureKey)
    );
    const feedbackWarning: FeatureWarning | null =
      caseDefectFeedback === null
        ? {
            code: "case-defect-feedback-unavailable",
            message: "案例问题反馈读取失败（跳过；不影响生成）"
          }
        : null;
    const splitHint =
      generation && generation.depthSplits > 0
        ? `本次有 ${generation.depthSplits} 条用例受 maxDepth=${generation.maxDepth} 限制从上一段终点接续（首尾相接）；如需更长的单条连续用例，请调大 maxDepth。`
        : "";
    const payload: Record<string, unknown> = {
      ok: true,
      schemaVersion: 2,
      source,
      generatedAt,
      designFingerprint,
      flowsFingerprint,
      reconciliationFingerprint: optionalFileFingerprint(
        path.join(runtime.configDirAbs, "design", "reconciliation.json")
      ),
      apiReview,
      ...(apiReview.status === "pending"
        ? { apiReviewNextAction: "provide-api-spec" }
        : apiReview.status === "unknown"
          ? { apiReviewNextAction: "confirm-api-change" }
          : {}),
      counts: { flows: counts.cases, screens: counts.screens, edges: counts.edges },
      summary: summarizeCases(cases),
      generation,
      coverage,
      ...(reconciliationApplied.upgradedEdges +
        reconciliationApplied.confirmedEdges +
        reconciliationApplied.rejectedEdges >
      0
        ? {
            reconciliation: {
              ...(reconciliationApplied.upgradedEdges > 0
                ? { upgradedEdges: reconciliationApplied.upgradedEdges }
                : {}),
              ...(reconciliationApplied.confirmedEdges > 0
                ? { confirmedEdges: reconciliationApplied.confirmedEdges }
                : {}),
              ...(reconciliationApplied.rejectedEdges > 0
                ? { rejectedEdges: reconciliationApplied.rejectedEdges }
                : {})
            }
          }
        : {}),
      flows: cases,
      features: featurePayload,
      ...(matchedFeedback.length > 0
        ? {
            feedback: {
              caseDefects: {
                total: matchedFeedback.reduce((sum, entry) => sum + entry.count, 0),
                byFeature: matchedFeedback
              }
            }
          }
        : {}),
      ...(featureAssignment.warnings.length > 0 || feedbackWarning !== null
        ? {
            warnings: [
              ...featureAssignment.warnings,
              ...(feedbackWarning !== null ? [feedbackWarning] : [])
            ]
          }
        : {}),
      hint:
        "用 mobile_run_task 执行 flows[].taskDesc；失败步骤可用 compare_design_and_device 做视觉断言；" +
        "若已跑过 figma_import_strings，步骤中会附带 i18n key（原文仅在 source locale 兜底）；" +
        "coverage 分硬/探索两类：complete 只按硬覆盖判定（inferred 边不虚高门禁），explore 单独报告" +
        "（requireFullCoverage:true 硬覆盖不完整即不落盘）。" +
        splitHint
    };
    /** 设计警告快照在 tests.json 落盘前定稿：登记期警告（用例集登记失败）晚于落盘，
     * 重写 tests.json 会改变已登记指纹，故只留在 `warnings`，不进入该快照。 */
    const applyDesignWarnings = (): DesignWarning[] => {
      const merged = mergeWarnings([
        { source: designWarningSource, warnings: designSourceWarnings },
        {
          source: "generated",
          warnings: [
            ...acceptance.warnings,
            ...apiReviewWarnings,
            ...(Array.isArray(payload.warnings) ? (payload.warnings as DesignWarning[]) : [])
          ]
        }
      ]);
      if (merged.warnings.length > 0) payload.warnings = merged.warnings;
      payload.designWarnings = merged.warnings;
      payload.designWarningsSummary = summarizeWarnings(merged.warnings, {
        available: true,
        bySource: merged.bySource,
        ...(designWarningsSnapshotAt !== null ? { snapshotAt: designWarningsSnapshotAt } : {})
      });
      return merged.warnings;
    };

    if (args.save !== false) {
      const jsonPath = path.join(runtime.configDirAbs, "design", "tests.json");
      const markdownPath = path.join(runtime.configDirAbs, "design", "tests.md");
      const excelPath = args.excelPath
        ? path.resolve(runtime.project.rootDir, args.excelPath)
        : path.join(runtime.configDirAbs, "design", "tests.xlsx");
      const templatePath = args.excelTemplate
        ? path.resolve(runtime.project.rootDir, args.excelTemplate)
        : undefined;
      const artifacts = args.saveArtifacts ?? {};
      const wantMarkdown = artifacts.markdown !== false;
      const wantXlsx = artifacts.xlsx !== false;
      const wantCaseSets = artifacts.caseSets !== false;

      const dotenv = runtime.project.dotenvValues ?? {};
      const wantScreens =
        (wantMarkdown || wantCaseSets) && screensEnabledFrom({ ...process.env, ...dotenv }, args.screens);
      if (!wantScreens && (wantMarkdown || wantXlsx)) {
        const priorWarnings = Array.isArray(payload.warnings)
          ? (payload.warnings as DesignWarning[])
          : [];
        payload.warnings = [
          ...priorWarnings,
          {
            code: SCREENSHOT_DISABLED,
            message: "截图已关闭（screens:false 或 AOS_SCREENS=0）：tests.md/xlsx 不含设计图"
          }
        ];
      }
      let caseScreens: CaseScreensResult | null = null;
      if (wantScreens) {
        try {
          caseScreens = await captureCaseScreens(runtime, {
            flowsPath,
            fromUrlFileKey,
            graph,
            cases,
            deps,
            dotenv
          });
        } catch (error) {
          caseScreens = {
            caseRefs: new Map(),
            warnings: [
              {
                code: SCREENSHOT_RENDER_UNAVAILABLE,
                message: `截图已跳过：渲染失败（${errorMessage(error)}）`
              }
            ],
            summary: null
          };
        }
        const priorWarnings = Array.isArray(payload.warnings)
          ? (payload.warnings as Array<{ code: string; message: string }>)
          : [];
        payload.warnings = [...priorWarnings, ...caseScreens.warnings];
        if (caseScreens.summary) payload.screenshots = caseScreens.summary;
      }

      const designWarnings = applyDesignWarnings();
      attachDesignWarningsToCases(cases, designWarnings);
      let excelBuffer: Buffer | null = null;
      if (wantXlsx) {
        excelBuffer = await renderTestsWorkbook(
          cases,
          {
            source,
            generatedAt,
            counts,
            summary: summarizeCases(cases),
            coverage,
            warnings: designWarnings.length,
            apiReview
          },
          { templatePath }
        );
      }
      if (wantMarkdown) {
        const markdown = renderMarkdown(cases, { source, generatedAt }, {
          images: caseScreens?.caseRefs ?? new Map(),
          ...(matchedFeedback.length > 0 ? { feedback: { byFeature: matchedFeedback } } : {}),
          designWarnings,
          apiReview
        });
        const embedWarning = screenshotEmbedWarning(markdown, caseScreens?.caseRefs ?? new Map());
        if (embedWarning !== null && !designWarnings.some((entry) => entry.code === embedWarning.code)) {
          designWarnings.push(embedWarning);
          const priorWarnings = Array.isArray(payload.warnings)
            ? (payload.warnings as DesignWarning[])
            : [];
          payload.warnings = [...priorWarnings, embedWarning];
          payload.designWarnings = designWarnings;
        }
        writeFileAtomic(markdownPath, markdown);
      }
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      if (excelBuffer !== null) writeFileAtomic(excelPath, excelBuffer);
      payload.savedTo = {
        json: jsonPath,
        ...(wantMarkdown ? { markdown: markdownPath } : {}),
        ...(wantXlsx ? { xlsx: excelPath } : {})
      };
      if (wantXlsx && templatePath) payload.excel = { template: templatePath };

      if (wantCaseSets) {
        const caseSetsBase = caseSetsDir(runtime.configDirAbs);
        const taken = new Set<string>();
        try {
          for (const name of fs.readdirSync(caseSetsBase)) {
            if (name.endsWith(".json")) taken.add(name.slice(0, -".json".length));
          }
        } catch {
          /* 目录不存在：全新 */
        }
        const stampNow = deps.now ? deps.now() : new Date();
        const caseSetEntries: Array<{ feature: string; json: string; md: string; xlsx: string }> = [];
        const registrationFeatures: Array<{
          key: string;
          name: string;
          caseCount: number;
          screens: string[];
          jsonPath: string;
          mdPath: string;
          xlsxPath: string;
        }> = [];
        for (const group of featureAssignment.groups) {
          const subset = cases.filter((testCase) => testCase.feature === group.key);
          if (subset.length === 0) continue;
          const subsetView = subset.map((testCase) => ({ ...testCase }));
          assignRelatedCases(subsetView);
          const stem = caseSetStem(group.name, stampNow, taken);
          taken.add(stem);
          const subsetFeedback = matchedFeedback.filter((entry) => entry.featureKey === group.key);
          const subsetCoverage = computeFlowCoverage(graph, subset);
          const saved = await saveCaseSetFiles(caseSetsBase, stem, {
            json:
              JSON.stringify(
                {
                  ...payload,
                  ...(subsetFeedback.length > 0
                    ? {
                        feedback: {
                          caseDefects: {
                            total: subsetFeedback.reduce((sum, entry) => sum + entry.count, 0),
                            byFeature: subsetFeedback
                          }
                        }
                      }
                    : { feedback: undefined }),
                  counts: { flows: subsetView.length, screens: counts.screens, edges: counts.edges },
                  summary: summarizeCases(subsetView),
                  coverage: subsetCoverage,
                  features: featurePayload.filter((entry) => entry.key === group.key),
                  flows: subsetView
                },
                null,
                2
              ) + "\n",
            markdown: renderMarkdown(subsetView, { source, generatedAt }, {
              images: caseScreens?.caseRefs ?? new Map(),
              ...(subsetFeedback.length > 0 ? { feedback: { byFeature: subsetFeedback } } : {}),
              designWarnings,
              apiReview
            }),
            xlsx: await renderTestsWorkbook(
              subsetView,
              {
                source,
                generatedAt,
                counts: { cases: subsetView.length, screens: counts.screens, edges: counts.edges },
                summary: summarizeCases(subsetView),
                coverage: subsetCoverage,
                warnings: designWarnings.length,
                apiReview
              },
              { templatePath }
            )
          });
          caseSetEntries.push({
            feature: group.name,
            json: saved.jsonPath,
            md: saved.mdPath,
            xlsx: saved.xlsxPath
          });
          registrationFeatures.push({
            key: group.key,
            name: group.name,
            caseCount: subset.length,
            screens: [...group.screens],
            jsonPath: saved.jsonPath,
            mdPath: saved.mdPath,
            xlsxPath: saved.xlsxPath
          });
        }
        if (caseSetEntries.length > 0) {
          (payload.savedTo as Record<string, unknown>).caseSets = caseSetEntries;
          try {
            const fingerprint = testsFingerprint(jsonPath);
            await runtime.store.recordCaseSet({
              rootPath: runtime.project.rootDir,
              source,
              designName: featureAssignment.designName,
              fingerprint: fingerprint.sha256,
              basename: path.basename(jsonPath, ".json"),
              features: registrationFeatures
            });
          } catch (error) {
            const current = Array.isArray(payload.warnings)
              ? (payload.warnings as FeatureWarning[])
              : [];
            payload.warnings = [
              ...current,
              {
                code: "case-set-registration-failed",
                message: `用例集登记失败（本地归档已写入）：${errorMessage(error)}`
              }
            ];
          }
        }
      }
    }

    if (args.save === false) applyDesignWarnings();

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: `测试用例生成失败: ${errorMessage(error)}` }, null, 2)
        }
      ],
      isError: true
    };
  }
}
