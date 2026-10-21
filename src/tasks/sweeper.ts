import type { ProjectStore, RegressionTaskRecord } from "../db/types.js";
import { logWarn } from "../log.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";

export const CANCEL_GRACE_DEFAULT_MS = 90_000;
export const SWEEP_INTERVAL_MS = 30_000;

const TASK_SCAN_LIMIT = 100_000;
const RUNNER_SCAN_LIMIT = 100_000;

export interface SweepStaleTasksInput {
  store: ProjectStore;
  rootPath?: string;
  now?: () => number;
  graceMs?: number;
  runnerTtlMs?: number;
}

export interface SweepStaleTasksResult {
  cancelled: number;
  /** 恒为 0：清扫只把 `stopping` 终态化为 `cancelled`，绝不回退 `pending`。 */
  released: number;
}

export function cancelGraceMsFrom(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AOS_CANCEL_GRACE_MS ?? "").trim();
  if (raw === "") return CANCEL_GRACE_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : CANCEL_GRACE_DEFAULT_MS;
}

function withinGrace(task: RegressionTaskRecord, cutoff: string): boolean {
  if (task.cancelRequestedAt === null) return task.cancelSource === null;
  return task.cancelRequestedAt <= cutoff;
}

/** 多宿主幂等的离线取消清扫（DESIGN §13.163）：宽限期内不动；领取执行机在线不动；
 * 其余 `stopping` 经 CAS 终态化为 `cancelled`。项目按自身 host 作用域隔离。 */
export async function sweepStaleTasks(
  input: SweepStaleTasksInput
): Promise<SweepStaleTasksResult> {
  const nowMs = (input.now ?? ((): number => Date.now()))();
  const graceMs = input.graceMs ?? cancelGraceMsFrom(process.env);
  const runnerTtlMs = input.runnerTtlMs ?? runnerTtlFrom(process.env);
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const at = new Date(nowMs).toISOString();
  const localHostId = input.store.localHostId;

  let projects;
  try {
    projects = await input.store.listProjects();
  } catch (error) {
    logWarn(`取消清扫读取项目失败：${error instanceof Error ? error.message : String(error)}`);
    return { cancelled: 0, released: 0 };
  }

  let cancelled = 0;
  for (const project of projects) {
    if (input.rootPath !== undefined && project.rootPath !== input.rootPath) continue;
    if (localHostId !== null && project.hostId !== null && project.hostId !== localHostId) {
      continue;
    }
    const scoped = project.hostId !== null ? input.store.scopeHost(project.hostId) : input.store;
    try {
      cancelled += await sweepProject(scoped, project.rootPath, {
        nowMs,
        cutoff,
        at,
        runnerTtlMs
      });
    } catch (error) {
      logWarn(
        `取消清扫失败（${project.rootPath}）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { cancelled, released: 0 };
}

async function sweepProject(
  store: ProjectStore,
  rootPath: string,
  options: { nowMs: number; cutoff: string; at: string; runnerTtlMs: number }
): Promise<number> {
  const tasks = await store.listRegressionTasks(rootPath, TASK_SCAN_LIMIT);
  const stale = tasks.filter(
    (task) => task.status === "stopping" && withinGrace(task, options.cutoff)
  );
  if (stale.length === 0) return 0;

  const runners = await store.listRunners(rootPath, RUNNER_SCAN_LIMIT);
  const byId = new Map(runners.map((runner) => [runner.id, runner]));
  let cancelled = 0;
  for (const task of stale) {
    const claimed = task.claimedBy === null ? null : (byId.get(task.claimedBy) ?? null);
    if (claimed !== null && isRunnerOnline(claimed.lastSeenAt, options.nowMs, options.runnerTtlMs)) {
      continue;
    }
    const legacy = task.cancelSource === null;
    const finalized = await store.finalizeCancellation({
      rootPath,
      taskId: task.id,
      at: options.at,
      note: legacy ? "legacy-stopping" : (task.cancelNote ?? "runner-offline"),
      source: legacy ? "panel" : null
    });
    if (finalized !== null) cancelled += 1;
  }
  return cancelled;
}
