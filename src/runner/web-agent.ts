import { randomUUID } from "node:crypto";
import { runnerJobTokenFrom } from "../env-tokens.js";
import os from "node:os";
import path from "node:path";

import { CENTER_DATABASE_ENV, openCenterStore } from "../center/store.js";
import type { ProjectStore, RunnerDevice } from "../db/types.js";
import { deviceLeaseTtlMs, WebRunnerAlreadyActiveError } from "../db/types.js";
import type { ExecFn } from "../device/adb.js";
import { resolveHostIdentity } from "../host/identity.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";
import type { WebJobTask, WebClaimResponse, WebHeartbeatResponse } from "./control/contract.js";
import { createHttpWebRunnerControl } from "./control/client.js";
import { createRunnerFetch, runnerDataTimeoutMs, runnerHttpTimeoutMs } from "./control/tls-fetch.js";
import { createStoreWebRunnerControl } from "./control/service.js";
import type { WebRunnerControl } from "./control/web-control.js";
import { collectRunnerInventory, type RunnerInventory } from "./inventory.js";
import { createDefaultWebJobExecutor } from "./web-job-runner.js";
import { cleanupWebJobWorkspace } from "./web-job-workspace.js";

export interface WebRunnerIO {
  log: (line: string) => void;
  errorLog: (line: string) => void;
}

export interface WebJobExecutorInput {
  task: WebJobTask;
  /** 中心项目根路径不在执行机上；这里只给工作目录分段。 */
  projectSlug?: string;
  /** 兼容旧执行器：控制面模式下与 projectSlug 同值，不再代表真实路径。 */
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
  /** 直连 PG 兼容路径；与 `control` 二选一。 */
  centralStore?: ProjectStore;
  /** HTTP 控制面（或测试注入）；提供时不需要 centralStore。 */
  control?: WebRunnerControl;
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
  serial: string;
  leaseToken: string;
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
  const control =
    options.control ??
    (options.centralStore === undefined
      ? null
      : createStoreWebRunnerControl({
          store: options.centralStore,
          hostId: identity.id,
          instanceId: randomUUID(),
          env,
          now
        }));
  if (control === null) {
    io.errorLog("[web-runner] 缺少控制面：请配置 AOS_RUNNER_CONTROL_URL 或中心 PG");
    return 2;
  }
  const hostId = control.hostId;

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
  const heartbeat = async (current: RunnerInventory): Promise<WebHeartbeatResponse> => {
    const response = await control.heartbeat({
      host: {
        hostname: identity.hostname,
        username: identity.username,
        osPlatform: identity.osPlatform,
        osVersion: identity.osVersion,
        arch: identity.arch,
        kind: identity.kind
      },
      name,
      version: AOS_MCP_VERSION,
      artifactBaseUrl: options.artifactBaseUrl ?? null,
      inventory: current,
      active: [...active.values()].map((job) => ({ taskId: job.taskId, serial: job.serial }))
    });
    for (const taskId of response.cancelTaskIds) {
      const job = [...active.values()].find((entry) => entry.taskId === taskId);
      if (job === undefined || job.aborted) continue;
      job.aborted = true;
      io.log(`[web-runner] 任务 ${taskId} 收到取消请求：中止执行并确认取消`);
    }
    for (const taskId of response.leaseLostTaskIds) {
      const job = [...active.values()].find((entry) => entry.taskId === taskId);
      if (job === undefined || job.aborted) continue;
      job.aborted = true;
      io.errorLog(`[web-runner] 任务 ${taskId} 设备 ${job.serial} 租约丢失：中止执行并回池`);
    }
    if (response.recovered > 0) io.log(`[web-runner] 回收失联 Web 领取：${response.recovered} 条`);
    if (response.reassigned > 0) io.log(`[web-runner] 过期预占回池：${response.reassigned} 条`);
    if (response.assigned > 0) io.log(`[web-runner] pending 任务选机绑定：${response.assigned} 条`);
    return response;
  };

