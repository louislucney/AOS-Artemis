import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  classifyFailure,
  scriptProvenanceSignal,
  type CrashSignal,
  type FailureClassification
} from "../artemis/failure-taxonomy.js";
import {
  readApiErrorsArtifact,
  type ApiErrorObservation
} from "../artemis/api-errors.js";
import type { TaskFailedItem, TaskStatus } from "../artemis/task-result.js";
import type { SuiteRunRecord, TaskStatRecord } from "../db/types.js";
import type { Runtime } from "../runtime.js";
import { outcomeOf, type TaskOutcome } from "../tasks/outcome.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { resolveDesignWarnings, type WarningSummary } from "../design/warnings.js";
import { loadDesignFlowGraph, loadGeneratedCases, type GeneratedCase } from "./design-store.js";
import { designFlowsPath } from "./design-source.js";
import {
  buildTraceability,
  type TraceabilityCaseInput,
  type TraceabilityReport
} from "./traceability.js";
import type { CoverageEdge } from "./coverage.js";

export type RunReportOutcome = TaskOutcome;

const TEST_RESULTS_SHEET = "执行结果";
const CROSS_PLATFORM_SHEET = "跨端对比";
const EXECUTOR_SHEET = "执行器";

export interface RunReportCase {
  caseId: string | null;
  name: string;
  traceId: string;
  outcome: RunReportOutcome;
  ledgerStatus: string;
  durationMs: number | null;
  model: string | null;
  feature: string | null;
  platform: string | null;
  /** 任务报告可用的批次/设备/开始时间；task_stats 报告为 null/缺省。 */
  runId?: string | null;
  device?: string | null;
  startedAt?: string | null;
  appVersion?: string | null;
  failure: FailureClassification | null;
  /** Script provenance summary (assert vs explore steps; null for legacy). */
  scriptProvenance: { asserts: number; explores: number } | null;
  failedItems: TaskFailedItem[];
  apiErrors: ApiErrorObservation[];
  apiErrorsDegraded: string | null;
  evidence: {
    traceDir: string;
    notesDir: string | null;
    stderrLog: string | null;
    stdoutLog: string | null;
  };
}

export interface RunReport {
  ok: boolean;
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  cases: RunReportCase[];
  traceability: TraceabilityReport | null;
  /** 当前设计源警告摘要（tests 快照优先、flows 回退）；读取失败 → null。 */
  designWarnings: WarningSummary | null;
  saved?: { xlsx: string; junit: string };
  /** `--update-tests` 回填结果。 */
  testsUpdated?: { path: string; rows: number; historyRows?: number };
  testsUpdateError?: string;
  error?: string;
}

export interface RunReportOptions {
  limit?: number;
  caseIds?: string[];
  outputDir?: string;
  save?: boolean;
  stamp?: string;
}

interface GeneratedIndex {
  byId: Map<string, GeneratedCase>;
  byTaskDesc: Map<string, GeneratedCase>;
}

function loadCases(runtime: Runtime): GeneratedIndex {
  const index: GeneratedIndex = { byId: new Map(), byTaskDesc: new Map() };
  const cases = loadGeneratedCases(runtime.configDirAbs);
  if (cases === null) return index;
  for (const generated of cases) {
    index.byId.set(generated.id, generated);
    if (generated.taskDesc) index.byTaskDesc.set(generated.taskDesc, generated);
  }
  return index;
}

function readFlowCoverageInputs(runtime: Runtime): { screens: string[]; edges: CoverageEdge[] } | null {
  const graph = loadDesignFlowGraph(runtime.configDirAbs, {
    flowsPath: designFlowsPath(runtime)
  });
  if (!graph) return null;
  return {
    screens: graph.screens.map((screen) => screen.name),
    edges: graph.edges.map((edge) => ({
      from: edge.from.name,
      to: edge.to ? edge.to.name : null
    }))
  };
}

function designWarningsOf(runtime: Runtime): WarningSummary | null {
  try {
    return resolveDesignWarnings(runtime.configDirAbs).summary;
  } catch {
    return null;
  }
}

