import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ExcelMappingRecord,
  ProjectStore,
  RegressionTaskRecord,
  RegressionTaskStatus,
  WebAssetRecord
} from "../db/types.js";
import { recordAuditSafe } from "../db/audit-event.js";
import { errorMessage, log, writeFileAtomic } from "../util.js";
import { writeAssertionColumn } from "./assertion-column.js";
import { classifyExpectedResult, type AssertionDoc } from "./assertions.js";
import { decodeCsv, exportWorkbookCsv, type CsvEncoding, type CsvLineEnding } from "./csv.js";
import { parseExcel, type ParsedExcelCase } from "./excel.js";
import { parseWebJobSpec, type WebJobSpec } from "./job-spec.js";
import { withFileLock } from "./lock.js";
import { writePlatformResults, type PlatformResultRow } from "./platform-result.js";
import { ensureWorkbookCopy, workbookCopyPath } from "./workbook.js";
import {
  recoverPendingWriteback,
  writebackWorkbook,
  type SystemColumnKey,
  type WritebackCellWrite,
  type WritebackResult,
  type WritebackRow
} from "./writeback.js";

export type WebResultCaseStatus = "PASS" | "FAIL" | "SKIP" | "ERROR";

export interface WebResultCase {
  caseId: string;
  name: string;
  status: WebResultCaseStatus;
  durationMs?: number;
  failureStep?: string;
  failureReason?: string;
  traceId?: string;
  screenshotPaths?: string[];
  logPath?: string;
}

export interface WebResultTokenUsage {
  caseId: string;
  traceId: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
}

export interface WebResultTokenTotals {
  promptTokens: number;
  completionTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

/** runner 内联上传的原始工件（base64）；不接受中心本机路径。 */
export interface WebResultArtifactUpload {
  filename: string;
  base64: string;
}

/** 解码后的工件（只用于暂存；幂等键用 filename+sha256，不重复序列化字节）。 */
export interface NormalizedWebResultArtifact {
  filename: string;
  buffer: Buffer;
  sha256: string;
}

export interface WebResultDevice {
  serial: string;
  model: string;
  osVersion: string;
}

export interface WebResultPackage {
  name: string;
  version: string;
  filename: string;
}

export interface WebResultGate {
  result: "passed" | "failed" | "partial" | "error";
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

export interface WebResultExecution {
  status: WebResultGate["result"];
  cases: WebResultCase[];
  startedAt: string;
  finishedAt: string;
  detail: string | null;
}

export interface NormalizedWebJobResultPayload {
  execution: WebResultExecution;
  device: WebResultDevice;
  package: WebResultPackage;
  startedAt: string;
  finishedAt: string;
  evidence: string[];
  tokenUsage: WebResultTokenUsage[];
  tokenArtifacts: {
    dataEngineDb?: NormalizedWebResultArtifact;
    statusJson?: NormalizedWebResultArtifact;
  };
  /** runner 上报的 execution.status（未上报则 undefined）；与用例聚合不同会告警。 */
  reportedStatus?: WebResultGate["result"];
  allowClearedRefresh: boolean;
}

/**
 * 结果契约里的任务状态：`error` 只用于结果文档/HTTP 摘要；DB 没有 error 枚举，
 * 落库统一为 `failed`（`dbStatus` 如实记录数据库状态）。
 */
export type WebResultTaskStatus = RegressionTaskStatus | "error";

export interface WebJobResultDocument {
  schemaVersion: 1;
  jobId: string;
  resultSha256: string;
  receivedAt: string;
  /** 结果契约状态（可能为 error）。 */
  taskStatus: WebResultTaskStatus;
  /** 实际落库的任务状态（error → failed；迟到首次上传保持原状态）。 */
  dbStatus: RegressionTaskStatus;
  gate: WebResultGate;
  execution: WebResultExecution;
  device: WebResultDevice;
  package: WebResultPackage;
  startedAt: string;
  finishedAt: string;
  evidence: string[];
  tokenUsage: WebResultTokenUsage[] | null;
  tokenTotals: WebResultTokenTotals | null;
  tokenArtifacts: { dataEngineDb?: string; statusJson?: string } | null;
  allowClearedRefresh: boolean;
  writebackStatus: "pending" | "written" | "writeback-failed";
  writebackError: string | null;
  writtenCells: WritebackCellWrite[];
  /** CSV 源导出的结果 CSV（绝对路径）；xlsx 源/导出失败为 null。 */
  resultCsvPath: string | null;
  /** 隐藏断言列写入格数。 */
  assertionCells: number;
  /** 平台结果列摘要（空结果/写失败为 null）。 */
  platformResult: {
    column: number;
    header: string;
    appended: boolean;
    layout: "fixed" | "legacy";
  } | null;
  warnings: string[];
}

export interface IngestWebJobResultInput {
  store: ProjectStore;
  jobId: string;
  /** HTTP 已解析的 JSON body。 */
  payload: unknown;
  /** 显式解冻人工清空的系统格（缺省 false；payload 顶层同名字段亦可）。 */
  allowClearedRefresh?: boolean;
  /** 审计操作人/主机（runner 路由传 host id）。 */
  actor?: string | null;
  nowMs?: number;
}

export interface WebJobIngestSummary {
  jobId: string;
  resultSha256: string;
  /** 结果契约状态（空结果/上报 error → `error`）。 */
  taskStatus: WebResultTaskStatus;
  /** 实际落库状态（`error` → `failed`；迟到首次上传保持任务原状态）。 */
  dbStatus: RegressionTaskStatus;
  gate: WebResultGate;
  writtenCells: WritebackCellWrite[];
  warnings: string[];
  writebackStatus: "written" | "writeback-failed";
  /** true＝同内容重复上传，未再次写回/journal。 */
  idempotent: boolean;
  resultPath: string;
  /** CSV 源导出的结果 CSV（绝对路径）；xlsx 源/导出失败为 null。 */
  resultCsvPath: string | null;
  /** 隐藏断言列写入格数（0＝未写/无可用原件）。 */
  assertionCells: number;
  /** 平台结果列摘要（未写时为 null）。 */
  platformResult: {
    column: number;
    header: string;
    appended: boolean;
    layout: "fixed" | "legacy";
  } | null;
}

export type WebResultErrorCode =
  | "invalid-result"
  | "job-not-found"
  | "task-not-running"
  | "invalid-job-spec"
  | "excel-asset-missing"
  | "excel-mapping-missing";

const ERROR_STATUS: Record<WebResultErrorCode, number> = {
  "invalid-result": 400,
  "job-not-found": 404,
  "task-not-running": 409,
  "invalid-job-spec": 409,
  "excel-asset-missing": 409,
  "excel-mapping-missing": 409
};

/** 迟到首次结果允许落库（不改任务状态）的终态。 */
const LATE_RESULT_STATUSES = new Set<RegressionTaskStatus>(["completed", "failed", "partial"]);

/** 结果上传的稳定错误码（action 层按 `status` 回 HTTP，不依赖文案）。 */
export class WebResultError extends Error {
  readonly code: WebResultErrorCode;
  readonly status: number;

