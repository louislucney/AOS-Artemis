import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import { flowGraphWarnings, routeFor, type FlowEdge, type FlowGraph } from "../figma/flows.js";
import { loadPenDocument, penRelativePath, PEN_HINT, resolvePenTarget } from "./paths.js";
import type { PenDocument, PenNode } from "./read.js";

export interface PenFlowScreen {
  id: string;
  name: string;
  suggestedRoute: string;
  childNames: string[];
  textHints: string[];
  sourceBoard: string;
  sourceFrameName: string;
  /** True when the name came from the (generic) layer name, not a screen label. */
  inferredName: boolean;
  /** State variants merged into this screen (label + frame id/name). */
  states: Array<{ id: string; label: string; frameName: string }>;
}

export interface PenFlowWarning {
  code: string;
  message: string;
  details?: string[];
}

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
    const screen: PenFlowScreen = {
      id: main.id,
      name: base,
      suggestedRoute: routeFor(base),
      childNames: (main.frame.children ?? []).slice(0, 10).map((child) => String(child.name ?? "")),
      textHints: texts,
      sourceBoard: String(boards[main.boardIndex]?.name ?? ""),
      sourceFrameName: main.frameName,
      inferredName: main.labelSource === "layer-name",
      states
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
      actionType: "INFERRED"
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

  const warnings: PenFlowWarning[] = [
    {
      code: "pen-no-interactions",
      message:
        "设计文件无原型/交互数据：所有跳转由画板排布推断（trigger=INFERRED），需人工复核"
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
      inferredEdges
    }
  };
}

function collectTextHints(node: PenNode, limit: number): string[] {
  const hints: string[] = [];
  const visit = (current: PenNode): void => {
    if (hints.length >= limit) return;
    const text = textOf(current);
    if (text && !hints.includes(text)) hints.push(text);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return hints;
}

export function renderPenFlowMap(input: {
  file: string;
  generatedAt: string;
  result: PenFlowResult;
}): string {
  const { result } = input;
  const lines: string[] = [
    "# Pen 交互地图（合成 · inferred）",
    "",
    `> 来源: ${input.file}`,
    `> 生成时间: ${input.generatedAt}`,
    "> 说明：设计文件无原型交互数据；跳转由画板排布推断，状态由标签归并，均需人工复核。",
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
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function penExtractFlows(
  runtime: Runtime,
  args: PenExtractFlowsArgs
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
    const payload: Record<string, unknown> = {
      ok: true,
      source: `pen:${penRelativePath(runtime, target)}`,
      counts: {
        boards: result.synthesis.boards.length,
        screens: result.screens.length,
        states: result.synthesis.statesMerged,
        edges: result.edges.length,
        inferredEdges: result.synthesis.inferredEdges,
        warnings: result.warnings.length
      },
      synthesis: result.synthesis,
      warnings: result.warnings,
      screens: result.screens.slice(0, 30),
      edges: result.edges.slice(0, 40),
      entryScreens: result.entryScreens,
      hint:
        "跳转全部为 inferred（画板排布推断）；flows.json 可直接供 figma_generate_tests / suite check 使用；" +
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
            unresolvedDestinations: []
          },
          null,
          2
        ) + "\n"
      );
      writeFileAtomic(
        mapPath,
        renderPenFlowMap({
          file: penRelativePath(runtime, target),
          generatedAt: new Date().toISOString(),
          result
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
