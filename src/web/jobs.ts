import type { ProjectStore, RegressionTaskRecord, WebAssetRecord, WebRunnerRecord } from "../db/types.js";
import { deviceLeaseTtlMs } from "../db/types.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import {
  selectWebAssignment,
  type WebAssignmentFailureCode,
  type WebAssignmentResult,
  type WebDispatchRequirements,
  type WebRunnerCandidate
} from "./dispatch.js";
import {
  WEB_JOB_REASSIGN_LIMIT,
  WebJobDispatchError,
  assertScriptSetMatch,
  assertWebJobCombination,
  buildAssetSnapshot,
  normalizeCaseFilter,
  parseWebJobSpec,
  webJobLeaseId,
  type WebAssetSnapshot,
  type WebJobAssignmentError,
  type WebJobExecutionMode,
  type WebJobSpec
} from "./job-spec.js";

export interface WebJobContext {
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
}

export interface CreateWebJobInput extends WebJobContext {
  rootPath: string;
  assignment: "auto" | "manual";
  devicePinned?: boolean;
  targetHostId?: string | null;
  deviceSerial?: string | null;
  requirements: WebDispatchRequirements;
  excelAssetId: string;
  packageAssetId: string;
  materialsAssetId?: string | null;
  scriptSetId?: string | null;
  executionMode: WebJobExecutionMode;
  caseFilter: { modules: string[]; caseIds: string[] };
  retry?: number;
  priority?: number;
  createdBy?: string | null;
  allowStaleScript?: boolean;
  allowPartialUnresolved?: boolean;
  nowMs?: number;
  runnerTtlMs?: number;
  /** 预占租约 TTL（缺省＝`AOS_DEVICE_LEASE_MS`）。 */
  reservationTtlMs?: number;
  rng?: () => number;
}

export interface WebJobBinding {
  hostId: string;
  deviceSerial: string;
  score: number;
}

export interface CreateWebJobResult {
  task: RegressionTaskRecord;
  /** 已绑定 host+设备时有值；manual host 离线/暂无候选时为 null（任务 pending 等待）。 */
  assignment: WebJobBinding | null;
  pendingReason: string | null;
}

export interface AssignPendingWebJobsInput extends WebJobContext {
  nowMs: number;
  runnerTtlMs: number;
  reservationTtlMs?: number;
  rng?: () => number;
}

export interface ReassignExpiredWebJobsInput extends WebJobContext {
  nowMs: number;
  leaseTtlMs: number;
  runnerTtlMs?: number;
  reservationTtlMs?: number;
  rng?: () => number;
}

export interface ReleaseWebJobInput extends WebJobContext {
  rootPath: string;
  taskId: string;
  reason: "cancelled" | "expired" | "reassign";
  actor?: string | null;
}

interface SelectionFailure {
  ok: false;
  code: WebAssignmentFailureCode;
  message: string;
}

interface SelectionSuccess {
  ok: true;
  hostId: string;
  deviceSerial: string;
  score: number;
}

type Selection = SelectionSuccess | SelectionFailure;

function runnerCandidates(runners: WebRunnerRecord[]): WebRunnerCandidate[] {
  return runners.map((runner) => ({
    id: runner.id,
    hostId: runner.hostId,
    hostname: runner.hostname,
    platforms: runner.platforms,
    devices: runner.devices,
    tools: runner.tools,
    lastSeenAt: runner.lastSeenAt
  }));
}

function assignmentError(
  code: string,
  message: string,
  nowMs: number
): WebJobAssignmentError {
  return { code, message, at: new Date(nowMs).toISOString() };
}

function specRecord(spec: WebJobSpec): Record<string, unknown> {
  return spec as unknown as Record<string, unknown>;
}

function assetLabel(kind: string): string {
  if (kind === "excel") return "Excel";
  if (kind === "package") return "安装包";
  if (kind === "materials") return "测试资料";
  return "脚本集";
}

