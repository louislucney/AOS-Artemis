import type { SuiteRunRecord, UsageEventRecord } from "../db/types.js";
import { crossPlatformDeltas, type CompareCaseInput } from "../tasks/run-compare.js";
import { usageSummary } from "../usage/aggregate.js";

/** 回归统计聚合（DESIGN：回归服务 §5.8）：feature 级跨份连续（feature key），
 * case 级仅同份累计（（caseSetId＋caseId）分组，禁止跨份按 caseId 聚合）。
 * 仅参与用例集血统的运行计入（featureKey/caseSetId 为 null 的普通运行跳过）；
 * 入参乱序亦按 createdAt 自排（新→旧），趋势/连败与入参顺序无关。 */
/** 生成/执行成本代理：只统计客户端经 stdio/HTTP 发起的工具调用（ADR-0006），
 * 用调用数与耗时近似投入，不读计费单价，因此不声称金额。 */
export interface PanelUsageCostView {
  available: boolean;
  days: number;
  total: number;
  successRate: number;
  p95: number | null;
  generation: { calls: number; p95: number | null };
  execution: { calls: number; p95: number | null };
  other: { calls: number };
  top: Array<{ tool: string; calls: number; p95: number | null }>;
}

const GENERATION_TOOLS = new Set([
  "design_to_test",
  "figma_extract_flows",
  "figma_generate_tests",
  "figma_import_assets",
  "figma_import_strings",
  "figma_import_tokens",
  "figma_export_brief",
  "pen_extract_flows",
  "pen_import_assets",
  "pen_import_strings",
  "pen_import_tokens",
  "pen_export_brief",
  "pen_agent"
]);

