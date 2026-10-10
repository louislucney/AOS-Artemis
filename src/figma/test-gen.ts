import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { computeClassifiedCoverage, type CoverageClass } from "./coverage.js";
import {
  buildFlowGraph,
  normalizeFlowGraph,
  normalizeFlowHints,
  type FlowEdge,
  type FlowGraph
} from "./flows.js";
import { deriveCasePreconditions } from "./preconditions.js";
import { applyReconciliationToGraph, loadReconciliation } from "./reconciliation.js";
import { canonicalizePlaceholders, normalizedText } from "./strings.js";
import { renderTestsWorkbook } from "./test-xlsx.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
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
  steps: string[];
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
  /** Per-step destination expectations, aligned with `steps` (deterministic audit). */
  expectations: StepExpectation[];
  /** Deterministic start-state check: the executor verifies the journey entry screen. */
  preflight: CasePreflight;
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
  const stack: ExploreNode[] = startIds.map((id) => ({
    screenId: id,
    path: [],
    prefix: [],
    visited: new Set([id]),
    continuation: false
  }));
  while (stack.length > 0 && flows.length < maxFlows * 4 && guard < 500) {
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
   * 直到没有候选能新增屏幕/跳转覆盖为止——避免"探索序前 N 条"产生大量共享前缀的短用例。 */
  const candidates = deduped.map((flow) => ({
    flow,
    signature: signatureOf(flow),
    screens: screensOf(flow),
    pairs: pairsOf(flow)
  }));
  const coveredScreens = new Set<string>();
  const coveredPairs = new Set<string>();
  const gainOf = (candidate: (typeof candidates)[number]): number =>
    candidate.screens.filter((screen) => !coveredScreens.has(screen)).length +
    candidate.pairs.filter((pair) => !coveredPairs.has(pair)).length;
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
  }

  const explorationStopped = guard >= 500 || flows.length >= maxFlows * 4;
  const truncatedAtCap =
    kept.length >= maxFlows && remaining.some((candidate) => gainOf(candidate) > 0);
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
      truncated: explorationStopped || truncatedAtCap
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
  const hints = kind === "assert" ? runtimeHintTexts(screen?.textHints).slice(0, 3) : [];
  return { screen: edge.to.name, hints, provenance, confidence, kind };
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

function stepFor(graph: FlowGraph, edge: FlowEdge, i18nKeys?: Map<string, string>): string {
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
    return "探索未知跳转（来源未确认）：记录实际页面变化；不参与断言判定";
  }
  const target = edge.to ? `「${edge.to.name}」` : null;
  const assertion = assertionFor(graph, edge);
  const elementHint = runtimeHintTexts(edge.textHints)[0];
  const label = elementHint ? `「${elementHint}」` : `「${edge.element.name}」`;
  const i18nKey = lookupI18nKey(elementHint, i18nKeys);
  const elementNote = elementHint
    ? `（设计元素：${edge.element.name}${i18nKey ? `；i18n: ${i18nKey}` : ""}）`
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

export interface GenerateTestCasesOptions {
  maxFlows?: number;
  maxDepth?: number;
  i18nKeys?: Map<string, string>;
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
  return paths.map((flowPath, pathIndex) => {
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
    const steps = flowPath.map((edge) => stepFor(graph, edge, options.i18nKeys));
    const prelude = prefix.map((edge) => stepFor(graph, edge, options.i18nKeys));
    const expectations = flowPath.map((edge) => expectationFor(graph, edge));
    const exploreCount = [...prefix, ...flowPath].filter((edge) =>
      isUnconfirmedProvenance(resolveProvenance(edge.provenance))
    ).length;
    const baseName =
      screens.length <= 4 ? screens.join(" → ") : `${screens.slice(0, 4).join(" → ")} → …`;
    const name = continuation ? `${baseName}（续段）` : baseName;
    const preconditions = deriveCasePreconditions(screens, {
      entryFallback: stats.entryFallback
    });
    const entryScreen = screens[0]!;
    const entryScreenObj = graph.screens.find((candidate) => candidate.name === entryScreen);
    const preflight: CasePreflight = {
      screen: entryScreen,
      hints: runtimeHintTexts(entryScreenObj?.textHints).slice(0, 3)
    };
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
          kind: expectation.kind
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
      id: caseIdFor(name, screens, steps),
      name,
      screens,
      steps,
      preconditions,
      taskDesc,
      continuation,
      startScreen: first.from.name,
      prelude,
      expectations,
      preflight
    };
  });
}