async function loadAsset(
  store: ProjectStore,
  rootPath: string,
  kind: WebAssetRecord["kind"],
  id: string | null
): Promise<WebAssetRecord | null> {
  if (id === null) return null;
  const asset = await store.getWebAsset(rootPath, id);
  if (asset === null) {
    throw new WebJobDispatchError("asset-not-found", `${assetLabel(kind)}资产不存在：${id}`);
  }
  if (asset.kind !== kind) {
    throw new WebJobDispatchError(
      "asset-kind-mismatch",
      `资产 ${id} 类型为 ${asset.kind}，此处要求 ${kind}（${assetLabel(kind)}）`
    );
  }
  return asset;
}

async function selectForSpec(
  input: WebJobContext & {
    spec: WebJobSpec;
    taskId: string | null;
    nowMs: number;
    runnerTtlMs: number;
    rng?: () => number;
  }
): Promise<Selection> {
  const [runners, leases] = await Promise.all([
    input.store.listWebRunners(),
    input.store.listDeviceLeases()
  ]);
  const result: WebAssignmentResult = selectWebAssignment({
    runners: runnerCandidates(runners),
    leases,
    request: {
      assignment: input.spec.assignment,
      devicePinned: input.spec.devicePinned,
      targetHostId: input.spec.targetHostId,
      deviceSerial: input.spec.deviceSerial,
      requirements: input.spec.requirements
    },
    nowMs: input.nowMs,
    runnerTtlMs: input.runnerTtlMs,
    taskId: input.taskId,
    ...(input.rng === undefined ? {} : { rng: input.rng })
  });
  return result;
}

function pendingSpec(
  spec: WebJobSpec,
  failure: SelectionFailure,
  nowMs: number
): WebJobSpec {
  return {
    ...spec,
    targetHostId: spec.assignment === "manual" ? spec.targetHostId : null,
    deviceSerial: spec.assignment === "manual" && spec.devicePinned ? spec.deviceSerial : null,
    deviceLeaseId: null,
    assignmentError: assignmentError(failure.code, failure.message, nowMs)
  };
}

async function createPendingTask(
  input: CreateWebJobInput,
  spec: WebJobSpec
): Promise<RegressionTaskRecord> {
  return input.store.createRegressionTask({
    rootPath: input.rootPath,
    refs: [],
    platforms: [spec.requirements.platform],
    baseline: "latest",
    createdBy: input.createdBy ?? null,
    targetHostId: spec.targetHostId,
    priority: input.priority,
    jobSpec: specRecord(spec),
    deviceSerial: spec.deviceSerial,
    deviceLeaseId: null
  });
}

/**
 * 创建 web 任务：校验组合/资产/脚本集，选机并预占设备。
 * manual 目标 host 离线或暂无候选时允许建 pending（保留 targetHostId，钉设备再保留 serial，无 lease）。
 */
