import path from "node:path";

import { deviceLeaseTtlMs } from "../../db/types.js";
import type { ProjectStore, RegressionTaskRecord, WebRunnerRecord } from "../../db/types.js";
import { parseWebJobSpec } from "../../web/job-spec.js";
import { assignPendingWebJobs, reassignExpiredWebJobs, recoverStaleWebJobs } from "../../web/jobs.js";
import { leaseTokenFor, leaseTokenMatches } from "./lease-token.js";
import { runnerTtlFrom } from "../status.js";
import type {
  WebClaimResponse,
  WebHeartbeatResponse,
  WebJobTask
} from "./contract.js";
import type {
  WebRunnerControl,
  WebRunnerHeartbeatInput,
  WebRunnerTerminalOutcome,
  WebRunnerTerminalStatus
} from "./web-control.js";

export type RunnerControlErrorCode =
  | "not-found"
  | "forbidden"
  | "claim-lost"
  | "session-lost"
  | "instance-mismatch"
  | "invalid-state";

export class RunnerControlError extends Error {
  readonly code: RunnerControlErrorCode;
  readonly status: number;

  constructor(code: RunnerControlErrorCode, message: string) {
    super(message);
    this.name = "RunnerControlError";
    this.code = code;
    this.status =
      code === "forbidden" ? 403 : code === "not-found" ? 404 : 409;
  }
}

