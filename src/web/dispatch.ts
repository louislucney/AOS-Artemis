import type { DeviceLeaseRecord, RunnerDevice, RunnerTools } from "../db/types.js";
import { isRunnerOnline } from "../runner/status.js";

export type WebDeviceKind = "device" | "simulator" | "any";

export type WebToolName =
  | "adb"
  | "idb"
  | "simctl"
  | "ideviceId"
  | "appium"
  | "maestro"
  | "devicectl";

export interface WebDispatchRequirements {
  platform: "android" | "ios";
  deviceKind: WebDeviceKind;
  deviceModel?: string[];
  osVersion?: { min?: string; max?: string };
  tools?: WebToolName[];
}

export interface WebAssignmentRequest {
  assignment: "auto" | "manual";
  devicePinned?: boolean;
  targetHostId?: string | null;
  deviceSerial?: string | null;
  requirements: WebDispatchRequirements;
}

export interface WebRunnerCandidate {
  id: string;
  hostId: string;
  hostname: string;
  platforms: string[];
  devices: RunnerDevice[];
  tools: RunnerTools;
  lastSeenAt: string;
}

export type WebAssignmentFailureCode =
  | "no-runner"
  | "no-device"
  | "host-offline"
  | "device-busy"
  | "requirements-unmet";

export type WebAssignmentResult =
  | { ok: true; hostId: string; deviceSerial: string; score: number; reasons: string[] }
  | { ok: false; code: WebAssignmentFailureCode; message: string };

export interface SelectWebAssignmentInput {
  runners: WebRunnerCandidate[];
  leases: DeviceLeaseRecord[];
  request: WebAssignmentRequest;
  nowMs: number;
  runnerTtlMs: number;
  /** 仅用于同分抽样；缺省取稳定顺序的第一台。 */
  rng?: () => number;
  /** 重新选机时排除本任务自己的预占租约（避免把自己判成占用）。 */
  taskId?: string | null;
}

export interface DeviceScore {
  score: number;
  reasons: string[];
}

export type DeviceHardCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "runner-offline"
        | "device-unavailable"
        | "platform-mismatch"
        | "device-kind-mismatch"
        | "missing-tool"
        | "lease-active";
      detail: string;
    };

const WEB_TOOL_NAMES: readonly WebToolName[] = [
  "adb",
  "idb",
  "simctl",
  "ideviceId",
  "appium",
  "maestro",
  "devicectl"
];

const WEB_TOOL_SET = new Set<string>(WEB_TOOL_NAMES);

const UNAVAILABLE_DEVICE_STATES = new Set(["offline", "unauthorized", "unavailable", "shutdown"]);

/** 数字点分版本：`17.2.1` → `[17,2,1]`；空串、非数字段、负号等一律 null。 */
export function parseOsVersion(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text === "") return null;
  const segments: number[] = [];
  for (const part of text.split(".")) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isSafeInteger(value)) return null;
    segments.push(value);
  }
  return segments.length === 0 ? null : segments;
}

/** 段级比较：缺失段按 0 处理（`17.2` == `17.2.0`）。 */
export function compareOsVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function versionDistance(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  let distance = 0;
  let weight = 1;
  for (let index = 0; index < length; index += 1) {
    distance += Math.abs((left[index] ?? 0) - (right[index] ?? 0)) * weight;
    weight /= 10;
  }
  return distance;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeModel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/g, " ").toLowerCase();
  return text === "" ? null : text;
}

function deviceBucket(device: RunnerDevice): "device" | "simulator" {
  return device.kind === "device" ? "device" : "simulator";
}

function requestedModels(requirements: WebDispatchRequirements): string[] {
  if (!Array.isArray(requirements.deviceModel)) return [];
  const models: string[] = [];
  for (const entry of requirements.deviceModel) {
    const normalized = normalizeModel(entry);
    if (normalized !== null && !models.includes(normalized)) models.push(normalized);
  }
  return models;
}