  constructor(code: WebResultErrorCode, message: string) {
    super(message);
    this.name = "WebResultError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

const CASE_STATUSES = new Set<WebResultCaseStatus>(["PASS", "FAIL", "SKIP", "ERROR"]);
const RESULT_STATUSES = new Set<WebResultGate["result"]>(["passed", "failed", "partial", "error"]);
const MAX_EVIDENCE = 500;
const MAX_STRING = 2000;
/** 单个 token 工件解码后上限（body 总上限见 `MAX_PANEL_RESULT_BODY_BYTES`）。 */
export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_NAME = 100;

export function webJobResultsDir(rootPath: string, jobId: string): string {
  return path.join(path.resolve(rootPath), ".artemis", "web", "results", jobId);
}

export function resultPathForJob(rootPath: string, jobId: string): string {
  return path.join(webJobResultsDir(rootPath, jobId), "result.json");
}

/** CSV 源的结果 CSV 固定路径（派生文件，可覆盖）：`.artemis/web/workbook/<assetId>.result.csv`。 */
export function webResultCsvPath(rootPath: string, assetId: string): string {
  return path.join(path.resolve(rootPath), ".artemis", "web", "workbook", `${assetId}.result.csv`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebResultError("invalid-result", `结果字段 ${field} 缺失或不是非空字符串`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new WebResultError("invalid-result", `结果字段 ${field} 必须是字符串`);
  }
  return value.trim();
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WebResultError("invalid-result", `结果字段 ${field} 缺失（需要 ISO 时间）`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new WebResultError("invalid-result", `结果字段 ${field} 不是合法时间：${value}`);
  }
  return new Date(parsed).toISOString();
}

function clip(value: string, max = MAX_STRING): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function numberField(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new WebResultError("invalid-result", `结果字段 ${field} 必须是非负数字`);
  }
  return value;
}

function stringList(value: unknown, field: string, max = MAX_EVIDENCE): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new WebResultError("invalid-result", `结果字段 ${field} 必须是字符串数组`);
  }
  if (value.length > max) {
    throw new WebResultError("invalid-result", `结果字段 ${field} 超过上限 ${max} 条`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new WebResultError("invalid-result", `结果字段 ${field}[${index}] 必须是字符串`);
    }
    return entry.trim();
  }).filter((entry) => entry !== "");
}

function parseCase(raw: unknown, index: number): WebResultCase {
  if (!isRecord(raw)) {
    throw new WebResultError("invalid-result", `execution.cases[${index}] 不是对象`);
  }
  const statusRaw = typeof raw.status === "string" ? raw.status.trim().toUpperCase() : "";
  if (!CASE_STATUSES.has(statusRaw as WebResultCaseStatus)) {
    throw new WebResultError(
      "invalid-result",
      `execution.cases[${index}].status 非法：${String(raw.status)}（PASS/FAIL/SKIP/ERROR）`
    );
  }
  const parsed: WebResultCase = {
    caseId: text(raw.caseId, `execution.cases[${index}].caseId`),
    name: optionalText(raw.name, `execution.cases[${index}].name`),
    status: statusRaw as WebResultCaseStatus
  };
  const duration = numberField(raw.durationMs, `execution.cases[${index}].durationMs`);
  if (duration !== undefined) parsed.durationMs = duration;
  const failureStep = optionalText(raw.failureStep, `execution.cases[${index}].failureStep`);
  if (failureStep !== "") parsed.failureStep = clip(failureStep);
  const failureReason = optionalText(raw.failureReason, `execution.cases[${index}].failureReason`);
  if (failureReason !== "") parsed.failureReason = clip(failureReason);
  const traceId = optionalText(raw.traceId, `execution.cases[${index}].traceId`);
  if (traceId !== "") parsed.traceId = traceId;
  if (raw.screenshotPaths !== undefined) {
    parsed.screenshotPaths = stringList(
      raw.screenshotPaths,
      `execution.cases[${index}].screenshotPaths`,
      50
    );
  }
  const logPath = optionalText(raw.logPath, `execution.cases[${index}].logPath`);
  if (logPath !== "") parsed.logPath = logPath;
  return parsed;
}

function parseTokenUsage(raw: unknown): WebResultTokenUsage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new WebResultError("invalid-result", "tokenUsage 必须是数组");
  }
  if (raw.length > 10_000) {
    throw new WebResultError("invalid-result", "tokenUsage 超过上限 10000 条");
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new WebResultError("invalid-result", `tokenUsage[${index}] 不是对象`);
    }
    const usage: WebResultTokenUsage = {
      caseId: text(entry.caseId, `tokenUsage[${index}].caseId`),
      traceId: optionalText(entry.traceId, `tokenUsage[${index}].traceId`),
      model: optionalText(entry.model, `tokenUsage[${index}].model`)
    };
    for (const field of [
      "promptTokens",
      "completionTokens",
      "cacheCreateTokens",
      "cacheReadTokens"
    ] as const) {
      const value = numberField(entry[field], `tokenUsage[${index}].${field}`);
      if (value !== undefined) usage[field] = value;
    }
    return usage;
  });
}