export interface WebRunnerControlServiceOptions {
  store: ProjectStore;
  hostId: string;
  instanceId: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface ClaimedJob {
  task: RegressionTaskRecord;
  rootPath: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function nonNegativeIntFromEnv(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/** basename 是给执行机的工作目录分段，不暴露中心项目根路径。 */
function projectSlugOf(rootPath: string): string {
  const base = path.basename(path.resolve(rootPath)).trim();
  return base === "" || base === "." || base === ".." ? "project" : base;
}

function toWebJobTask(task: RegressionTaskRecord): WebJobTask {
  return {
    id: task.id,
    jobSpec: task.jobSpec,
    attempts: task.attempts,
    deviceSerial: task.deviceSerial,
    claimedHostId: task.claimedHostId,
    targetHostId: task.targetHostId,
    status: task.status
  };
}

function maxAttemptsFor(task: RegressionTaskRecord, env: NodeJS.ProcessEnv): number {
  const spec = parseWebJobSpec(task.jobSpec);
  if (spec !== null && spec.retry > 0) return spec.retry + 1;
  return positiveIntFromEnv(env.AOS_RUNNER_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
}

export class WebRunnerControlService {
  private readonly store: ProjectStore;
  private readonly hostId: string;
  private readonly instanceId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: WebRunnerControlServiceOptions) {
    this.store = options.store;
    this.hostId = options.hostId;
    this.instanceId = options.instanceId;
    this.env = options.env ?? process.env;
    this.now = options.now ?? ((): number => Date.now());
  }

  private async requireRunner(): Promise<WebRunnerRecord> {
    const runner = await this.store.getWebRunner(this.hostId);
    if (runner === null || runner.instanceId !== this.instanceId) {
      throw new RunnerControlError("session-lost", "runner 实例已失效，请重新心跳");
    }
    return runner;
  }

  private async resolveJob(taskId: string): Promise<ClaimedJob> {
    const job = await this.store.getWebJobById(taskId);
    if (job === null || job.task.jobSpec === null) {
      throw new RunnerControlError("not-found", `未知 web job ${taskId}`);
    }
    if (job.task.claimedHostId !== null && job.task.claimedHostId !== this.hostId) {
      throw new RunnerControlError("forbidden", `job ${taskId} 不属于主机 ${this.hostId}`);
    }
    return job;
  }

  private async requireClaimedJob(taskId: string): Promise<ClaimedJob> {
    const job = await this.resolveJob(taskId);
    if (job.task.claimedHostId !== this.hostId) {
      throw new RunnerControlError("claim-lost", `job ${taskId} 未被主机 ${this.hostId} 领取`);
    }
    if (job.task.claimedInstanceId !== this.instanceId) {
      throw new RunnerControlError("claim-lost", `job ${taskId} 已被其他 runner 实例接管`);
    }
    return job;
  }

  async heartbeat(input: WebRunnerHeartbeatInput): Promise<WebHeartbeatResponse> {
    const atMs = this.now();
    const at = iso(atMs);
    const runner = await this.store.upsertWebRunner({
      hostId: this.hostId,
      name: input.name,
      hostname: input.host.hostname,
      platforms: input.inventory.platforms,
      devices: input.inventory.devices,
      tools: input.inventory.tools,
      artifactBaseUrl: input.artifactBaseUrl,
      version: input.version,
      instanceId: this.instanceId,
      lastSeenAt: at,
      activeWithinMs: runnerTtlFrom(this.env)
    });
    try {
      await this.store.upsertHost({
        id: this.hostId,
        hostname: input.host.hostname,
        username: input.host.username,
        osPlatform: input.host.osPlatform,
        osVersion: input.host.osVersion,
        arch: input.host.arch,
        kind: input.host.kind,
        runnerSeenAt: at
      });
    } catch {
      /* 主机画像失败不阻断 runner 心跳（与直连 PG 路径一致）。 */
    }

    const cancelTaskIds = new Set<string>();
    const leaseLostTaskIds = new Set<string>();
    for (const active of input.active) {
      const job = await this.store.getWebJobById(active.taskId).catch(() => null);
      if (job === null) continue;
      if (job.task.claimedHostId !== this.hostId || job.task.claimedInstanceId !== this.instanceId) {
        continue;
      }
      try {
        await this.store.updateRegressionTask(job.rootPath, job.task.id, {
          lastProgressAt: at
        });
      } catch {
        /* best effort */
      }
      try {
        const renewed = await this.store.renewDeviceLeases({
          hostId: this.hostId,
          taskId: job.task.id,
          serials: [active.serial],
          at
        });
        if (renewed === 0) leaseLostTaskIds.add(job.task.id);
      } catch {
        leaseLostTaskIds.add(job.task.id);
      }
      if (job.task.status === "stopping") cancelTaskIds.add(job.task.id);
    }

    let recovered = 0;
    try {
      recovered = await recoverStaleWebJobs({
        store: this.store,
        env: this.env,
        nowMs: atMs,
        staleMs: nonNegativeIntFromEnv(
          this.env.MOBILE_TESTING_RUNNER_STALE_CLAIM_MS ??
            this.env.AOS_RUNNER_STALE_CLAIM_MS,
          900_000
        ),
        runnerTtlMs: runnerTtlFrom(this.env),
        hostId: this.hostId,
        instanceId: this.instanceId
      });
    } catch {
      /* 心跳仍成功；下一轮再回收 */
    }

    let reassigned = 0;
    try {
      reassigned = await reassignExpiredWebJobs({
        store: this.store,
        env: this.env,
        nowMs: atMs,
        leaseTtlMs: deviceLeaseTtlMs(this.env),
        runnerTtlMs: runnerTtlFrom(this.env)
      });
    } catch {
      /* best effort */
    }

    let assigned = 0;
    try {
      assigned = await assignPendingWebJobs({
        store: this.store,
        env: this.env,
        nowMs: atMs,
        runnerTtlMs: runnerTtlFrom(this.env),
        reservationTtlMs: deviceLeaseTtlMs(this.env)
      });
    } catch {
      /* best effort */
    }

    const host = await this.store.getHost(this.hostId).catch(() => null);
    return {
      ok: true,
      runnerId: runner.id,
      queuePaused: host?.queuePaused === true,
      cancelTaskIds: [...cancelTaskIds],
      leaseLostTaskIds: [...leaseLostTaskIds],
      assigned,
      reassigned,
      recovered,
      serverTime: at
    };
  }

  async claim(deviceSerial: string): Promise<WebClaimResponse> {
    const runner = await this.requireRunner();
    const host = await this.store.getHost(this.hostId).catch(() => null);
    if (host?.queuePaused === true) return { kind: "paused" };
    const claimed = await this.store.claimWebJob({
      runnerId: runner.id,
      hostId: this.hostId,
      deviceSerial,
      instanceId: this.instanceId,
      executionMode: "maestro",
      nowMs: this.now()
    });
    if (claimed === null) return { kind: "idle" };

    const projectSlug = projectSlugOf(claimed.rootPath);
    const busy = await this.leaseConflict(claimed.task);
    if (busy !== null) {
      await this.store
        .releaseRegressionTask({
          rootPath: claimed.rootPath,
          runnerId: runner.id,
          taskId: claimed.task.id,
          to: "pending"
        })
        .catch(() => false);
      await this.releaseTaskLeases(claimed.task);
      return { kind: "busy", reason: busy };
    }

    const maxAttempts = maxAttemptsFor(claimed.task, this.env);
    if (claimed.task.attempts >= maxAttempts) {
      const cancelled = await this.failExhausted(claimed, maxAttempts);
      return { kind: "exhausted", taskId: claimed.task.id, projectSlug, cancelled };
    }
    return {
      kind: "claimed",
      task: toWebJobTask(claimed.task),
      projectSlug,
      maxAttempts,
      leaseToken: leaseTokenFor(
        this.env,
        this.hostId,
        claimed.task.id,
        claimed.task.deviceSerial ?? deviceSerial
      )
    };
  }

  private async leaseConflict(
    task: RegressionTaskRecord
  ): Promise<"device-busy" | "lease-lost" | null> {
    if (task.deviceSerial === null) return null;
    const leases = await this.store.listDeviceLeases({ hostId: this.hostId }).catch(() => []);
    const nowMs = this.now();
    const mine = leases.find(
      (lease) =>
        lease.serial === task.deviceSerial &&
        lease.taskId === task.id &&
        Date.parse(lease.expiresAt) > nowMs
    );
    if (mine === undefined) return "lease-lost";
    const foreign = leases.find(
      (lease) =>
        lease.serial === task.deviceSerial &&
        lease.taskId !== task.id &&
        Date.parse(lease.expiresAt) > nowMs
    );
    return foreign === undefined ? null : "device-busy";
  }

  private async releaseTaskLeases(task: RegressionTaskRecord): Promise<void> {
    const serials = task.deviceSerial === null ? [] : [task.deviceSerial];
    await this.store
      .releaseDeviceLeases({
        hostId: this.hostId,
        taskId: task.id,
        ...(serials.length === 0 ? {} : { serials })
      })
      .catch(() => 0);
  }

  private async failExhausted(job: ClaimedJob, maxAttempts: number): Promise<boolean> {
    const at = iso(this.now());
    const spec = parseWebJobSpec(job.task.jobSpec);
    const updated = await this.store
      .updateRegressionTask(job.rootPath, job.task.id, {
        status: "failed",
        deviceLeaseId: null,
        ...(spec === null
          ? {}
          : {
              jobSpec: {
                ...spec,
                deviceLeaseId: null,
                assignmentError: {
                  code: "max-attempts",
                  message: `执行失败已达上限（${maxAttempts} 次），任务终止`,
                  at
                }
              } as Record<string, unknown>
            }),
        expectStatuses: ["claimed"]
      })
      .catch(() => false);
    let cancelled = false;
    if (!updated) {
      const after = await this.store.getWebJobById(job.task.id).catch(() => null);
      if (after?.task.status === "stopping") {
        await this.store.ackCancellation({ rootPath: job.rootPath, taskId: job.task.id }).catch(
          () => null
        );
        cancelled = true;
      }
    }
    await this.releaseTaskLeases(job.task);
    return cancelled;
  }

  async begin(taskId: string) {
    const job = await this.requireClaimedJob(taskId);
    const runner = await this.requireRunner();
    const at = iso(this.now());
    const started = await this.store.beginExecution({
      rootPath: job.rootPath,
      taskId,
      runnerId: runner.id,
      instanceId: this.instanceId,
      at
    });
    if (started !== null) {
      return { started: true as const, startedAt: started.startedAt ?? at };
    }
    const after = await this.store.getWebJobById(taskId).catch(() => null);
    if (after === null) return { started: false as const, reason: "not-found" as const };
    if (after.task.status === "stopping" || after.task.status === "cancelled") {
      return { started: false as const, reason: "cancelled" as const };
    }
    return { started: false as const, reason: "claim-lost" as const };
  }

  async progress(taskId: string) {
    const job = await this.requireClaimedJob(taskId);
    const at = iso(this.now());
    await this.store
      .updateRegressionTask(job.rootPath, taskId, { lastProgressAt: at })
      .catch(() => false);
    const fresh = await this.store.getWebJobById(taskId).catch(() => null);
    const status = fresh?.task.status ?? job.task.status;
    return { cancelRequested: status === "stopping", status };
  }

  async terminal(
    taskId: string,
    status: WebRunnerTerminalStatus,
    detail?: string
  ): Promise<WebRunnerTerminalOutcome> {
    void detail;
    const job = await this.requireClaimedJob(taskId);
    if (job.task.status === "stopping") {
      await this.store
        .ackCancellation({ rootPath: job.rootPath, taskId })
        .catch(() => null);
      return "cancelled";
    }
    if (job.task.status !== "running") return "skipped";
    const spec = parseWebJobSpec(job.task.jobSpec);
    const updated = await this.store
      .updateRegressionTask(job.rootPath, taskId, {
        status,
        lastProgressAt: iso(this.now()),
        deviceLeaseId: null,
        ...(spec === null
          ? {}
          : { jobSpec: { ...spec, deviceLeaseId: null } as Record<string, unknown> }),
        expectStatuses: ["running"]
      })
      .catch(() => false);
    if (updated) return "written";
    const after = await this.store.getWebJobById(taskId).catch(() => null);
    if (after?.task.status === "stopping") {
      await this.store.ackCancellation({ rootPath: job.rootPath, taskId }).catch(() => null);
      return "cancelled";
    }
    return "skipped";
  }

  async cancelAck(taskId: string): Promise<void> {
    const job = await this.requireClaimedJob(taskId);
    await this.store.ackCancellation({ rootPath: job.rootPath, taskId }).catch(() => null);
  }

  async release(taskId: string, to: "pending" | "failed"): Promise<void> {
    const job = await this.requireClaimedJob(taskId);
    if (job.task.status === "stopping") {
      await this.store.ackCancellation({ rootPath: job.rootPath, taskId }).catch(() => null);
      return;
    }
    const runner = await this.requireRunner();
    await this.store.releaseRegressionTask({
      rootPath: job.rootPath,
      runnerId: runner.id,
      taskId,
      to
    });
  }

  async renewLease(taskId: string, serial: string, leaseToken: string) {
    await this.requireClaimedJob(taskId);
    if (!leaseTokenMatches(this.env, this.hostId, taskId, serial, leaseToken)) {
      throw new RunnerControlError("forbidden", `设备租约令牌无效（task=${taskId} serial=${serial}）`);
    }
    const at = iso(this.now());
    const renewed = await this.store.renewDeviceLeases({
      hostId: this.hostId,
      taskId,
      serials: [serial],
      at
    });
    return { renewed, serverTime: at };
  }

  async releaseLease(taskId: string, serial: string, leaseToken: string) {
    if (!leaseTokenMatches(this.env, this.hostId, taskId, serial, leaseToken)) {
      throw new RunnerControlError("forbidden", `设备租约令牌无效（task=${taskId} serial=${serial}）`);
    }
    const released = await this.store.releaseDeviceLeases({
      hostId: this.hostId,
      taskId,
      serials: [serial]
    });
    return { released };
  }

  async stop(): Promise<void> {
    await this.store
      .markWebRunnerStopped({ hostId: this.hostId, instanceId: this.instanceId })
      .catch(() => false);
  }
}

/** 直连 PG 的兼容实现：中心本机/旧部署继续可用。 */
export function createStoreWebRunnerControl(
  options: WebRunnerControlServiceOptions
): WebRunnerControl {
  const service = new WebRunnerControlService(options);
  return {
    hostId: options.hostId,
    instanceId: options.instanceId,
    heartbeat: (input) => service.heartbeat(input),
    claim: (deviceSerial) => service.claim(deviceSerial),
    begin: (taskId) => service.begin(taskId),
    progress: (taskId) => service.progress(taskId),
    terminal: (taskId, status, detail) => service.terminal(taskId, status, detail),
    cancelAck: (taskId) => service.cancelAck(taskId),
    release: (taskId, to) => service.release(taskId, to),
    renewLease: (taskId, serial, leaseToken) =>
      service.renewLease(taskId, serial, leaseToken),
    releaseLease: (taskId, serial, leaseToken) =>
      service.releaseLease(taskId, serial, leaseToken),
    stop: () => service.stop()
  };
}