function requestedBound(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

function hasRequiredTool(tools: RunnerTools, name: WebToolName): boolean {
  const record = tools as unknown as Record<string, unknown>;
  return record[name] === true;
}

function blockingLease(
  hostId: string,
  serial: string,
  leases: DeviceLeaseRecord[],
  nowMs: number,
  taskId: string | null
): { lease: DeviceLeaseRecord; invalid: boolean } | null {
  for (const lease of leases) {
    if (lease.hostId !== hostId || lease.serial !== serial) continue;
    if (taskId !== null && lease.taskId === taskId) continue;
    const expires = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expires)) return { lease, invalid: true };
    if (expires > nowMs) return { lease, invalid: false };
  }
  return null;
}

/**
 * 硬要求（失败即不参与打分）：执行机在线、设备状态可用、平台/设备类型匹配、
 * 执行方式所需工具全部可用、设备无其他任务的有效租约。
 */
export function deviceMeetsHardRequirements(input: {
  runner: WebRunnerCandidate;
  device: RunnerDevice;
  requirements: WebDispatchRequirements;
  leases: DeviceLeaseRecord[];
  nowMs: number;
  runnerTtlMs: number;
  taskId?: string | null;
}): DeviceHardCheck {
  const { runner, device, requirements, leases, nowMs, runnerTtlMs } = input;
  if (!isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtlMs)) {
    return { ok: false, reason: "runner-offline", detail: `执行机 ${runner.hostId} 已离线` };
  }
  if (UNAVAILABLE_DEVICE_STATES.has(device.state)) {
    return {
      ok: false,
      reason: "device-unavailable",
      detail: `设备 ${device.serial} 状态不可用：${device.state}`
    };
  }
  if (device.platform !== requirements.platform) {
    return {
      ok: false,
      reason: "platform-mismatch",
      detail: `设备 ${device.serial} 平台为 ${device.platform}，要求 ${requirements.platform}`
    };
  }
  if (requirements.deviceKind !== "any" && deviceBucket(device) !== requirements.deviceKind) {
    return {
      ok: false,
      reason: "device-kind-mismatch",
      detail: `设备 ${device.serial} 类型为 ${deviceBucket(device)}，要求 ${requirements.deviceKind}`
    };
  }
  for (const tool of requirements.tools ?? []) {
    if (!hasRequiredTool(runner.tools, tool)) {
      return {
        ok: false,
        reason: "missing-tool",
        detail: `执行机 ${runner.hostId} 缺少工具 ${tool}`
      };
    }
  }
  const blocked = blockingLease(
    runner.hostId,
    device.serial,
    leases,
    nowMs,
    input.taskId ?? null
  );
  if (blocked !== null) {
    return {
      ok: false,
      reason: "lease-active",
      detail: blocked.invalid
        ? `设备 ${device.serial} 的租约时间非法，按占用处理`
        : `设备 ${device.serial} 已被任务 ${blocked.lease.taskId} 占用`
    };
  }
  return { ok: true };
}

/**
 * 软偏好打分（不排除设备）：型号精确 +20 / 同系列前缀 +10；系统版本落在 min..max 内 +5，
 * 且离下界（无下界时取上界）越近加分越多（最多 +3）。型号/版本缺失或非法均不加分。
 */