export async function createWebJob(input: CreateWebJobInput): Promise<CreateWebJobResult> {
  const env = input.env ?? process.env;
  const combination = assertWebJobCombination(input);

  const webProject = await input.store.getWebProject(input.rootPath);
  if (webProject === null) {
    throw new WebJobDispatchError(
      "project-not-found",
      `不是托管 Web 项目：${input.rootPath}`
    );
  }
  if (webProject.status !== "active") {
    throw new WebJobDispatchError(
      "project-archived",
      `项目已归档（status=${webProject.status}）：${webProject.name}`
    );
  }
  const project = await input.store.getProjectByPath(input.rootPath);
  if (project === null) {
    throw new WebJobDispatchError("project-not-found", `项目未注册：${input.rootPath}`);
  }

  const excel = await loadAsset(input.store, input.rootPath, "excel", input.excelAssetId);
  const pkg = await loadAsset(input.store, input.rootPath, "package", input.packageAssetId);
  const materials = await loadAsset(
    input.store,
    input.rootPath,
    "materials",
    typeof input.materialsAssetId === "string" && input.materialsAssetId.trim() !== ""
      ? input.materialsAssetId.trim()
      : null
  );
  const scriptId =
    typeof input.scriptSetId === "string" && input.scriptSetId.trim() !== ""
      ? input.scriptSetId.trim()
      : null;
  const script = await loadAsset(input.store, input.rootPath, "scripts", scriptId);
  if (script !== null) {
    assertScriptSetMatch({
      script,
      excelAssetId: excel!.id,
      packageAssetId: pkg!.id,
      allowStaleScript: input.allowStaleScript
    });
  }

  const snapshot: WebAssetSnapshot[] = buildAssetSnapshot(
    [excel!, pkg!, materials, script].filter((asset): asset is WebAssetRecord => asset !== null)
  );
  const retry = typeof input.retry === "number" && input.retry >= 0 ? Math.trunc(input.retry) : 0;
  const spec: WebJobSpec = {
    kind: "web-test",
    assignment: combination.assignment,
    devicePinned: combination.devicePinned,
    targetHostId: combination.targetHostId,
    deviceSerial: combination.deviceSerial,
    requirements: combination.requirements,
    deviceLeaseId: null,
    excelAssetId: excel!.id,
    packageAssetId: pkg!.id,
    materialsAssetId: materials?.id ?? null,
    scriptSetId: script?.id ?? null,
    executionMode: combination.executionMode,
    caseFilter: normalizeCaseFilter(input.caseFilter),
    retry,
    allowStaleScript: input.allowStaleScript === true,
    allowPartialUnresolved: input.allowPartialUnresolved === true,
    assetSnapshot: snapshot,
    reassignCount: 0,
    assignmentError: null
  };

  const nowMs = input.nowMs ?? Date.now();
  const runnerTtlMs = input.runnerTtlMs ?? runnerTtlFrom(env);
  const reservationTtlMs = input.reservationTtlMs ?? deviceLeaseTtlMs(env);
  const selection = await selectForSpec({
    store: input.store,
    env,
    spec,
    taskId: null,
    nowMs,
    runnerTtlMs,
    rng: input.rng
  });

  if (!selection.ok) {
    if (selection.code === "device-busy") {
      throw new WebJobDispatchError("device-busy", selection.message);
    }
    if (
      spec.assignment === "manual" &&
      spec.devicePinned &&
      selection.code === "requirements-unmet"
    ) {
      throw new WebJobDispatchError("device-not-on-host", selection.message);
    }
    if (spec.assignment === "auto" && selection.code === "requirements-unmet") {
      throw new WebJobDispatchError("invalid-requirements", selection.message);
    }
    const pending = pendingSpec(spec, selection, nowMs);
    const task = await createPendingTask(input, pending);
    return { task, assignment: null, pendingReason: selection.message };
  }

  const boundSpec: WebJobSpec = {
    ...spec,
    targetHostId: selection.hostId,
    deviceSerial: selection.deviceSerial,
    deviceLeaseId: webJobLeaseId(selection.hostId, selection.deviceSerial)
  };
  const task = await input.store.createRegressionTask({
    rootPath: input.rootPath,
    refs: [],
    platforms: [spec.requirements.platform],
    baseline: "latest",
    createdBy: input.createdBy ?? null,
    targetHostId: selection.hostId,
    priority: input.priority,
    jobSpec: specRecord(boundSpec),
    deviceSerial: selection.deviceSerial,
    deviceLeaseId: boundSpec.deviceLeaseId
  });

  const leased = await input.store.acquireDeviceLeases({
    hostId: selection.hostId,
    taskId: task.id,
    projectId: project.id,
    serials: [selection.deviceSerial],
    ttlMs: reservationTtlMs,
    at: new Date(nowMs).toISOString()
  });
  if (!leased.ok) {
    await input.store.cancelRegressionTask({
      rootPath: input.rootPath,
      taskId: task.id,
      source: "panel",
      actor: input.createdBy ?? "web-job",
      actorHostId: null,
      note: `设备预占冲突：${leased.busy.join(",")}`
    });
    throw new WebJobDispatchError(
      "device-busy",
      `设备 ${selection.deviceSerial} 已被其他任务占用（${leased.busy.join(",")}）`
    );
  }

  return {
    task,
    assignment: {
      hostId: selection.hostId,
      deviceSerial: selection.deviceSerial,
      score: selection.score
    },
    pendingReason: null
  };
}

