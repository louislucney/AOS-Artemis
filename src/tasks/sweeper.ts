import { AmbiguousProjectError, type ProjectStore, type RegressionTaskRecord } from "../db/types.js";
import { logWarn } from "../log.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";

export const CANCEL_GRACE_DEFAULT_MS = 90_000;
export const SWEEP_INTERVAL_MS = 30_000;

export interface SweepStaleTasksInput {
  store: ProjectStore;
  rootPath?: string;
  /** 中心清扫：忽略本机过滤，按每个项目自身 host（含 NULL legacy）作用域读取。 */
  allHosts?: boolean;
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

function isPastGrace(task: RegressionTaskRecord, cutoff: string): boolean {
  if (task.cancelRequestedAt !== null) return task.cancelRequestedAt <= cutoff;
  return task.cancelSource === null;
}

function appendedNote(note: string | null, marker: string): string {
  return note === null || note.trim() === "" ? marker : `${note}; ${marker}`;
}

function claimedRunnerIsOnline(
  task: RegressionTaskRecord,
  runner: { lastSeenAt: string; instanceId: string | null } | null,
  nowMs: number,
  runnerTtlMs: number
): boolean {
  if (task.claimedBy === null || runner === null) return false;
  if (
    task.claimedInstanceId !== null &&
    runner.instanceId !== null &&
    task.claimedInstanceId !== runner.instanceId
  ) {
    return false;
  }
  return isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtlMs);
}

/** 多宿主幂等的离线取消清扫（DESIGN §13.163/§13.164）：宽限期内不动；领取执行机在线且
 * instance 未轮换不动；其余 `stopping` 经 CAS 终态化为 `cancelled`。 */
export async function sweepStaleTasks(
  input: SweepStaleTasksInput
): Promise<SweepStaleTasksResult> {
  const nowMs = (input.now ?? ((): number => Date.now()))();
  const graceMs = input.graceMs ?? cancelGraceMsFrom(process.env);
  const runnerTtlMs = input.runnerTtlMs ?? runnerTtlFrom(process.env);
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const at = new Date(nowMs).toISOString();
  const localHostId = input.store.localHostId;
  const allHosts = input.allHosts === true;

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
    if (!allHosts && localHostId !== null && project.hostId !== null && project.hostId !== localHostId) {
      continue;
    }
    const scoped =
      allHosts || project.hostId !== null
        ? input.store.scopeHost(project.hostId)
        : input.store;
    try {
      cancelled += await sweepProject(scoped, project.rootPath, {
        nowMs,
        cutoff,
        at,
        runnerTtlMs
      });
    } catch (error) {
      if (error instanceof AmbiguousProjectError) continue;
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
  const stale = (
    await store.listStoppingTasks({ rootPath, deadline: options.cutoff })
  ).filter((task) => isPastGrace(task, options.cutoff));
  if (stale.length === 0) return 0;

  const runnerCache = new Map<string, { lastSeenAt: string; instanceId: string | null } | null>();
  let cancelled = 0;
  for (const task of stale) {
    let runner: { lastSeenAt: string; instanceId: string | null } | null = null;
    if (task.claimedBy !== null) {
      if (!runnerCache.has(task.claimedBy)) {
        const record = await store.getRunner(rootPath, task.claimedBy);
        runnerCache.set(
          task.claimedBy,
          record === null
            ? null
            : { lastSeenAt: record.lastSeenAt, instanceId: record.instanceId }
        );
      }
      runner = runnerCache.get(task.claimedBy) ?? null;
    }
    if (claimedRunnerIsOnline(task, runner, options.nowMs, options.runnerTtlMs)) continue;
    const legacy = task.cancelSource === null;
    const marker = legacy ? "legacy-stopping" : "runner-offline";
    const finalized = await store.finalizeCancellation({
      rootPath,
      taskId: task.id,
      at: options.at,
      note: appendedNote(task.cancelNote, marker),
      source: legacy ? "panel" : null
    });
    if (finalized === null) continue;
    cancelled += 1;
    try {
      await store.recordAudit(rootPath, {
        domain: "task",
        action: "task.cancel.sweep",
        result: "ok",
        summary: `离线清扫终结取消：${task.id}（${marker}）`,
        refs: {
          taskId: task.id,
          source: legacy ? "panel" : (task.cancelSource ?? undefined)
        },
        at: options.at
      });
    } catch {
      /* 审计 best-effort */
    }
  }
  return cancelled;
}
