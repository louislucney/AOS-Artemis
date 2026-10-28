import { randomUUID } from "node:crypto";
import os from "node:os";

import { CENTER_DATABASE_ENV, openCenterStore } from "../center/store.js";
import type {
  ProjectStore,
  RegressionTaskRecord,
  RunnerDevice,
  WebRunnerRecord
} from "../db/types.js";
import { deviceLeaseTtlMs } from "../db/types.js";
import type { ExecFn } from "../device/adb.js";
import { resolveHostIdentity } from "../host/identity.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";
import { parseWebJobSpec } from "../web/job-spec.js";
import { assignPendingWebJobs, reassignExpiredWebJobs } from "../web/jobs.js";
import { collectRunnerInventory, type RunnerInventory } from "./inventory.js";
import { runnerTtlFrom } from "./status.js";

export interface WebRunnerIO {
  log: (line: string) => void;
  errorLog: (line: string) => void;
}

export interface WebJobExecutorInput {
  task: RegressionTaskRecord;
  rootPath: string;
  device: RunnerDevice;
  /** 租约丢失/设备移除/停止时置 true；执行器应尽快中止。 */
  shouldAbort?: () => boolean;
}

export interface WebJobExecutorResult {
  status: "completed" | "partial" | "failed";
  detail?: string;
}

export type WebJobExecutor = (
  input: WebJobExecutorInput
) => Promise<WebJobExecutorResult>;

export interface WebRunnerOptions {
  centralStore: ProjectStore;
  name: string;
  artifactBaseUrl?: string | null;
  heartbeatMs?: number;
  once?: boolean;
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
}

export interface WebRunnerDeps {
  collectInventory?: () => Promise<RunnerInventory>;
  executeJob?: WebJobExecutor;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 优雅停止（CLI 信号/测试注入）；`once` 忽略。 */
  shouldStop?: () => boolean;
}

const HEARTBEAT_DEFAULT_MS = 30_000;
const POLL_DEFAULT_MS = 5_000;
const STOP_STEP_MS = 250;

const DEFAULT_EXECUTOR: WebJobExecutor = async () => {
  throw new Error("web-executor-not-wired");
};

/** `AOS_RUNNER_DEVICES` 覆盖项与未启动设备用 `configured` 表示「已登记、未探测」。 */
const USABLE_ANDROID_STATES = new Set(["device", "configured"]);
const USABLE_SIMULATOR_STATES = new Set(["Booted", "configured"]);
const USABLE_IOS_DEVICE_STATES = new Set(["device", "connected", "configured"]);

/** 执行前本地二次校验：Android `device`/`configured`；模拟器 `Booted`/`configured`；真机 `device`/`connected`/`configured`。 */
export function isWebDeviceUsable(device: RunnerDevice): boolean {
  if (device.platform === "android") return USABLE_ANDROID_STATES.has(device.state);
  if (device.kind === "simulator") return USABLE_SIMULATOR_STATES.has(device.state);
  return USABLE_IOS_DEVICE_STATES.has(device.state);
}

interface ActiveJob {
  taskId: string;
  rootPath: string;
  serial: string;
  /** 租约丢失/设备移除/停止：执行器应中止，终态不得写入。 */
  aborted: boolean;
}

interface WorkerHandle {
  device: RunnerDevice;
  stop: () => void;
}

/**
 * host 级 web runner（DESIGN §13.x）：每台设备一个 worker，串行领取该 serial 的 job；
 * 心跳循环每轮重新盘点设备（新设备起 worker、消失的设备停 worker），登记 `web_runners`、
 * 续租设备与 best-effort 选机/回池。执行器由 Task 6/7 注入；缺省抛
 * `web-executor-not-wired`（异常路径回池，不留 running）。
 */
