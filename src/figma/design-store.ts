import fs from "node:fs";
import path from "node:path";

import { isExploreKind, resolveProvenance, summarizeScriptProvenance } from "../provenance.js";
import { normalizeFlowGraph, type FlowGraph } from "./flows.js";
import type { ExploreStepSignal } from "./reconciliation.js";

/** design 资源单一读取（DESIGN §13.84）：tests.json / flows.json 的所有消费方
 * （suite-runner / preflight / run-report / feedback / CLI / case-index）经本模块，
 * 避免各自解析漂移；flows 一律经 `normalizeFlowGraph` 归一。 */

export function designDir(configDirAbs: string): string {
  return path.join(configDirAbs, "design");
}

export interface FlowDocumentMeta {
  /** Figma 来源的 fileKey（顶层字段）。 */
  fileKey: string | null;
  /** pen 来源的相对项目根路径（`source: "pen:<path>"`）。 */
  penPath: string | null;
  /** 屏幕名 → 节点 id（用于 tests.md 截图映射；同名取首个）。 */
  screenIdsByName: Map<string, string>;
}

/** flows.json 顶层来源信息（fileKey / pen source）——`normalizeFlowGraph` 会丢弃
 * 这些字段，截图映射单独读取原文，不改归一化契约。 */
export function readFlowDocumentMeta(
  configDirAbs: string,
  options: { flowsPath?: string } = {}
): FlowDocumentMeta | null {
  const file = options.flowsPath ?? path.join(designDir(configDirAbs), "flows.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const fileKey =
      typeof parsed.fileKey === "string" && parsed.fileKey.trim() !== "" ? parsed.fileKey : null;
    const source = typeof parsed.source === "string" ? parsed.source : "";
    const penPath =
      source.startsWith("pen:") && source.slice(4).trim() !== "" ? source.slice(4).trim() : null;
    const screensRaw = Array.isArray(parsed.screens) ? parsed.screens : [];
    const screenIdsByName = new Map<string, string>();
    for (const entry of screensRaw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as { id?: unknown; name?: unknown };
      if (typeof record.id !== "string" || record.id.trim() === "") continue;
      if (typeof record.name !== "string" || record.name.trim() === "") continue;
      if (!screenIdsByName.has(record.name)) screenIdsByName.set(record.name, record.id);
    }
    return { fileKey, penPath, screenIdsByName };
  } catch {
    return null;
  }
}

export interface GeneratedCaseRecord {
  id: string;
  name: string;
  /** 跨端语义身份（旧产物缺失 → null）。 */
  semanticId: string | null;
  /** 人类展示编号（旧产物缺失 → null）。 */
  displayId: string | null;
  preconditions: string[];
  taskDesc: string | null;
  screens: string[];
  steps: string[];
  expectations: unknown[];
  /** 功能段 key（回归服务 §5.1；旧产物缺失 → null）。 */
  feature: string | null;
}

export interface TestsDocument {
  records: GeneratedCaseRecord[];
  generation: unknown;
  /** 原始 flows[]（保留渲染/导出所需的完整字段；records 是消费方投影）。 */
  rawFlows: unknown[];
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** tests.json（默认 `<configDir>/design/tests.json`）：缺失/不可解析 → null；无 id 条目跳过。 */
export function readTestsDocument(
  configDirAbs: string,
  options: { testsPath?: string } = {}
): TestsDocument | null {
  const file = options.testsPath ?? path.join(designDir(configDirAbs), "tests.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      flows?: unknown;
      generation?: unknown;
    };
    const flows = Array.isArray(parsed.flows) ? parsed.flows : [];
    const records: GeneratedCaseRecord[] = [];
    for (const entry of flows) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      records.push({
        id: record.id,
        name: typeof record.name === "string" ? record.name : record.id,
        semanticId:
          typeof record.semanticId === "string" && record.semanticId !== ""
            ? record.semanticId
            : null,
        displayId:
          typeof record.displayId === "string" && record.displayId !== ""
            ? record.displayId
            : null,
        preconditions: stringArray(record.preconditions),
        taskDesc: typeof record.taskDesc === "string" ? record.taskDesc : null,
        screens: stringArray(record.screens),
        steps: stringArray(record.steps),
        expectations: Array.isArray(record.expectations) ? record.expectations : [],
        feature:
          typeof record.feature === "string" && record.feature !== "" ? record.feature : null
      });
    }
    return { records, generation: parsed.generation ?? null, rawFlows: flows };
  } catch {
    return null;
  }
}

/** flows.json（默认 `<configDir>/design/flows.json`）：缺失/不可解析 → null；始终归一化。 */
export function loadDesignFlowGraph(
  configDirAbs: string,
  options: { flowsPath?: string } = {}
): FlowGraph | null {
  try {
    const flowsPath = options.flowsPath ?? path.join(designDir(configDirAbs), "flows.json");
    return normalizeFlowGraph(JSON.parse(fs.readFileSync(flowsPath, "utf-8")));
  } catch {
    return null;
  }
}