export function scoreDevice(
  device: RunnerDevice,
  requirements: WebDispatchRequirements
): DeviceScore {
  const reasons: string[] = [];
  let score = 0;

  const deviceModel = normalizeModel(device.model);
  const wantedModels = requestedModels(requirements);
  if (deviceModel !== null && wantedModels.length > 0) {
    let bestModelPoints = 0;
    for (const wanted of wantedModels) {
      if (deviceModel === wanted) {
        bestModelPoints = 20;
        reasons.push(`model exact match: ${device.model} (+20)`);
        break;
      }
      if (bestModelPoints < 10 && (deviceModel.startsWith(wanted) || wanted.startsWith(deviceModel))) {
        bestModelPoints = 10;
        reasons.push(`model same series: ${device.model} (~ ${wanted}) (+10)`);
      }
    }
    score += bestModelPoints;
  }

  const minRaw = requestedBound(requirements.osVersion?.min);
  const maxRaw = requestedBound(requirements.osVersion?.max);
  const min = minRaw === null ? null : parseOsVersion(minRaw);
  const max = maxRaw === null ? null : parseOsVersion(maxRaw);
  const version = parseOsVersion(device.osVersion);
  if (version !== null && (min !== null || max !== null)) {
    const aboveMin = min === null || compareOsVersions(version, min) >= 0;
    const belowMax = max === null || compareOsVersions(version, max) <= 0;
    if (aboveMin && belowMax) {
      score += 5;
      reasons.push(`os ${device.osVersion} within ${minRaw ?? "*"}..${maxRaw ?? "*"} (+5)`);
      const reference = min ?? max;
      if (reference !== null) {
        const bonus = Math.max(0, 3 - 2 * versionDistance(version, reference));
        if (bonus > 0) {
          score += round2(bonus);
          reasons.push(
            `os ${device.osVersion} close to ${minRaw ?? maxRaw} (+${round2(bonus)})`
          );
        }
      }
    }
  }

  return { score: round2(score), reasons };
}

function validateRequirements(requirements: WebDispatchRequirements): string | null {
  if (requirements === null || typeof requirements !== "object") {
    return "缺少 requirements";
  }
  if (requirements.platform !== "android" && requirements.platform !== "ios") {
    return `不支持的平台：${String(requirements.platform)}`;
  }
  const kind = requirements.deviceKind ?? "any";
  if (kind !== "device" && kind !== "simulator" && kind !== "any") {
    return `不支持的设备类型：${String(kind)}`;
  }
  if (requirements.tools !== undefined) {
    if (!Array.isArray(requirements.tools)) return "tools 必须是数组";
    for (const tool of requirements.tools) {
      if (typeof tool !== "string" || !WEB_TOOL_SET.has(tool)) {
        return `未知工具：${String(tool)}`;
      }
    }
  }
  if (requirements.deviceModel !== undefined && !Array.isArray(requirements.deviceModel)) {
    return "deviceModel 必须是数组";
  }
  const minRaw = requestedBound(requirements.osVersion?.min);
  const maxRaw = requestedBound(requirements.osVersion?.max);
  const min = minRaw === null ? null : parseOsVersion(minRaw);
  const max = maxRaw === null ? null : parseOsVersion(maxRaw);
  if (minRaw !== null && min === null) return `osVersion.min 非法：${minRaw}`;
  if (maxRaw !== null && max === null) return `osVersion.max 非法：${maxRaw}`;
  if (min !== null && max !== null && compareOsVersions(min, max) > 0) {
    return `osVersion 下界 ${minRaw} 大于上界 ${maxRaw}`;
  }
  return null;
}

interface Candidate {
  runner: WebRunnerCandidate;
  device: RunnerDevice;
  score: number;
  reasons: string[];
}

function pickBest(candidates: Candidate[], rng: (() => number) | undefined): Candidate {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.score > best.score) best = candidate;
  }
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  if (tied.length <= 1 || rng === undefined) return tied[0] ?? best;
  const value = rng();
  const clamped = Number.isFinite(value) ? Math.min(1 - Number.EPSILON, Math.max(0, value)) : 0;
  return tied[Math.floor(clamped * tied.length)] ?? tied[0];
}

function failure(code: WebAssignmentFailureCode, message: string): WebAssignmentResult {
  return { ok: false, code, message };
}

function success(candidate: Candidate, pinned: boolean): WebAssignmentResult {
  const reasons = [
    `runner ${candidate.runner.hostId} (${candidate.runner.hostname}) online`,
    `device ${candidate.device.serial} has no blocking lease`,
    ...(pinned ? [`device pinned by caller: ${candidate.device.serial}`] : []),
    ...candidate.reasons
  ];
  return {
    ok: true,
    hostId: candidate.runner.hostId,
    deviceSerial: candidate.device.serial,
    score: candidate.score,
    reasons
  };
}

