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
import {
  resolveDesignWarnings,
  type DesignWarning,
  type WarningSummary
} from "../design/warnings.js";
import {
  baselineEntryKey,
  type UiParityBaselineFile
} from "../ui/parity-baseline.js";
import {
  loadUiSemantics,
  matchesDynamicExample,
  matchesDynamicPattern
} from "../ui/semantics.js";

export type DesignWarningsSource = "tests" | "flows" | "none";

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

export interface PreflightDynamicCase {
  caseId: string;
  name: string;
  texts: string[];
  baselined: boolean;
}

export interface PreflightDynamicContent {
  cases: PreflightDynamicCase[];
  total: number;
  fresh: number;
  baselined: number;
  semanticsPath: string | null;
  /** 文件存在但解析失败时的错误；缺文件为 null。 */
  semanticsError: string | null;
}

export interface PreflightReport {
  cases: number;
  weakCases: PreflightWeakCase[];
  coverage: PreflightCoverage;
  generation: unknown;
  artifacts: PreflightArtifacts;
  dataPolicy: PreflightDataPolicy;
  dynamicContent: PreflightDynamicContent;
  designWarnings: DesignWarning[];
  designWarningSummary: WarningSummary;
  designWarningsSource: DesignWarningsSource;
  designWarningsSnapshotAt: string | null;
  designWarningsStale: boolean;
}

export interface DesignWarningLineInput {
  designWarningSummary: WarningSummary;
  designWarningsSource: DesignWarningsSource;
  designWarningsStale: boolean;
}

/** 单一渲染口径：`suite check` 文本与 `suite loop` markdown 共用。 */
export function renderDesignWarningLine(input: DesignWarningLineInput): string {
  const summary = input.designWarningSummary;
  if (!summary.available) return "设计源警告: 不可用（缺 tests.json/flows.json 快照）";
  const codes = summary.codes.length > 0 ? `（${summary.codes.join("、")}）` : "";
  const notes = [`来源 ${input.designWarningsSource}`];
  if (summary.snapshotAt) notes.push(`快照 ${summary.snapshotAt}`);
  if (input.designWarningsStale) {
    notes.push("stale-snapshot（tests 快照早于 flows.json，建议重新生成）");
  }
  return `设计源警告: ${summary.total} 条${codes} · ${notes.join(" · ")}`;
}

export interface PreflightOptions {
  /** Absolute path of the cases file; defaults to <configDir>/design/tests.json. */
  testsPath?: string;
  /** Effective flows path (shared design source or local); defaults to <configDir>/design/flows.json. */
  flowsPath?: string;
  /** ui-semantics.json path; defaults to <configDir>/design/ui-semantics.json. */
  semanticsPath?: string;
  /** 已加载的 check-dynamic 基线；缺省不启用。 */
  dynamicBaseline?: UiParityBaselineFile;
}

function collectDynamicContent(
  configDirAbs: string,
  records: Array<{ id: string; name: string; taskDesc: string | null; steps: string[] }>,
  options: PreflightOptions
): PreflightDynamicContent {
  const semanticsPath = options.semanticsPath ?? path.join(configDirAbs, "design", "ui-semantics.json");
  const loaded = loadUiSemantics(configDirAbs, { path: semanticsPath });
  if (loaded.errors.length > 0) {
    return {
      cases: [],
      total: 0,
      fresh: 0,
      baselined: 0,
      semanticsPath,
      semanticsError: loaded.errors.join(" | ")
    };
  }
  if (loaded.file === null) {
    return { cases: [], total: 0, fresh: 0, baselined: 0, semanticsPath: null, semanticsError: null };
  }
  const examples = new Set<string>();
  const patterns = new Set<string>();
  for (const screen of loaded.file.screens) {
    for (const region of screen.regions) {
      for (const example of region.dynamicExamples ?? []) examples.add(example);
      for (const pattern of region.dynamicPatterns ?? []) patterns.add(pattern);
    }
  }
  if (examples.size === 0 && patterns.size === 0) {
    return { cases: [], total: 0, fresh: 0, baselined: 0, semanticsPath: null, semanticsError: null };
  }
  const baselineKeys = new Set(
    (options.dynamicBaseline?.entries ?? []).map((entry) => baselineEntryKey(entry))
  );
  const cases: PreflightDynamicCase[] = [];
  for (const record of records) {
    const haystack = [record.taskDesc ?? "", ...record.steps].join("\n");
    const matched = new Set<string>();
    for (const example of examples) {
      if (matchesDynamicExample(haystack, example)) matched.add(example);
    }
    if (matched.size === 0) {
      for (const pattern of patterns) {
        if (matchesDynamicPattern(haystack, [pattern])) matched.add(pattern);
      }
    }
    if (matched.size === 0) continue;
    const texts = [...matched];
    const baselined = texts.every((text) =>
      baselineKeys.has(
        baselineEntryKey({
          tool: "check-dynamic",
          caseId: record.id,
          kind: "dynamic-content",
          text
        })
      )
    );
    cases.push({ caseId: record.id, name: record.name, texts, baselined });
  }
  const baselined = cases.filter((entry) => entry.baselined).length;
  return {
    cases,
    total: cases.length,
    fresh: cases.length - baselined,
    baselined,
    semanticsPath,
    semanticsError: null
  };
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
  const designWarnings = resolveDesignWarnings(configDirAbs, {
    ...(options.testsPath ? { testsPath: options.testsPath } : {}),
    ...(options.flowsPath ? { flowsPath: options.flowsPath } : {})
  });
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

  const graph = loadDesignFlowGraph(
    configDirAbs,
    options.flowsPath ? { flowsPath: options.flowsPath } : {}
  );
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

  return {
    cases: cases.length,
    weakCases,
    coverage,
    generation: document.generation,
    artifacts,
    dataPolicy,
    dynamicContent: collectDynamicContent(configDirAbs, cases, options),
    designWarnings: designWarnings.warnings,
    designWarningSummary: designWarnings.summary,
    designWarningsSource: designWarnings.source,
    designWarningsSnapshotAt: designWarnings.snapshotAt,
    designWarningsStale: designWarnings.stale
  };
}
