/** 运行对比（DESIGN：回归服务 §5.6）：同用例集血统的逐用例差量与跨端差异。
 * pending 不参与计数；无基线 → `established`（全部按新增计）。输出按 caseId 确定性排序。 */
export type RunCaseOutcome = "passed" | "failed" | "pending";

export interface CompareCaseInput {
  caseId: string;
  name: string;
  outcome: RunCaseOutcome;
}

export interface RunComparison {
  baseline: "compared" | "established";
  stillPassed: number;
  fixed: number;
  regressed: number;
  stillFailed: number;
  newFailed: number;
  newPassed: number;
  vanished: number;
  regressedCases: Array<{ caseId: string; name: string }>;
  fixedCases: Array<{ caseId: string; name: string }>;
  newFailedCases: Array<{ caseId: string; name: string }>;
  vanishedCases: Array<{ caseId: string; name: string }>;
}

function compareIds(a: { caseId: string }, b: { caseId: string }): number {
  return a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0;
}

export function compareRuns(
  baseline: CompareCaseInput[] | null,
  current: CompareCaseInput[]
): RunComparison {
  const result: RunComparison = {
    baseline: baseline === null ? "established" : "compared",
    stillPassed: 0,
    fixed: 0,
    regressed: 0,
    stillFailed: 0,
    newFailed: 0,
    newPassed: 0,
    vanished: 0,
    regressedCases: [],
    fixedCases: [],
    newFailedCases: [],
    vanishedCases: []
  };
  const baselineById = new Map((baseline ?? []).map((entry) => [entry.caseId, entry]));
  const currentIds = new Set(current.map((entry) => entry.caseId));

  for (const entry of [...current].sort(compareIds)) {
    if (entry.outcome === "pending") continue;
    const prior = baselineById.get(entry.caseId);
    if (!prior) {
      if (entry.outcome === "passed") {
        result.newPassed += 1;
      } else {
        result.newFailed += 1;
        result.newFailedCases.push({ caseId: entry.caseId, name: entry.name });
      }
      continue;
    }
    if (prior.outcome === "pending") continue;
    if (prior.outcome === "passed" && entry.outcome === "passed") {
      result.stillPassed += 1;
    } else if (prior.outcome === "failed" && entry.outcome === "passed") {
      result.fixed += 1;
      result.fixedCases.push({ caseId: entry.caseId, name: entry.name });
    } else if (prior.outcome === "passed" && entry.outcome === "failed") {
      result.regressed += 1;
      result.regressedCases.push({ caseId: entry.caseId, name: entry.name });
    } else if (prior.outcome === "failed" && entry.outcome === "failed") {
      result.stillFailed += 1;
    }
  }

  for (const entry of [...(baseline ?? [])].sort(compareIds)) {
    if (entry.outcome === "pending") continue;
    if (currentIds.has(entry.caseId)) continue;
    result.vanished += 1;
    result.vanishedCases.push({ caseId: entry.caseId, name: entry.name });
  }

  return result;
}

export function crossPlatformDeltas(
  runs: Array<{ platform: string; cases: CompareCaseInput[] }>
): Array<{ caseId: string; name: string; results: Record<string, RunCaseOutcome> }> {
  const byCase = new Map<string, { name: string; results: Record<string, RunCaseOutcome> }>();
  for (const run of runs) {
    for (const entry of run.cases) {
      const record = byCase.get(entry.caseId) ?? { name: entry.name, results: {} };
      record.results[run.platform] = entry.outcome;
      byCase.set(entry.caseId, record);
    }
  }
  return [...byCase.entries()]
    .filter(([, record]) => new Set(Object.values(record.results)).size > 1)
    .map(([caseId, record]) => ({ caseId, name: record.name, results: record.results }))
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
}
