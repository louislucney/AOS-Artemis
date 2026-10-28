import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
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
import { parseWebJobSpec, type WebJobSpec } from "./job-spec.js";
import { withFileLock } from "./lock.js";
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
  tokenArtifacts: { dataEngineDb?: string; statusJson?: string };
  allowClearedRefresh: boolean;
}

export interface WebJobResultDocument {
  schemaVersion: 1;
  jobId: string;
  resultSha256: string;
  receivedAt: string;
  taskStatus: RegressionTaskStatus;
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
  taskStatus: RegressionTaskStatus;
  gate: WebResultGate;
  writtenCells: WritebackCellWrite[];
  warnings: string[];
  writebackStatus: "written" | "writeback-failed";
  /** true＝同内容重复上传，未再次写回/journal。 */
  idempotent: boolean;
  resultPath: string;
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
const MAX_EVIDENCE = 500;
const MAX_STRING = 2000;
const ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;

export function webJobResultsDir(rootPath: string, jobId: string): string {
  return path.join(path.resolve(rootPath), ".artemis", "web", "results", jobId);
}

export function resultPathForJob(rootPath: string, jobId: string): string {
  return path.join(webJobResultsDir(rootPath, jobId), "result.json");
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

function parseTokenArtifacts(
  raw: unknown
): { dataEngineDb?: string; statusJson?: string } {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    throw new WebResultError("invalid-result", "tokenArtifacts 必须是对象");
  }
  const artifacts: { dataEngineDb?: string; statusJson?: string } = {};
  const db = optionalText(raw.dataEngineDb, "tokenArtifacts.dataEngineDb");
  if (db !== "") artifacts.dataEngineDb = db;
  const status = optionalText(raw.statusJson, "tokenArtifacts.statusJson");
  if (status !== "") artifacts.statusJson = status;
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
 * 空结果 → gate/execution `error`，任务落 `failed`（DB 状态没有 error，绝不写成成功）。
 */
export function taskStatusFromGate(gate: WebResultGate): RegressionTaskStatus {
  if (gate.result === "passed") return "completed";
  if (gate.result === "failed") return "failed";
  if (gate.result === "partial") return "partial";
  return "failed";
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
    tokenArtifacts: payload.tokenArtifacts,
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
  const gate = aggregateResultGate(cases);

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
  const allowClearedRefresh = raw.allowClearedRefresh === true;

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
  return payload.execution.cases.map((entry) => {
    const traceId = entry.traceId ?? traceByCase.get(entry.caseId);
    const values: Partial<Record<SystemColumnKey, string>> = {
      result: entry.status,
      device,
      package: pkg,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt
    };
    if (traceId !== undefined && traceId !== "") values.traceId = traceId;
    return { caseId: entry.caseId, values };
  });
}

async function stageTokenArtifacts(
  resultDir: string,
  artifacts: { dataEngineDb?: string; statusJson?: string }
): Promise<{
  paths: { dataEngineDb?: string; statusJson?: string } | null;
  problems: string[];
}> {
  const problems: string[] = [];
  const staged: { dataEngineDb?: string; statusJson?: string } = {};
  const entries: Array<[keyof typeof staged, string | undefined, string]> = [
    ["dataEngineDb", artifacts.dataEngineDb, "data-engine.db"],
    ["statusJson", artifacts.statusJson, "status.json"]
  ];
  for (const [key, source, filename] of entries) {
    if (source === undefined || source.trim() === "") continue;
    try {
      const info = await stat(source);
      if (!info.isFile()) {
        problems.push(`${key} 不是普通文件：${source}`);
        continue;
      }
      if (info.size > ARTIFACT_MAX_BYTES) {
        problems.push(`${key} 超过上限 ${ARTIFACT_MAX_BYTES} 字节：${source}`);
        continue;
      }
      const targetDir = path.join(resultDir, "artifacts");
      await mkdir(targetDir, { recursive: true });
      await copyFile(source, path.join(targetDir, filename));
      staged[key] = `artifacts/${filename}`;
    } catch (error) {
      problems.push(`${key} 工件不可读（${source}）：${errorMessage(error)}`);
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
    gate: document.gate,
    writtenCells: document.writtenCells ?? [],
    warnings: document.warnings ?? [],
    writebackStatus: document.writebackStatus === "writeback-failed" ? "writeback-failed" : "written",
    idempotent,
    resultPath
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
export async function ingestWebJobResult(
  input: IngestWebJobResultInput
): Promise<WebJobIngestSummary> {
  const job = await input.store.getWebJobById(input.jobId);
  if (job === null) {
    throw new WebResultError("job-not-found", `未知 job ${input.jobId}`);
  }
  const { task, rootPath } = job;
  const spec = parseWebJobSpec(task.jobSpec);
  if (spec === null) {
    throw new WebResultError("invalid-job-spec", `job ${task.id} 没有可用的任务规格`);
  }

  const payload = normalizeWebJobResultPayload(input.payload);
  if (input.allowClearedRefresh === true) payload.allowClearedRefresh = true;
  const resultSha256 = resultSha(payload);
  const resultPath = resultPathForJob(rootPath, task.id);

  const existing = await readResultDocument(resultPath);
  if (existing !== null && existing.resultSha256 === resultSha256) {
    return summaryFromDocument(existing, resultPath, true);
  }
  if (task.status !== "running") {
    throw new WebResultError(
      "task-not-running",
      existing === null
        ? `job ${task.id} 当前状态为 ${task.status}（不是 running），拒绝写入结果`
        : `job ${task.id} 已有结果且任务状态为 ${task.status}：不同结果不得覆盖（result-already-recorded）`
    );
  }

  const target = await resolveWritebackTarget(input.store, rootPath, spec);

  const gate = aggregateResultGate(payload.execution.cases);
  const taskStatus = taskStatusFromGate(gate);
  const warnings: string[] = [];

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
    if (missing.length === 0 && tokenArtifacts === null) missing.push("原始工件不可读");
    if (missing.length > 0) {
      warnings.push(
        `token-unavailable: 远程 LLM 结果缺少 ${[...new Set(missing)].join("、")}；不按 0 计费、不伪造本地路径`
      );
    }
  }
  const tokenTotals = payload.tokenUsage.length > 0 ? sumTokenUsage(payload.tokenUsage) : null;

  let workbookResult: WritebackResult | null = null;
  let writebackError: string | null = null;
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
        store: input.store,
        rootPath,
        assetId: target.asset.id,
        workbookPath: target.workbookPath
      });
      warnings.push(...recovery.warnings);
      await ensureWorkbookCopy(target.originalPath, target.workbookPath);
      return await writebackWorkbook({
        workbookPath: target.workbookPath,
        assetId: target.asset.id,
        sheetName: target.sheetName,
        caseIdHeader: target.caseIdHeader,
        rows: writebackRows(payload),
        originalPath: target.originalPath,
        allowClearedRefresh: payload.allowClearedRefresh,
        lastSystemValue: async (caseId, key) => {
          const record = await input.store.lastExcelWritebackByCellKey(
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
            const record = await input.store.recordExcelWriteback({
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
            const confirmed = await input.store.confirmExcelWriteback(rootPath, id);
            if (!confirmed) {
              throw new Error(`pending 写回日志确认未命中：${cell.cellRef}`);
            }
          }
        }
      });
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
    receivedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    taskStatus,
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
    warnings
  };
  await persistDocument(resultPath, document);

  const updated = await input.store.updateRegressionTask(rootPath, task.id, {
    status: taskStatus,
    lastProgressAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    deviceLeaseId: null,
    jobSpec: { ...spec, deviceLeaseId: null } as Record<string, unknown>,
    expectStatuses: ["running"]
  });
  if (!updated) {
    throw new WebResultError(
      "task-not-running",
      `job ${task.id} 结果已保存，但任务状态在写入期间已不是 running；不覆盖终态（result-already-recorded）`
    );
  }

  await recordAuditSafe(input.store, rootPath, {
    domain: "web",
    action: "web.job.result",
    result: writebackStatus === "written" ? "ok" : "failed",
    summary:
      writebackStatus === "written"
        ? `Web job ${task.id} 结果入库：${taskStatus}，写回 ${document.writtenCells.length} 格`
        : `Web job ${task.id} 结果入库：${taskStatus}，Excel 写回失败（${writebackError ?? "unknown"}）`,
    refs: {
      jobId: task.id,
      taskStatus,
      writebackStatus,
      ...(target.asset.id === "" ? {} : { excelAssetId: target.asset.id })
    },
    actor: input.actor ?? null,
    channel: "runner"
  });

  log(
    `Web job ${task.id} 结果入库：${taskStatus}（写回 ${writebackStatus}，${document.writtenCells.length} 格）`
  );

  return {
    jobId: task.id,
    resultSha256,
    taskStatus,
    gate,
    writtenCells: document.writtenCells,
    warnings,
    writebackStatus,
    idempotent: false,
    resultPath
  };
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
    warnings: document.warnings
  };
}