function durationOf(task: TaskStatRecord, status: TaskStatus | null): number | null {
  if (status?.startTimeMs != null && status?.endTimeMs != null) {
    return Math.max(0, status.endTimeMs - status.startTimeMs);
  }
  if (task.finishedAt) {
    const start = Date.parse(task.submittedAt);
    const end = Date.parse(task.finishedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  }
  return null;
}

function crashesForTrace(runtime: Runtime, traceId: string): CrashSignal[] {
  try {
    return runtime.crashStore
      .list({ limit: 100 })
      .records.filter((record) => record.traceIds.includes(traceId))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        package: record.package,
        exceptionClass: record.exceptionClass
      }));
  } catch {
    return [];
  }
}

function stampOf(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function seconds(ms: number | null): string {
  return ((ms ?? 0) / 1000).toFixed(3);
}

function renderJunit(report: RunReport): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${report.total}" failures="${report.failed}" skipped="${report.pending}">`,
    `  <testsuite name="aos-run" tests="${report.total}" failures="${report.failed}" skipped="${report.pending}" time="${seconds(
      report.cases.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
    )}">`
  ];
  for (const entry of report.cases) {
    const name = escapeXml(entry.name);
    const classname = escapeXml(entry.caseId ?? "aos");
    lines.push(
      `    <testcase name="${name}" classname="${classname}" time="${seconds(entry.durationMs)}">`
    );
    if (entry.outcome === "failed") {
      const domain = entry.failure?.domain ?? "unclassified";
      const message = escapeXml(entry.failure?.reason ?? entry.ledgerStatus);
      lines.push(`      <failure type="${escapeXml(domain)}" message="${message}">`);
      lines.push(`        trace_id: ${escapeXml(entry.traceId)}`);
      for (const apiError of entry.apiErrors) {
        lines.push(
          `        api_error: ${escapeXml(apiError.code)} verdict=${escapeXml(apiError.verdict)}${
            apiError.handler ? ` handler=${escapeXml(apiError.handler)}` : ""
          }`
        );
      }
      lines.push(`      </failure>`);
    } else if (entry.outcome === "pending") {
      lines.push(`      <skipped message="pending (${escapeXml(entry.ledgerStatus)})"/>`);
    }
    lines.push(`    </testcase>`);
  }
  lines.push("  </testsuite>", "</testsuites>");
  return lines.join("\n") + "\n";
}

function evidenceText(entry: RunReportCase): string {
  const lines = [`trace: ${entry.evidence.traceDir}`];
  if (entry.evidence.notesDir) lines.push(`notes: ${entry.evidence.notesDir}`);
  if (entry.evidence.stderrLog) lines.push(`stderr: ${entry.evidence.stderrLog}`);
  if (entry.evidence.stdoutLog) lines.push(`stdout: ${entry.evidence.stdoutLog}`);
  return lines.join("\n");
}

function apiErrorsText(entry: RunReportCase): string {
  if (entry.apiErrors.length === 0) return "";
  return entry.apiErrors
    .map((error) => `${error.code}(${error.verdict}${error.count > 1 ? ` ×${error.count}` : ""})`)
    .join("；");
}

function apiHandledText(entry: RunReportCase): string {
  if (entry.apiErrors.length === 0) return "";
  return entry.apiErrors
    .map((error) => `${error.code}=${error.handler ?? error.expect ?? error.verdict}`)
    .join("；");
}

