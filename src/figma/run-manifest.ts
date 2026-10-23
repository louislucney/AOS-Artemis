import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ApiErrorObservation } from "../artemis/api-errors.js";
import {
  FAILURE_TAXONOMY_VERSION,
  type FailureConfidence,
  type FailureDomain
} from "../artemis/failure-taxonomy.js";
import {
  mergeWarnings,
  summarizeWarnings,
  type DesignWarning,
  type WarningSummary
} from "../design/warnings.js";
import type { UiSummary, UiVerification } from "../ui/verification.js";
import { designDir } from "./design-store.js";
import type { SuiteCaseResult, SuiteRunReport } from "./suite-runner.js";

/** 批次清单（run manifest，DESIGN §13.95）：一次 suite run/loop 的一等实体，
 * 一批次一文件、append-only、永不覆写；面板以清单为权威源。
 * 读取为判别式结果（ok/missing/invalid/newer），缺件/坏件/高版本一律如实降级，不猜测。 */

export const RUN_MANIFEST_DIR = "runs";
export const RUN_MANIFEST_VERSION = 1;
export const RUN_MANIFEST_MAX_DEFAULT = 200;

export type RunManifestSource =
  | "suite-run"
  | "suite-loop"
  | "design_to_test"
  | "run_regression"
  | "verify_jira_issue";

export interface RunManifestOptions {
  deviceSerial: string | null;
  lockedAppPackage: string | null;
  model: string | null;
  maxCases: number | null;
  stopOnFailure: boolean;
  apiErrors: boolean;
  failOnApiErrors: boolean;
  strict: boolean;
  failOnUncovered: boolean;
  retry: number;
  quarantinedCaseIds: string[];
}

export interface RunManifestPreflightSummary {
  cases: number;
  weakCases: number;
  coverage: {
    available: boolean;
    uncoveredScreens: number;
    uncoveredEdges: number;
    exploreUncoveredScreens: number;
    exploreUncoveredEdges: number;
  };
  artifacts: { excelPresent: boolean; excelStale: boolean };
  dataPolicyMissing: number;
  generation: { truncated: boolean; entryFallback: boolean } | null;
}

export interface RunManifestCase {
  caseId: string;
  name: string;
  status: SuiteCaseResult["status"];
  traceId: string | null;
  error: string | null;
  failure: { domain: FailureDomain; confidence: FailureConfidence; reason: string } | null;
  /** UI 核验状态；旧清单没有该字段。 */
  ui?: UiVerification;
  scriptProvenance: { asserts: number; explores: number } | null;
  apiErrors: ApiErrorObservation[];
  apiErrorsDegraded: string | null;
  quarantined: boolean;
  retry: NonNullable<SuiteCaseResult["retry"]> | null;
  evidence: SuiteCaseResult["evidence"];
}

/** 回归服务回填所需维度：保存时点可得即写，缺省字段不写。 */
export interface RunManifestRegistration {
  regressionTaskId?: string | null;
  caseSetId?: string | null;
  featureKey?: string | null;
  featureName?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  runner?: string | null;
  caseSetJsonPath?: string | null;
  testsPath?: string | null;
}

export interface RunManifest {
  schemaVersion: typeof RUN_MANIFEST_VERSION;
  runId: string;
  source: RunManifestSource;
  registration?: RunManifestRegistration;
  taxonomyVersion: typeof FAILURE_TAXONOMY_VERSION;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error: string | null;
  tests: { path: string; sha256: string | null; generatedAt: string | null };
  options: RunManifestOptions;
  preflight: RunManifestPreflightSummary | null;
  /** 运行期设计源警告摘要（冻结快照；无 preflight → null，不回读当前 flows）。 */
  designWarnings: WarningSummary | null;
  apiErrorCatalog: { file: string; rules: number; errors: string[] } | null;
  summary: {
    total: number;
    executed: number;
    skipped: number;
    passed: number;
    failed: number;
    flaky: number;
    quarantinedFailed: number;
    /** UI 核验计数；旧清单没有该字段。 */
    ui?: UiSummary;
  };
  gate: { result: "pass" | "fail"; exitCode: number; reasons: string[] };
  failureDomains: Partial<Record<FailureDomain, number>>;
  cases: RunManifestCase[];
}

