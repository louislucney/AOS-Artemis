import type { RunnerDevice, WebAssetKind, WebAssetRecord } from "../db/types.js";
import type { WebDispatchRequirements } from "./dispatch.js";

export const WEB_JOB_SPEC_KIND = "web-test" as const;

/** 自动回池上限：超过后判 failed（防止设备反复掉线导致无限改派）。 */
export const WEB_JOB_REASSIGN_LIMIT = 3;

export type WebJobAssignmentMode = "auto" | "manual";
export type WebJobExecutionMode = "maestro" | "llm";

export interface WebJobCaseFilter {
  modules: string[];
  caseIds: string[];
}

export interface WebAssetSnapshot {
  kind: WebAssetKind;
  id: string;
  sha256: string;
  filename: string;
}

export interface WebJobAssignmentError {
  code: string;
  message: string;
  at: string;
}

export interface WebJobSpec {
  kind: "web-test";
  assignment: WebJobAssignmentMode;
  devicePinned: boolean;
  targetHostId: string | null;
  deviceSerial: string | null;
  requirements: WebDispatchRequirements;
  deviceLeaseId: string | null;
  excelAssetId: string;
  packageAssetId: string;
  materialsAssetId: string | null;
  scriptSetId: string | null;
  executionMode: WebJobExecutionMode;
  caseFilter: WebJobCaseFilter;
  retry: number;
  allowStaleScript: boolean;
  allowPartialUnresolved: boolean;
  assetSnapshot: WebAssetSnapshot[];
  reassignCount?: number;
  /** 钉设备等待轮次（只用于显式告警，不计入 `reassignCount`，不会触发 unstable-assignment）。 */
  pinnedWaitCount?: number;
  /** 最近一次选机/回池失败原因（pending 任务可见；成功绑定后清空）。 */
  assignmentError?: WebJobAssignmentError | null;
}

export type WebJobDispatchErrorCode =
  | "invalid-assignment"
  | "invalid-requirements"
  | "manual-requires-host"
  | "device-serial-requires-pin"
  | "ios-real-device-requires-llm"
  | "unknown-execution-mode"
  | "project-not-found"
  | "project-archived"
  | "asset-not-found"
  | "asset-kind-mismatch"
  | "script-set-mismatch"
  | "script-set-unverified"
  | "device-not-on-host"
  | "device-busy";

const ERROR_STATUS: Record<WebJobDispatchErrorCode, number> = {
  "invalid-assignment": 400,
  "invalid-requirements": 400,
  "manual-requires-host": 400,
  "device-serial-requires-pin": 400,
  "ios-real-device-requires-llm": 400,
  "unknown-execution-mode": 400,
  "project-not-found": 404,
  "project-archived": 409,
  "asset-not-found": 404,
  "asset-kind-mismatch": 400,
  "script-set-mismatch": 409,
  "script-set-unverified": 409,
  "device-not-on-host": 409,
  "device-busy": 409
};

/** 下发前的稳定错误码：action 层按 `status` 返回 4xx，不依赖错误文案。 */
export class WebJobDispatchError extends Error {
  readonly code: WebJobDispatchErrorCode;
  readonly status: number;

  constructor(code: WebJobDispatchErrorCode, message: string) {
    super(message);
    this.name = "WebJobDispatchError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export function webJobLeaseId(hostId: string, serial: string): string {
  return `${hostId}:${serial}`;
}

export function normalizeCaseFilter(raw: unknown): WebJobCaseFilter {
  const read = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  };
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { modules: read(record.modules), caseIds: read(record.caseIds) };
}

