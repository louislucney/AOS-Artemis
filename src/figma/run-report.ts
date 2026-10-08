import fs from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";

import {
  classifyFailure,
  type CrashSignal,
  type FailureClassification
} from "../artemis/failure-taxonomy.js";
import {
  readApiErrorsArtifact,
  type ApiErrorObservation
} from "../artemis/api-errors.js";
import type { TaskFailedItem, TaskStatus } from "../artemis/task-result.js";
import type { TaskStatRecord } from "../db/types.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import {
  buildTraceability,
  type TraceabilityCaseInput,
  type TraceabilityReport
} from "./traceability.js";
import type { CoverageEdge } from "./coverage.js";

export type RunReportOutcome = "passed" | "failed" | "pending";

export interface RunReportCase {
  caseId: string | null;
  name: string;
  traceId: string;
  outcome: RunReportOutcome;
  ledgerStatus: string;
  durationMs: number | null;
  model: string | null;
  failure: FailureClassification | null;
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
  saved?: { xlsx: string; junit: string };
  error?: string;
}

export interface RunReportOptions {
  limit?: number;
  caseIds?: string[];
  outputDir?: string;
  save?: boolean;
  stamp?: string;
}

interface GeneratedCaseLike {
  id: string;
  name: string;
  screens: string[];
  preconditions: string[];
  taskDesc: string;
}

interface GeneratedIndex {
  byId: Map<string, GeneratedCaseLike>;
  byTaskDesc: Map<string, GeneratedCaseLike>;
}

function loadCases(runtime: Runtime): GeneratedIndex {
  const index: GeneratedIndex = { byId: new Map(), byTaskDesc: new Map() };
  const testsPath = path.join(runtime.configDirAbs, "design", "tests.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as {
      flows?: Array<{
        id?: unknown;
        name?: unknown;
        screens?: unknown;
        preconditions?: unknown;
        taskDesc?: unknown;
      }>;
    };
    for (const entry of parsed.flows ?? []) {
      if (!entry || typeof entry.id !== "string") continue;
      const generated: GeneratedCaseLike = {
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        screens: Array.isArray(entry.screens)
          ? entry.screens.filter((screen): screen is string => typeof screen === "string")
          : [],
        preconditions: Array.isArray(entry.preconditions)
          ? entry.preconditions.filter((item): item is string => typeof item === "string")
          : [],
        taskDesc: typeof entry.taskDesc === "string" ? entry.taskDesc : ""
      };
      index.byId.set(generated.id, generated);
      if (generated.taskDesc) index.byTaskDesc.set(generated.taskDesc, generated);
    }
  } catch {
    /* tests.json not generated yet */
  }
  return index;
}

function readFlowCoverageInputs(runtime: Runtime): { screens: string[]; edges: CoverageEdge[] } | null {
  try {
    const flows = JSON.parse(
      fs.readFileSync(path.join(runtime.configDirAbs, "design", "flows.json"), "utf-8")
    ) as {
      screens?: Array<{ name?: unknown }>;
      edges?: Array<{ from?: { name?: unknown }; to?: { name?: unknown } | null }>;
    };
    const screens = (flows.screens ?? [])
      .map((screen) => screen.name)
      .filter((name): name is string => typeof name === "string");
    const edges: CoverageEdge[] = [];
    for (const edge of flows.edges ?? []) {
      const from = edge.from?.name;
      if (typeof from !== "string") continue;
      const to = edge.to?.name;
      edges.push({ from, to: typeof to === "string" ? to : null });
    }
    return { screens, edges };
  } catch {
    return null;
  }
}

function outcomeOf(ledgerStatus: string): RunReportOutcome {
  if (ledgerStatus === "completed") return "passed";
  if (ledgerStatus === "submitted") return "pending";
  return "failed";
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
    { header: "结果", key: "outcome", width: 10 },
    { header: "台账状态", key: "ledgerStatus", width: 12 },
    { header: "耗时(秒)", key: "duration", width: 10 },
    { header: "traceId", key: "traceId", width: 24 },
    { header: "失败域", key: "domain", width: 18 },
    { header: "置信度", key: "confidence", width: 10 },
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
      outcome: entry.outcome,
      ledgerStatus: entry.ledgerStatus,
      duration: entry.durationMs == null ? "" : Number((entry.durationMs / 1000).toFixed(3)),
      traceId: entry.traceId,
      domain: entry.failure?.domain ?? "",
      confidence: entry.failure?.confidence ?? "",
      reason: entry.failure?.reason ?? "",
      evidence: evidenceText(entry),
      apiErrors: apiErrorsText(entry),
      apiHandled: apiHandledText(entry)
    });
    row.getCell(10).alignment = { wrapText: true, vertical: "top" };
    row.getCell(11).alignment = { wrapText: true, vertical: "top" };
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
      error: `无法读取运行台账：${errorMessage(error)}`
    };
  }

  const wanted = options.caseIds && options.caseIds.length > 0 ? new Set(options.caseIds) : null;
  const cases = loadCases(runtime);
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
    results.push({
      caseId: task.caseId,
      name:
        generated?.name ??
        task.caseId ??
        (task.taskDesc ? task.taskDesc.split("\n")[0]! : task.traceId),
      traceId: task.traceId,
      outcome,
      ledgerStatus: task.status,
      durationMs: durationOf(task, status),
      model: task.model,
      failure:
        outcome === "failed"
          ? classifyFailure({
              status,
              crashes: crashesForTrace(runtime, task.traceId),
              preconditions: generated?.preconditions,
              apiErrors: apiErrors.map((entry) => ({ code: entry.code, handled: entry.handled }))
            })
          : null,
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
      id: task.caseId ?? task.traceId,
      name: generated?.name ?? task.caseId ?? task.traceId,
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
    traceability
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
