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

export interface GeneratedCaseRecord {
  id: string;
  name: string;
  preconditions: string[];
  taskDesc: string | null;
  screens: string[];
  steps: string[];
  expectations: unknown[];
}

export interface TestsDocument {
  records: GeneratedCaseRecord[];
  generation: unknown;
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
        preconditions: stringArray(record.preconditions),
        taskDesc: typeof record.taskDesc === "string" ? record.taskDesc : null,
        screens: stringArray(record.screens),
        steps: stringArray(record.steps),
        expectations: Array.isArray(record.expectations) ? record.expectations : []
      });
    }
    return { records, generation: parsed.generation ?? null };
  } catch {
    return null;
  }
}

/** flows.json（默认 `<configDir>/design/flows.json`）：缺失/不可解析 → null；始终归一化。 */
export function loadDesignFlowGraph(configDirAbs: string): FlowGraph | null {
  try {
    const flowsPath = path.join(designDir(configDirAbs), "flows.json");
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
  preconditions: string[];
  taskDesc: string;
  screens: string[];
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
    preconditions: record.preconditions,
    taskDesc: record.taskDesc ?? "",
    screens: record.screens,
    exploreSteps: exploreStepsOf(record.expectations),
    hintScreens: hintScreensOf(record.expectations),
    scriptProvenance: summarizeScriptProvenance(record.expectations)
  };
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