export interface RunManifestBase {
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  summary: { total: number | null; passed: number | null; failed: number | null } | null;
}

export type RunManifestRead =
  | { kind: "ok"; file: string; manifest: RunManifest }
  | { kind: "missing"; file: string }
  | { kind: "invalid"; file: string; reason: string }
  | { kind: "newer"; file: string; version: number; base: RunManifestBase };

export interface BuildRunManifestInput {
  report: SuiteRunReport;
  source: RunManifestSource;
  startedAtMs: number;
  finishedAtMs: number;
  exitCode: number;
  coverageIssue: string | null;
  testsPath: string;
  testsSha256: string | null;
  testsGeneratedAt: string | null;
  options: RunManifestOptions;
  registration?: RunManifestRegistration;
}

export function runManifestDir(configDirAbs: string): string {
  return path.join(designDir(configDirAbs), RUN_MANIFEST_DIR);
}

export function runManifestsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.AOS_SUITE_RUNS !== "0";
}

export function runManifestMax(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_SUITE_RUNS_MAX?.trim();
  if (!raw) return RUN_MANIFEST_MAX_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : RUN_MANIFEST_MAX_DEFAULT;
}

export function newRunId(startedAtMs: number, suffix?: string): string {
  const stamp = new Date(startedAtMs).toISOString().slice(0, 19).replace(/[-:]/g, "");
  return `run-${stamp}-${suffix ?? randomBytes(3).toString("hex")}`;
}

/** tests.json 指纹：sha256 + mtime（三件套门禁即以 mtime 定性新鲜度；文件无生成时间字段）。 */
export function testsFingerprint(testsPath: string): {
  sha256: string | null;
  generatedAt: string | null;
} {
  try {
    const buffer = fs.readFileSync(testsPath);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    return { sha256, generatedAt: new Date(fs.statSync(testsPath).mtimeMs).toISOString() };
  } catch {
    return { sha256: null, generatedAt: null };
  }
}

function generationFlags(raw: unknown): { truncated: boolean; entryFallback: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as { truncated?: unknown; entryFallback?: unknown };
  return { truncated: record.truncated === true, entryFallback: record.entryFallback === true };
}

export function summarizePreflight(report: SuiteRunReport["preflight"]): RunManifestPreflightSummary | null {
  if (!report) return null;
  return {
    cases: report.cases,
    weakCases: report.weakCases.length,
    coverage: {
      available: report.coverage.available,
      uncoveredScreens: report.coverage.uncoveredScreens.length,
      uncoveredEdges: report.coverage.uncoveredEdges.length,
      exploreUncoveredScreens: report.coverage.explore.uncoveredScreens.length,
      exploreUncoveredEdges: report.coverage.explore.uncoveredEdges.length
    },
    artifacts: {
      excelPresent: report.artifacts.excelPresent,
      excelStale: report.artifacts.excelStale
    },
    dataPolicyMissing: report.dataPolicy.missing.length,
    generation: generationFlags(report.generation)
  };
}

function copyWarningSummary(summary: WarningSummary | null | undefined): WarningSummary | null {
  if (!summary) return null;
  return {
    ...summary,
    byCode: { ...summary.byCode },
    codes: [...summary.codes],
    ...(summary.bySource ? { bySource: { ...summary.bySource } } : {})
  };
}

export interface DesignWarningBatch {
  source: string;
  warnings: DesignWarning[];
  summary: WarningSummary | null;
}

export interface MergedDesignWarnings extends WarningSummary {
  /** 无设计源警告摘要的集数（preflight 缺失或未产出摘要）；>0 表示合并覆盖不完整。 */
  missingSets: number;
}