export function renderMarkdown(
  cases: GeneratedTest[],
  meta: { source: string; generatedAt: string }
): string {
  const lines: string[] = [
    "# 设计流程测试用例",
    "",
    `> 来源: ${meta.source}`,
    `> 生成时间: ${meta.generatedAt}`,
    ""
  ];
  cases.forEach((testCase, index) => {
    lines.push(`## ${index + 1}. ${testCase.name}`, "");
    if (testCase.continuation) {
      lines.push(`> 接续段：先按前导导航到「${testCase.startScreen}」（不计断言）`, "");
    }
    if (testCase.preconditions.length > 0) {
      lines.push(`- 前置假设：${testCase.preconditions.join("；")}`, "");
    }
    if (testCase.prelude.length > 0) {
      lines.push("- 前导导航（仅到达起点）：");
      testCase.prelude.forEach((step, stepIndex) => {
        lines.push(`  - [ ] P${stepIndex + 1}) ${step}`);
      });
      lines.push("");
    }
    testCase.steps.forEach((step, stepIndex) => {
      lines.push(`- [ ] ${stepIndex + 1}) ${step}`);
    });
    lines.push("", "### artemis 任务描述（可直接传给 mobile_run_task）", "", "```text", testCase.taskDesc, "```", "");
  });
  return lines.join("\n") + "\n";
}


export interface GenerateTestsArgs {
  url?: string;
  flowsPath?: string;
  maxFlows?: number;
  maxDepth?: number;
  save?: boolean;
  excelPath?: string;
  excelTemplate?: string;
  requireFullCoverage?: boolean;
}

/** Load the frozen text→key mapping produced by figma_import_strings (M6b). */
function loadI18nKeys(runtime: Runtime): Map<string, string> {
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

export async function figmaGenerateTests(
  runtime: Runtime,
  args: GenerateTestsArgs
): Promise<CallToolResult> {
  try {
    const flowsPath = args.flowsPath
      ? path.resolve(runtime.project.rootDir, args.flowsPath)
      : path.join(runtime.configDirAbs, "design", "flows.json");

    let graph: FlowGraph;
    let source: string;
    if (args.url) {
      const { fileKey } = parseFigmaUrl(args.url);
      const file = (await fetchFile(fileKey)) as { name?: string; document?: FigmaNode };
      if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);
      graph = buildFlowGraph(file.document);
      source = `figma:${fileKey}${file.name ? ` (${file.name})` : ""}`;
    } else {
      if (!fs.existsSync(flowsPath)) {
        throw new Error(`未找到 ${flowsPath}：先运行 figma_extract_flows（或直接传 url）`);
      }
      const parsed = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as FlowGraph;
      if (!Array.isArray(parsed.screens) || !Array.isArray(parsed.edges)) {
        throw new Error(`${flowsPath} 格式不正确（缺少 screens/edges）`);
      }
      graph = normalizeFlowGraph(parsed);
      source = flowsPath;
    }

    const reconciliation = applyReconciliationToGraph(graph, loadReconciliation(runtime.configDirAbs));
    graph = reconciliation.graph;

    const generationRef: { stats: LinearizeStats | null } = { stats: null };
    const cases = generateTestCases(graph, {
      maxFlows: args.maxFlows ?? 10,
      maxDepth: args.maxDepth,
      i18nKeys: loadI18nKeys(runtime),
      onStats: (stats) => {
        generationRef.stats = stats;
      }
    });
    const generation = generationRef.stats;
    const generatedAt = new Date().toISOString();
    const counts = { cases: cases.length, screens: graph.screens.length, edges: graph.edges.length };
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
    const splitHint =
      generation && generation.depthSplits > 0
        ? `本次有 ${generation.depthSplits} 条用例受 maxDepth=${generation.maxDepth} 限制从上一段终点接续（首尾相接）；如需更长的单条连续用例，请调大 maxDepth。`
        : "";
    const payload: Record<string, unknown> = {
      ok: true,
      source,
      counts: { flows: counts.cases, screens: counts.screens, edges: counts.edges },
      generation,
      coverage,
      ...(reconciliation.upgradedEdges > 0
        ? { reconciliation: { upgradedEdges: reconciliation.upgradedEdges } }
        : {}),
      flows: cases,
      hint:
        "用 mobile_run_task 执行 flows[].taskDesc；失败步骤可用 compare_design_and_device 做视觉断言；" +
        "若已跑过 figma_import_strings，步骤中会附带 i18n key（原文仅在 source locale 兜底）；" +
        "coverage 分硬/探索两类：complete 只按硬覆盖判定（inferred 边不虚高门禁），explore 单独报告" +
        "（requireFullCoverage:true 硬覆盖不完整即不落盘）。" +
        splitHint
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
      const excelBuffer = await renderTestsWorkbook(
        cases,
        { source, generatedAt, counts },
        { templatePath }
      );
      writeFileAtomic(jsonPath, JSON.stringify(payload, null, 2) + "\n");
      writeFileAtomic(markdownPath, renderMarkdown(cases, { source, generatedAt }));
      writeFileAtomic(excelPath, excelBuffer);
      payload.savedTo = { json: jsonPath, markdown: markdownPath, xlsx: excelPath };
      if (templatePath) payload.excel = { template: templatePath };
    }

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