  try {
    await heartbeat(inventory);
  } catch (error) {
    io.errorLog(`[web-runner] 首轮心跳失败：${errorMessage(error)}`);
    return 2;
  }
  io.log(
    `[web-runner] 启动：name=${name} host=${hostId}（设备 ${inventory.devices.map((device) => device.serial).join(",") || "无"}）`
  );

  const releaseLocal = async (
    taskId: string,
    serial: string,
    leaseToken: string
  ): Promise<void> => {
    try {
      await control.release(taskId, "pending");
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${taskId} 回池失败：${errorMessage(error)}`);
    }
    try {
      await control.releaseLease(taskId, serial, leaseToken);
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${taskId} 释放设备租约失败：${errorMessage(error)}`);
    }
  };

  const skipClaim = async (
    taskId: string,
    serial: string,
    leaseToken: string,
    code: string,
    detail: string
  ): Promise<void> => {
    io.log(`[web-runner] 设备 ${serial} 任务 ${taskId} 暂不执行：${code}（${detail}）`);
    await releaseLocal(taskId, serial, leaseToken);
  };

  /** 终态由服务端做 CAS/取消裁决；执行机只上报结果。 */
  const writeTerminal = async (
    taskId: string,
    status: WebJobExecutorResult["status"],
    detail?: string
  ): Promise<"written" | "cancelled" | "skipped"> => {
    try {
      const outcome = await control.terminal(taskId, status, detail);
      if (outcome === "cancelled") {
        io.log(`[web-runner] 任务 ${taskId} 执行期间被取消：已 ackCancellation，不写结果`);
      } else if (outcome === "skipped") {
        io.log(`[web-runner] 任务 ${taskId} 终态未写入：已取消/已终态/被接管，保留原状态`);
      } else {
        io.log(`[web-runner] 任务 ${taskId} 执行结束：${status}${detail ? `（${detail}）` : ""}`);
      }
      return outcome;
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${taskId} 终态写入失败：${errorMessage(error)}`);
      return "skipped";
    }
  };

  const workRoot =
    (env.AOS_RUNNER_WORK_DIR ?? "").trim() || path.join(os.homedir(), ".aos", "web-runner");

  const claimAndRun = async (device: RunnerDevice): Promise<"executed" | "idle" | "skipped"> => {
    let claimed: WebClaimResponse;
    try {
      claimed = await control.claim(device.serial);
    } catch (error) {
      io.errorLog(`[web-runner] 设备 ${device.serial} 领取失败：${errorMessage(error)}`);
      return "skipped";
    }
    if (claimed.kind === "idle" || claimed.kind === "paused") return "idle";
    if (claimed.kind === "busy") {
      io.log(`[web-runner] 设备 ${device.serial} 暂不执行：${claimed.reason}`);
      return "skipped";
    }
    if (claimed.kind === "exhausted") {
      io.log(
        `[web-runner] 任务 ${claimed.taskId} 已达重试上限，服务端已置 failed${
          claimed.cancelled ? "；ackCancellation" : ""
        }`
      );
      await cleanupWebJobWorkspace({
        workRoot,
        completedJobIds: [claimed.taskId]
      }).catch(() => undefined);
      return "executed";
    }

    const { task, projectSlug, leaseToken } = claimed;
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
        task.id,
        device.serial,
        leaseToken,
        "device-unavailable",
        local === null ? "设备已不在本地清单" : `设备状态 ${local.state} 不可用`
      );
      return "skipped";
    }

    let began: Awaited<ReturnType<WebRunnerControl["begin"]>>;
    try {
      began = await control.begin(task.id);
    } catch (error) {
      io.errorLog(`[web-runner] 任务 ${task.id} 开始执行失败：${errorMessage(error)}`);
      await releaseLocal(task.id, device.serial, leaseToken);
      return "skipped";
    }
    if (!began.started) {
      io.log(`[web-runner] 任务 ${task.id} 领取后状态已变化（${began.reason}），释放并跳过`);
      await releaseLocal(task.id, device.serial, leaseToken);
      return "skipped";
    }

    io.log(`[web-runner] 领取任务 ${task.id}（设备 ${device.serial} · 项目 ${projectSlug}）`);
    const job: ActiveJob = {
      taskId: task.id,
      serial: device.serial,
      leaseToken,
      aborted: false
    };
    active.set(device.serial, job);
    try {
      const result = await executeJob({
        task,
        projectSlug,
        rootPath: projectSlug,
        device: local,
        shouldAbort: () => job.aborted || shouldStop()
      });
      if (job.aborted) {
        io.log(`[web-runner] 任务 ${task.id} 执行中止（租约丢失/设备移除/停止/取消）：不写结果，回池等待`);
        await releaseLocal(task.id, device.serial, leaseToken);
        return "executed";
      }
      const status = result?.status;
      if (status !== "completed" && status !== "partial" && status !== "failed") {
        throw new Error(`web-executor-invalid-status: ${String(status)}`);
      }
      await writeTerminal(task.id, status, result.detail);
    } catch (error) {
      if (job.aborted) {
        io.log(`[web-runner] 任务 ${task.id} 执行中止：${errorMessage(error)}`);
      } else {
        io.errorLog(`[web-runner] 任务 ${task.id} 执行异常：${errorMessage(error)}`);
      }
      await releaseLocal(task.id, device.serial, leaseToken);
    } finally {
      active.delete(device.serial);
      try {
        await control.releaseLease(task.id, device.serial, leaseToken);
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
          syncWorkers(fresh);
        } catch (error) {
          if (error instanceof WebRunnerAlreadyActiveError) {
            fatalHeartbeat = error;
            io.errorLog(
              `[web-runner] 心跳登记被拒（另一实例已接管），停止 runner：${errorMessage(error)}`
            );
            stopped = true;
            break;
          }
          io.errorLog(
            `[web-runner] 心跳登记临时失败，保留上次状态并稍后重试：${errorMessage(error)}`
          );
        }
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
      await releaseLocal(job.taskId, job.serial, job.leaseToken);
    }
    active.clear();
    try {
      await control.stop();
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
  /** 直连 PG 的兼容注入（测试）；缺省按 `MOBILE_TESTING_DATABASE_URL` 打开 PG 并负责关闭。 */
  store?: ProjectStore;
  /** HTTP 控制面注入（测试/嵌入）；提供时不需要 store。 */
  control?: WebRunnerControl;
  exec?: ExecFn;
}

export function printWebRunnerUsage(log: (line: string) => void): void {
  log(`mobile-testing-mcp web-runner [options]

host 级远端 Web 任务执行机（不要求项目目录；每台设备一个 worker）：
  --name <n>              执行机名称（缺省 hostname）
  --artifact-base-url <u> 产物基址（回传给中心，可选）
  --panel-base-url <u>    中心基址（缺省 AOS_PANEL_BASE_URL；可回退控制面）
  --control-url <u>       控制面基址（缺省 AOS_RUNNER_CONTROL_URL；设置后不连中心 PG）
  --once                  只跑一轮（心跳/选机 + 每设备一次领取并执行一次尝试）后退出
  环境变量：AOS_RUNNER_CONTROL_URL（推荐）、AOS_PANEL_BASE_URL、MOBILE_TESTING_RUNNER_JOB_TOKEN（≥16）、
            AOS_HOST_ID、AOS_RUNNER_TTL_MS、AOS_DEVICE_LEASE_MS、AOS_RUNNER_HEARTBEAT_MS、
            AOS_RUNNER_POLL_MS、AOS_RUNNER_WORK_DIR、AOS_RUNNER_CACHE_DIR；
            未配置控制面时回退中心 PG：MOBILE_TESTING_DATABASE_URL（必需）`);
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

/** CLI 入口：配置 `AOS_RUNNER_CONTROL_URL` 时只连中心 HTTP；否则走中心 PG 兼容路径。 */
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
  const controlUrl =
    flags.get("control-url")?.trim() || (env.AOS_RUNNER_CONTROL_URL ?? "").trim();
  const panelBaseUrl =
    flags.get("panel-base-url")?.trim() ||
    (env.AOS_PANEL_BASE_URL ?? "").trim() ||
    controlUrl;
  const runnerToken = runnerJobTokenFrom(env);
  const needsHttpControl =
    deps.control === undefined && deps.store === undefined && controlUrl !== "";
  const needsExecutor = deps.executeJob === undefined;
  const needsIdentity = needsHttpControl || needsExecutor;

  if (needsExecutor || needsHttpControl) {
    if (panelBaseUrl === "") {
      io.errorLog(
        "web-runner 需要中心基址：--panel-base-url <url> 或 AOS_PANEL_BASE_URL（spec/资产/结果接口）"
      );
      return 2;
    }
    if (runnerToken.length < 16) {
      io.errorLog(
        "web-runner 需要 MOBILE_TESTING_RUNNER_JOB_TOKEN（≥16 字符）访问中心控制面/spec/资产/结果接口；不会回退管理员令牌"
      );
      return 2;
    }
  }

  const identity = needsIdentity
    ? await resolveHostIdentity({
        env,
        ...(deps.exec === undefined ? {} : { exec: deps.exec })
      })
    : null;

  let control = deps.control;
  let store = deps.store ?? null;
  let opened = false;
  if (control === undefined) {
    if (controlUrl !== "") {
      if (identity === null) {
        io.errorLog("web-runner 无法解析主机身份，不能建立控制面会话");
        return 2;
      }
      const runnerFetch = createRunnerFetch(env);
      control = createHttpWebRunnerControl({
        baseUrl: panelBaseUrl,
        token: runnerToken,
        hostId: identity.id,
        instanceId: randomUUID(),
        timeoutMs: runnerHttpTimeoutMs(env),
        ...(runnerFetch === undefined ? {} : { fetchImpl: runnerFetch })
      });
      io.log(`[web-runner] 控制面 ${panelBaseUrl}（host=${identity.id}）`);
    } else {
      if (store === null) {
        try {
          store = await openCenterStore(env);
          opened = true;
        } catch (error) {
          io.errorLog(
            `${errorMessage(error)}（web-runner 需要 AOS_RUNNER_CONTROL_URL 或中心 PG；请设置 ${CENTER_DATABASE_ENV}）`
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
    }
  }

  let executeJob = deps.executeJob;
  if (executeJob === undefined) {
    if (identity === null) {
      io.errorLog("web-runner 无法解析主机身份，不能创建执行器");
      if (opened && store !== null) await store.close().catch(() => undefined);
      return 2;
    }
    const workRoot =
      (env.AOS_RUNNER_WORK_DIR ?? "").trim() || path.join(os.homedir(), ".aos", "web-runner");
    const cacheRoot = (env.AOS_RUNNER_CACHE_DIR ?? "").trim() || path.join(workRoot, "cache");
    const executorFetch = createRunnerFetch(env);
    executeJob = createDefaultWebJobExecutor({
      hostId: identity.id,
      panelBaseUrl,
      runnerToken,
      workRoot,
      cacheRoot,
      ...(control === undefined ? {} : { instanceId: control.instanceId }),
      requestTimeoutMs: runnerDataTimeoutMs(env),
      ...(executorFetch === undefined ? {} : { fetchImpl: executorFetch }),
      ...(deps.exec === undefined ? {} : { exec: deps.exec }),
      env
    });
    io.log(`[web-runner] 中心接口 ${panelBaseUrl}；工作目录 ${workRoot}`);
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
        ...(control === undefined ? {} : { control }),
        ...(control === undefined && store !== null ? { centralStore: store } : {}),
        name,
        artifactBaseUrl,
        once: flags.bool("once"),
        env,
        ...(deps.exec === undefined ? {} : { exec: deps.exec })
      },
      io,
      {
        ...(deps.collectInventory === undefined ? {} : { collectInventory: deps.collectInventory }),
        executeJob,
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        shouldStop: () => stopRequested || deps.shouldStop?.() === true
      }
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (opened && store !== null) {
      await store.close().catch(() => undefined);
    }
  }
}
