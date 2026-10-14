import os from "node:os";

import { defaultBuildRuntime, type CliRuntimeBundle } from "../cli-runtime.js";
import type { RegressionTaskRecord, RunnerRecord } from "../db/types.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";
import { collectRunnerInventory, type RunnerInventory } from "./inventory.js";

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
  once?: boolean;
  shouldStop?: () => boolean;
  artifactBaseUrl?: string | null;
  env?: NodeJS.ProcessEnv;
  buildRuntime?: (projectDir: string | null) => Promise<CliRuntimeBundle>;
  executeSuite: (argv: string[]) => Promise<number>;
  collectInventory?: () => Promise<RunnerInventory>;
  io?: RunnerAgentIO;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

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
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const io = options.io ?? {
    log: (line: string): void => console.log(line),
    errorLog: (line: string): void => console.error(line)
  };
  const buildRuntime = options.buildRuntime ?? defaultBuildRuntime;
  const collectInventory = options.collectInventory ?? ((): Promise<RunnerInventory> =>
    collectRunnerInventory({ env }));
  const once = options.once === true;
  const stopped = (): boolean => options.shouldStop?.() === true;

  const bundle = await buildRuntime(options.projectDir ?? null);
  try {
    const store = bundle.runtime.store;
    const rootPath = bundle.runtime.project.rootDir;
    let inventory: RunnerInventory = EMPTY_INVENTORY;

    const refreshInventory = async (): Promise<void> => {
      try {
        inventory = await collectInventory();
      } catch {
        /* 保留上次清单 */
      }
    };
    const heartbeat = async (): Promise<RunnerRecord> => {
      await refreshInventory();
      return store.upsertRunner({
        rootPath,
        name,
        hostname: os.hostname(),
        platforms: inventory.platforms,
        devices: inventory.devices,
        tools: inventory.tools,
        artifactBaseUrl: options.artifactBaseUrl ?? null,
        version: AOS_MCP_VERSION
      });
    };

    await refreshInventory();
    let me: RunnerRecord;
    try {
      me = await heartbeat();
    } catch (error) {
      io.errorLog(`[runner] 首轮心跳失败：${errorMessage(error)}`);
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
        const snapshot = inventory;
        let task: RegressionTaskRecord | null;
        try {
          task = await store.claimRegressionTask({
            rootPath,
            runnerId: me.id,
            platforms: snapshot.platforms
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

        const devices = snapshot.devices
          .filter((device) => task.platforms.includes(device.platform))
          .map((device) => device.serial);
        const argv = [
          "run",
          "--task",
          task.id,
          ...(options.projectDir ? ["--project", options.projectDir] : []),
          ...devices.flatMap((serial) => ["--device", serial])
        ];
        io.log(
          `[runner] 领取任务 ${task.id}（端 ${task.platforms.join(",")} · 设备 ${devices.join(",") || "无"}）`
        );
        let exitCode: number | null = null;
        try {
          exitCode = await options.executeSuite(argv);
          io.log(`[runner] 任务 ${task.id} 执行结束（退出码 ${exitCode}）`);
        } catch (error) {
          io.errorLog(`[runner] 任务 ${task.id} 执行异常：${errorMessage(error)}`);
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
