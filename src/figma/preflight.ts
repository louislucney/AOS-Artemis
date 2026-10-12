import fs from "node:fs";
import path from "node:path";

import {
  computeClassifiedCoverage,
  computeScreenCoverage,
  type CoverageClass,
  type CoverageEdge
} from "./coverage.js";
import { loadDesignFlowGraph, readTestsDocument } from "./design-store.js";
import { hasRealDataPolicy } from "./data-policy.js";
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

/** 生成物三件套与真实数据约束的静态核验结果（ADR-0010 相邻契约：三件套强制；
 * 真实数据硬限制：禁止伪造页面/假数据）。两者都是硬门禁输入。 */
export interface PreflightArtifacts {
  testsFile: string;
  excelFile: string;
  excelPresent: boolean;
  excelStale: boolean;
}

export interface PreflightDataPolicy {
  /** Cases whose taskDesc lacks the real-data clause marker. */
  missing: Array<{ id: string; name: string }>;
}

export interface PreflightReport {
  cases: number;
  weakCases: PreflightWeakCase[];
  coverage: PreflightCoverage;
  generation: unknown;
  artifacts: PreflightArtifacts;
  dataPolicy: PreflightDataPolicy;
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
  const document = readTestsDocument(
    configDirAbs,
    options.testsPath ? { testsPath: options.testsPath } : {}
  );
  if (document === null) return null;
  const cases = document.records;
  const caseInputs = cases.map((record) => ({ screens: record.screens }));

  const testsFile =
    options.testsPath ?? path.join(configDirAbs, "design", "tests.json");
  const parsedTests = path.parse(testsFile);
  const excelFile = path.join(parsedTests.dir, `${parsedTests.name}.xlsx`);
  const excelPresent = fs.existsSync(excelFile);
  let excelStale = false;
  if (excelPresent) {
    try {
      excelStale = fs.statSync(excelFile).mtimeMs < fs.statSync(testsFile).mtimeMs;
    } catch {
      excelStale = false;
    }
  }
  const artifacts: PreflightArtifacts = { testsFile, excelFile, excelPresent, excelStale };
  const dataPolicy: PreflightDataPolicy = {
    missing: cases
      .filter((record) => !hasRealDataPolicy(record.taskDesc))
      .map((record) => ({ id: record.id, name: record.name }))
  };

  const weakCases: PreflightWeakCase[] = [];
  for (const record of cases) {
    const kindOf = (index: number): unknown => {
      const expectation = record.expectations[index];
      return expectation && typeof expectation === "object"
        ? (expectation as { kind?: unknown }).kind
        : undefined;
    };
    const weakSteps = record.steps
      .map((step, index) => ({ step, index }))
      .map((item) => ({
        index: item.index,
        weak: !isExploreKind(kindOf(item.index)) && !item.step.includes("应")
      }))
      .filter((item) => item.weak)
      .map((item) => ({ index: item.index, reason: "缺少可验证断言（目的地屏无文本提示）" }));
    if (weakSteps.length > 0) {
      weakCases.push({ id: record.id, name: record.name, weakSteps });
    }
  }

  const graph = loadDesignFlowGraph(configDirAbs);
  let coverage: PreflightCoverage;
  if (graph) {
    const screenInputs = graph.screens.map((screen) => ({
      name: screen.name,
      hard: isHardCoverageValue(screen.provenance)
    }));
    const edgeInputs: Array<CoverageEdge & { hard: boolean }> = [];
    for (const edge of graph.edges) {
      edgeInputs.push({
        from: edge.from.name,
        to: edge.to ? edge.to.name : null,
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
  } else {
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

  return { cases: cases.length, weakCases, coverage, generation: document.generation, artifacts, dataPolicy };
}