/** 跨批次合并：同 code+message 去重、按来源计数；无任何摘要 → null（缺失不折算成 0 条）。
 * 部分集缺摘要时保留已有摘要的合并结果，并以 `missingSets` 显式披露覆盖缺口。 */
export function mergeDesignWarningBatches(batches: DesignWarningBatch[]): MergedDesignWarnings | null {
  const present = batches.filter(
    (batch): batch is DesignWarningBatch & { summary: WarningSummary } => batch.summary !== null
  );
  if (present.length === 0) return null;
  const merged = mergeWarnings(
    present.map((batch) => ({ source: batch.source, warnings: batch.warnings }))
  );
  const snapshotAts = [
    ...new Set(
      present
        .map((batch) => batch.summary.snapshotAt)
        .filter((value): value is string => typeof value === "string" && value !== "")
    )
  ];
  return {
    ...summarizeWarnings(merged.warnings, {
      available: present.some((batch) => batch.summary.available),
      bySource: merged.bySource,
      ...(snapshotAts.length === 1 ? { snapshotAt: snapshotAts[0] } : {}),
      stale: present.some((batch) => batch.summary.stale === true)
    }),
    missingSets: batches.length - present.length
  };
}

export function buildRunManifest(input: BuildRunManifestInput): RunManifest {
  const { report } = input;
  const quarantinedFailed = report.cases.filter(
    (entry) => entry.quarantined === true && entry.status !== "passed"
  ).length;
  const flaky = report.cases.filter((entry) => entry.retry?.flaky === true).length;
  const failedRemaining = report.failed - quarantinedFailed;

  const failureDomains: Partial<Record<FailureDomain, number>> = {};
  for (const entry of report.cases) {
    if (entry.status === "passed") continue;
    const domain = entry.failure?.domain ?? "unclassified";
    failureDomains[domain] = (failureDomains[domain] ?? 0) + 1;
  }

  const reasons: string[] = [];
  if (!report.ok) {
    reasons.push("suite-not-executed");
  } else {
    if (input.coverageIssue !== null) reasons.push("preflight-gate");
    if (failedRemaining > 0) reasons.push(`failed:${failedRemaining}`);
  }

  return {
    schemaVersion: RUN_MANIFEST_VERSION,
    runId: newRunId(input.startedAtMs),
    source: input.source,
    ...(input.registration ? { registration: input.registration } : {}),
    taxonomyVersion: FAILURE_TAXONOMY_VERSION,
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(input.finishedAtMs).toISOString(),
    ok: report.ok,
    error: report.error ?? null,
    tests: {
      path: input.testsPath,
      sha256: input.testsSha256,
      generatedAt: input.testsGeneratedAt
    },
    options: input.options,
    preflight: summarizePreflight(report.preflight),
    designWarnings: copyWarningSummary(report.preflight?.designWarningSummary),
    apiErrorCatalog: report.apiErrorCatalog
      ? {
          file: report.apiErrorCatalog.file,
          rules: report.apiErrorCatalog.rules,
          errors: [...report.apiErrorCatalog.errors]
        }
      : null,
    summary: {
      total: report.total,
      executed: report.executed,
      skipped: report.skipped,
      passed: report.passed,
      failed: report.failed,
      flaky,
      quarantinedFailed,
      ...(report.ui ? { ui: report.ui } : {})
    },
    gate: {
      result: input.exitCode === 0 ? "pass" : "fail",
      exitCode: input.exitCode,
      reasons
    },
    failureDomains,
    cases: report.cases.map((entry) => ({
      caseId: entry.caseId,
      name: entry.name,
      status: entry.status,
      traceId: entry.traceId,
      error: entry.error,
      failure: entry.failure
        ? {
            domain: entry.failure.domain,
            confidence: entry.failure.confidence,
            reason: entry.failure.reason
          }
        : null,
      ...(entry.ui ? { ui: entry.ui } : {}),
      scriptProvenance: entry.scriptProvenance,
      apiErrors: entry.apiErrors,
      apiErrorsDegraded: entry.apiErrorsDegraded,
      quarantined: entry.quarantined === true,
      retry: entry.retry ?? null,
      evidence: entry.evidence
    }))
  };
}