export async function runWebRunner(
  options: WebRunnerOptions,
  io: WebRunnerIO,
  deps: WebRunnerDeps = {}
): Promise<number> {
  const env = options.env ?? process.env;
  const store = options.centralStore;
  const once = options.once === true;
  const name = options.name.trim() || os.hostname();
  const heartbeatMs = Math.max(
    1,
    Math.min(
      options.heartbeatMs ?? intFromEnv(env.AOS_RUNNER_HEARTBEAT_MS, HEARTBEAT_DEFAULT_MS),
      Math.floor(deviceLeaseTtlMs(env) / 3)
    )
  );
  const pollMs = intFromEnv(env.AOS_RUNNER_POLL_MS, POLL_DEFAULT_MS);
  const leaseTtlMs = deviceLeaseTtlMs(env);
  const runnerTtlMs = runnerTtlFrom(env);
  const instanceId = randomUUID();
  const now = deps.now ?? ((): number => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const collectInventory =
    deps.collectInventory ??
    ((): Promise<RunnerInventory> =>
      collectRunnerInventory({
        env,
        ...(options.exec === undefined ? {} : { exec: options.exec })
      }));
  const executeJob = deps.executeJob ?? DEFAULT_EXECUTOR;

  let stopped = false;
  let fatalHeartbeat: unknown = null;
  const shouldStop = (): boolean => stopped || deps.shouldStop?.() === true;
  const sleepInterruptible = async (ms: number): Promise<void> => {
    let waited = 0;
    while (waited < ms && !shouldStop()) {
      const step = Math.min(STOP_STEP_MS, ms - waited);
      await sleep(step);
      waited += step;
    }
  };

  const identity = await resolveHostIdentity({
    env,
    ...(options.exec === undefined ? {} : { exec: options.exec })
  });
  const hostId = identity.id;

  let inventory: RunnerInventory;
  try {
    inventory = await collectInventory();
  } catch (error) {
    io.errorLog(`[web-runner] 设备盘点失败：${errorMessage(error)}`);
    return 2;
  }

  const active = new Map<string, ActiveJob>();
  const workers = new Map<string, WorkerHandle>();
  const workerPromises = new Set<Promise<void>>();
  let runner: WebRunnerRecord;

  const heartbeat = async (current: RunnerInventory): Promise<WebRunnerRecord> => {
    const atMs = now();
    const at = new Date(atMs).toISOString();
    const record = await store.upsertWebRunner({
      hostId,
      name,
      hostname: identity.hostname,
      platforms: current.platforms,
      devices: current.devices,
      tools: current.tools,
      artifactBaseUrl: options.artifactBaseUrl ?? null,
      version: AOS_MCP_VERSION,
      instanceId,
      lastSeenAt: at,
      activeWithinMs: runnerTtlMs
    });
    for (const job of active.values()) {
      try {
        await store.updateRegressionTask(job.rootPath, job.taskId, { lastProgressAt: at });
      } catch (error) {
        io.errorLog(`[web-runner] 任务 ${job.taskId} 进度写入失败：${errorMessage(error)}`);
      }
      try {
        const renewed = await store.renewDeviceLeases({
          hostId,
          taskId: job.taskId,
          serials: [job.serial],
          at
        });
        if (renewed === 0) {
          if (!job.aborted) {
            job.aborted = true;
            io.errorLog(
              `[web-runner] 任务 ${job.taskId} 设备 ${job.serial} 租约丢失：中止执行并回池（不写结果）`
            );
          }
        }
      } catch (error) {
        if (!job.aborted) {
          job.aborted = true;
          io.errorLog(
            `[web-runner] 任务 ${job.taskId} 设备租约续期失败：中止执行并回池（不写结果）——${errorMessage(error)}`
          );
        }
      }
    }
    try {
      const reassigned = await reassignExpiredWebJobs({
        store,
        env,
        nowMs: atMs,
        leaseTtlMs,
        runnerTtlMs
      });
      if (reassigned > 0) io.log(`[web-runner] 过期预占回池：${reassigned} 条`);
    } catch (error) {
      io.errorLog(`[web-runner] 过期预占回池失败（忽略）：${errorMessage(error)}`);
    }
    try {
      const assigned = await assignPendingWebJobs({
        store,
        env,
        nowMs: atMs,
        runnerTtlMs,
        reservationTtlMs: leaseTtlMs
      });
      if (assigned > 0) io.log(`[web-runner] pending 任务选机绑定：${assigned} 条`);
    } catch (error) {
      io.errorLog(`[web-runner] pending 任务选机失败（忽略）：${errorMessage(error)}`);
    }
    return record;
  };

  try {
    runner = await heartbeat(inventory);
  } catch (error) {
    io.errorLog(`[web-runner] 首轮心跳失败：${errorMessage(error)}`);
    return 2;
  }
  const runnerId = runner.id;
  io.log(
    `[web-runner] 启动：name=${name} host=${hostId}（设备 ${inventory.devices.map((device) => device.serial).join(",") || "无"}）`
  );

  const releaseLocal = async (
    taskId: string,
    rootPath: string,
    serial: string
  ): Promise<void> => {
    try {
      await store.releaseRegressionTask({
        rootPath,
        runnerId,
        taskId,
        to: "pending"
      });
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${taskId} 回池失败：${errorMessage(error)}`);
    }
    try {
      await store.releaseDeviceLeases({ hostId, taskId, serials: [serial] });
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${taskId} 释放设备租约失败：${errorMessage(error)}`);
    }
  };

  const skipClaim = async (
    task: RegressionTaskRecord,
    rootPath: string,
    serial: string,
    code: string,
    detail: string
  ): Promise<void> => {
    io.log(`[web-runner] 设备 ${serial} 任务 ${task.id} 暂不执行：${code}（${detail}）`);
    await releaseLocal(task.id, rootPath, serial);
  };

  /** 终态写入：写前重读 + `expectStatuses:["running"]`；stopping 只 ack 不覆盖，终态直接跳过。 */
  const writeTerminal = async (
    task: RegressionTaskRecord,
    rootPath: string,
    status: WebJobExecutorResult["status"],
    detail?: string
  ): Promise<"written" | "cancelled" | "skipped"> => {
    let fresh: RegressionTaskRecord | null;
    try {
      fresh = await store.getRegressionTask(rootPath, task.id);
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${task.id} 终态写入前读取失败：${errorMessage(error)}`);
      return "skipped";
    }
    if (fresh === null) {
      io.log(`[web-runner] 任务 ${task.id} 终态未写入：任务已不存在`);
      return "skipped";
    }
    if (fresh.status === "stopping") {
      try {
        await store.ackCancellation({ rootPath, taskId: task.id });
      } catch (error) {
        io.errorLog(`[web-runner] 任务 ${task.id} 取消确认失败：${errorMessage(error)}`);
      }
      io.log(`[web-runner] 任务 ${task.id} 执行期间被取消：已 ackCancellation，不写结果`);
      return "cancelled";
    }
    if (fresh.status !== "running") {
      io.log(
        `[web-runner] 任务 ${task.id} 终态未写入：当前状态 ${fresh.status}（已终态/取消），保留原状态`
      );
      return "skipped";
    }
    const spec = parseWebJobSpec(fresh.jobSpec);
    let updated = false;
    try {
      updated = await store.updateRegressionTask(rootPath, task.id, {
        status,
        lastProgressAt: new Date(now()).toISOString(),
        deviceLeaseId: null,
        ...(spec === null
          ? {}
          : { jobSpec: { ...spec, deviceLeaseId: null } as Record<string, unknown> }),
        expectStatuses: ["running"]
      });
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${task.id} 终态写入失败：${errorMessage(error)}`);
      return "skipped";
    }
    if (!updated) {
      io.log(`[web-runner] 任务 ${task.id} 终态写入未生效（updated=false，可能并发取消/接管）`);
      const after = await store.getRegressionTask(rootPath, task.id).catch(() => null);
      if (after?.status === "stopping") {
        await store.ackCancellation({ rootPath, taskId: task.id }).catch(() => null);
        io.log(`[web-runner] 任务 ${task.id} 写入失败后确认取消（stopping → cancelled）`);
      }
      return "skipped";
    }
    io.log(
      `[web-runner] 任务 ${task.id} 执行结束：${status}${detail ? `（${detail}）` : ""}`
    );
    return "written";
  };

  const claimAndRun = async (device: RunnerDevice): Promise<"executed" | "idle" | "skipped"> => {
    const nowMs = now();
    let claimed: { task: RegressionTaskRecord; rootPath: string } | null;
    try {
      claimed = await store.claimWebJob({
        runnerId,
        hostId,
        deviceSerial: device.serial,
        instanceId,
        nowMs
      });
    } catch (error) {
      io.errorLog(`[web-runner] 设备 ${device.serial} 领取失败：${errorMessage(error)}`);
      return "skipped";
    }
    if (claimed === null) return "idle";
    const { task, rootPath } = claimed;

    let fresh: RunnerInventory | null = null;
    try {
      fresh = await collectInventory();
    } catch (error) {
      io.errorLog(`[web-runner] 执行前设备盘点失败：${errorMessage(error)}`);
      fresh = null;
    }
    const local = fresh?.devices.find((entry) => entry.serial === device.serial) ?? null;
    if (local === null || !isWebDeviceUsable(local)) {
      await skipClaim(
        task,
        rootPath,
        device.serial,
        "device-unavailable",
        local === null ? "设备已不在本地清单" : `设备状态 ${local.state} 不可用`
      );
      return "skipped";
    }

    let leases;
    try {
      leases = await store.listDeviceLeases({ hostId });
    } catch (error) {
      io.errorLog(`[web-runner] 设备租约读取失败：${errorMessage(error)}`);
      await skipClaim(task, rootPath, device.serial, "lease-unreadable", errorMessage(error));
      return "skipped";
    }
    const mine = leases.find(
      (lease) =>
        lease.serial === device.serial &&
        lease.taskId === task.id &&
        Date.parse(lease.expiresAt) > nowMs
    );
    if (mine === undefined) {
      await skipClaim(task, rootPath, device.serial, "lease-lost", "本任务预占租约已过期或丢失");
      return "skipped";
    }
    const foreign = leases.find(
      (lease) =>
        lease.serial === device.serial &&
        lease.taskId !== task.id &&
        Date.parse(lease.expiresAt) > nowMs
    );
    if (foreign !== undefined) {
      await skipClaim(
        task,
        rootPath,
        device.serial,
        "device-busy",
        `设备被任务 ${foreign.taskId} 占用`
      );
      return "skipped";
    }

    let running: RegressionTaskRecord | null;
    try {
      running = await store.beginExecution({
        rootPath,
        taskId: task.id,
        runnerId,
        instanceId,
        at: new Date(nowMs).toISOString()
      });
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${task.id} 开始执行失败：${errorMessage(error)}`);
      running = null;
    }
    if (running === null) {
      io.log(`[web-runner] 任务 ${task.id} 领取后状态已变化（取消/接管），释放并跳过`);
      await releaseLocal(task.id, rootPath, device.serial);
      return "skipped";
    }

    io.log(`[web-runner] 领取任务 ${task.id}（设备 ${device.serial} · 项目 ${rootPath}）`);
    const job: ActiveJob = {
      taskId: task.id,
      rootPath,
      serial: device.serial,
      aborted: false
    };
    active.set(device.serial, job);
    try {
      const result = await executeJob({
        task: running,
        rootPath,
        device: local,
        shouldAbort: () => job.aborted || shouldStop()
      });
      if (job.aborted) {
        io.log(
          `[web-runner] 任务 ${task.id} 执行中止（租约丢失/设备移除/停止）：不写结果，回池等待`
        );
        await releaseLocal(task.id, rootPath, device.serial);
        return "executed";
      }
      const status = result?.status;
      if (status !== "completed" && status !== "partial" && status !== "failed") {
        throw new Error(`web-executor-invalid-status: ${String(status)}`);
      }
      await writeTerminal(task, rootPath, status, result.detail);
    } catch (error) {
      if (job.aborted) {
        io.log(
          `[web-runner] 任务 ${task.id} 执行中止（租约丢失/设备移除/停止）：${errorMessage(error)}`
        );
      } else {
        io.errorLog(`[web-runner] 任务 ${task.id} 执行异常：${errorMessage(error)}`);
      }
      await releaseLocal(task.id, rootPath, device.serial);
    } finally {
      active.delete(device.serial);
      try {
        await store.releaseDeviceLeases({ hostId, taskId: task.id, serials: [device.serial] });
      } catch (error) {
        io.errorLog(`[web-runner] 任务 ${task.id} 释放设备租约失败：${errorMessage(error)}`);
      }
    }
    return "executed";
  };

  const startWorker = (device: RunnerDevice): WorkerHandle => {
    let stopRequested = false;
    const stop = (): void => {
      stopRequested = true;
      const job = active.get(device.serial);
      if (job !== undefined) job.aborted = true;
    };
    const promise = (async (): Promise<void> => {
      while (!shouldStop() && !stopRequested) {
        let outcome: "executed" | "idle" | "skipped";
        try {
          outcome = await claimAndRun(device);
        } catch (error) {
          io.errorLog(`[web-runner] 设备 ${device.serial} worker 异常：${errorMessage(error)}`);
          outcome = "skipped";
        }
        if (once) return;
        if (shouldStop() || stopRequested) return;
        if (outcome !== "executed") await sleepInterruptible(pollMs);
      }
    })();
    workerPromises.add(promise);
    void promise.then(
      () => workerPromises.delete(promise),
      () => workerPromises.delete(promise)
    );
    return { device, stop };
  };

  const syncWorkers = (current: RunnerInventory): void => {
    const wanted = new Map(current.devices.map((device) => [device.serial, device]));
    for (const [serial, handle] of [...workers]) {
      if (wanted.has(serial)) continue;
      handle.stop();
      workers.delete(serial);
      io.log(`[web-runner] 设备 ${serial} 已移除：停止 worker`);
    }
    for (const device of wanted.values()) {
      if (workers.has(device.serial)) continue;
      workers.set(device.serial, startWorker(device));
      io.log(`[web-runner] 设备 ${device.serial} 可用：启动 worker`);
    }
  };

  const allWorkerPromises = (): Promise<void> =>
    Promise.allSettled([...workerPromises]).then(() => undefined);

  syncWorkers(inventory);

  let heartbeatTask: Promise<void> = Promise.resolve();
  if (!once) {
    heartbeatTask = (async (): Promise<void> => {
      while (!shouldStop()) {
        await sleepInterruptible(heartbeatMs);
        if (shouldStop()) break;
        let fresh: RunnerInventory;
        try {
          fresh = await collectInventory();
        } catch (error) {
          io.errorLog(`[web-runner] 心跳设备盘点失败（保留上次清单）：${errorMessage(error)}`);
          fresh = inventory;
        }
        inventory = fresh;
        try {
          await heartbeat(fresh);
        } catch (error) {
          fatalHeartbeat = error;
          io.errorLog(
            `[web-runner] 心跳登记失败，停止 runner（请检查是否已被其他实例接管）：${errorMessage(error)}`
          );
          stopped = true;
          break;
        }
        syncWorkers(fresh);
      }
    })();
  }

  let code = 0;
  try {
    if (once) {
      await Promise.all([...workerPromises]);
    } else {
      await heartbeatTask;
      stopped = true;
      for (const handle of workers.values()) handle.stop();
      await settleWithin(allWorkerPromises(), 2_000);
    }
  } catch (error) {
    io.errorLog(`[web-runner] worker 失败：${errorMessage(error)}`);
    code = 2;
  } finally {
    stopped = true;
    await settleWithin(heartbeatTask, 2_000);
    for (const handle of workers.values()) handle.stop();
    await settleWithin(allWorkerPromises(), 2_000);
    for (const job of [...active.values()]) {
      await releaseLocal(job.taskId, job.rootPath, job.serial);
    }
    active.clear();
    try {
      await store.markWebRunnerStopped({ hostId, instanceId });
    } catch (error) {
      io.errorLog(`[web-runner] 标记停止失败：${errorMessage(error)}`);
    }
  }
  if (fatalHeartbeat !== null) code = 2;
  return code;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export type WebRunnerCommandIo = WebRunnerIO;

export interface WebRunnerCommandDeps extends WebRunnerDeps {
  env?: NodeJS.ProcessEnv;
  /** 注入的中心存储（测试）；缺省按 `MOBILE_TESTING_DATABASE_URL` 打开 PG 并负责关闭。 */
  store?: ProjectStore;
  exec?: ExecFn;
}

export function printWebRunnerUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp web-runner [options]

host 级远端 Web 任务执行机（只连中心 PG，不要求项目目录；每台设备一个 worker）：
  --name <n>              执行机名称（缺省 hostname）
  --artifact-base-url <u> 产物基址（回传给中心，可选）
  --once                  只跑一轮（心跳/选机 + 每设备一次领取）后退出
  环境变量：MOBILE_TESTING_DATABASE_URL（必需）、AOS_HOST_ID、AOS_RUNNER_TTL_MS、
            AOS_DEVICE_LEASE_MS、AOS_RUNNER_HEARTBEAT_MS、AOS_RUNNER_POLL_MS`);
}

