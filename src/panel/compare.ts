import { collectVerdictExits } from "../tasks/verdict-exits.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import { errorMessage } from "../util.js";
import type { SuiteRunRecord, ProjectStore } from "../db/types.js";
import {
  alignFeatureRuns,
  type FeatureAlignmentGroup,
  type FeatureAlignmentInput
} from "./feature-alignment.js";
import {
  buildPanelOverview,
  type PanelDeps,
  type PanelLamp,
  type PanelProjectRow
} from "./overview.js";

/** 跨项目对比聚合（回归服务 P3c）：行集合复用总览项目行（灯/lampReasons），
 * 逐项目聚合最近血统运行窗口 → 关注序排序 → 封顶 50。行级 try/catch 降级。 */

export const PANEL_COMPARE_ROW_CAP = 50;
export const PANEL_COMPARE_RUNS_LIMIT = 40;
export const PANEL_COMPARE_WINDOW = 20;
export const PANEL_COMPARE_TREND_LIMIT = 10;
export const PANEL_COMPARE_DOMAIN_TOP = 3;
export const PANEL_COMPARE_TASK_LIMIT = 200;
export const PANEL_COMPARE_RUNNER_LIMIT = 100;

export interface PanelCompareProject {
  name: string;
  rootPath: string;
  hostId: string | null;
  lamp: PanelLamp;
  lampReasons: string[];
  /** 集成轴就绪（LLM/Figma/Jira）：只报告，不参与执行灯。 */
  integration: { ready: number; total: number; missing: string[] };
  latestBatch: { at: string | null; gate: "pass" | "fail" | null; passRate: number | null } | null;
  /** 时间升序 ≤10 */
  trend: Array<{ at: string | null; passRate: number | null }>;
  flaky: number;
  /** top3（count 降序、domain 升序） */
  domains: Array<{ domain: string; count: number }>;
  pendingVerdicts: number;
  unissuedAppDefects: number;
  taskBacklog: { pending: number; claimed: number; running: number; failed: number };
  runners: { online: number; devices: number };
  schedules: { enabled: number; lastFiredAt: string | null };
  error: string | null;
}

export interface PanelCompareView {
  ok: true;
  generatedAt: string;
  store: { kind: "postgres" | "file" | "memory"; degraded: boolean };
  window: { runs: number };
  projects: PanelCompareProject[];
  truncated: boolean;
  warnings: string[];
  featureAlignment: { groups: FeatureAlignmentGroup[]; unmatched: number };
}

/** gate 归一：非 pass/fail 一律 null（如 canceled/skipped 等门禁结果不入排序信号）。 */
function normalizeGate(gateResult: string | null): "pass" | "fail" | null {
  return gateResult === "pass" ? "pass" : gateResult === "fail" ? "fail" : null;
}

function passRateOf(total: number, passed: number): number | null {
  return total > 0 ? passed / total : null;
}

/** 关注优先排序 + 封顶（纯 helper，便于单测）：rank（无批次 0 → fail 1 → 其余 2）
 * 升序 → passRate 升序（null 后置）→ name 升序（稳定）。 */
