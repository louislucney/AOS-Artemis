import { randomUUID } from "node:crypto";
import os from "node:os";

import { defaultBuildRuntime, type CliRuntimeBundle } from "../cli-runtime.js";
import {
  RunnerAlreadyActiveError,
  type RegressionTaskRecord,
  type RunnerRecord
} from "../db/types.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";
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
  io?: RunnerAgentIO;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const STOP_POLL_MS = 3_000;

const EMPTY_INVENTORY: RunnerInventory = {
  platforms: [],
  devices: [],
  tools: { adb: false, idb: false, simctl: false, ideviceId: false, appium: false }
};

/** runner 常驻循环（DESIGN §13.109）：心跳循环与主循环解耦（执行期间不失联）；
 * 启动释放自己的未完成领取；执行异常释放本次领取；`once` 单轮冒烟、`shouldStop` 优雅退出。 */
export async function runRunnerAgent(options: RunnerAgentOptions): Promise<number> {
  const env = options.env ?? process.env;
  const name = options.name?.trim() || os.hostname();
  const pollMs = options.pollMs ?? intFromEnv(env.AOS_RUNNER_POLL_MS, 5_000);
  const heartbeatMs = options.heartbeatMs ?? intFromEnv(env.AOS_RUNNER_HEARTBEAT_MS, 30_000);
  const maxAttempts = options.maxAttempts ?? intFromEnv(env.AOS_RUNNER_MAX_ATTEMPTS, 3);
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
      await store.upsertHostAddresses({ hostId, addresses: snapshot.addresses });
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
        instanceId
      });
    };

    await refreshInventory();
    let me: RunnerRecord;
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
    io.log(
      `[runner] 启动：name=${name} project=${rootPath}（端 ${inventory.platforms.join(",") || "无"}）`
    );

    try {
      const released = await store.releaseRegressionTasks({ rootPath, runnerId: me.id });
      if (released > 0) io.log(`[runner] 释放未完成领取：${released} 条`);
    } catch (error) {
      io.errorLog(`[runner] 释放未完成领取失败：${errorMessage(error)}`);
    }

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
            await heartbeat();
          } catch (error) {
            io.errorLog(`[runner] 心跳失败：${errorMessage(error)}`);
          }
        }
      })();
    }

    try {
      while (!stopped()) {
        const nowMs = now();
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
          await store
            .releaseRegressionTask({ rootPath, runnerId: me.id, taskId: task.id, to: "pending" })
            .catch(() => false);
          if (once) return 0;
          await sleep(pollMs);
          continue;
        }
        task = running;

        const devices = currentInventory.devices
          .filter((device) => task.platforms.includes(device.platform))
          .map((device) => device.serial);
        const argv = [
          "run",
          "--task",
          task.id,
          ...(options.projectDir ? ["--project", options.projectDir] : []),
          ...devices.flatMap((serial) => ["--device", serial])
        ];
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
              if ((fresh.status === "stopping" || fresh.status === "stopped") && !stopAcked) {
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
          exitCode = await options.executeSuite(argv, { shouldAbort: () => stopRequested });
          io.log(`[runner] 任务 ${task.id} 执行结束（退出码 ${exitCode}）`);
        } catch (error) {
          io.errorLog(`[runner] 任务 ${task.id} 执行异常：${errorMessage(error)}`);
        } finally {
          clearInterval(stopPoll);
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
      }
      return 0;
    } finally {
      stopHeartbeat = true;
      await settleWithin(heartbeatTask, 2_000);
    }
  } finally {
    await bundle.dispose();
  }
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
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
