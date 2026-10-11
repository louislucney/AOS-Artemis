import fs from "node:fs";
import path from "node:path";

import type { FailureClassification } from "../artemis/failure-taxonomy.js";
import type { Runtime } from "../runtime.js";
import { readTestsDocument } from "./design-store.js";
import { preflightGeneratedTests } from "./preflight.js";
import { buildRunReport, type RunReportCase } from "./run-report.js";

export interface FeedbackTarget {
  caseId?: string;
  screen?: string;
  stepIndex?: number;
  precondition?: string;
}

export interface FeedbackSuggestion {
  kind: "prompt" | "hint" | "assertion" | "data" | "api";
  message: string;
  targets: FeedbackTarget;
  caseIds: string[];
  traceIds: string[];
}

export interface ScreenIssue {
  screen: string;
  failures: number;
  caseIds: string[];
  traceIds: string[];
}

export interface AssertionIssue {
  text: string;
  failures: number;
  caseIds: string[];
  traceIds: string[];
}

export interface DataIssue {
  precondition: string;
  failures: number;
  caseIds: string[];
  traceIds: string[];
}

export interface WeakAssertionIssue {
  caseId: string;
  name: string;
  stepIndex: number;
  step: string;
}

export interface VisualHotspot {
  caseId: string;
  stepNumber: number;
  regions: number;
  categories: string[];
  dir: string;
}

export interface ApiErrorIssue {
  code: string;
  handler: string | null;
  expect: string | null;
  occurrences: number;
  caseIds: string[];
  traceIds: string[];
}

export interface GenerationFeedback {
  ok: boolean;
  generatedFrom: { tasks: number; failed: number; baselines: number };
  issues: {
    screens: ScreenIssue[];
    assertions: AssertionIssue[];
    data: DataIssue[];
    weakAssertions: WeakAssertionIssue[];
    visualHotspots: VisualHotspot[];
    apiErrors: ApiErrorIssue[];
  };
  suggestions: FeedbackSuggestion[];
  error?: string;
}

export interface GenerationFeedbackOptions {
  limit?: number;
  minFailures?: number;
}

interface CaseMeta {
  screens: string[];
  steps: string[];
}

function loadCaseMeta(runtime: Runtime): Map<string, CaseMeta> {
  const map = new Map<string, CaseMeta>();
  const document = readTestsDocument(runtime.configDirAbs);
  if (document === null) return map;
  for (const record of document.records) {
    map.set(record.id, { screens: record.screens, steps: record.steps });
  }
  return map;
}

function collectVisualHotspots(runtime: Runtime): VisualHotspot[] {
  const root = path.join(runtime.configDirAbs, "design", "baselines");
  const hotspots: VisualHotspot[] = [];
  let serials: string[];
  try {
    serials = fs.readdirSync(root).sort();
  } catch {
    return hotspots;
  }
  for (const serial of serials) {
    const serialDir = path.join(root, serial);
    let caseIds: string[];
    try {
      caseIds = fs.readdirSync(serialDir).sort();
    } catch {
      continue;
    }
    for (const caseId of caseIds) {
      const caseDir = path.join(serialDir, caseId);
      let steps: string[];
      try {
        steps = fs.readdirSync(caseDir).sort();
      } catch {
        continue;
      }
      for (const step of steps) {
        const dir = path.join(caseDir, step);
        let regions: Array<{ category?: unknown }>;
        try {
          const parsed = JSON.parse(
            fs.readFileSync(path.join(dir, "last-diff.json"), "utf-8")
          ) as { regions?: Array<{ category?: unknown }> };
          regions = Array.isArray(parsed.regions) ? parsed.regions : [];
        } catch {
          continue;
        }
        if (regions.length === 0) continue;
        const stepNumber = Number(/^step-(\d+)/.exec(step)?.[1] ?? NaN);
        if (!Number.isFinite(stepNumber)) continue;
        const categories = [
          ...new Set(
            regions
              .map((region) => (typeof region.category === "string" ? region.category : null))
              .filter((category): category is string => category !== null)
          )
        ].sort();
        hotspots.push({ caseId, stepNumber, regions: regions.length, categories, dir });
      }
    }
  }
  return hotspots;
}