function hintScreensOf(raw: unknown): Array<{ screen: string; hints: string[] }> {
  if (!Array.isArray(raw)) return [];
  const screens: Array<{ screen: string; hints: string[] }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { screen?: unknown; hints?: unknown };
    if (typeof record.screen !== "string" || record.screen.trim() === "") continue;
    const hints = Array.isArray(record.hints)
      ? record.hints.filter((hint): hint is string => typeof hint === "string" && hint.trim() !== "")
      : [];
    if (hints.length === 0) continue;
    screens.push({ screen: record.screen.trim(), hints });
  }
  return screens;
}

function exploreStepsOf(raw: unknown): ExploreStepSignal[] {
  if (!Array.isArray(raw)) return [];
  const steps: ExploreStepSignal[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { index?: unknown; screen?: unknown; kind?: unknown; provenance?: unknown };
    if (!isExploreKind(record.kind)) continue;
    if (typeof record.screen !== "string" || record.screen.trim() === "") continue;
    const index =
      typeof record.index === "number" && Number.isFinite(record.index)
        ? Math.floor(record.index)
        : steps.length + 1;
    steps.push({
      index,
      screen: record.screen.trim(),
      provenance: resolveProvenance(record.provenance)
    });
  }
  return steps;
}

/** suite-runner / run-report 共用的富用例视图。 */
export interface GeneratedCase {
  id: string;
  name: string;
  semanticId: string | null;
  displayId: string | null;
  preconditions: string[];
  taskDesc: string;
  screens: string[];
  /** 功能段 key（回归服务 §5.1；旧产物缺失 → null）。 */
  feature: string | null;
  /** Exploration steps (kind=explore with a target screen) for reconciliation. */
  exploreSteps: ExploreStepSignal[];
  /** Design runtime texts per expected screen (element-level matching). */
  hintScreens: Array<{ screen: string; hints: string[] }>;
  /** Script provenance counts from tests.json expectations (null = legacy). */
  scriptProvenance: { asserts: number; explores: number } | null;
}

export function toGeneratedCase(record: GeneratedCaseRecord): GeneratedCase {
  return {
    id: record.id,
    name: record.name,
    semanticId: record.semanticId,
    displayId: record.displayId,
    preconditions: record.preconditions,
    taskDesc: record.taskDesc ?? "",
    screens: record.screens,
    feature: record.feature,
    exploreSteps: exploreStepsOf(record.expectations),
    hintScreens: hintScreensOf(record.expectations),
    scriptProvenance: summarizeScriptProvenance(record.expectations)
  };
}

export interface CaseSelectorCase {
  id: string;
  semanticId: string | null;
  displayId: string | null;
}

export type CaseSelectorResolution =
  | { ok: true; caseId: string; matchedBy: "caseId" | "semanticId" | "displayId" }
  | { ok: false; reason: "not-found" | "ambiguous"; selector: string; candidates: string[] };

/** 统一用例选择器（DESIGN §13.206）：精确 caseId 优先，其次 semanticId/displayId；
 * 同一选择器对应多条 → 显式 ambiguous 并列出候选，绝不静默取首条。 */
export function resolveCaseSelector(
  selector: string,
  cases: readonly CaseSelectorCase[]
): CaseSelectorResolution {
  const wanted = selector.trim();
  if (wanted === "") {
    return { ok: false, reason: "not-found", selector, candidates: [] };
  }
  const exact = cases.find((entry) => entry.id === wanted);
  if (exact) return { ok: true, caseId: exact.id, matchedBy: "caseId" };
  for (const [matchedBy, key] of [
    ["semanticId", "semanticId"],
    ["displayId", "displayId"]
  ] as const) {
    const hits = cases.filter((entry) => entry[key] === wanted);
    if (hits.length === 1) return { ok: true, caseId: hits[0]!.id, matchedBy };
    if (hits.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        selector,
        candidates: hits.map((entry) => entry.id)
      };
    }
  }
  return { ok: false, reason: "not-found", selector, candidates: [] };
}

/** 富用例列表：无 taskDesc 的条目按既有语义跳过（等价原 suite-runner.loadCases）。 */
export function loadGeneratedCases(
  configDirAbs: string,
  options: { testsPath?: string; maxCases?: number } = {}
): GeneratedCase[] | null {
  const document = readTestsDocument(
    configDirAbs,
    options.testsPath ? { testsPath: options.testsPath } : {}
  );
  if (document === null) return null;
  const cases = document.records
    .filter((record) => record.taskDesc !== null)
    .map(toGeneratedCase);
  return options.maxCases && options.maxCases > 0 ? cases.slice(0, options.maxCases) : cases;
}