function parseArtifact(
  raw: unknown,
  field: string
): NormalizedWebResultArtifact | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new WebResultError(
      "invalid-result",
      `${field} 必须是 {filename, base64} 对象（不接受中心本机路径）`
    );
  }
  if (typeof raw.base64 !== "string") {
    throw new WebResultError(
      "invalid-result",
      `${field}.base64 缺失：请内联上传工件内容（不接受路径）`
    );
  }
  const filename = text(raw.filename, `${field}.filename`);
  if (filename.length > 255) {
    throw new WebResultError("invalid-result", `${field}.filename 超过 255 字符`);
  }
  const encoded = raw.base64.trim().replace(/=+$/, "");
  if (encoded === "" || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+$/.test(encoded)) {
    throw new WebResultError("invalid-result", `${field}.base64 不是合法 base64`);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0) {
    throw new WebResultError("invalid-result", `${field} 解码后为空`);
  }
  if (buffer.toString("base64").replace(/=+$/, "") !== encoded) {
    throw new WebResultError("invalid-result", `${field}.base64 不是规范 base64`);
  }
  if (buffer.length > ARTIFACT_MAX_BYTES) {
    throw new WebResultError(
      "invalid-result",
      `${field} 解码后超过上限 ${ARTIFACT_MAX_BYTES} 字节`
    );
  }
  return {
    filename,
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex")
  };
}

function parseTokenArtifacts(raw: unknown): {
  dataEngineDb?: NormalizedWebResultArtifact;
  statusJson?: NormalizedWebResultArtifact;
} {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new WebResultError("invalid-result", "tokenArtifacts 必须是对象");
  }
  const artifacts: {
    dataEngineDb?: NormalizedWebResultArtifact;
    statusJson?: NormalizedWebResultArtifact;
  } = {};
  const db = parseArtifact(raw.dataEngineDb, "tokenArtifacts.dataEngineDb");
  if (db !== undefined) artifacts.dataEngineDb = db;
  const status = parseArtifact(raw.statusJson, "tokenArtifacts.statusJson");
  if (status !== undefined) artifacts.statusJson = status;
  const totalBytes = (db?.buffer.length ?? 0) + (status?.buffer.length ?? 0);
  if (totalBytes > ARTIFACT_MAX_BYTES * 2) {
    throw new WebResultError(
      "invalid-result",
      `tokenArtifacts 合计 ${totalBytes} 字节，超过上限 ${ARTIFACT_MAX_BYTES * 2}`
    );
  }
  return artifacts;
}

function sumTokenUsage(entries: WebResultTokenUsage[]): WebResultTokenTotals {
  const totals: WebResultTokenTotals = {
    promptTokens: 0,
    completionTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0
  };
  for (const entry of entries) {
    totals.promptTokens += entry.promptTokens ?? 0;
    totals.completionTokens += entry.completionTokens ?? 0;
    totals.cacheCreateTokens += entry.cacheCreateTokens ?? 0;
    totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
  }
  return totals;
}

/** 任务终态聚合：空结果 ≠ 成功；SKIP 只计数。 */
export function aggregateResultGate(cases: WebResultCase[]): WebResultGate {
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let skipped = 0;
  for (const entry of cases) {
    if (entry.status === "PASS") passed += 1;
    else if (entry.status === "FAIL") failed += 1;
    else if (entry.status === "ERROR") errors += 1;
    else skipped += 1;
  }
  const result: WebResultGate["result"] =
    cases.length === 0
      ? "error"
      : failed + errors > 0
        ? "failed"
        : skipped > 0
          ? "partial"
          : "passed";
  return {
    result,
    total: cases.length,
    passed,
    failed,
    errors,
    skipped
  };
}

/**
 * 任务终态：全 PASS → completed；任一 FAIL/ERROR → failed；含 SKIP → partial；
 * 空结果/runner 上报 error → 契约状态 `error`（DB 无 error，落库 `failed`，绝不写成成功）。
 */
export function taskStatusFromGate(gate: WebResultGate): WebResultTaskStatus {
  if (gate.result === "passed") return "completed";
  if (gate.result === "failed") return "failed";
  if (gate.result === "partial") return "partial";
  return "error";
}

export function persistedTaskStatus(status: WebResultTaskStatus): RegressionTaskStatus {
  return status === "error" ? "failed" : status;
}

/**
 * runner 上报的 execution.status 优先于用例聚合：`error` 永远保留（exec 超时/非零退出时
 * JUnit 可能仍全 PASS）；`failed` 或任一 FAIL/ERROR → failed；其余按用例计算。
 */
export function resolveResultStatus(
  reported: WebResultGate["result"] | undefined,
  computed: WebResultGate["result"]
): WebResultGate["result"] {
  if (reported === "error") return "error";
  if (reported === "failed" || computed === "failed") return "failed";
  return computed;
}

function canonicalArtifact(
  artifact: NormalizedWebResultArtifact | undefined
): { filename: string; sha256: string } | undefined {
  return artifact === undefined
    ? undefined
    : { filename: artifact.filename, sha256: artifact.sha256 };
}

