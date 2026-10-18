import { listArtifacts } from "../artifacts/index.js";
import type { ProjectStore } from "../db/types.js";

export type ExportWhat = "results" | "process" | "data";

export interface ExportRequest {
  what: ExportWhat;
  format?: "json" | "csv";
  since?: string;
  limit?: number;
}

export interface ExportResult {
  what: ExportWhat;
  format: "json" | "csv";
  filename: string;
  contentType: string;
  content: string;
  counts: Record<string, number>;
}

const DEFAULT_LIMIT = 500;

/** 三口径导出（DESIGN §13.125）：results＝测试结果；process＝测试过程（审计/任务/计划/执行机）；data＝测试用的数据。 */
export async function exportProjectData(
  rootPath: string,
  store: ProjectStore,
  request: ExportRequest
): Promise<ExportResult> {
  const limit = normalizeLimit(request.limit);
  const format = request.format ?? "json";
  const generatedAt = new Date().toISOString();
  const since = request.since;

  let payload: Record<string, unknown>;
  let counts: Record<string, number>;
  let csvColumns: string[];
  let csvRows: Array<Record<string, unknown>>;

  if (request.what === "results") {
    const runs = (await store.listSuiteRuns(rootPath, { limit })).filter(
      (run) => since === undefined || run.createdAt >= since
    );
    const verdicts = runs.flatMap((run) =>
      run.cases
        .filter((entry) => entry.verdict !== null)
        .map((entry) => ({
          runId: run.id,
          caseId: entry.caseId,
          verdict: entry.verdict,
          verdictBy: entry.verdictBy,
          verdictAt: entry.verdictAt,
          verdictNote: entry.verdictNote
        }))
    );
    const issues = runs.flatMap((run) =>
      run.cases
        .filter((entry) => entry.jiraIssueKey !== null)
        .map((entry) => ({ runId: run.id, caseId: entry.caseId, issueKey: entry.jiraIssueKey }))
    );
    counts = { runs: runs.length, verdicts: verdicts.length, issues: issues.length };
    payload = { what: "results", generatedAt, counts, runs, verdicts, issues };
    csvColumns = ["runId", "createdAt", "platform", "device", "status", "total", "passed", "failed", "gateResult"];
    csvRows = runs.map((run) => ({
      runId: run.id,
      createdAt: run.createdAt,
      platform: run.platform,
      device: run.device,
      status: run.status,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      gateResult: run.gateResult
    }));
  } else if (request.what === "process") {
    const audit = await store.listAudit(rootPath, {
      ...(since === undefined ? {} : { since }),
      limit
    });
    const tasks = await store.listRegressionTasks(rootPath, limit);
    const schedules = await store.listSchedules(rootPath, limit);
    const runners = await store.listRunners(rootPath, limit);
    counts = {
      audit: audit.length,
      tasks: tasks.length,
      schedules: schedules.length,
      runners: runners.length
    };
    payload = { what: "process", generatedAt, counts, audit, tasks, schedules, runners };
    csvColumns = ["at", "domain", "action", "result", "summary"];
    csvRows = audit.map((event) => ({
      at: event.at,
      domain: event.domain,
      action: event.action,
      result: event.result,
      summary: event.summary
    }));
  } else {
    const caseSets = await store.listCaseSets(rootPath, limit);
    const tasks = await store.listTasks(rootPath, limit);
    const artifacts = await listArtifacts(rootPath, {
      ...(since === undefined ? {} : { since }),
      limit
    });
    counts = { caseSets: caseSets.length, tasks: tasks.length, artifacts: artifacts.length };
    payload = { what: "data", generatedAt, counts, caseSets, tasks, artifacts };
    csvColumns = ["id", "createdAt", "source", "basename", "features", "caseCount"];
    csvRows = caseSets.map((set) => ({
      id: set.id,
      createdAt: set.createdAt,
      source: set.source,
      basename: set.basename,
      features: set.features.map((feature) => feature.key).join("|"),
      caseCount: set.features.reduce((sum, feature) => sum + feature.caseCount, 0)
    }));
  }

  const content = format === "csv" ? toCsv(csvColumns, csvRows) : JSON.stringify(payload, null, 2);
  return {
    what: request.what,
    format,
    filename: `aos-${request.what}-${stamp()}.${format === "csv" ? "csv" : "json"}`,
    contentType:
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    content,
    counts
  };
}

function normalizeLimit(limit?: number): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_LIMIT;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z").replace("T", "-");
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))];
  return `${lines.join("\n")}\n`;
}