export function selectCompareRows(
  rows: PanelCompareProject[],
  cap: number = PANEL_COMPARE_ROW_CAP
): { rows: PanelCompareProject[]; truncated: boolean } {
  const sorted = [...rows].sort((left, right) => {
    const leftRank = compareRank(left);
    const rightRank = compareRank(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftRate = left.latestBatch?.passRate ?? null;
    const rightRate = right.latestBatch?.passRate ?? null;
    if (leftRate !== null && rightRate !== null && leftRate !== rightRate) {
      return leftRate - rightRate;
    }
    if (leftRate === null && rightRate !== null) return 1;
    if (leftRate !== null && rightRate === null) return -1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const truncated = sorted.length > cap;
  return { rows: sorted.slice(0, cap), truncated };
}

function compareRank(row: PanelCompareProject): number {
  if (row.latestBatch === null) return 0;
  return row.latestBatch.gate === "fail" ? 1 : 2;
}

function emptyCompareRow(row: PanelProjectRow): PanelCompareProject {
  return {
    name: row.name,
    rootPath: row.rootPath,
    hostId: row.hostId,
    lamp: row.lamp,
    lampReasons: row.lampReasons,
    integration: row.integration,
    latestBatch: null,
    trend: [],
    flaky: 0,
    domains: [],
    pendingVerdicts: 0,
    unissuedAppDefects: 0,
    taskBacklog: { pending: 0, claimed: 0, running: 0, failed: 0 },
    runners: { online: 0, devices: 0 },
    schedules: { enabled: 0, lastFiredAt: null },
    error: null
  };
}

function compareStore(deps: PanelDeps, hostId: string | null): ProjectStore {
  if (hostId === null) return deps.store;
  const injected = deps.storeForHost?.(hostId);
  if (injected) return injected;
  try {
    return deps.store.scopeHost(hostId);
  } catch {
    return deps.store;
  }
}

async function buildCompareRow(
  deps: PanelDeps,
  row: PanelProjectRow,
  nowMs: number
): Promise<{ row: PanelCompareProject; runs: FeatureAlignmentInput["runs"]; sets: FeatureAlignmentInput["sets"] }> {
  const base = emptyCompareRow(row);
  const store = compareStore(deps, row.hostId);
  let lineage: SuiteRunRecord[] = [];
  try {
    const runs = await store.listSuiteRuns(row.rootPath, { limit: PANEL_COMPARE_RUNS_LIMIT });
    lineage = runs.filter((run) => run.featureKey !== null).slice(0, PANEL_COMPARE_WINDOW);

    if (lineage.length > 0) {
      const latest = lineage[0];
      base.latestBatch = {
        at: latest.finishedAt,
        gate: normalizeGate(latest.gateResult),
        passRate: passRateOf(latest.total, latest.passed)
      };
    }

    base.trend = lineage
      .slice(0, PANEL_COMPARE_TREND_LIMIT)
      .map((run) => ({ at: run.finishedAt, passRate: passRateOf(run.total, run.passed) }))
      .reverse();

    base.flaky = lineage.reduce((sum, run) => sum + run.flaky, 0);

    const domainTotals = new Map<string, number>();
    for (const run of lineage) {
      for (const [domain, count] of Object.entries(run.failureDomains)) {
        domainTotals.set(domain, (domainTotals.get(domain) ?? 0) + count);
      }
    }
    base.domains = [...domainTotals.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0))
      .slice(0, PANEL_COMPARE_DOMAIN_TOP);

    base.pendingVerdicts = lineage.reduce(
      (sum, run) =>
        sum + run.cases.filter((entry) => entry.status !== "passed" && entry.verdict === null).length,
      0
    );

    base.unissuedAppDefects = collectVerdictExits(lineage).appDefects.filter(
      (entry) => entry.jiraKey === null
    ).length;

    const tasks = await store.listRegressionTasks(row.rootPath, PANEL_COMPARE_TASK_LIMIT);
    const taskBacklog = { pending: 0, claimed: 0, running: 0, failed: 0 };
    for (const task of tasks) {
      if (task.status === "pending") taskBacklog.pending += 1;
      else if (task.status === "claimed") taskBacklog.claimed += 1;
      else if (task.status === "running") taskBacklog.running += 1;
      else if (task.status === "failed") taskBacklog.failed += 1;
    }
    base.taskBacklog = taskBacklog;

    const ttlMs = runnerTtlFrom(deps.env ?? process.env);
    const runners = await store.listRunners(row.rootPath, PANEL_COMPARE_RUNNER_LIMIT);
    let online = 0;
    let devices = 0;
    for (const runner of runners) {
      if (isRunnerOnline(runner.lastSeenAt, nowMs, ttlMs)) {
        online += 1;
        devices += runner.devices.length;
      }
    }
    base.runners = { online, devices };

    const schedules = await store.listSchedules(row.rootPath);
    let enabled = 0;
    let lastFiredAt: string | null = null;
    for (const schedule of schedules) {
      if (schedule.enabled) enabled += 1;
      if (schedule.lastFiredAt !== null && (lastFiredAt === null || schedule.lastFiredAt > lastFiredAt)) {
        lastFiredAt = schedule.lastFiredAt;
      }
    }
    base.schedules = { enabled, lastFiredAt };
  } catch (error) {
    base.error = errorMessage(error);
  }

  let sets: FeatureAlignmentInput["sets"] = null;
  try {
    const caseSets = await store.listCaseSets(row.rootPath);
    sets = caseSets.map((set) => ({
      id: set.id,
      source: set.source,
      features: set.features.map((feature) => ({ key: feature.key, name: feature.name }))
    }));
  } catch {
    sets = null;
  }

  return { row: base, runs: lineage, sets };
}

export async function buildPanelCompare(deps: PanelDeps): Promise<PanelCompareView> {
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const overview = await buildPanelOverview(deps);

  const projects: PanelCompareProject[] = [];
  const builds: Array<{ row: PanelCompareProject; runs: FeatureAlignmentInput["runs"]; sets: FeatureAlignmentInput["sets"] }> = [];
  for (const row of overview.projects) {
    const built = await buildCompareRow(deps, row, nowMs);
    builds.push(built);
    projects.push(built.row);
  }

  const { rows, truncated } = selectCompareRows(projects, PANEL_COMPARE_ROW_CAP);
  const warnings: string[] = [];
  if (truncated) {
    warnings.push(`项目数 ${projects.length} 超上限 ${PANEL_COMPARE_ROW_CAP}：仅显示关注序前 ${PANEL_COMPARE_ROW_CAP}`);
  }

  const featureAlignment = alignFeatureRuns(
    builds.map((built) => ({
      name: built.row.name,
      rootPath: built.row.rootPath,
      runs: built.runs,
      sets: built.sets
    }))
  );

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    store: { kind: deps.store.kind, degraded: deps.store.kind === "memory" },
    window: { runs: PANEL_COMPARE_WINDOW },
    projects: rows,
    truncated,
    warnings,
    featureAlignment
  };
}
