import fs from "node:fs";
import path from "node:path";

import {
  computeClassifiedCoverage,
  computeScreenCoverage,
  type CoverageClass,
  type CoverageEdge
} from "./coverage.js";
import { isExploreKind, isHardCoverageValue } from "../provenance.js";

export interface PreflightWeakStep {
  index: number;
  reason: string;
}

export interface PreflightWeakCase {
  id: string;
  name: string;
  weakSteps: PreflightWeakStep[];
}

export interface PreflightCoverage {
  /** flows.json readable → screen/transition coverage is computable. */
  available: boolean;
  /** All design screen names from flows.json (empty when unavailable). */
  designScreens: string[];
  /** Screens visited by at least one case (hard + explore). */
  screens: string[];
  /** Hard-class gaps: these gate the run (fail-closed). */
  uncoveredScreens: string[];
  uncoveredEdges: string[];
  /** Exploration-class gaps (inferred evidence): reported only, never gate. */
  explore: Pick<CoverageClass, "uncoveredScreens" | "uncoveredEdges">;
}

export interface PreflightReport {
  cases: number;
  weakCases: PreflightWeakCase[];
  coverage: PreflightCoverage;
  generation: unknown;
}

export interface PreflightOptions {
  /** Absolute path of the cases file; defaults to <configDir>/design/tests.json.
   * flows.json is always read from <configDir>/design/ (custom case subsets are
   * still validated against the project flows). */
  testsPath?: string;
}

export function preflightGeneratedTests(
  configDirAbs: string,
  options: PreflightOptions = {}
): PreflightReport | null {
  const designDir = path.join(configDirAbs, "design");
  const testsPath = options.testsPath ?? path.join(designDir, "tests.json");
  let tests: { flows?: unknown; generation?: unknown };
  try {
    tests = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as {
      flows?: unknown;
      generation?: unknown;
    };
  } catch {
    return null;
  }

  const rawCases = Array.isArray(tests.flows) ? tests.flows : [];
  const cases = rawCases.filter(
    (entry): entry is {
      id: string;
      name?: unknown;
      screens?: unknown;
      steps?: unknown;
      expectations?: unknown;
    } =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
  );
  const caseInputs = cases.map((entry) => ({
    screens: Array.isArray(entry.screens)
      ? entry.screens.filter((screen): screen is string => typeof screen === "string")
      : []
  }));

  const weakCases: PreflightWeakCase[] = [];
  for (const entry of cases) {
    const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    const expectations = Array.isArray(entry.expectations) ? entry.expectations : [];
    const kindOf = (index: number): unknown => {
      const expectation = expectations[index];
      return expectation && typeof expectation === "object"
        ? (expectation as { kind?: unknown }).kind
        : undefined;
    };
    const weakSteps = rawSteps
      .map((step, index) => ({ step, index }))
      .filter((item): item is { step: string; index: number } => typeof item.step === "string")
      .map((item) => ({
        index: item.index,
        weak: !isExploreKind(kindOf(item.index)) && !item.step.includes("应")
      }))
      .filter((item) => item.weak)
      .map((item) => ({ index: item.index, reason: "缺少可验证断言（目的地屏无文本提示）" }));
    if (weakSteps.length > 0) {
      weakCases.push({
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        weakSteps
      });
    }
  }

  let coverage: PreflightCoverage;
  try {
    const flows = JSON.parse(fs.readFileSync(path.join(designDir, "flows.json"), "utf-8")) as {
      screens?: Array<{ name?: unknown; provenance?: unknown }>;
      edges?: Array<{
        from?: { name?: unknown };
        to?: { name?: unknown } | null;
        provenance?: unknown;
      }>;
    };
    const screenInputs = (flows.screens ?? [])
      .map((screen) => ({
        name: screen.name,
        hard: isHardCoverageValue(screen.provenance)
      }))
      .filter((entry): entry is { name: string; hard: boolean } => typeof entry.name === "string");
    const edgeInputs: Array<CoverageEdge & { hard: boolean }> = [];
    for (const edge of flows.edges ?? []) {
      const from = edge.from?.name;
      if (typeof from !== "string") continue;
      const to = edge.to?.name;
      edgeInputs.push({
        from,
        to: typeof to === "string" ? to : null,
        hard: isHardCoverageValue(edge.provenance)
      });
    }
    const split = computeClassifiedCoverage(screenInputs, edgeInputs, caseInputs);
    coverage = {
      available: true,
      designScreens: screenInputs.map((entry) => entry.name),
      screens: [...new Set([...split.hard.coveredScreens, ...split.explore.coveredScreens])],
      uncoveredScreens: split.hard.uncoveredScreens,
      uncoveredEdges: split.hard.uncoveredEdges,
      explore: {
        uncoveredScreens: split.explore.uncoveredScreens,
        uncoveredEdges: split.explore.uncoveredEdges
      }
    };
  } catch {
    const result = computeScreenCoverage([], [], caseInputs);
    coverage = {
      available: false,
      designScreens: [],
      screens: result.coveredScreens,
      uncoveredScreens: [],
      uncoveredEdges: [],
      explore: { uncoveredScreens: [], uncoveredEdges: [] }
    };
  }

  return { cases: cases.length, weakCases, coverage, generation: tests.generation ?? null };
}