function canonicalPayload(payload: NormalizedWebJobResultPayload): string {
  const value = {
    execution: {
      status: payload.execution.status,
      cases: payload.execution.cases,
      startedAt: payload.execution.startedAt,
      finishedAt: payload.execution.finishedAt,
      detail: payload.execution.detail
    },
    device: payload.device,
    package: payload.package,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    evidence: payload.evidence,
    tokenUsage: payload.tokenUsage,
    tokenArtifacts: {
      dataEngineDb: canonicalArtifact(payload.tokenArtifacts.dataEngineDb),
      statusJson: canonicalArtifact(payload.tokenArtifacts.statusJson)
    },
    allowClearedRefresh: payload.allowClearedRefresh
  };
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value);
}

function resultSha(payload: NormalizedWebJobResultPayload): string {
  return createHash("sha256").update(canonicalPayload(payload)).digest("hex");
}

/** 校验 + 归一化调用方（runner）上报的结果；任何结构问题 → `invalid-result`。 */
export function normalizeWebJobResultPayload(raw: unknown): NormalizedWebJobResultPayload {
  if (!isRecord(raw)) {
    throw new WebResultError("invalid-result", "结果 body 必须是 JSON 对象");
  }
  if (!isRecord(raw.execution)) {
    throw new WebResultError("invalid-result", "缺少 execution 对象");
  }
  const rawExecution = raw.execution;
  if (!Array.isArray(rawExecution.cases)) {
    throw new WebResultError("invalid-result", "execution.cases 必须是数组");
  }
  const cases = rawExecution.cases.map((entry, index) => parseCase(entry, index));
  const computed = aggregateResultGate(cases);
  let reportedStatus: WebResultGate["result"] | undefined;
  if (rawExecution.status !== undefined && rawExecution.status !== null) {
    if (typeof rawExecution.status !== "string") {
      throw new WebResultError("invalid-result", "execution.status 必须是字符串");
    }
    const normalized = rawExecution.status.trim().toLowerCase();
    if (!RESULT_STATUSES.has(normalized as WebResultGate["result"])) {
      throw new WebResultError(
        "invalid-result",
        `execution.status 非法：${rawExecution.status}（passed/failed/partial/error）`
      );
    }
    reportedStatus = normalized as WebResultGate["result"];
  }
  const gate: WebResultGate = {
    ...computed,
    result: resolveResultStatus(reportedStatus, computed.result)
  };

  const startedAt = iso(
    raw.startedAt ?? rawExecution.startedAt,
    "startedAt"
  );
  const finishedAt = iso(
    raw.finishedAt ?? rawExecution.finishedAt,
    "finishedAt"
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new WebResultError("invalid-result", "finishedAt 早于 startedAt");
  }

  if (!isRecord(raw.device)) {
    throw new WebResultError("invalid-result", "缺少 device 对象");
  }
  const device: WebResultDevice = {
    serial: text(raw.device.serial, "device.serial"),
    model: optionalText(raw.device.model, "device.model"),
    osVersion: optionalText(raw.device.osVersion, "device.osVersion")
  };

  if (!isRecord(raw.package)) {
    throw new WebResultError("invalid-result", "缺少 package 对象");
  }
  const pkg: WebResultPackage = {
    name: optionalText(raw.package.name, "package.name"),
    version: optionalText(raw.package.version, "package.version"),
    filename: text(raw.package.filename, "package.filename")
  };

  const detailRaw = optionalText(rawExecution.detail, "execution.detail");
  const tokenUsage = parseTokenUsage(raw.tokenUsage);
  const tokenArtifacts = parseTokenArtifacts(raw.tokenArtifacts);
  // runner 上传 body 不得解冻人工清空：只认内部调用参数；当前没有面板解冻入口。
  const allowClearedRefresh = false;

  return {
    execution: {
      status: gate.result,
      cases,
      startedAt,
      finishedAt,
      detail: detailRaw === "" ? null : clip(detailRaw, 4000)
    },
    device,
    package: pkg,
    startedAt,
    finishedAt,
    evidence: stringList(raw.evidence, "evidence"),
    tokenUsage,
    tokenArtifacts,
    ...(reportedStatus === undefined ? {} : { reportedStatus }),
    allowClearedRefresh
  };
}

interface WritebackTarget {
  asset: WebAssetRecord;
  mapping: ExcelMappingRecord;
  caseIdHeader: string;
  sheetName: string;
  originalPath: string;
  workbookPath: string;
}

async function resolveWritebackTarget(
  store: ProjectStore,
  rootPath: string,
  spec: WebJobSpec
): Promise<WritebackTarget> {
  if (spec.excelAssetId.trim() === "") {
    throw new WebResultError(
      "excel-asset-missing",
      "job 没有 excelAssetId：结果无法写回 Excel（不伪造写回）"
    );
  }
  const asset = await store.getWebAsset(rootPath, spec.excelAssetId);
  if (asset === null || asset.kind !== "excel") {
    throw new WebResultError(
      "excel-asset-missing",
      `Excel 资产不存在（${spec.excelAssetId}）或类型不是 excel：结果无法写回`
    );
  }
  const mappings = await store.listExcelMappings(rootPath, asset.id);
  const mapping = mappings.find(
    (candidate) =>
      candidate.sheetName.trim() !== "" &&
      typeof candidate.columnMap.caseId === "string" &&
      candidate.columnMap.caseId.trim() !== ""
  );
  if (mapping === undefined) {
    throw new WebResultError(
      "excel-mapping-missing",
      `Excel 资产 ${asset.id} 没有可用的列映射（缺 caseId 表头）：请先在面板确认列映射后再上传结果`
    );
  }
  return {
    asset,
    mapping,
    caseIdHeader: mapping.columnMap.caseId!.trim(),
    sheetName: mapping.sheetName.trim(),
    originalPath: path.resolve(asset.storagePath),
    workbookPath: workbookCopyPath(rootPath, asset.id)
  };
}