function toolCostClass(tool: string): "generation" | "execution" | "other" {
  if (GENERATION_TOOLS.has(tool) || tool.startsWith("figma_") || tool.startsWith("pen_")) {
    return "generation";
  }
  if (
    tool === "run_regression" ||
    tool === "verify_jira_issue" ||
    tool.startsWith("mobile_")
  ) {
    return "execution";
  }
  return "other";
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export function buildPanelUsageCostView(
  events: readonly UsageEventRecord[],
  days = 7
): PanelUsageCostView {
  const summary = usageSummary(events);
  const generationDurations: number[] = [];
  const executionDurations: number[] = [];
  let other = 0;
  for (const event of events) {
    const kind = toolCostClass(event.tool);
    if (kind === "generation") generationDurations.push(event.durationMs);
    else if (kind === "execution") executionDurations.push(event.durationMs);
    else other += 1;
  }
  return {
    available: events.length > 0,
    days,
    total: summary.total,
    successRate: summary.successRate,
    p95: summary.p95,
    generation: { calls: generationDurations.length, p95: p95(generationDurations) },
    execution: { calls: executionDurations.length, p95: p95(executionDurations) },
    other: { calls: other },
    top: summary.byTool.slice(0, 5).map((entry) => ({
      tool: entry.tool,
      calls: entry.count,
      p95: entry.p95
    }))
  };
}

export interface FeatureStat {
  featureKey: string;
  featureName: string | null;
  runs: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number | null;
  trend: Array<"pass" | "fail">;
  failureDomains: Record<string, number>;
  verdicts: Record<string, number>;
}

export interface CaseStat {
  caseId: string;
  caseSetId: string;
  name: string;
  featureName: string | null;
  runs: number;
  failed: number;
  consecutiveFailures: number;
  flaky: number;
  lastStatus: string | null;
  lastFailureDomain: string | null;
  verdict: string | null;
}

export interface PanelRegressionStats {
  features: FeatureStat[];
  unstableCases: CaseStat[];
  verdictTotals: Record<string, number>;
  crossPlatform: Array<{ caseId: string; name: string; results: Record<string, string> }>;
}

interface CaseHistoryEntry {
  status: string;
  failureDomain: string | null;
  verdict: string | null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function outcomeOf(status: string): "passed" | "failed" {
  return status === "passed" ? "passed" : "failed";
}

export function buildRegressionStats(runs: SuiteRunRecord[]): PanelRegressionStats {
  const ordered = [...runs].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0
  );
  const features = new Map<string, FeatureStat>();
  const caseHistories = new Map<string, CaseStat & { history: CaseHistoryEntry[] }>();
  const verdictTotals: Record<string, number> = {};
  const latestByCaseSetPlatform = new Map<string, Map<string, SuiteRunRecord>>();

  for (const run of ordered) {
    if (run.featureKey === null) continue;

    const feature = features.get(run.featureKey) ?? {
      featureKey: run.featureKey,
      featureName: run.featureName,
      runs: 0,
      total: 0,
      passed: 0,
      failed: 0,
      passRate: null,
      trend: [],
      failureDomains: {},
      verdicts: {}
    };
    if (feature.featureName === null && run.featureName !== null) {
      feature.featureName = run.featureName;
    }
    feature.runs += 1;
    feature.total += run.total;
    feature.passed += run.passed;
    feature.failed += run.failed;
    if (feature.trend.length < 10) {
      feature.trend.push(
        run.gateResult === "pass"
          ? "pass"
          : run.gateResult === "fail"
            ? "fail"
            : run.failed === 0
              ? "pass"
              : "fail"
      );
    }
    for (const [domain, count] of Object.entries(run.failureDomains)) {
      feature.failureDomains[domain] = (feature.failureDomains[domain] ?? 0) + count;
    }
    for (const entry of run.cases) {
      if (entry.verdict === null) continue;
      feature.verdicts[entry.verdict] = (feature.verdicts[entry.verdict] ?? 0) + 1;
      verdictTotals[entry.verdict] = (verdictTotals[entry.verdict] ?? 0) + 1;
    }
    features.set(run.featureKey, feature);

    if (run.caseSetId !== null) {
      for (const entry of run.cases) {
        const key = `${run.caseSetId}|${entry.caseId}`;
        const stat = caseHistories.get(key) ?? {
          caseId: entry.caseId,
          caseSetId: run.caseSetId,
          name: entry.name,
          featureName: run.featureName,
          runs: 0,
          failed: 0,
          consecutiveFailures: 0,
          flaky: 0,
          lastStatus: null,
          lastFailureDomain: null,
          verdict: null,
          history: []
        };
        stat.runs += 1;
        if (entry.status !== "passed") stat.failed += 1;
        if (entry.flaky) stat.flaky += 1;
        stat.history.push({
          status: entry.status,
          failureDomain: entry.failureDomain,
          verdict: entry.verdict
        });
        caseHistories.set(key, stat);
      }

      const byPlatform =
        latestByCaseSetPlatform.get(run.caseSetId) ?? new Map<string, SuiteRunRecord>();
      if (!byPlatform.has(run.platform)) byPlatform.set(run.platform, run);
      latestByCaseSetPlatform.set(run.caseSetId, byPlatform);
    }
  }

  const featureList = [...features.values()].sort((a, b) => compareText(a.featureKey, b.featureKey));
  for (const feature of featureList) {
    feature.passRate = feature.total === 0 ? null : feature.passed / feature.total;
  }

  const unstableCases: CaseStat[] = [];
  for (const stat of caseHistories.values()) {
    stat.lastStatus = stat.history[0]?.status ?? null;
    stat.lastFailureDomain = stat.history[0]?.failureDomain ?? null;
    stat.verdict = stat.history.find((entry) => entry.verdict !== null)?.verdict ?? null;
    let consecutive = 0;
    for (const entry of stat.history) {
      if (entry.status === "passed") break;
      consecutive += 1;
    }
    stat.consecutiveFailures = consecutive;
    unstableCases.push({
      caseId: stat.caseId,
      caseSetId: stat.caseSetId,
      name: stat.name,
      featureName: stat.featureName,
      runs: stat.runs,
      failed: stat.failed,
      consecutiveFailures: stat.consecutiveFailures,
      flaky: stat.flaky,
      lastStatus: stat.lastStatus,
      lastFailureDomain: stat.lastFailureDomain,
      verdict: stat.verdict
    });
  }
  unstableCases.sort(
    (a, b) =>
      b.failed - a.failed ||
      b.consecutiveFailures - a.consecutiveFailures ||
      compareText(a.caseSetId, b.caseSetId) ||
      compareText(a.caseId, b.caseId)
  );

  const crossPlatform: PanelRegressionStats["crossPlatform"] = [];
  const seenCases = new Set<string>();
  for (const byPlatform of latestByCaseSetPlatform.values()) {
    const deltas = crossPlatformDeltas(
      [...byPlatform.entries()].map(([platform, run]) => ({
        platform,
        cases: run.cases.map((entry): CompareCaseInput => ({
          caseId: entry.caseId,
          name: entry.name,
          outcome: outcomeOf(entry.status)
        }))
      }))
    );
    for (const delta of deltas) {
      if (seenCases.has(delta.caseId)) continue;
      seenCases.add(delta.caseId);
      crossPlatform.push(delta);
    }
  }
  crossPlatform.sort((a, b) => compareText(a.caseId, b.caseId));

  return { features: featureList, unstableCases, verdictTotals, crossPlatform };
}