/**
 * 下发选机：manual 先按 host（可选钉住 serial）收窄，auto 忽略 targetHostId/deviceSerial
 * 在全池选择；硬要求过滤后按软偏好打分，仅同分时用 rng 抽样。
 */
export function selectWebAssignment(input: SelectWebAssignmentInput): WebAssignmentResult {
  const { runners, leases, request, nowMs, runnerTtlMs } = input;
  const requirements = request?.requirements;
  const invalid = validateRequirements(requirements);
  if (invalid !== null) return failure("requirements-unmet", invalid);
  const effectiveRequirements: WebDispatchRequirements = {
    ...requirements,
    deviceKind: requirements.deviceKind ?? "any"
  };

  if (request.assignment !== "auto" && request.assignment !== "manual") {
    return failure("requirements-unmet", `不支持的分配方式：${String(request.assignment)}`);
  }

  const taskId = input.taskId ?? null;
  const onlineRunners = runners.filter((runner) =>
    isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtlMs)
  );

  let pool: WebRunnerCandidate[];

  if (request.assignment === "manual") {
    const targetHostId = typeof request.targetHostId === "string" ? request.targetHostId.trim() : "";
    if (targetHostId === "") {
      return failure("requirements-unmet", "manual 下发必须指定 targetHostId");
    }
    const hostRunners = runners.filter((runner) => runner.hostId === targetHostId);
    if (hostRunners.length === 0) {
      return failure("host-offline", `目标主机 ${targetHostId} 未注册 Web 执行机`);
    }
    pool = hostRunners.filter((runner) =>
      isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtlMs)
    );
    if (pool.length === 0) {
      return failure("host-offline", `目标主机 ${targetHostId} 的执行机离线`);
    }

    if (request.devicePinned === true) {
      const serial = typeof request.deviceSerial === "string" ? request.deviceSerial.trim() : "";
      if (serial === "") {
        return failure("requirements-unmet", "钉住设备必须指定 deviceSerial");
      }
      const found = pool
        .map((runner) => ({ runner, device: runner.devices.find((entry) => entry.serial === serial) }))
        .find((entry) => entry.device !== undefined);
      if (found === undefined || found.device === undefined) {
        return failure(
          "requirements-unmet",
          `设备 ${serial} 不属于目标主机 ${targetHostId}`
        );
      }
      const hard = deviceMeetsHardRequirements({
        runner: found.runner,
        device: found.device,
        requirements: effectiveRequirements,
        leases,
        nowMs,
        runnerTtlMs,
        taskId
      });
      if (!hard.ok) {
        return hard.reason === "lease-active"
          ? failure("device-busy", hard.detail)
          : failure("requirements-unmet", hard.detail);
      }
      const scored = scoreDevice(found.device, effectiveRequirements);
      return success(
        {
          runner: found.runner,
          device: found.device,
          score: scored.score,
          reasons: scored.reasons
        },
        true
      );
    }
  } else {
    pool = onlineRunners;
    if (pool.length === 0) {
      return failure("no-runner", "没有在线的 Web 执行机");
    }
  }

  let deviceCount = 0;
  let leaseOnly = 0;
  const candidates: Candidate[] = [];
  for (const runner of pool) {
    for (const device of runner.devices) {
      deviceCount += 1;
      const hard = deviceMeetsHardRequirements({
        runner,
        device,
        requirements: effectiveRequirements,
        leases,
        nowMs,
        runnerTtlMs,
        taskId
      });
      if (!hard.ok) {
        if (hard.reason === "lease-active") leaseOnly += 1;
        continue;
      }
      const scored = scoreDevice(device, effectiveRequirements);
      candidates.push({ runner, device, score: scored.score, reasons: scored.reasons });
    }
  }

  if (candidates.length === 0) {
    if (leaseOnly > 0) {
      return failure("device-busy", "满足要求的设备均被其他任务占用");
    }
    return failure(
      "no-device",
      deviceCount === 0
        ? "在线执行机上没有可用设备"
        : "在线执行机上没有满足硬要求的设备"
    );
  }

  return success(pickBest(candidates, input.rng), false);
}