async function bindPendingTask(
  input: AssignPendingWebJobsInput,
  entry: { task: RegressionTaskRecord; rootPath: string },
  spec: WebJobSpec,
  nowMs: number,
  runnerTtlMs: number,
  reservationTtlMs: number
): Promise<boolean> {
  const selection = await selectForSpec({
    store: input.store,
    env: input.env,
    spec,
    taskId: entry.task.id,
    nowMs,
    runnerTtlMs,
    rng: input.rng
  });
  if (!selection.ok) {
    const message = selection.message;
    if (spec.assignmentError?.message !== message) {
      await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
        jobSpec: specRecord({
          ...spec,
          assignmentError: assignmentError(selection.code, message, nowMs)
        }),
        expectStatuses: ["pending"]
      });
    }
    return false;
  }

  const project = await input.store.getProjectByPath(entry.rootPath);
  const leased = await input.store.acquireDeviceLeases({
    hostId: selection.hostId,
    taskId: entry.task.id,
    projectId: project?.id ?? null,
    serials: [selection.deviceSerial],
    ttlMs: reservationTtlMs,
    at: new Date(nowMs).toISOString()
  });
  if (!leased.ok) {
    await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
      jobSpec: specRecord({
        ...spec,
        assignmentError: assignmentError(
          "device-busy",
          `设备预占冲突：${leased.busy.join(",")}`,
          nowMs
        )
      }),
      expectStatuses: ["pending"]
    });
    return false;
  }

  const leaseId = webJobLeaseId(selection.hostId, selection.deviceSerial);
  const updated = await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
    targetHostId: selection.hostId,
    deviceSerial: selection.deviceSerial,
    deviceLeaseId: leaseId,
    jobSpec: specRecord({
      ...spec,
      targetHostId: selection.hostId,
      deviceSerial: selection.deviceSerial,
      deviceLeaseId: leaseId,
      assignmentError: null
    }),
    expectStatuses: ["pending"]
  });
  if (!updated) {
    await input.store.releaseDeviceLeases({
      hostId: selection.hostId,
      taskId: entry.task.id
    });
    return false;
  }
  return true;
}

/** 给已 pending 且未绑定设备的 web 任务选机并预占；返回本次成功绑定的条数。 */
export async function assignPendingWebJobs(input: AssignPendingWebJobsInput): Promise<number> {
  const env = input.env ?? process.env;
  const reservationTtlMs = input.reservationTtlMs ?? deviceLeaseTtlMs(env);
  const pending = await input.store.listPendingWebJobs();
  let bound = 0;
  for (const entry of pending) {
    if (entry.task.deviceSerial !== null) continue;
    const spec = parseWebJobSpec(entry.task.jobSpec);
    if (spec === null) continue;
    if ((spec.reassignCount ?? 0) > WEB_JOB_REASSIGN_LIMIT) continue;
    const ok = await bindPendingTask(
      input,
      entry,
      spec,
      input.nowMs,
      input.runnerTtlMs,
      reservationTtlMs
    );
    if (ok) bound += 1;
  }
  return bound;
}

/**
 * 回收过期/离线预占：auto 回全局池重选；manual 未钉设备保留 host 重选；
 * manual 钉设备保留 host+serial 等待（在线时尝试重新预占）。改派超过 3 次判 failed。
 */