async function renderWorkbook(report: RunReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("运行报告", {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: "#", key: "index", width: 5 },
    { header: "用例", key: "name", width: 36 },
    { header: "用例ID", key: "caseId", width: 18 },
    { header: "功能", key: "feature", width: 16 },
    { header: "端", key: "platform", width: 8 },
    { header: "结果", key: "outcome", width: 10 },
    { header: "台账状态", key: "ledgerStatus", width: 12 },
    { header: "耗时(秒)", key: "duration", width: 10 },
    { header: "traceId", key: "traceId", width: 24 },
    { header: "失败域", key: "domain", width: 18 },
    { header: "置信度", key: "confidence", width: 10 },
    { header: "脚本来源", key: "scriptProvenance", width: 16 },
    { header: "判定依据", key: "reason", width: 50 },
    { header: "证据路径", key: "evidence", width: 50 },
    { header: "API 错误", key: "apiErrors", width: 24 },
    { header: "处理判定", key: "apiHandled", width: 24 }
  ];
  sheet.getRow(1).font = { bold: true };
  report.cases.forEach((entry, index) => {
    const row = sheet.addRow({
      index: index + 1,
      name: entry.name,
      caseId: entry.caseId ?? "",
      feature: entry.feature ?? "—",
      platform: entry.platform ?? "—",
      outcome: entry.outcome,
      ledgerStatus: entry.ledgerStatus,
      duration: entry.durationMs == null ? "" : Number((entry.durationMs / 1000).toFixed(3)),
      traceId: entry.traceId,
      domain: entry.failure?.domain ?? "",
      confidence: entry.failure?.confidence ?? "",
      scriptProvenance: entry.scriptProvenance
        ? `断言 ${entry.scriptProvenance.asserts} / 探索 ${entry.scriptProvenance.explores}`
        : "",
      reason: entry.failure?.reason ?? "",
      evidence: evidenceText(entry),
      apiErrors: apiErrorsText(entry),
      apiHandled: apiHandledText(entry)
    });
    row.getCell("reason").alignment = { wrapText: true, vertical: "top" };
    row.getCell("evidence").alignment = { wrapText: true, vertical: "top" };
  });
  if (report.traceability) {
    const trace = workbook.addWorksheet("追溯矩阵", { views: [{ state: "frozen", ySplit: 1 }] });
    trace.columns = [
      { header: "类型", key: "kind", width: 10 },
      { header: "名称", key: "name", width: 44 },
      { header: "覆盖用例", key: "cases", width: 36 },
      { header: "追溯ID", key: "traces", width: 36 },
      { header: "备注", key: "note", width: 16 }
    ];
    trace.getRow(1).font = { bold: true };
    for (const screen of report.traceability.screens) {
      trace.addRow({
        kind: "屏幕",
        name: screen.screen,
        cases: screen.caseIds.join(", "),
        traces: screen.traceIds.join(", "),
        note: screen.caseIds.length === 0 ? "未覆盖" : ""
      });
    }
    for (const edge of report.traceability.edges) {
      trace.addRow({
        kind: "跳转",
        name: edge.edge,
        cases: edge.caseIds.join(", "),
        traces: "",
        note: edge.caseIds.length === 0 ? "未覆盖" : ""
      });
    }
    for (const caseId of report.traceability.casesWithoutTrace) {
      trace.addRow({ kind: "用例", name: caseId, cases: caseId, traces: "", note: "无 trace" });
    }
    for (const caseId of report.traceability.casesWithoutEvidence) {
      trace.addRow({ kind: "用例", name: caseId, cases: caseId, traces: "", note: "无证据" });
    }
  }
  const rendered = await workbook.xlsx.writeBuffer();
  return Buffer.from(rendered);
}

function displayIdsFromWorkbook(workbook: ExcelJS.Workbook): Map<string, string> {
  const map = new Map<string, string>();
  const sheet = workbook.getWorksheet(EXECUTOR_SHEET);
  if (!sheet) return map;
  const header = sheet.getRow(1);
  let caseColumn = 0;
  let displayColumn = 0;
  header.eachCell((cell, column) => {
    if (cell.value === "用例编号") caseColumn = column;
    if (cell.value === "展示编号") displayColumn = column;
  });
  if (caseColumn === 0 || displayColumn === 0) return map;
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const caseId = String(sheet.getRow(row).getCell(caseColumn).value ?? "").trim();
    const displayId = String(sheet.getRow(row).getCell(displayColumn).value ?? "").trim();
    if (caseId !== "" && displayId !== "") map.set(caseId, displayId);
  }
  return map;
}

interface PlatformHistoryCell {
  name: string;
  status: string;
  runId: string | null;
  finishedAt: string;
  device: string | null;
  traceId: string | null;
  featureKey: string | null;
}

interface PlatformHistoryRow {
  caseId: string;
  name: string;
  latest: Map<string, PlatformHistoryCell>;
  changes: Map<string, string>;
}

function platformLabel(platform: string): string {
  if (platform === "android") return "Android";
  if (platform === "ios") return "iOS";
  return platform === "" ? "—" : platform[0]!.toUpperCase() + platform.slice(1);
}

function normalizedStatus(status: string): "passed" | "failed" | "pending" {
  if (status === "passed") return "passed";
  if (status === "pending") return "pending";
  return "failed";
}