function writebackRows(
  payload: NormalizedWebJobResultPayload
): WritebackRow[] {
  const device =
    [payload.device.model, payload.device.osVersion].filter((part) => part !== "").join(" / ") ||
    payload.device.serial;
  const pkg = [payload.package.name, payload.package.version, payload.package.filename]
    .filter((part) => part !== "")
    .join(" ");
  const traceByCase = new Map<string, string>();
  for (const usage of payload.tokenUsage) {
    if (usage.traceId !== "" && !traceByCase.has(usage.caseId)) {
      traceByCase.set(usage.caseId, usage.traceId);
    }
  }
  // 任务级 error / 上报 failed 但用例全 PASS 时不写逐例 PASS，避免 Excel 假绿。
  const computed = aggregateResultGate(payload.execution.cases);
  const suppressPerCaseResult =
    payload.execution.status === "error" ||
    (payload.execution.status === "failed" && computed.result !== "failed");
  return payload.execution.cases.map((entry) => {
    const traceId = entry.traceId ?? traceByCase.get(entry.caseId);
    const values: Partial<Record<SystemColumnKey, string>> = {
      device,
      package: pkg,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt
    };
    if (!suppressPerCaseResult || entry.status !== "PASS") values.result = entry.status;
    if (traceId !== undefined && traceId !== "") values.traceId = traceId;
    return { caseId: entry.caseId, values };
  });
}

interface SourceWorkbookSummary {
  cases: ParsedExcelCase[];
  headers: string[];
}

/** CSV 原件的输出保真参数：编码/BOM/行尾，直接由原字节检测，不依赖用例映射是否可解析。 */
interface SourceCsvInfo {
  encoding: CsvEncoding;
  bom: boolean;
  lineEnding: CsvLineEnding;
}

/**
 * 只读解析原始测试文档（原件 CAS 字节）：用例/步骤/预期用于断言分类，表头用于平台列归属判定。
 * 原件的映射仍是 job 资产上已确认的那份。
 */
async function analyzeSourceWorkbook(target: WritebackTarget): Promise<SourceWorkbookSummary> {
  const buffer = await readFile(target.originalPath);
  const parsed = await parseExcel(buffer, {
    sheetName: target.sheetName,
    mapping: target.mapping.columnMap,
    ...(target.asset.metadata.format === "csv" ? { format: "csv" as const } : {})
  });
  return { cases: parsed.cases, headers: parsed.headers };
}

/**
 * CSV 结果导出的编码/行尾检测与用例解析解耦：即使映射缺列导致 `parseExcel` 失败，
 * 只要 8 列写回成功，仍能按原件编码导出结果 CSV。
 */
async function detectResultCsvSource(target: WritebackTarget): Promise<SourceCsvInfo | null> {
  if (target.asset.metadata.format !== "csv") return null;
  const buffer = await readFile(target.originalPath);
  const decoded = decodeCsv(buffer);
  return {
    encoding: decoded.encoding,
    bom: decoded.bom,
    lineEnding: decoded.text.includes("\r\n") ? "\r\n" : "\n"
  };
}

/**
 * 平台结果行沿用 8 列摘要的假绿守卫：任务级 error / 强制 failed 而用例全 PASS 时不写逐例 PASS。
 */
function platformResultRows(payload: NormalizedWebJobResultPayload): PlatformResultRow[] {
  const computed = aggregateResultGate(payload.execution.cases);
  const suppressPerCaseResult =
    payload.execution.status === "error" ||
    (payload.execution.status === "failed" && computed.result !== "failed");
  const rows: PlatformResultRow[] = [];
  for (const entry of payload.execution.cases) {
    if (suppressPerCaseResult && entry.status === "PASS") continue;
    rows.push({ caseId: entry.caseId, status: entry.status });
  }
  return rows;
}

/** 只保留安全 basename：拒绝目录分隔/隐藏文件/控制字符，限制长度。 */
export function safeArtifactFilename(filename: string, fallback: string): string {
  const base = path
    .basename(filename)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const clipped = base.slice(0, MAX_ARTIFACT_NAME);
  if (clipped === "" || clipped === "." || clipped === "..") return fallback;
  return clipped;
}

async function stageTokenArtifacts(
  resultDir: string,
  artifacts: {
    dataEngineDb?: NormalizedWebResultArtifact;
    statusJson?: NormalizedWebResultArtifact;
  }
): Promise<{
  paths: { dataEngineDb?: string; statusJson?: string } | null;
  problems: string[];
}> {
  const problems: string[] = [];
  const staged: { dataEngineDb?: string; statusJson?: string } = {};
  const entries: Array<
    [keyof typeof staged, NormalizedWebResultArtifact | undefined, string]
  > = [
    ["dataEngineDb", artifacts.dataEngineDb, "data-engine.db"],
    ["statusJson", artifacts.statusJson, "status.json"]
  ];
  const used = new Set<string>();
  for (const [key, artifact, fallback] of entries) {
    if (artifact === undefined) continue;
    const targetDir = path.join(resultDir, "artifacts");
    let filename = safeArtifactFilename(artifact.filename, fallback);
    if (used.has(filename)) filename = `${key}-${filename}`;
    used.add(filename);
    try {
      await mkdir(targetDir, { recursive: true });
      writeFileAtomic(path.join(targetDir, filename), artifact.buffer);
      staged[key] = `artifacts/${filename}`;
    } catch (error) {
      problems.push(`${key} 工件写入失败（${filename}）：${errorMessage(error)}`);
    }
  }
  if (staged.dataEngineDb === undefined && staged.statusJson === undefined) {
    return { paths: null, problems };
  }
  return { paths: staged, problems };
}