export async function reassignExpiredWebJobs(
  input: ReassignExpiredWebJobsInput
): Promise<number> {
  const env = input.env ?? process.env;
  const runnerTtlMs = input.runnerTtlMs ?? runnerTtlFrom(env);
  const reservationTtlMs = input.reservationTtlMs ?? input.leaseTtlMs;
  const [pending, leases, runners] = await Promise.all([
    input.store.listPendingWebJobs(),
    input.store.listDeviceLeases(),
    input.store.listWebRunners()
  ]);
  let processed = 0;
  for (const entry of pending) {
    if (entry.task.deviceSerial !== null) {
      const spec = parseWebJobSpec(entry.task.jobSpec);
      if (spec === null) continue;
      const hostId = entry.task.targetHostId;
      if (hostId === null) continue;
      const lease = leases.find(
        (row) =>
          row.hostId === hostId &&
          row.serial === entry.task.deviceSerial &&
          row.taskId === entry.task.id
      );
      const leaseExpired =
        lease === undefined || !(Date.parse(lease.expiresAt) > input.nowMs);
      const runner = runners.find((row) => row.hostId === hostId);
      const online = runner !== undefined && isRunnerOnline(runner.lastSeenAt, input.nowMs, runnerTtlMs);
      if (!leaseExpired && online) continue;

      processed += 1;
      const reason = leaseExpired ? "设备预占租约已过期" : `执行机 ${hostId} 离线`;
      await input.store.releaseDeviceLeases({ hostId, taskId: entry.task.id });
      const reassignCount = (spec.reassignCount ?? 0) + 1;

      if (reassignCount > WEB_JOB_REASSIGN_LIMIT) {
        await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
          status: "failed",
          deviceLeaseId: null,
          jobSpec: specRecord({
            ...spec,
            deviceLeaseId: null,
            reassignCount,
            assignmentError: assignmentError(
              "unstable-assignment",
              `无法稳定分配：${reason}（已改派 ${WEB_JOB_REASSIGN_LIMIT} 次，任务终止）`,
              input.nowMs
            )
          }),
          expectStatuses: ["pending"]
        });
        continue;
      }

      if (spec.assignment === "manual" && spec.devicePinned) {
        if (online) {
          const ok = await bindPendingTask(
            {
              store: input.store,
              env,
              nowMs: input.nowMs,
              runnerTtlMs,
              reservationTtlMs,
              rng: input.rng
            },
            entry,
            { ...spec, reassignCount },
            input.nowMs,
            runnerTtlMs,
            reservationTtlMs
          );
          if (ok) continue;
        }
        await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
          deviceLeaseId: null,
          jobSpec: specRecord({
            ...spec,
            deviceLeaseId: null,
            reassignCount,
            assignmentError: assignmentError(
              "host-offline",
              `${reason}；设备已钉住，等待 host/设备恢复后领取`,
              input.nowMs
            )
          }),
          expectStatuses: ["pending"]
        });
        continue;
      }

      const keepHost = spec.assignment === "manual";
      await input.store.updateRegressionTask(entry.rootPath, entry.task.id, {
        targetHostId: keepHost ? hostId : null,
        deviceSerial: null,
        deviceLeaseId: null,
        jobSpec: specRecord({
          ...spec,
          targetHostId: keepHost ? hostId : null,
          deviceSerial: null,
          deviceLeaseId: null,
          reassignCount,
          assignmentError: assignmentError(
            leaseExpired ? "no-device" : "host-offline",
            `${reason}；已放回${keepHost ? "目标 host 队列" : "全局队列"}重选`,
            input.nowMs
          )
        }),
        expectStatuses: ["pending"]
      });
    }
  }

  if (processed > 0) {
    await assignPendingWebJobs({
      store: input.store,
      env,
      nowMs: input.nowMs,
      runnerTtlMs,
      reservationTtlMs,
      rng: input.rng
    });
  }

  return processed;
}

/** 释放设备租约并撤销/回池任务（不删除历史行）。 */
export async function releaseWebJob(input: ReleaseWebJobInput): Promise<boolean> {
  const task = await input.store.getRegressionTask(input.rootPath, input.taskId);
  if (task === null) return false;
  const hostId = task.targetHostId ?? task.claimedHostId;
  if (hostId !== null) {
    await input.store.releaseDeviceLeases({ hostId, taskId: task.id });
  }
  if (input.reason === "cancelled") {
    const cancelled = await input.store.cancelRegressionTask({
      rootPath: input.rootPath,
      taskId: task.id,
      source: "panel",
      actor: input.actor ?? "web-job",
      actorHostId: null,
      note: "web job cancelled"
    });
    return cancelled !== null;
  }
  const spec = parseWebJobSpec(task.jobSpec);
  return input.store.updateRegressionTask(input.rootPath, task.id, {
    status: "pending",
    claimedBy: null,
    claimedAt: null,
    lastProgressAt: null,
    deviceLeaseId: null,
    expectStatuses: ["pending", "claimed", "running"],
    ...(spec === null
      ? {}
      : {
          jobSpec: specRecord({
            ...spec,
            deviceLeaseId: null,
            assignmentError: assignmentError(input.reason, `任务已回池（${input.reason}）`, Date.now())
          })
        })
  });
}