function dataPreconditionOf(failure: FailureClassification | null): string | null {
  if (!failure) return null;
  for (const item of failure.evidence) {
    if (item.startsWith("precondition:")) return item.slice("precondition:".length);
  }
  return null;
}

/** Read-only aggregation over the run ledger plus device baselines. Produces
 * suggestions with case/trace back-references; it never rewrites generated
 * artifacts (the caller decides whether to apply them). */
export async function buildGenerationFeedback(
  runtime: Runtime,
  options: GenerationFeedbackOptions = {}
): Promise<GenerationFeedback> {
  const minFailures = options.minFailures ?? 2;
  const report = await buildRunReport(runtime, { limit: options.limit ?? 100, save: false });
  const empty: GenerationFeedback = {
    ok: report.ok,
    generatedFrom: { tasks: report.total, failed: report.failed, baselines: 0 },
    issues: {
      screens: [],
      assertions: [],
      data: [],
      weakAssertions: [],
      visualHotspots: [],
      apiErrors: []
    },
    suggestions: []
  };
  if (!report.ok) {
    return { ...empty, error: report.error ?? "运行台账不可读" };
  }

  const meta = loadCaseMeta(runtime);
  const failed = report.cases.filter((entry) => entry.outcome === "failed");

  const screens = new Map<string, ScreenIssue>();
  const assertions = new Map<string, AssertionIssue>();
  const data = new Map<string, DataIssue>();
  const apiErrorIssues = new Map<string, ApiErrorIssue>();

  const addRef = (
    entry: { caseIds: string[]; traceIds: string[] },
    task: RunReportCase
  ): void => {
    if (task.caseId && !entry.caseIds.includes(task.caseId)) entry.caseIds.push(task.caseId);
    if (!entry.traceIds.includes(task.traceId)) entry.traceIds.push(task.traceId);
  };

  for (const task of failed) {
    const caseMeta = task.caseId ? meta.get(task.caseId) : undefined;
    for (const screen of caseMeta?.screens ?? []) {
      const issue = screens.get(screen) ?? { screen, failures: 0, caseIds: [], traceIds: [] };
      issue.failures += 1;
      addRef(issue, task);
      screens.set(screen, issue);
    }
    for (const failedItem of task.failedItems) {
      const text = failedItem.itemText ?? failedItem.evidence;
      if (!text || text.trim() === "") continue;
      const issue =
        assertions.get(text) ?? { text, failures: 0, caseIds: [], traceIds: [] };
      issue.failures += 1;
      addRef(issue, task);
      assertions.set(text, issue);
    }
    const precondition = dataPreconditionOf(task.failure);
    if (precondition) {
      const issue =
        data.get(precondition) ?? { precondition, failures: 0, caseIds: [], traceIds: [] };
      issue.failures += 1;
      addRef(issue, task);
      data.set(precondition, issue);
    }
  }

  for (const task of report.cases) {
    for (const apiError of task.apiErrors) {
      if (apiError.handled !== false) continue;
      const issue =
        apiErrorIssues.get(apiError.code) ??
        ({
          code: apiError.code,
          handler: apiError.handler,
          expect: apiError.expect,
          occurrences: 0,
          caseIds: [],
          traceIds: []
        } satisfies ApiErrorIssue);
      issue.occurrences += apiError.count > 0 ? apiError.count : 1;
      addRef(issue, task);
      apiErrorIssues.set(apiError.code, issue);
    }
  }

  const preflight = preflightGeneratedTests(runtime.configDirAbs);
  const weakAssertions: WeakAssertionIssue[] = [];
  for (const weakCase of preflight?.weakCases ?? []) {
    for (const weakStep of weakCase.weakSteps) {
      const caseMeta = meta.get(weakCase.id);
      weakAssertions.push({
        caseId: weakCase.id,
        name: weakCase.name,
        stepIndex: weakStep.index,
        step: caseMeta?.steps[weakStep.index] ?? ""
      });
    }
  }

  const visualHotspots = collectVisualHotspots(runtime);

  const byCountThenKey = <T extends { failures: number }>(entries: T[], key: (entry: T) => string): T[] =>
    entries.sort((a, b) => {
      if (b.failures !== a.failures) return b.failures - a.failures;
      const left = key(a);
      const right = key(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const screenIssues = byCountThenKey(
    [...screens.values()].filter((entry) => entry.failures >= minFailures),
    (entry) => entry.screen
  );
  const assertionIssues = byCountThenKey(
    [...assertions.values()].filter((entry) => entry.failures >= minFailures),
    (entry) => entry.text
  );
  const dataIssues = byCountThenKey(
    [...data.values()].filter((entry) => entry.failures >= minFailures),
    (entry) => entry.precondition
  );
  const apiIssues = [...apiErrorIssues.values()]
    .filter((entry) => entry.occurrences >= minFailures)
    .sort((a, b) => b.occurrences - a.occurrences || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const suggestions: FeedbackSuggestion[] = [];
  for (const issue of screenIssues) {
    suggestions.push({
      kind: "prompt",
      message: `「${issue.screen}」相关用例反复失败（${issue.failures} 次）：建议补充该屏幕的稳定定位线索、加载等待与明确断言。`,
      targets: { screen: issue.screen },
      caseIds: issue.caseIds,
      traceIds: issue.traceIds
    });
  }
  for (const issue of dataIssues) {
    suggestions.push({
      kind: "data",
      message: `前置数据假设「${issue.precondition}」多次不满足（${issue.failures} 次）：建议在生成物中标注数据准备步骤或改用具备该数据的测试账号。`,
      targets: { precondition: issue.precondition },
      caseIds: issue.caseIds,
      traceIds: issue.traceIds
    });
  }
  for (const issue of assertionIssues) {
    suggestions.push({
      kind: "hint",
      message: `断言「${issue.text}」反复失败（${issue.failures} 次）：建议核对设计预期文本或在关键步骤补充中间态断言。`,
      targets: {},
      caseIds: issue.caseIds,
      traceIds: issue.traceIds
    });
  }
  for (const issue of apiIssues) {
    suggestions.push({
      kind: "api",
      message: `API 错误「${issue.code}」未被通用处理（${issue.occurrences} 次${
        issue.expect ? `，期望：${issue.expect}` : ""
      }）：建议检查通用错误处理或补充用例对该错误态的断言。`,
      targets: {},
      caseIds: issue.caseIds,
      traceIds: issue.traceIds
    });
  }
  for (const issue of weakAssertions) {
    suggestions.push({
      kind: "assertion",
      message: `用例「${issue.name}」第 ${issue.stepIndex + 1} 步缺少可验证断言：建议补充目的地屏幕文本断言。`,
      targets: { caseId: issue.caseId, stepIndex: issue.stepIndex },
      caseIds: [issue.caseId],
      traceIds: []
    });
  }
  for (const hotspot of visualHotspots) {
    suggestions.push({
      kind: "hint",
      message: `用例 ${hotspot.caseId} 第 ${hotspot.stepNumber} 步存在 ${hotspot.regions} 个未消除的设备基线差异（${hotspot.categories.join("/")}）：建议为该屏幕补充视觉断言或稳定等待。`,
      targets: { caseId: hotspot.caseId, stepIndex: hotspot.stepNumber - 1 },
      caseIds: [hotspot.caseId],
      traceIds: []
    });
  }

  return {
    ok: true,
    generatedFrom: {
      tasks: report.total,
      failed: report.failed,
      baselines: visualHotspots.length
    },
    issues: {
      screens: screenIssues,
      assertions: assertionIssues,
      data: dataIssues,
      weakAssertions,
      visualHotspots,
      apiErrors: apiIssues
    },
    suggestions
  };
}