function changeLabel(latest: string, previous: string | null): string {
  const current = normalizedStatus(latest);
  if (previous === null) return "新增";
  const prior = normalizedStatus(previous);
  if (prior === "pending" || current === "pending") return "—";
  if (prior === "passed" && current === "passed") return "仍通过";
  if (prior === "failed" && current === "passed") return "修复";
  if (prior === "passed" && current === "failed") return "回归";
  if (prior === "failed" && current === "failed") return "仍失败";
  return "—";
}

function buildPlatformHistory(
  runs: SuiteRunRecord[],
  caseIds: Set<string> | null
): { platforms: string[]; rows: PlatformHistoryRow[] } {
  const latest = new Map<string, Map<string, PlatformHistoryCell>>();
  const previous = new Map<string, Map<string, string>>();
  const ordered = [...runs].sort((left, right) => {
    const leftAt = Date.parse(left.finishedAt || left.createdAt);
    const rightAt = Date.parse(right.finishedAt || right.createdAt);
    return rightAt - leftAt;
  });
  for (const run of ordered) {
    for (const entry of run.cases) {
      if (caseIds !== null && !caseIds.has(entry.caseId)) continue;
      const byPlatform = latest.get(entry.caseId) ?? new Map<string, PlatformHistoryCell>();
      if (!byPlatform.has(run.platform)) {
        byPlatform.set(run.platform, {
          name: entry.name,
          status: entry.status,
          runId: run.runId,
          finishedAt: run.finishedAt || run.createdAt,
          device: run.device,
          traceId: entry.traceId,
          featureKey: entry.featureKey ?? run.featureKey
        });
        latest.set(entry.caseId, byPlatform);
        continue;
      }
      const prior = previous.get(entry.caseId) ?? new Map<string, string>();
      if (!prior.has(run.platform)) {
        prior.set(run.platform, entry.status);
        previous.set(entry.caseId, prior);
      }
    }
  }
  const rows: PlatformHistoryRow[] = [...latest.entries()]
    .map(([caseId, byPlatform]) => {
      const changes = new Map<string, string>();
      for (const [platform, cell] of byPlatform) {
        const prior = previous.get(caseId)?.get(platform) ?? null;
        changes.set(platform, changeLabel(cell.status, prior));
      }
      const first = byPlatform.values().next().value as PlatformHistoryCell | undefined;
      return {
        caseId,
        name: first?.name ?? caseId,
        latest: byPlatform,
        changes
      };
    })
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  const platformSet = new Set<string>();
  for (const row of rows) {
    for (const platform of row.latest.keys()) platformSet.add(platform);
  }
  const platforms = [...platformSet].sort((left, right) => {
    const order = (platform: string): number =>
      platform === "android" ? 0 : platform === "ios" ? 1 : 2;
    return order(left) - order(right) || left.localeCompare(right);
  });
  return { platforms, rows };
}