export function buildAssetSnapshot(records: WebAssetRecord[]): WebAssetSnapshot[] {
  return records.map((record) => ({
    kind: record.kind,
    id: record.id,
    sha256: record.sha256,
    filename: record.filename
  }));
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface WebJobCombinationInput {
  assignment: WebJobAssignmentMode;
  devicePinned?: boolean;
  targetHostId?: string | null;
  deviceSerial?: string | null;
  requirements: WebDispatchRequirements;
  executionMode: WebJobExecutionMode;
}

export interface WebJobCombination {
  assignment: WebJobAssignmentMode;
  devicePinned: boolean;
  targetHostId: string | null;
  deviceSerial: string | null;
  requirements: WebDispatchRequirements;
  executionMode: WebJobExecutionMode;
}

/**
 * 组合硬校验：`ios × device × maestro` 拒绝（iOS 真机只走 LLM/Appium）；
 * manual 必须带 host，钉设备必须显式 `devicePinned:true`；auto 忽略定向字段。
 */
export function assertWebJobCombination(input: WebJobCombinationInput): WebJobCombination {
  if (input.assignment !== "auto" && input.assignment !== "manual") {
    throw new WebJobDispatchError("invalid-assignment", `不支持的分配方式：${String(input.assignment)}`);
  }
  const mode = input.executionMode;
  if (mode !== "maestro" && mode !== "llm") {
    throw new WebJobDispatchError("unknown-execution-mode", `不支持的执行方式：${String(mode)}`);
  }
  const requirements = input.requirements;
  if (requirements === null || typeof requirements !== "object") {
    throw new WebJobDispatchError("invalid-requirements", "缺少 requirements");
  }
  if (requirements.platform !== "android" && requirements.platform !== "ios") {
    throw new WebJobDispatchError(
      "invalid-requirements",
      `不支持的平台：${String(requirements.platform)}`
    );
  }
  const kind = requirements.deviceKind ?? "any";
  if (kind !== "device" && kind !== "simulator" && kind !== "any") {
    throw new WebJobDispatchError("invalid-requirements", `不支持的设备类型：${String(kind)}`);
  }
  const normalizedRequirements: WebDispatchRequirements = { ...requirements, deviceKind: kind };
  if (requirements.platform === "ios" && kind === "device" && mode === "maestro") {
    throw new WebJobDispatchError(
      "ios-real-device-requires-llm",
      "iOS 真机不支持 Maestro 执行（请改用 executionMode=llm）"
    );
  }

  const pinned = input.devicePinned === true;
  const serial = nonEmpty(input.deviceSerial);
  const targetHostId = nonEmpty(input.targetHostId);

  if (input.assignment === "auto") {
    return {
      assignment: "auto",
      devicePinned: false,
      targetHostId: null,
      deviceSerial: null,
      requirements: normalizedRequirements,
      executionMode: mode
    };
  }

  if (targetHostId === null) {
    throw new WebJobDispatchError("manual-requires-host", "manual 下发必须指定 targetHostId");
  }
  if (!pinned && serial !== null) {
    throw new WebJobDispatchError(
      "device-serial-requires-pin",
      "deviceSerial requires devicePinned:true（只钉 host 时请清空 deviceSerial）"
    );
  }
  if (pinned && serial === null) {
    throw new WebJobDispatchError("invalid-assignment", "钉住设备必须指定 deviceSerial");
  }
  return {
    assignment: "manual",
    devicePinned: pinned,
    targetHostId,
    deviceSerial: pinned ? serial : null,
    requirements: normalizedRequirements,
    executionMode: mode
  };
}

export interface ScriptSetMatchInput {
  script: WebAssetRecord;
  excelAssetId: string;
  packageAssetId: string;
  allowStaleScript?: boolean;
}

/**
 * 脚本集与任务资产精确匹配：脚本 metadata 的 `sourceExcelAssetId`/`packageAssetId`
 * 至少声明一个绑定；声明了几个就要求几个相等。两者都缺失视为「无法核验」拒绝
 * （Plan 2 会写入绑定）。`allowStaleScript` 显式跳过校验。
 */
export function assertScriptSetMatch(input: ScriptSetMatchInput): void {
  if (input.allowStaleScript === true) return;
  const metadata = input.script.metadata ?? {};
  const expectedExcel = nonEmpty(metadata.sourceExcelAssetId);
  const expectedPackage = nonEmpty(metadata.packageAssetId);
  if (expectedExcel === null && expectedPackage === null) {
    throw new WebJobDispatchError(
      "script-set-unverified",
      `脚本集 ${input.script.id} 未声明 sourceExcelAssetId/packageAssetId，无法核验与任务资产的匹配（需重新发现或 allowStaleScript）`
    );
  }
  if (expectedExcel !== null && expectedExcel !== input.excelAssetId) {
    throw new WebJobDispatchError(
      "script-set-mismatch",
      `脚本集 ${input.script.id} 基于 Excel ${expectedExcel}，与任务 Excel ${input.excelAssetId} 不一致（需重新发现或 allowStaleScript）`
    );
  }
  if (expectedPackage !== null && expectedPackage !== input.packageAssetId) {
    throw new WebJobDispatchError(
      "script-set-mismatch",
      `脚本集 ${input.script.id} 基于安装包 ${expectedPackage}，与任务安装包 ${input.packageAssetId} 不一致（需重新发现或 allowStaleScript）`
    );
  }
}

/** Maestro 发现执行可用设备：Android 任意 / iOS 模拟器；都没有时只能产出 draft（本计划不下发发现任务）。 */
export function maestroDiscoveryDevices(devices: RunnerDevice[]): RunnerDevice[] {
  return devices.filter(
    (device) => device.platform === "android" || (device.platform === "ios" && device.kind === "simulator")
  );
}

export function canRunMaestroDiscovery(devices: RunnerDevice[]): boolean {
  return maestroDiscoveryDevices(devices).length > 0;
}

function isRequirementsRecord(value: unknown): value is WebDispatchRequirements {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.platform === "android" || record.platform === "ios";
}

/** 防御式解析 DB 中的 job_spec（损坏/旧格式一律 null，不猜测）。 */
export function parseWebJobSpec(value: Record<string, unknown> | null): WebJobSpec | null {
  if (value === null || typeof value !== "object") return null;
  if (value.kind !== WEB_JOB_SPEC_KIND) return null;
  if (value.assignment !== "auto" && value.assignment !== "manual") return null;
  if (value.executionMode !== "maestro" && value.executionMode !== "llm") return null;
  if (!isRequirementsRecord(value.requirements)) return null;
  if (typeof value.excelAssetId !== "string" || typeof value.packageAssetId !== "string") return null;
  if (!Array.isArray(value.assetSnapshot)) return null;
  if (typeof value.devicePinned !== "boolean") return null;
  const snapshot: WebAssetSnapshot[] = [];
  for (const entry of value.assetSnapshot) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.kind !== "string" || typeof record.id !== "string") continue;
    if (typeof record.sha256 !== "string" || typeof record.filename !== "string") continue;
    if (!isAssetKind(record.kind)) continue;
    snapshot.push({
      kind: record.kind,
      id: record.id,
      sha256: record.sha256,
      filename: record.filename
    });
  }
  const assignmentError =
    value.assignmentError !== null &&
    typeof value.assignmentError === "object" &&
    typeof (value.assignmentError as Record<string, unknown>).code === "string" &&
    typeof (value.assignmentError as Record<string, unknown>).message === "string"
      ? {
          code: String((value.assignmentError as Record<string, unknown>).code),
          message: String((value.assignmentError as Record<string, unknown>).message),
          at: String((value.assignmentError as Record<string, unknown>).at ?? "")
        }
      : null;
  return {
    kind: WEB_JOB_SPEC_KIND,
    assignment: value.assignment,
    devicePinned: value.devicePinned,
    targetHostId: nonEmpty(value.targetHostId),
    deviceSerial: nonEmpty(value.deviceSerial),
    requirements: { ...value.requirements, deviceKind: value.requirements.deviceKind ?? "any" },
    deviceLeaseId: nonEmpty(value.deviceLeaseId),
    excelAssetId: value.excelAssetId,
    packageAssetId: value.packageAssetId,
    materialsAssetId: nonEmpty(value.materialsAssetId),
    scriptSetId: nonEmpty(value.scriptSetId),
    executionMode: value.executionMode,
    caseFilter: normalizeCaseFilter(value.caseFilter),
    retry: typeof value.retry === "number" && value.retry >= 0 ? Math.trunc(value.retry) : 0,
    allowStaleScript: value.allowStaleScript === true,
    allowPartialUnresolved: value.allowPartialUnresolved === true,
    assetSnapshot: snapshot,
    reassignCount:
      typeof value.reassignCount === "number" && value.reassignCount >= 0
        ? Math.trunc(value.reassignCount)
        : 0,
    pinnedWaitCount:
      typeof value.pinnedWaitCount === "number" && value.pinnedWaitCount >= 0
        ? Math.trunc(value.pinnedWaitCount)
        : 0,
    assignmentError
  };
}

function isAssetKind(value: string): value is WebAssetKind {
  return value === "excel" || value === "package" || value === "materials" || value === "scripts";
}