interface ParsedFlags {
  get: (key: string) => string | null;
  bool: (key: string) => boolean;
  has: (key: string) => boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return {
    get: (key) => {
      const value = flags.get(key);
      return typeof value === "string" ? value : null;
    },
    bool: (key) => {
      const value = flags.get(key);
      return value !== undefined && value !== "false";
    },
    has: (key) => flags.has(key)
  };
}

/** CLI 入口：只连中心 PG；缺连接串/非 PG 明确 exit 2。 */
export async function runWebRunnerCommand(
  argv: string[],
  io: WebRunnerCommandIo,
  deps: WebRunnerCommandDeps = {}
): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.has("help")) {
    printWebRunnerUsage(io.log);
    return 0;
  }
  const env = deps.env ?? process.env;
  const name = flags.get("name")?.trim() || os.hostname();
  const artifactBaseUrl = flags.get("artifact-base-url")?.trim() || null;

  let store = deps.store ?? null;
  let opened = false;
  if (store === null) {
    try {
      store = await openCenterStore(env);
      opened = true;
    } catch (error) {
      io.errorLog(
        `${errorMessage(error)}（web-runner 只支持中心 PG；请设置 ${CENTER_DATABASE_ENV}）`
      );
      return 2;
    }
  }
  if (store.kind !== "postgres") {
    io.errorLog(
      "web-runner 需要中心 PG（文件台账不支持多机）；请配置 MOBILE_TESTING_DATABASE_URL"
    );
    if (opened) await store.close().catch(() => undefined);
    return 2;
  }

  let stopRequested = false;
  const onSignal = (): void => {
    stopRequested = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await runWebRunner(
      {
        centralStore: store,
        name,
        artifactBaseUrl,
        once: flags.bool("once"),
        env,
        ...(deps.exec === undefined ? {} : { exec: deps.exec })
      },
      io,
      {
        ...(deps.collectInventory === undefined ? {} : { collectInventory: deps.collectInventory }),
        ...(deps.executeJob === undefined ? {} : { executeJob: deps.executeJob }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        shouldStop: () => stopRequested || deps.shouldStop?.() === true
      }
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (opened) {
      await store.close().catch(() => undefined);
    }
  }
}