/** 把运行结果写入 `tests.xlsx` 的「执行结果」+「跨端对比」sheet；不动生成计划，幂等替换。 */
export async function updateTestsWorkbookWithResults(
  testsXlsxPath: string,
  report: RunReport,
  options: { runs?: SuiteRunRecord[] } = {}
): Promise<{ path: string; rows: number; historyRows?: number }> {
  if (!fs.existsSync(testsXlsxPath)) {
    throw new Error(`未找到 tests.xlsx：${testsXlsxPath}`);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(testsXlsxPath);
  const existing = workbook.getWorksheet(TEST_RESULTS_SHEET);
  if (existing) workbook.removeWorksheet(existing.id);
  const existingCross = workbook.getWorksheet(CROSS_PLATFORM_SHEET);
  if (existingCross) workbook.removeWorksheet(existingCross.id);
  const displayIds = displayIdsFromWorkbook(workbook);
  const sheet = workbook.addWorksheet(TEST_RESULTS_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: "#", key: "index", width: 5 },
    { header: "用例编号", key: "displayId", width: 14 },
    { header: "caseId", key: "caseId", width: 20 },
    { header: "用例名称", key: "name", width: 36 },
    { header: "结果", key: "outcome", width: 10 },
    { header: "台账状态", key: "ledgerStatus", width: 12 },
    { header: "功能", key: "feature", width: 16 },
    { header: "端", key: "platform", width: 8 },
    { header: "设备", key: "device", width: 18 },
    { header: "耗时(ms)", key: "duration", width: 10 },
    { header: "traceId", key: "traceId", width: 24 },
    { header: "失败域", key: "domain", width: 18 },
    { header: "失败原因", key: "reason", width: 50 },
    { header: "API 错误", key: "apiErrors", width: 24 },
    { header: "证据路径", key: "evidence", width: 50 },
    { header: "批次", key: "runId", width: 22 },
    { header: "运行时间", key: "startedAt", width: 24 }
  ];
  sheet.getRow(1).font = { bold: true };
  report.cases.forEach((entry, index) => {
    const row = sheet.addRow({
      index: index + 1,
      displayId: entry.caseId ? displayIds.get(entry.caseId) ?? "—" : "—",
      caseId: entry.caseId ?? "",
      name: entry.name,
      outcome: entry.outcome,
      ledgerStatus: entry.ledgerStatus,
      feature: entry.feature ?? "—",
      platform: entry.platform ?? "—",
      device: entry.device ?? "—",
      duration: entry.durationMs ?? "",
      traceId: entry.traceId,
      domain: entry.failure?.domain ?? "",
      reason: entry.failure?.reason ?? "",
      apiErrors: apiErrorsText(entry),
      evidence: entry.evidence.traceDir,
      runId: entry.runId ?? "—",
      startedAt: entry.startedAt ?? "—"
    });
    row.getCell("reason").alignment = { wrapText: true, vertical: "top" };
    row.getCell("evidence").alignment = { wrapText: true, vertical: "top" };
  });
  const wanted = new Set(
    report.cases
      .map((entry) => entry.caseId)
      .filter((caseId): caseId is string => typeof caseId === "string" && caseId !== "")
  );
  const history = buildPlatformHistory(options.runs ?? [], wanted.size > 0 ? wanted : null);
  if (history.rows.length > 0) {
    const cross = workbook.addWorksheet(CROSS_PLATFORM_SHEET, {
      views: [{ state: "frozen", ySplit: 1 }]
    });
    const platformKeys = history.platforms.map((_, index) => `platform${index}`);
    cross.columns = [
      { header: "#", key: "index", width: 5 },
      { header: "用例编号", key: "displayId", width: 14 },
      { header: "caseId", key: "caseId", width: 20 },
      { header: "用例名称", key: "name", width: 36 },
      { header: "功能", key: "feature", width: 16 },
      ...history.platforms.map((platform, index) => ({
        header: platformLabel(platform),
        key: platformKeys[index]!,
        width: 10
      })),
      { header: "变化", key: "changes", width: 30 },
      { header: "最近批次", key: "runId", width: 22 },
      { header: "最近时间", key: "finishedAt", width: 24 }
    ];
    cross.getRow(1).font = { bold: true };
    history.rows.forEach((row, index) => {
      const cells = [...row.latest.values()].sort(
        (left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt)
      );
      const latest = cells[0];
      const data: Record<string, string | number> = {
        index: index + 1,
        displayId: displayIds.get(row.caseId) ?? "—",
        caseId: row.caseId,
        name: row.name,
        feature: latest?.featureKey ?? "—",
        changes:
          history.platforms
            .map((platform) => {
              const change = row.changes.get(platform);
              return change === undefined || change === "—"
                ? null
                : `${platformLabel(platform)}:${change}`;
            })
            .filter((value): value is string => value !== null)
            .join("；") || "—",
        runId: latest?.runId ?? "—",
        finishedAt: latest?.finishedAt ?? "—"
      };
      history.platforms.forEach((platform, platformIndex) => {
        data[platformKeys[platformIndex]!] = row.latest.get(platform)?.status ?? "—";
      });
      cross.addRow(data);
    });
  }
  writeFileAtomic(testsXlsxPath, Buffer.from(await workbook.xlsx.writeBuffer()));
  return {
    path: testsXlsxPath,
    rows: report.cases.length,
    ...(history.rows.length > 0 ? { historyRows: history.rows.length } : {})
  };
}