async function readResultDocument(filePath: string): Promise<WebJobResultDocument | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WebJobResultDocument>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.jobId !== "string" ||
      typeof parsed.resultSha256 !== "string"
    ) {
      return null;
    }
    return parsed as WebJobResultDocument;
  } catch {
    return null;
  }
}

export async function readWebJobResult(
  rootPath: string,
  jobId: string
): Promise<WebJobResultDocument | null> {
  return readResultDocument(resultPathForJob(rootPath, jobId));
}

function summaryFromDocument(
  document: WebJobResultDocument,
  resultPath: string,
  idempotent: boolean
): WebJobIngestSummary {
  return {
    jobId: document.jobId,
    resultSha256: document.resultSha256,
    taskStatus: document.taskStatus,
    dbStatus: document.dbStatus ?? persistedTaskStatus(document.taskStatus),
    gate: document.gate,
    writtenCells: document.writtenCells ?? [],
    warnings: document.warnings ?? [],
    writebackStatus: document.writebackStatus === "writeback-failed" ? "writeback-failed" : "written",
    idempotent,
    resultPath,
    resultCsvPath: document.resultCsvPath ?? null,
    assertionCells: document.assertionCells ?? 0,
    platformResult: document.platformResult ?? null
  };
}

async function persistDocument(
  resultPath: string,
  document: WebJobResultDocument
): Promise<void> {
  writeFileAtomic(resultPath, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * 结果入库：校验 → 聚合 → 持久化 `result.json` → 写回 Excel 工作副本（两阶段 journal）→
 * 任务终态 CAS。写回失败不回滚结果，也不改变聚合出来的任务状态（`writeback-failed` 单独上报）。
 * 幂等键＝归一化结果的 sha256：同 job 同内容重复上传返回既有摘要，不再写 journal。
 */
function resultLockPath(rootPath: string, jobId: string): string {
  return path.join(path.resolve(rootPath), ".artemis", "web", "results", `${jobId}.lock`);
}

/**
 * 任务终态写入：只在仍为 running 时 CAS；连续失败但状态仍是 running（极端 store 竞态）时
 * 再读后无守卫落终态，避免结果已保存却把任务永久留在 running。
 */
async function settleRunningTask(
  store: ProjectStore,
  rootPath: string,
  taskId: string,
  status: RegressionTaskStatus,
  spec: WebJobSpec,
  at: string
): Promise<"updated" | "not-running"> {
  const patch = {
    status,
    lastProgressAt: at,
    deviceLeaseId: null,
    jobSpec: { ...spec, deviceLeaseId: null } as Record<string, unknown>,
    expectStatuses: ["running" as const]
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await store.getRegressionTask(rootPath, taskId);
    if (fresh === null || fresh.status !== "running") return "not-running";
    if (await store.updateRegressionTask(rootPath, taskId, patch)) return "updated";
  }
  const fresh = await store.getRegressionTask(rootPath, taskId);
  if (fresh !== null && fresh.status === "running") {
    const updated = await store.updateRegressionTask(rootPath, taskId, {
      status,
      lastProgressAt: at,
      deviceLeaseId: null,
      jobSpec: { ...spec, deviceLeaseId: null } as Record<string, unknown>
    });
    return updated ? "updated" : "not-running";
  }
  return "not-running";
}

async function ingestUnderJobLock(
  input: IngestWebJobResultInput,
  payload: NormalizedWebJobResultPayload,
  jobId: string
): Promise<WebJobIngestSummary> {
  const store = input.store;
  const job = await store.getWebJobById(jobId);
  if (job === null) {
    throw new WebResultError("job-not-found", `未知 job ${jobId}`);
  }
  const { task, rootPath } = job;
  const spec = parseWebJobSpec(task.jobSpec);
  if (spec === null) {
    throw new WebResultError("invalid-job-spec", `job ${task.id} 没有可用的任务规格`);
  }

  const resultSha256 = resultSha(payload);
  const resultPath = resultPathForJob(rootPath, task.id);
  const at = new Date(input.nowMs ?? Date.now()).toISOString();

  // 锁内重读：并发的同内容上传在第二个请求里命中幂等分支。
  const existing = await readResultDocument(resultPath);
  if (existing !== null && existing.resultSha256 === resultSha256) {
    if (task.status === "running") {
      await settleRunningTask(
        store,
        rootPath,
        task.id,
        persistedTaskStatus(existing.taskStatus),
        spec,
        at
      );
    }
    return summaryFromDocument(existing, resultPath, true);
  }

  const lateFirstResult =
    existing === null && LATE_RESULT_STATUSES.has(task.status);
  if (task.status !== "running" && !lateFirstResult) {
    throw new WebResultError(
      "task-not-running",
      existing === null
        ? `job ${task.id} 当前状态为 ${task.status}（不是 running），拒绝写入结果`
        : `job ${task.id} 已有结果且任务状态为 ${task.status}：不同结果不得覆盖（result-already-recorded）`
    );
  }

  const target = await resolveWritebackTarget(store, rootPath, spec);

  const counts = aggregateResultGate(payload.execution.cases);
  const gate: WebResultGate = { ...counts, result: payload.execution.status };
  const taskStatus = taskStatusFromGate(gate);
  const dbStatus = persistedTaskStatus(taskStatus);
  const warnings: string[] = [];
  if (payload.reportedStatus !== undefined && payload.reportedStatus !== counts.result) {
    warnings.push(
      `status-mismatch: runner 上报 ${payload.reportedStatus}，按用例聚合为 ${counts.result}；采用 ${gate.result} 作为结果状态`
    );
  }
  if (lateFirstResult) {
    warnings.push(
      `status-mismatch: 任务已是 ${task.status}，按迟到的首次结果记录（${taskStatus}）；不改变任务状态`
    );
  }

  const resultDir = path.dirname(resultPath);
  await mkdir(resultDir, { recursive: true });
  const staged = await stageTokenArtifacts(resultDir, payload.tokenArtifacts);
  warnings.push(...staged.problems.map((problem) => `token-artifact: ${problem}`));
  const tokenArtifacts = staged.paths;
  if (spec.executionMode === "llm") {
    const missing: string[] = [];
    if (payload.tokenUsage.length === 0) missing.push("tokenUsage");
    if (payload.tokenArtifacts.dataEngineDb === undefined) missing.push("dataEngineDb");
    if (payload.tokenArtifacts.statusJson === undefined) missing.push("statusJson");
    if (missing.length === 0 && tokenArtifacts === null) missing.push("原始工件写入失败");
    if (missing.length > 0) {
      warnings.push(
        `token-unavailable: 远程 LLM 结果缺少 ${[...new Set(missing)].join("、")}；不按 0 计费、不伪造本地路径`
      );
    }
  }
  const tokenTotals = payload.tokenUsage.length > 0 ? sumTokenUsage(payload.tokenUsage) : null;

  let csvInfo: SourceCsvInfo | null = null;
  try {
    csvInfo = await detectResultCsvSource(target);
  } catch (error) {
    warnings.push(
      `result-csv-unavailable: 无法读取/识别 CSV 原件编码，跳过结果 CSV 导出（${errorMessage(error)}）`
    );
  }
  let source: SourceWorkbookSummary | null = null;
  try {
    source = await analyzeSourceWorkbook(target);
  } catch (error) {
    warnings.push(
      `source-unreadable: 无法解析原始测试文档，跳过平台结果列与预期断言（${errorMessage(error)}）`
    );
    warnings.push("platform-result-skipped: 原件不可解析，未写平台结果列");
    warnings.push("assertion-column-skipped: 原件不可解析，未写隐藏断言列");
  }

  let workbookResult: WritebackResult | null = null;
  let writebackError: string | null = null;
  let platformResult: WebJobIngestSummary["platformResult"] = null;
  let assertionCells = 0;
  let resultCsvPath: string | null = null;
  const pendingIds = new Map<string, string>();
  const lockPath = path.join(
    path.resolve(rootPath),
    ".artemis",
    "web",
    "workbook",
    `${target.asset.id}.lock`
  );
  try {
    workbookResult = await withFileLock(lockPath, async () => {
      const recovery = await recoverPendingWriteback({
        store,
        rootPath,
        assetId: target.asset.id,
        workbookPath: target.workbookPath
      });
      warnings.push(...recovery.warnings);
      await ensureWorkbookCopy(target.originalPath, target.workbookPath);

      // 平台结果列先写：追加位置在 8 列摘要之前（可见列顺序 = 原件 + AOS/IOS + 8 列）。
      const platformRows = platformResultRows(payload);
      if (source !== null) {
        try {
          const written = await writePlatformResults({
            workbookPath: target.workbookPath,
            sheetName: target.sheetName,
            caseIdHeader: target.caseIdHeader,
            platform: spec.requirements.platform,
            rows: platformRows,
            originalPath: target.originalPath,
            ...(source === null ? {} : { sourceHeaders: source.headers })
          });
          platformResult = {
            column: written.column,
            header: written.header,
            appended: written.appended,
            layout: written.layout
          };
          warnings.push(...written.warnings.map((warning) => `platform-result: ${warning}`));
        } catch (error) {
          warnings.push(`platform-result-failed: ${errorMessage(error)}`);
        }
      }

      const result = await writebackWorkbook({
        workbookPath: target.workbookPath,
        assetId: target.asset.id,
        sheetName: target.sheetName,
        caseIdHeader: target.caseIdHeader,
        rows: writebackRows(payload),
        originalPath: target.originalPath,
        allowClearedRefresh: payload.allowClearedRefresh,
        lastSystemValue: async (caseId, key) => {
          const record = await store.lastExcelWritebackByCellKey(
            rootPath,
            target.asset.id,
            target.sheetName,
            caseId,
            key
          );
          return record?.value ?? null;
        },
        journal: {
          begin: async (cell) => {
            const record = await store.recordExcelWriteback({
              rootPath,
              assetId: target.asset.id,
              sheetName: target.sheetName,
              jobId: task.id,
              caseId: cell.caseId,
              columnKey: cell.key,
              cellRef: cell.cellRef,
              value: cell.value,
              actor: input.actor ?? null,
              status: "pending"
            });
            pendingIds.set(cell.cellRef, record.id);
          },
          confirm: async (cell) => {
            const id = pendingIds.get(cell.cellRef);
            if (id === undefined) {
              throw new Error(`找不到 pending 写回日志：${cell.cellRef}`);
            }
            const confirmed = await store.confirmExcelWriteback(rootPath, id);
            if (!confirmed) {
              throw new Error(`pending 写回日志确认未命中：${cell.cellRef}`);
            }
          }
        }
      });

      // 隐藏断言列最后追加：可见列顺序保持「原件 + 平台结果 + 8 列」，隐藏列在末尾。
      if (source !== null) {
        try {
          const assertions = new Map<string, AssertionDoc>();
          for (const entry of source.cases) {
            assertions.set(
              entry.caseId,
              classifyExpectedResult({
                expected: entry.expected,
                steps: entry.steps,
                caseId: entry.caseId
              })
            );
          }
          const written = await writeAssertionColumn({
            workbookPath: target.workbookPath,
            sheetName: target.sheetName,
            caseIdHeader: target.caseIdHeader,
            assertions
          });
          assertionCells = written.written;
          warnings.push(...written.warnings.map((warning) => `assertion-column: ${warning}`));
        } catch (error) {
          warnings.push(`assertion-column-failed: ${errorMessage(error)}`);
        }
      }

      // 结果 CSV 只对 CSV 源导出，编码/行尾/BOM 直接来自原件检测（与用例解析解耦）；
      // 8 列写回无失败单元格才导出，映射/解析失败不影响；隐藏列由导出器跳过。
      if (csvInfo !== null && result.failed > 0) {
        warnings.push(
          `result-csv-skipped: 8 列写回存在 ${result.failed} 个失败单元格，未导出结果 CSV`
        );
      }
      if (csvInfo !== null && result.failed === 0) {
        try {
          const exported = await exportWorkbookCsv(
            target.workbookPath,
            webResultCsvPath(rootPath, target.asset.id),
            {
              encoding: csvInfo.encoding,
              lineEnding: csvInfo.lineEnding,
              bom: csvInfo.bom,
              sheetName: target.sheetName,
              overwrite: true,
              originalPath: target.originalPath
            }
          );
          resultCsvPath = exported.outPath;
        } catch (error) {
          warnings.push(`result-csv-failed: ${errorMessage(error)}`);
        }
      }

      return result;
    });
  } catch (error) {
    writebackError = errorMessage(error);
    warnings.push(`writeback-failed: ${writebackError}`);
  }
  if (workbookResult !== null) {
    warnings.push(...workbookResult.warnings);
    if (workbookResult.failed > 0) {
      writebackError = `写回失败 ${workbookResult.failed} 格`;
      warnings.push(`writeback-failed: ${writebackError}`);
    }
  }
  const writebackStatus: WebJobResultDocument["writebackStatus"] =
    writebackError === null ? "written" : "writeback-failed";

  const document: WebJobResultDocument = {
    schemaVersion: 1,
    jobId: task.id,
    resultSha256,
    receivedAt: at,
    taskStatus,
    dbStatus: lateFirstResult ? task.status : dbStatus,
    gate,
    execution: payload.execution,
    device: payload.device,
    package: payload.package,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    evidence: payload.evidence,
    tokenUsage: payload.tokenUsage.length > 0 ? payload.tokenUsage : null,
    tokenTotals,
    tokenArtifacts,
    allowClearedRefresh: payload.allowClearedRefresh,
    writebackStatus,
    writebackError,
    writtenCells: workbookResult?.writtenCells ?? [],
    resultCsvPath,
    assertionCells,
    platformResult,
    warnings
  };
  await persistDocument(resultPath, document);

  if (!lateFirstResult) {
    const outcome = await settleRunningTask(store, rootPath, task.id, dbStatus, spec, at);
    if (outcome === "not-running") {
      const fresh = await store.getRegressionTask(rootPath, task.id);
      if (fresh === null || fresh.status !== dbStatus) {
        throw new WebResultError(
          "task-not-running",
          `job ${task.id} 结果已保存，但任务状态在写入期间已不是 running；不覆盖终态（result-already-recorded）`
        );
      }
    }
  }

  await recordAuditSafe(store, rootPath, {
    domain: "web",
    action: "web.job.result",
    result: writebackStatus === "written" ? "ok" : "failed",
    summary:
      writebackStatus === "written"
        ? `Web job ${task.id} 结果入库：${taskStatus}（DB ${document.dbStatus}），写回 ${document.writtenCells.length} 格`
        : `Web job ${task.id} 结果入库：${taskStatus}（DB ${document.dbStatus}），Excel 写回失败（${writebackError ?? "unknown"}）`,
    refs: {
      jobId: task.id,
      taskStatus,
      dbStatus: document.dbStatus,
      writebackStatus,
      excelAssetId: target.asset.id
    },
    actor: input.actor ?? null,
    channel: "runner"
  });

  log(
    `Web job ${task.id} 结果入库：${taskStatus}（DB ${document.dbStatus}，写回 ${writebackStatus}，${document.writtenCells.length} 格）`
  );

  return {
    jobId: task.id,
    resultSha256,
    taskStatus,
    dbStatus: document.dbStatus,
    gate,
    writtenCells: document.writtenCells,
    warnings,
    writebackStatus,
    idempotent: false,
    resultPath,
    resultCsvPath,
    assertionCells,
    platformResult
  };
}

/**
 * 结果入库：校验 → 聚合 → 持久化 `result.json` → 写回 Excel 工作副本（两阶段 journal）→
 * 任务终态 CAS。写回失败不回滚结果，也不改变聚合出来的任务状态（`writeback-failed` 单独上报）。
 * 幂等键＝归一化结果的 sha256：同 job 同内容重复上传返回既有摘要，不再写 journal。
 * 整个流程持有 per-job 文件锁（`.artemis/web/results/<jobId>.lock`），并发上传只写一次。
 */
export async function ingestWebJobResult(
  input: IngestWebJobResultInput
): Promise<WebJobIngestSummary> {
  const initial = await input.store.getWebJobById(input.jobId);
  if (initial === null) {
    throw new WebResultError("job-not-found", `未知 job ${input.jobId}`);
  }
  const payload = normalizeWebJobResultPayload(input.payload);
  if (input.allowClearedRefresh === true) payload.allowClearedRefresh = true;
  const lockPath = resultLockPath(initial.rootPath, initial.task.id);
  return withFileLock(lockPath, () => ingestUnderJobLock(input, payload, initial.task.id));
}

/** 结果文档里的任务记录只读摘要（面板/后续任务详情用；不触网、不写盘）。 */
export function webJobResultSummary(
  task: Pick<RegressionTaskRecord, "id">,
  document: WebJobResultDocument
): Record<string, unknown> {
  return {
    jobId: task.id,
    taskStatus: document.taskStatus,
    gate: document.gate,
    device: document.device,
    package: document.package,
    startedAt: document.startedAt,
    finishedAt: document.finishedAt,
    evidence: document.evidence,
    writebackStatus: document.writebackStatus,
    resultCsvPath: document.resultCsvPath ?? null,
    warnings: document.warnings
  };
}