/** 独占创建（tmp + link，rename 会覆写）：目标存在 → EEXIST → 调用方换 runId 重试。 */
function writeExclusive(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content, "utf-8");
  try {
    fs.linkSync(tmp, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}

export interface SaveRunManifestDeps {
  /** 冲突时生成新后缀（测试注入确定性值）。 */
  randomSuffix?: () => string;
}

/** 原子 + 独占写盘；撞名换后缀重试 ≤4 次。返回落盘路径。 */
export function saveRunManifest(
  configDirAbs: string,
  manifest: RunManifest,
  deps: SaveRunManifestDeps = {}
): string {
  const dir = runManifestDir(configDirAbs);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = deps.randomSuffix ?? (() => randomBytes(3).toString("hex"));
  const startedMs = Date.parse(manifest.startedAt);
  const baseMs = Number.isFinite(startedMs) ? startedMs : Date.now();
  let current = manifest;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const file = path.join(dir, `${current.runId}.json`);
    try {
      writeExclusive(file, JSON.stringify(current, null, 2) + "\n");
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      current = { ...current, runId: newRunId(baseMs, suffix()) };
    }
  }
  throw new Error(`批次清单命名冲突：${manifest.runId}`);
}

function baseRunManifest(record: Record<string, unknown>): RunManifestBase {
  const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const asNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const rawSummary = record.summary;
  const summaryRecord =
    rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)
      ? (rawSummary as Record<string, unknown>)
      : null;
  return {
    runId: asString(record.runId),
    startedAt: asString(record.startedAt),
    finishedAt: asString(record.finishedAt),
    ok: typeof record.ok === "boolean" ? record.ok : null,
    summary: summaryRecord
      ? {
          total: asNumber(summaryRecord.total),
          passed: asNumber(summaryRecord.passed),
          failed: asNumber(summaryRecord.failed)
        }
      : null
  };
}

export function loadRunManifest(configDirAbs: string, fileName: string): RunManifestRead {
  // 面板任务页持有台账里的绝对清单路径；允许直接读取，避免反推项目目录。
  const file = path.isAbsolute(fileName) ? fileName : path.join(runManifestDir(configDirAbs), fileName);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { kind: "missing", file };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", file, reason: "JSON 解析失败" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", file, reason: "清单不是对象" };
  }
  const record = parsed as Record<string, unknown>;
  const version = record.schemaVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > RUN_MANIFEST_VERSION) {
    return { kind: "newer", file, version, base: baseRunManifest(record) };
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { kind: "invalid", file, reason: "schemaVersion 缺失或无效" };
  }
  if (typeof record.runId !== "string" || record.runId.trim() === "") {
    return { kind: "invalid", file, reason: "runId 缺失" };
  }
  return { kind: "ok", file, manifest: record as unknown as RunManifest };
}

/** 文件名倒序（run-<UTC 定宽时间戳>-<后缀>：字典序即时间序）；零额外 stat。 */
export function runManifestFileNames(configDirAbs: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runManifestDir(configDirAbs), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.startsWith("run-") && entry.name.endsWith(".json")
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** L1 轻量入口：最新 1 件；无清单返回 null。 */
export function loadLatestRunManifest(configDirAbs: string): RunManifestRead | null {
  const names = runManifestFileNames(configDirAbs);
  if (names.length === 0) return null;
  return loadRunManifest(configDirAbs, names[0]!);
}

/** 按文件名倒序保留最新 max 件；max ≤ 0 视为关闭（不裁剪）。返回删除数。 */
export function pruneRunManifests(configDirAbs: string, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const names = runManifestFileNames(configDirAbs);
  const dir = runManifestDir(configDirAbs);
  let removed = 0;
  for (const name of names.slice(Math.trunc(max))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  return removed;
}