export async function buildRunReport(
  runtime: Runtime,
  options: RunReportOptions = {}
): Promise<RunReport> {
  const generatedAt = new Date().toISOString();
  const limit = options.limit ?? 50;
  let tasks: TaskStatRecord[];
  try {
    tasks = await runtime.store.listTasks(runtime.project.rootDir, limit);
  } catch (error) {
    return {
      ok: false,
      generatedAt,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      cases: [],
      traceability: null,
      designWarnings: designWarningsOf(runtime),
      error: `无法读取运行台账：${errorMessage(error)}`
    };
  }

  const wanted = options.caseIds && options.caseIds.length > 0 ? new Set(options.caseIds) : null;
  const cases = loadCases(runtime);
  const featureNames = new Map<string, string>();
  try {
    const sets = await runtime.store.listCaseSets(runtime.project.rootDir);
    for (const set of sets) {
      for (const feature of set.features) {
        if (!featureNames.has(feature.key)) featureNames.set(feature.key, feature.name);
      }
    }
  } catch {
    /* 名称解析降级：显示 feature key */
  }
  const selected = tasks
    .filter((task) => (wanted ? task.caseId != null && wanted.has(task.caseId) : true))
    .sort(
      (a, b) =>
        Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.traceId.localeCompare(b.traceId)
    );

  const results: RunReportCase[] = [];
  const traceCases: TraceabilityCaseInput[] = [];
  for (const task of selected) {
    const generated = task.caseId
      ? cases.byId.get(task.caseId) ?? null
      : task.taskDesc
        ? cases.byTaskDesc.get(task.taskDesc) ?? null
        : null;
    const status = task.status === "submitted" ? null : await runtime.traceStatus(task.traceId);
    const outcome = outcomeOf(task.status);
    const apiArtifact = readApiErrorsArtifact(runtime.traceDir(task.traceId));
    const apiErrors = apiArtifact?.errors ?? [];
    const resolvedCaseId = task.caseId ?? generated?.id ?? null;
    results.push({
      caseId: resolvedCaseId,
      name:
        generated?.name ??
        resolvedCaseId ??
        (task.taskDesc ? task.taskDesc.split("\n")[0]! : task.traceId),
      traceId: task.traceId,
      outcome,
      ledgerStatus: task.status,
      durationMs: durationOf(task, status),
      model: task.model,
      feature: generated?.feature
        ? featureNames.get(generated.feature) ?? generated.feature
        : null,
      platform: null,
      failure:
        outcome === "failed"
          ? classifyFailure({
              status,
              crashes: crashesForTrace(runtime, task.traceId),
              preconditions: generated?.preconditions,
              apiErrors: apiErrors.map((entry) => ({ code: entry.code, handled: entry.handled })),
              scriptProvenance: scriptProvenanceSignal(
                generated?.scriptProvenance ?? null,
                status?.testSummary?.adherence ?? null
              )
            })
          : null,
      scriptProvenance: generated?.scriptProvenance ?? null,
      failedItems: status?.testSummary?.failedItems ?? [],
      apiErrors,
      apiErrorsDegraded: apiArtifact?.degraded ?? null,
      evidence: {
        traceDir: runtime.traceDir(task.traceId),
        notesDir: status?.notesDir ?? null,
        stderrLog: status?.stderrLog ?? null,
        stdoutLog: status?.stdoutLog ?? null
      }
    });
    traceCases.push({
      id: resolvedCaseId ?? task.traceId,
      name: generated?.name ?? resolvedCaseId ?? task.traceId,
      screens: generated?.screens ?? [],
      traceId: task.traceId,
      hasEvidence: fs.existsSync(runtime.traceDir(task.traceId))
    });
  }

  const flowInputs = readFlowCoverageInputs(runtime);
  const traceability = flowInputs
    ? buildTraceability({ screenNames: flowInputs.screens, edges: flowInputs.edges, cases: traceCases })
    : null;
  const passed = results.filter((entry) => entry.outcome === "passed").length;
  const pending = results.filter((entry) => entry.outcome === "pending").length;
  const report: RunReport = {
    ok: true,
    generatedAt,
    total: results.length,
    passed,
    failed: results.length - passed - pending,
    pending,
    cases: results,
    traceability,
    designWarnings: designWarningsOf(runtime)
  };

  if (options.save !== false) {
    const stamp = options.stamp ?? stampOf(new Date(generatedAt));
    const dir = options.outputDir
      ? path.resolve(runtime.project.rootDir, options.outputDir)
      : path.join(runtime.configDirAbs, "design", "reports");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const xlsx = path.join(dir, `run-${stamp}.xlsx`);
      const junit = path.join(dir, `run-${stamp}.xml`);
      writeFileAtomic(xlsx, await renderWorkbook(report));
      writeFileAtomic(junit, renderJunit(report));
      report.saved = { xlsx, junit };
    } catch (error) {
      report.ok = false;
      report.error = `运行报告写入失败: ${errorMessage(error)}`;
    }
  }

  return report;
}

