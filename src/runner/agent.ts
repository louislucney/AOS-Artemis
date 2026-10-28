import { randomUUID } from "node:crypto";
import os from "node:os";

import { defaultBuildRuntime, type CliRuntimeBundle } from "../cli-runtime.js";
import { recordAuditSafe } from "../db/audit-event.js";
import {
  deviceLeaseTtlMs,
  RunnerAlreadyActiveError,
  type RegressionTaskRecord,
  type RunnerRecord
} from "../db/types.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";
import { sweepStaleTasks, SWEEP_INTERVAL_MS } from "../tasks/sweeper.js";
import { hostAddressHistoryFrom } from "../host/online.js";
import {
  collectHostSnapshot,
  upsertHostInputFromSnapshot,
  type HostSnapshot
} from "./host-snapshot.js";
import { collectRunnerInventory, type RunnerInventory } from "./inventory.js";
import { fireDueSchedules } from "./schedules.js";
import { runnerTtlFrom } from "./status.js";

export interface RunnerAgentIO {
  log: (line: string) => void;
  errorLog: (line: string) => void;
}

export interface RunnerTimerHandle {
  cancel: () => void;
  unref?: () => void;
}

export interface RunnerAgentOptions {
  projectDir?: string | null;
  name?: string;
  pollMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  schedulesEnabled?: boolean;
  once?: boolean;
  shouldStop?: () => boolean;
  artifactBaseUrl?: string | null;
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
  buildRuntime?: (projectDir: string | null) => Promise<CliRuntimeBundle>;
  executeSuite: (argv: string[], options?: { shouldAbort?: () => boolean }) => Promise<number | null>;
  collectInventory?: () => Promise<RunnerInventory>;
  collectHostSnapshot?: (input: {
    projectRoot: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<HostSnapshot>;
  /** 可选任务硬上限（毫秒；缺省读 `AOS_TASK_MAX_RUNTIME_MS`，0/非法关闭）。 */
  maxRuntimeMs?: number;
  scheduleTimeout?: (fn: () => void, ms: number) => RunnerTimerHandle;
  io?: RunnerAgentIO;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const STOP_POLL_MS = 3_000;

const EMPTY_INVENTORY: RunnerInventory = {
  platforms: [],
  devices: [],
  tools: {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false
  }
};

/** runner 常驻循环（DESIGN §13.109）：心跳循环与主循环解耦（执行期间不失联）；
 * 启动释放自己的未完成领取；执行异常释放本次领取；`once` 单轮冒烟、`shouldStop` 优雅退出。 */
export async function runRunnerAgent(options: RunnerAgentOptions): Promise<number> {
  const env = options.env ?? process.env;
  const name = options.name?.trim() || os.hostname();
  const pollMs = options.pollMs ?? intFromEnv(env.AOS_RUNNER_POLL_MS, 5_000);
  const configuredHeartbeatMs =
    options.heartbeatMs ?? intFromEnv(env.AOS_RUNNER_HEARTBEAT_MS, 30_000);
  const heartbeatMs = clampRunnerHeartbeatMs(configuredHeartbeatMs, env);
  const maxAttempts = options.maxAttempts ?? intFromEnv(env.AOS_RUNNER_MAX_ATTEMPTS, 3);
  const configuredMaxRuntimeMs =
    options.maxRuntimeMs ?? runtimeCapFromEnv(env.AOS_TASK_MAX_RUNTIME_MS);
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((fn: () => void, ms: number): RunnerTimerHandle => {
      const timer = setTimeout(fn, ms);
      return {
        cancel: () => clearTimeout(timer),
        unref: () => timer.unref()
      };
    });
  const runnerTtlMs = runnerTtlFrom(env);
  const staleClaimMs = staleClaimMsFromEnv(env.AOS_RUNNER_STALE_CLAIM_MS);
  const partialClaim = env.AOS_RUNNER_PARTIAL_CLAIM === "1";
  const envRefreshMs = intFromEnv(env.AOS_HOST_ENV_REFRESH_MS, 600_000);
  const schedulesEnabled =
    options.schedulesEnabled ?? (env.AOS_RUNNER_SCHEDULES ?? "").trim() !== "0";
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const io = options.io ?? {
    log: (line: string): void => console.log(line),
    errorLog: (line: string): void => console.error(line)
  };
  const maxRuntimeMs = clampRuntimeCap(configuredMaxRuntimeMs, io);
  if (heartbeatMs < configuredHeartbeatMs) {
    io.log(
      `[runner] 心跳间隔 ${configuredHeartbeatMs}ms 超过设备租约 TTL/3，已收敛为 ${heartbeatMs}ms（否则租约可能先过期）`
    );
  }
  const buildRuntime = options.buildRuntime ?? defaultBuildRuntime;
  const collectInventory = options.collectInventory ?? ((): Promise<RunnerInventory> =>
    collectRunnerInventory({ env }));
  const collectSnapshot =
    options.collectHostSnapshot ??
    ((input: { projectRoot: string; env: NodeJS.ProcessEnv }): Promise<HostSnapshot> =>
      collectHostSnapshot(input));
  const once = options.once === true;
  const stopped = (): boolean => options.shouldStop?.() === true;

  const bundle = await buildRuntime(options.projectDir ?? null);
  try {
    const store = bundle.runtime.store;
    const rootPath = bundle.runtime.project.rootDir;
    let inventory: RunnerInventory = EMPTY_INVENTORY;
    let snapshot: HostSnapshot = await collectSnapshot({ projectRoot: rootPath, env });
    let snapshotAt = now();
    const instanceId = options.instanceId ?? randomUUID();

    const refreshInventory = async (): Promise<void> => {
      try {
        inventory = await collectInventory();
      } catch {
        /* 保留上次清单 */
      }
    };
    const refreshSnapshot = async (): Promise<void> => {
      if (now() - snapshotAt < envRefreshMs) return;
      try {
        snapshot = await collectSnapshot({ projectRoot: rootPath, env });
        snapshotAt = now();
      } catch {
        /* 保留上次快照 */
      }
    };
    const heartbeat = async (): Promise<RunnerRecord> => {
      await refreshInventory();
      await refreshSnapshot();
      const hostId = snapshot.identity.id;
      const seenAt = new Date(now()).toISOString();
      await store.upsertHost(upsertHostInputFromSnapshot(snapshot, hostId, seenAt));
      await store.upsertHostAddresses({
        hostId,
        addresses: snapshot.addresses,
        at: seenAt,
        ...(hostAddressHistoryFrom(env) ? {} : { maxPerSource: 1 })
      });
      return store.upsertRunner({
        rootPath,
        name,
        hostname: os.hostname(),
        platforms: inventory.platforms,
        devices: inventory.devices,
        tools: inventory.tools,
        artifactBaseUrl: options.artifactBaseUrl ?? null,
        version: AOS_MCP_VERSION,
        hostId,
        instanceId,
        activeWithinMs: runnerTtlMs
      });
    };

    await refreshInventory();
    let me: RunnerRecord;
    let runnerId: string | null = null;
    try {
      me = await heartbeat();
    } catch (error) {
      if (error instanceof RunnerAlreadyActiveError) {
        io.errorLog(`[runner] 双启保护：${error.message}`);
      } else {
        io.errorLog(`[runner] 首轮心跳失败：${errorMessage(error)}`);
      }
      return 2;
    }
    runnerId = me.id;
    io.log(
      `[runner] 启动：name=${name} project=${rootPath}（端 ${inventory.platforms.join(",") || "无"}）`
    );

    try {
      const released = await store.releaseRegressionTasks({ rootPath, runnerId: me.id });
      if (released > 0) io.log(`[runner] 释放未完成领取：${released} 条`);
    } catch (error) {
      io.errorLog(`[runner] 释放未完成领取失败：${errorMessage(error)}`);
    }
    try {
      let drained = 0;
      for (const task of await store.listStoppingTasks({ rootPath })) {
        if (task.claimedBy !== me.id) continue;
        const legacy = task.cancelSource === null;
        const finalized = await store.finalizeCancellation({
          rootPath,
          taskId: task.id,
          note:
            task.cancelNote === null || task.cancelNote.trim() === ""
              ? "runner-restart"
              : `${task.cancelNote}; runner-restart`,
          source: legacy ? "panel" : null
        });
        if (finalized !== null) drained += 1;
      }
      if (drained > 0) io.log(`[runner] 重启终结遗留停止任务：${drained} 条`);
    } catch (error) {
      io.errorLog(`[runner] 重启终结遗留停止任务失败：${errorMessage(error)}`);
    }
    const projectId = (await store.getProjectByPath(rootPath).catch(() => null))?.id ?? null;
    let active: { taskId: string; serials: string[] } | null = null;
    let leaseLost = false;

    const settleClaimFailure = async (
      taskId: string,
      context: string
    ): Promise<"stopped" | "released"> => {
      const acknowledged = await store
        .ackCancellation({ rootPath, taskId })
        .catch(() => null);
      let fresh = acknowledged;
      if (fresh === null) {
        fresh = await store.getRegressionTask(rootPath, taskId).catch(() => null);
      }
      if (fresh?.status === "cancelled" || fresh?.status === "stopped") {
        io.log(
          `[runner] 任务 ${taskId} 在领取与执行之间被取消（${context}）：已确认 cancelled（不执行、不释放）`
        );
        return "stopped";
      }
      if (fresh?.status === "stopping") {
        io.log(
          `[runner] 任务 ${taskId} 在领取与执行之间取消确认未生效（${context}）：仍为 stopping，等待心跳/收尾兜底`
        );
        return "stopped";
      }
      await store
        .releaseRegressionTask({ rootPath, runnerId: me.id, taskId, to: "pending" })
        .catch(() => false);
      return "released";
    };

    const tick = async (): Promise<void> => {
      try {
        await heartbeat();
      } catch (error) {
        io.errorLog(`[runner] 心跳失败：${errorMessage(error)}`);
      }
      const current = active;
      if (current === null) return;
      const at = new Date(now()).toISOString();
      try {
        await store.updateRegressionTask(rootPath, current.taskId, { lastProgressAt: at });
      } catch (error) {
        io.errorLog(`[runner] 任务 ${current.taskId} 进度写入失败：${errorMessage(error)}`);
      }
      try {
        const renewed = await store.renewDeviceLeases({
          hostId: snapshot.identity.id,
          taskId: current.taskId,
          serials: current.serials,
          at
        });
        if (renewed < current.serials.length) {
          leaseLost = true;
          io.errorLog(
            `[runner] 任务 ${current.taskId} 设备租约丢失（续租 ${renewed}/${current.serials.length}）：停止执行并释放领取`
          );
        }
      } catch (error) {
        leaseLost = true;
        io.errorLog(
          `[runner] 任务 ${current.taskId} 设备租约续期失败（停止执行并释放领取）：${errorMessage(error)}`
        );
      }
    };

    let stopHeartbeat = false;
    let heartbeatTask: Promise<void> = Promise.resolve();
    if (!once) {
      heartbeatTask = (async (): Promise<void> => {
        while (!stopHeartbeat) {
          let waited = 0;
          while (waited < heartbeatMs && !stopHeartbeat) {
            const step = Math.min(HEARTBEAT_STOP_STEP_MS, heartbeatMs - waited);
            await sleep(step);
            waited += step;
          }
          if (stopHeartbeat) break;
          try {
            await tick();
          } catch (error) {
            io.errorLog(`[runner] 心跳失败：${errorMessage(error)}`);
          }
        }
      })();
    }

    try {
      let lastSweepAt = Number.NEGATIVE_INFINITY;
      while (!stopped()) {
        const nowMs = now();
        if (nowMs - lastSweepAt >= SWEEP_INTERVAL_MS) {
          lastSweepAt = nowMs;
          try {
            const swept = await sweepStaleTasks({ store, rootPath, now, runnerTtlMs });
            if (swept.cancelled > 0) {
              io.log(`[runner] 离线取消终结：${swept.cancelled} 条`);
            }
          } catch (error) {
            io.errorLog(`[runner] 离线取消清扫失败：${errorMessage(error)}`);
          }
        }
        if (staleClaimMs > 0) {
          try {
            const reclaimed = await store.releaseStaleClaims({
              rootPath,
              offlineBefore: new Date(nowMs - runnerTtlMs).toISOString(),
              claimedBefore: new Date(nowMs - staleClaimMs).toISOString()
            });
            if (reclaimed > 0) io.log(`[runner] 回收失联领取：${reclaimed} 条`);
          } catch (error) {
            io.errorLog(`[runner] 回收失联领取失败：${errorMessage(error)}`);
          }
        }
        if (schedulesEnabled) {
          try {
            await fireDueSchedules({ store, rootPath, now, io });
          } catch (error) {
            io.errorLog(`[runner] 调度检查失败：${errorMessage(error)}`);
          }
        }
        const currentInventory = inventory;
        let task: RegressionTaskRecord | null;
        try {
          task = await store.claimRegressionTask({
            rootPath,
            runnerId: me.id,
            hostId: snapshot.identity.id,
            instanceId,
            capabilities: snapshot.capabilities,
            platforms: currentInventory.platforms,
            onlineBefore: new Date(nowMs - runnerTtlMs).toISOString(),
            allowPartial: partialClaim
          });
        } catch (error) {
          io.errorLog(`[runner] 领取失败：${errorMessage(error)}`);
          if (once) return 0;
          await sleep(pollMs);
          continue;
        }
        if (!task) {
          if (once) return 0;
          await sleep(pollMs);
          continue;
        }

        if (task.attempts >= maxAttempts) {
          try {
            const released = await store.releaseRegressionTask({
              rootPath,
              runnerId: me.id,
              taskId: task.id,
              to: "failed"
            });
            if (released) {
              io.log(
                `[runner] 任务 ${task.id} 已尝试 ${task.attempts} 次，超上限 ${maxAttempts}，标记 failed（毒丸防护，不进入执行）`
              );
            } else {
              io.errorLog(
                `[runner] 任务 ${task.id} 超上限置 failed 失败（可能已被并发处理）`
              );
            }
          } catch (error) {
            io.errorLog(`[runner] 毒丸防护释放失败：${errorMessage(error)}`);
          }
          if (once) return 0;
          await sleep(pollMs);
          continue;
        }

        const taskPlatforms = task.platforms;
        const devices = currentInventory.devices
          .filter((device) => taskPlatforms.includes(device.platform))
          .map((device) => device.serial);
        const hostId = snapshot.identity.id;
        let acquired: boolean;
        try {
          const leases = await store.acquireDeviceLeases({
            hostId,
            taskId: task.id,
            projectId,
            serials: devices,
            at: new Date(nowMs).toISOString()
          });
          acquired = leases.ok;
          if (!leases.ok) {
            io.log(
              `[runner] 任务 ${task.id} device-busy（设备 ${leases.busy.join(",") || "无"} 被其他任务占用），停止本次领取（不计尝试）`
            );
          }
        } catch (error) {
          io.errorLog(`[runner] 任务 ${task.id} 设备租约获取失败：${errorMessage(error)}`);
          acquired = false;
        }
        if (!acquired) {
          const outcome = await settleClaimFailure(task.id, "设备租约获取失败");
          if (once) return 0;
          if (outcome === "released") await sleep(pollMs);
          continue;
        }

        let running: RegressionTaskRecord | null;
        try {
          running = await store.beginExecution({
            rootPath,
            taskId: task.id,
            runnerId: me.id,
            instanceId
          });
        } catch (error) {
          io.errorLog(`[runner] 任务 ${task.id} 开始执行失败：${errorMessage(error)}`);
          running = null;
        }
        if (running === null) {
          await store.releaseDeviceLeases({ hostId, taskId: task.id }).catch(() => 0);
          const outcome = await settleClaimFailure(task.id, "开始执行失败");
          if (once) return 0;
          if (outcome === "released") await sleep(pollMs);
          continue;
        }
        task = running;
        active = { taskId: task.id, serials: devices };
        leaseLost = false;

        const argv = [
          "run",
          "--task",
          task.id,
          ...(options.projectDir ? ["--project", options.projectDir] : []),
          ...devices.flatMap((serial) => ["--device", serial])
        ];
        try {
          const missing = task.platforms.filter(
            (platform) => !currentInventory.platforms.some((mine) => mine === platform)
          );
          if (missing.length > 0) {
            const covered = task.platforms.filter((platform) =>
              currentInventory.platforms.some((mine) => mine === platform)
            );
            io.log(
              `[runner] 领取任务 ${task.id}（部分端 ${covered.join(",")}，缺 ${missing.join(",")}——在线无全覆盖执行机）`
            );
          } else {
            io.log(
              `[runner] 领取任务 ${task.id}（端 ${task.platforms.join(",")} · 设备 ${devices.join(",") || "无"}）`
            );
          }
          let exitCode: number | null = null;
          let stopRequested = false;
          let stopAcked = false;
          let runtimeExceeded = false;
          let runtimeTimer: RunnerTimerHandle | null = null;
          if (maxRuntimeMs > 0) {
            runtimeTimer = scheduleTimeout(() => {
              runtimeExceeded = true;
              io.errorLog(
                `[runner] 任务 ${task.id} 超过 AOS_TASK_MAX_RUNTIME_MS（${maxRuntimeMs}ms）：请求中止并取消`
              );
            }, maxRuntimeMs);
            runtimeTimer.unref?.();
          }
          const stopPoll = setInterval(() => {
            void store
              .getRegressionTask(rootPath, task.id)
              .then(async (fresh) => {
                if (
                  fresh?.status !== "stopping" &&
                  fresh?.status !== "cancelled" &&
                  fresh?.status !== "stopped"
                ) {
                  return;
                }
                stopRequested = true;
                if (
                  (fresh.status === "stopping" || fresh.status === "stopped") &&
                  !stopAcked
                ) {
                  stopAcked = true;
                  await store
                    .ackCancellation({ rootPath, taskId: task.id })
                    .catch(() => null);
                  io.log(`[runner] 任务 ${task.id} 停止请求已确认（stopping → cancelled）`);
                }
              })
              .catch(() => {});
          }, STOP_POLL_MS);
          stopPoll.unref?.();
          try {
            exitCode = await options.executeSuite(argv, {
              shouldAbort: () => stopRequested || leaseLost || runtimeExceeded
            });
            io.log(`[runner] 任务 ${task.id} 执行结束（退出码 ${exitCode}）`);
          } catch (error) {
            io.errorLog(`[runner] 任务 ${task.id} 执行异常：${errorMessage(error)}`);
          } finally {
            clearInterval(stopPoll);
            runtimeTimer?.cancel();
          }
          const afterRun = await store.getRegressionTask(rootPath, task.id).catch(() => null);
          let afterStatus = afterRun?.status ?? null;
          if (afterStatus === "stopping") {
            const acked = await store
              .ackCancellation({ rootPath, taskId: task.id })
              .catch(() => null);
            if (acked) afterStatus = acked.status;
            io.log(`[runner] 任务 ${task.id} 停止请求已确认（收尾兜底）`);
          }
          if (afterStatus === "cancelled" || afterStatus === "stopped") {
            io.log(`[runner] 任务 ${task.id} 已取消（面板请求）：保留 cancelled，不释放、不重试`);
            if (once) return 0;
            continue;
          }
          if (runtimeExceeded) {
            const note = `任务超过 AOS_TASK_MAX_RUNTIME_MS（${maxRuntimeMs}）`;
            try {
              const requested = await store.cancelRegressionTask({
                rootPath,
                taskId: task.id,
                source: "runner",
                actor: "runner",
                actorHostId: hostId,
                note
              });
              const acked =
                requested === null
                  ? null
                  : await store.ackCancellation({ rootPath, taskId: task.id });
              if (acked !== null && (acked.status === "cancelled" || acked.status === "stopped")) {
                io.log(
                  `[runner] 任务 ${task.id} 超过 AOS_TASK_MAX_RUNTIME_MS（${maxRuntimeMs}ms）：已按取消终结（source=runner，不释放、不重试）`
                );
                await recordAuditSafe(store, rootPath, {
                  domain: "task",
                  action: "task.cancel",
                  result: "ok",
                  summary: `回归任务 ${task.id} 超过执行上限 ${maxRuntimeMs}ms，由 runner 取消（${hostId}）`,
                  refs: { taskId: task.id, source: "runner", hostId, note },
                  actor: "runner",
                  actorHostId: hostId,
                  channel: "runner"
                });
              } else {
                const status = acked?.status ?? requested?.status ?? "unknown";
                io.errorLog(
                  `[runner] 任务 ${task.id} 超时取消未生效（当前 ${status}）：未确认 cancelled，请检查面板/清扫器兜底`
                );
              }
            } catch (error) {
              io.errorLog(
                `[runner] 任务 ${task.id} 超时取消落库失败：${errorMessage(error)}`
              );
            }
            if (once) return 0;
            continue;
          }
          const failed = exitCode === null || exitCode !== 0;
          if (failed) {
            try {
              const exhausted = task.attempts >= maxAttempts;
              const released = await store.releaseRegressionTask({
                rootPath,
                runnerId: me.id,
                taskId: task.id,
                to: exhausted ? "failed" : "pending"
              });
              if (released) {
                io.log(
                  exhausted
                    ? `[runner] 任务 ${task.id} 第 ${task.attempts} 次失败（上限 ${maxAttempts}），标记 failed（不再自动重试；修复引用后请新建任务）`
                    : `[runner] 任务 ${task.id} 未达终态，已释放回待执行（第 ${task.attempts} 次尝试）`
                );
              } else {
                io.errorLog(
                  `[runner] 任务 ${task.id} 守卫释放未生效（可能已被并发处理/终态）`
                );
              }
            } catch (releaseError) {
              io.errorLog(`[runner] 释放任务失败：${errorMessage(releaseError)}`);
            }
          }
          if (once) return 0;
          if (failed) await sleep(pollMs);
        } finally {
          active = null;
          leaseLost = false;
          await store.releaseDeviceLeases({ hostId, taskId: task.id }).catch(() => 0);
        }
      }
      return 0;
    } finally {
      stopHeartbeat = true;
      await settleWithin(heartbeatTask, 2_000);
      if (runnerId !== null) {
        try {
          await store.markRunnerStopped({
            rootPath,
            runnerId,
            instanceId
          });
        } catch (error) {
          io.errorLog(`[runner] 标记停止失败：${errorMessage(error)}`);
        }
      }
    }
  } finally {
    await bundle.dispose();
  }
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** `AOS_TASK_MAX_RUNTIME_MS`：缺省/非法/<=0 一律关闭（0）。 */
function runtimeCapFromEnv(raw: string | undefined): number {
  const parsed = Number((raw ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const truncated = Math.trunc(parsed);
  return truncated > 0 ? truncated : 0;
}

/** setTimeout 的 32 位毫秒上限；超出会立即触发（1ms），故收敛并告警。 */
const MAX_TIMER_MS = 2_147_483_647;

function clampRuntimeCap(raw: number, io: RunnerAgentIO): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const truncated = Math.trunc(raw);
  if (truncated <= MAX_TIMER_MS) return truncated;
  io.errorLog(
    `[runner] AOS_TASK_MAX_RUNTIME_MS=${truncated} 超过 setTimeout 上限，已收敛为 ${MAX_TIMER_MS}ms`
  );
  return MAX_TIMER_MS;
}

/** tick 间隔不超过设备租约 TTL 的 1/3：续租失败后仍有一次 tick 的止损窗口。 */
export function clampRunnerHeartbeatMs(
  heartbeatMs: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const limit = Math.floor(deviceLeaseTtlMs(env) / 3);
  if (limit <= 0) return heartbeatMs;
  return Math.min(heartbeatMs, limit);
}

const STALE_CLAIM_DEFAULT_MS = 900_000;

function staleClaimMsFromEnv(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return STALE_CLAIM_DEFAULT_MS;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : STALE_CLAIM_DEFAULT_MS;
}

const HEARTBEAT_STOP_STEP_MS = 250;

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