function sanitizeLabel(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned === "" ? "feature" : cleaned;
}

export interface TaskRunReportOptions {
  taskId: string;
  outputDir?: string;
  save?: boolean;
  stamp?: string;
}

/** 回归任务报告（DESIGN：回归服务 §5.6）：逐例来自 `suite_runs`；
 * 命名 `<stamp>_<功能>_回归.xlsx`（多功能 → `多功能N项`）。 */
export async function buildTaskRunReport(
  runtime: Runtime,
  options: TaskRunReportOptions
): Promise<RunReport> {
  const generatedAt = new Date().toISOString();
  const task = await runtime.store.getRegressionTask(runtime.project.rootDir, options.taskId);
  if (!task) {
    return {
      ok: false,
      generatedAt,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      cases: [],
      traceability: null,
      designWarnings: designWarningsOf(runtime),
      error: `未找到回归任务 ${options.taskId}`
    };
  }
  const runs = await runtime.store.listSuiteRuns(runtime.project.rootDir, {
    taskId: options.taskId,
    limit: 100
  });
  const results: RunReportCase[] = [];
  for (const run of runs) {
    for (const entry of run.cases) {
      results.push({
        caseId: entry.caseId,
        name: entry.name,
        traceId: entry.traceId ?? "",
        outcome: entry.status === "passed" ? "passed" : "failed",
        ledgerStatus: entry.status,
        durationMs: entry.durationMs,
        model: null,
        feature: run.featureName ?? run.featureKey,
        platform: run.platform,
        runId: run.runId,
        device: run.device,
        startedAt: run.startedAt,
        appVersion: run.appVersion,
        failure: entry.failureDomain
          ? {
              domain: entry.failureDomain as FailureClassification["domain"],
              confidence: (entry.failureConfidence ??
                "low") as FailureClassification["confidence"],
              reason: entry.failureReason ?? "",
              evidence: []
            }
          : null,
        scriptProvenance: null,
        failedItems: [],
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: {
          traceDir: entry.traceId ? runtime.traceDir(entry.traceId) : "",
          notesDir: null,
          stderrLog: null,
          stdoutLog: null
        }
      });
    }
  }
  const passed = results.filter((entry) => entry.outcome === "passed").length;
  const pending = results.filter((entry) => entry.outcome === "pending").length;
  const report: RunReport = {
    ok: true,
    generatedAt,
    total: results.length,
    passed,
    failed: results.length - passed - pending,
    pending,
    cases: results,
    traceability: null,
    designWarnings: designWarningsOf(runtime)
  };
  if (options.save !== false) {
    const stamp = options.stamp ?? stampOf(new Date(generatedAt));
    const featureLabels = [
      ...new Set(
        runs
          .map((run) => run.featureName ?? run.featureKey)
          .filter((label): label is string => label !== null && label !== "")
      )
    ];
    const label =
      featureLabels.length <= 1
        ? sanitizeLabel(featureLabels[0] ?? "回归")
        : `多功能${featureLabels.length}项`;
    const dir = options.outputDir
      ? path.resolve(runtime.project.rootDir, options.outputDir)
      : path.join(runtime.configDirAbs, "design", "reports");
    try {
      fs.mkdirSync(dir, { recursive: true });
      const xlsx = path.join(dir, `${stamp}_${label}_回归.xlsx`);
      const junit = path.join(dir, `${stamp}_${label}_回归.xml`);
      writeFileAtomic(xlsx, await renderWorkbook(report));
      writeFileAtomic(junit, renderJunit(report));
      report.saved = { xlsx, junit };
    } catch (error) {
      report.ok = false;
      report.error = `任务报告写入失败: ${errorMessage(error)}`;
    }
  }
  return report;
}
