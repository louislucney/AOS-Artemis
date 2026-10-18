import fs from "node:fs";
import path from "node:path";

import { configDirAbs, projectTracesDir } from "../artemis/assembly.js";
import { depsStatus, type DepsStatus } from "../artemis/bootstrap.js";
import { defaultArtemisRepo, loadProject, type LoadedProject } from "../config/loader.js";
import type {
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  RegressionTaskRecord,
  RunnerDevice,
  RunnerRecord,
  RunnerTools,
  TaskStatRecord
} from "../db/types.js";
import { resolveAndroidAdbSocket, resolveIosHost } from "../device/device-hosts.js";
import { designDir } from "../figma/design-store.js";
import {
  loadLatestRunManifest,
  loadRunManifest,
  runManifestFileNames,
  type RunManifest,
  type RunManifestBase,
  type RunManifestRead
} from "../figma/run-manifest.js";
import { jiraConfigFrom, type ResolvedJiraConfig } from "../jira/config.js";
import { entriesFromConfig, entryFromStore, entryIssues } from "../llm/registry.js";
import { scanProjectEnv, type EnvScanResult } from "../projects/scan.js";
import { detectProjectStacks } from "../projects/stack.js";
import { outcomeOf, type TaskOutcome } from "../tasks/outcome.js";
import { crossPlatformDeltas } from "../tasks/run-compare.js";
import {
  collectVerdictExits,
  type VerdictEnvironmentGroup
} from "../tasks/verdict-exits.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import { buildRegressionStats, type PanelRegressionStats } from "./stats.js";
import { errorMessage } from "../util.js";
import { collectDiskAssets, type PanelDiskAssets } from "./assets.js";
import type { PanelDeepProbe, PanelDeepView } from "./deep.js";

/** 多项目总览面板聚合层（overview-panel T2，DESIGN §13.95 D5 口径）：
 * 注册层（PG）∪ HTTP 工作区目录 → 磁盘可达性 → 配置层软读（loadProject 级，
 * 无子进程/无网络）→ 集成详情 / 批次清单（权威）/ 独立运行（台账）。
 * 一律如实降级：磁盘不可达 → "仅台账"；缺件/坏件/高版本 → 占位标注，不猜测。 */

export const PANEL_BATCH_LIMIT_DEFAULT = 20;
export const PANEL_BATCH_LIMIT_MAX = 100;
export const PANEL_TASK_SCAN_LIMIT_DEFAULT = 100;
export const PANEL_STANDALONE_LIMIT_DEFAULT = 20;

/** 批次空态原因清单（面板不做断言式归因：读不到 runner 进程 env）。 */
export const PANEL_BATCH_EMPTY_CAUSES = [
  "从未运行过套件（无批次清单记录）",
  "批次清单写入被运行侧关闭（suite run --no-save 或 AOS_SUITE_RUNS=0）",
  "批次清单已被保留期清理（suite retention 的 runs 分类）"
];

export type PanelLamp = "red" | "yellow" | "green" | "gray";

export interface PanelDeps {
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  /** HTTP 工作区：其子目录并入项目集合（未注册项目合成灰/未注册行）。 */
  workspaceRoot?: string | null;
  /** 宿主级 artemis 仓库（默认 AOS_ARTEMIS_REPO 或服务旁仓库）。 */
  serviceRepo?: string;
  /** 宿主级构建陈旧标记（由调用方注入；未提供则显示未知）。 */
  buildStale?: boolean | null;
  now?: () => number;
  /** 深探层（HTTP 模式注入；懒建 Runtime 纯读子集，见 deep.ts）。 */
  deepProbe?: PanelDeepProbe | null;
}

export interface PanelBatchSummary {
  result: "ok" | "missing" | "invalid" | "newer";
  runId: string | null;
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  gate: "pass" | "fail" | null;
  summary: { total: number | null; passed: number | null; failed: number | null } | null;
  note: string | null;
}

export interface PanelProjectRow {
  name: string;
  rootPath: string;
  registered: boolean;
  lastSeenAt: string | null;
  diskReachable: boolean;
  stacks: string[];
  lamp: PanelLamp;
  lampReasons: string[];
  latestBatch: PanelBatchSummary | null;
  warnings: string[];
}

export interface PanelOverview {
  ok: true;
  generatedAt: string;
  store: { kind: "postgres" | "file" | "memory"; degraded: boolean };
  host: { serviceRepo: string; deps: DepsStatus["status"]; buildStale: boolean | null };
  workspaceRoot: string | null;
  projects: PanelProjectRow[];
  warnings: string[];
}

export interface PanelAssetStat {
  id: string;
  path: string;
  present: boolean;
  modifiedAt: string | null;
}

export interface PanelIntegration {
  llm: { entries: number; activeName: string | null; usable: boolean; missing: string[] };
  credentials: {
    figma: boolean;
    jira: { configured: boolean; siteUrl: string | null; missing: string[] };
    penKey: boolean;
  };
  validation: { errors: string[]; warnings: string[] };
  deviceHosts: { configured: boolean; iosAppiumUrl: string | null; androidAdbHost: string | null };
  assets: PanelAssetStat[];
  host: { serviceRepo: string; deps: DepsStatus["status"]; buildStale: boolean | null };
}

export interface PanelBatchRow extends PanelBatchSummary {
  file: string;
  failureDomains: Record<string, number> | null;
}

export interface PanelBatchTrendPoint {
  runId: string;
  finishedAt: string | null;
  passed: number | null;
  failed: number | null;
  total: number | null;
  gate: "pass" | "fail" | null;
}

export interface PanelBatchTrend {
  /** 时间升序的批次数列（来自已加载清单，≤ L2 上限）。 */
  points: PanelBatchTrendPoint[];
  /** 窗口内失败域累计。 */
  domainTotals: Record<string, number>;
  /** 最近批次的通过率（passed/total；缺数则 null）。 */
  recentPassRate: number | null;
}

export interface PanelStandaloneRow {
  traceId: string;
  caseId: string | null;
  status: string;
  outcome: TaskOutcome;
  model: string | null;
  taskDesc: string | null;
  submittedAt: string;
  finishedAt: string | null;
}

export interface PanelRegressionRef {
  caseSetId: string;
  featureKey: string;
  featureName: string;
  caseCount: number;
  createdAt: string;
  source: string;
  jsonPath: string;
  lastPassRate: number | null;
}

export interface PanelTaskRow {
  id: string;
  status: string;
  refs: number;
  platforms: string[];
  runIds: number;
  createdAt: string;
}

export interface PanelTaskRunView {
  runId: string;
  platform: string;
  device: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  failureDomains: Record<string, number>;
  comparison: {
    baseline: string;
    fixed: number;
    regressed: number;
    newFailed: number;
    vanished: number;
  } | null;
  manifestPath: string | null;
  artifacts: { manifestUrl: string | null };
  createdAt: string;
}

export interface PanelTaskDetail {
  task: RegressionTaskRecord;
  refs: Array<{
    caseSetId: string;
    featureKey: string;
    featureName: string | null;
    caseCount: number | null;
    jsonPath: string | null;
    xlsxPath: string | null;
    jsonUrl: string | null;
    xlsxUrl: string | null;
  }>;
  runs: PanelTaskRunView[];
  crossPlatform: Array<{ caseId: string; name: string; results: Record<string, string> }>;
  runner: PanelRunnerView | null;
  runners: PanelRunnerView[];
  warnings: string[];
}

export interface PanelRunnerView {
  id: string;
  name: string;
  hostname: string;
  online: boolean;
  lastSeenAt: string;
  platforms: string[];
  devices: RunnerDevice[];
  tools: RunnerTools;
  artifactBaseUrl: string | null;
}

export interface PanelScheduleView {
  id: string;
  name: string;
  featureKeys: string[];
  platforms: string[];
  baseline: "latest" | "none";
  everyMinutes: number;
  enabled: boolean;
  lastFiredAt: string | null;
  lastNote: string | null;
  lastTaskId: string | null;
  lastTaskStatus: string | null;
}

function runnerView(record: RunnerRecord, nowMs: number, ttlMs: number): PanelRunnerView {
  return {
    id: record.id,
    name: record.name,
    hostname: record.hostname,
    online: isRunnerOnline(record.lastSeenAt, nowMs, ttlMs),
    lastSeenAt: record.lastSeenAt,
    platforms: record.platforms,
    devices: record.devices,
    tools: record.tools,
    artifactBaseUrl: record.artifactBaseUrl
  };
}

/** 产物 URL（服务根＝`<rootPath>/.artemis`，与服务端一致）：越界/无基址 → null。 */
export function artifactUrl(
  artifactBaseUrl: string | null,
  rootPath: string,
  absPath: string | null
): string | null {
  if (artifactBaseUrl === null || absPath === null) return null;
  const rel = path.relative(path.join(rootPath, ".artemis"), absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const base = artifactBaseUrl.replace(/\/+$/, "");
  if (rel === "") return `${base}/artifact/`;
  const encoded = rel
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/artifact/${encoded}`;
}

export interface PanelReviewItem {
  runId: string;
  caseId: string;
  name: string;
  featureName: string | null;
  platform: string;
  device: string | null;
  status: string;
  failureDomain: string | null;
  failureConfidence: string | null;
  failureReason: string | null;
  traceId: string | null;
  evidencePath: string | null;
  evidenceUrl: string | null;
  verdict: string | null;
  verdictBy: string | null;
  verdictAt: string | null;
  verdictNote: string | null;
  createdAt: string;
}

export interface PanelImprovementItem {
  caseId: string;
  name: string;
  featureName: string | null;
  runId: string;
  platform: string;
  device: string | null;
  traceId: string | null;
  jiraKey: string | null;
}

export interface PanelStatsView {
  stats: PanelRegressionStats;
  improvement: {
    caseDefects: PanelImprovementItem[];
    environment: VerdictEnvironmentGroup[];
    appDefects: PanelImprovementItem[];
  };
  guidance: string[];
  warnings: string[];
}

export interface PanelProjectDetail {
  generatedAt: string;
  project: PanelProjectRow;
  integration: PanelIntegration | null;
  batches: PanelBatchRow[];
  trend: PanelBatchTrend | null;
  standalones: PanelStandaloneRow[];
  regressionRefs: PanelRegressionRef[];
  tasks: PanelTaskRow[];
  runners: PanelRunnerView[];
  schedules: PanelScheduleView[];
  diskAssets: PanelDiskAssets | null;
  deep: PanelDeepView | null;
  emptyState: { causes: string[] } | null;
  warnings: string[];
}

export interface PanelEvidenceLink {
  kind: "trace" | "notes" | "stderr" | "stdout";
  path: string;
  status: "present" | "missing";
}

export interface PanelBatchCaseView {
  caseId: string;
  name: string;
  status: string;
  traceId: string | null;
  error: string | null;
  failure: { domain: string; confidence: string; reason: string } | null;
  scriptProvenance: { asserts: number; explores: number } | null;
  quarantined: boolean;
  flaky: boolean;
  evidence: PanelEvidenceLink[];
}

export interface PanelBatchDetail {
  file: string;
  read: "ok" | "newer" | "invalid" | "missing";
  note: string | null;
  runId: string | null;
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  taxonomyVersion: number | null;
  gate: { result: string; exitCode: number; reasons: string[] } | null;
  summary: { total: number | null; passed: number | null; failed: number | null } | null;
  failureDomains: Record<string, number> | null;
  options: RunManifest["options"] | null;
  tests: RunManifest["tests"] | null;
  cases: PanelBatchCaseView[];
  warnings: string[];
}

const ASSET_FILES: Array<{ id: string; file: string }> = [
  { id: "flows", file: "flows.json" },
  { id: "tests", file: "tests.json" },
  { id: "tests-md", file: "tests.md" },
  { id: "tests-xlsx", file: "tests.xlsx" },
  { id: "reconciliation", file: "reconciliation.json" },
  { id: "quarantine", file: "quarantine.json" },
  { id: "error-codes", file: "error-codes.json" }
];

async function safeStore<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function isDiskReachable(rootPath: string): boolean {
  try {
    return fs.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}

function statSignature(target: string): { present: boolean; modifiedAt: string | null } {
  try {
    const stat = fs.statSync(target);
    return { present: true, modifiedAt: new Date(stat.mtimeMs).toISOString() };
  } catch {
    return { present: false, modifiedAt: null };
  }
}

function pathStatus(target: string, kind: "dir" | "file"): "present" | "missing" {
  try {
    const stat = fs.statSync(target);
    return kind === "dir" ? (stat.isDirectory() ? "present" : "missing") : stat.isFile() ? "present" : "missing";
  } catch {
    return "missing";
  }
}

interface PanelHostStatus {
  serviceRepo: string;
  deps: DepsStatus;
  buildStale: boolean | null;
}

function hostStatus(deps: PanelDeps): PanelHostStatus {
  const env = deps.env ?? process.env;
  const serviceRepo = path.resolve(deps.serviceRepo ?? env.AOS_ARTEMIS_REPO?.trim() ?? defaultArtemisRepo());
  return { serviceRepo, deps: depsStatus(serviceRepo), buildStale: deps.buildStale ?? null };
}

interface SoftProjectRead {
  project: LoadedProject;
  configDirAbs: string;
  stacks: string[];
  scan: EnvScanResult;
  storeEntries: ProjectLlmRecord[];
  configEntryCount: number;
  activeName: string | null;
  llmUsable: boolean;
  llmMissing: string[];
  jira: ResolvedJiraConfig;
  penKeyPresent: boolean;
  deviceHosts: { configured: boolean; iosAppiumUrl: string | null; androidAdbHost: string | null };
}

async function softReadProject(deps: PanelDeps, rootPath: string): Promise<SoftProjectRead> {
  const env = deps.env ?? process.env;
  const project = loadProject({ env: { ...env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" } });
  const scan = scanProjectEnv(project.resolver);
  const storeEntries = await safeStore(() => deps.store.listLlms(rootPath), [] as ProjectLlmRecord[]);
  const configEntries = entriesFromConfig(project.config, project.resolver);

  const storeUsable = storeEntries.some((record) => entryIssues(entryFromStore(record)).length === 0);
  const configUsable = configEntries.some((entry) => entryIssues(entry).length === 0);
  const envUsable = scan.llm?.complete === true;
  const llmUsable = storeUsable || configUsable || envUsable;

  const missing: string[] = [];
  if (!llmUsable) {
    if (scan.llm) missing.push(...scan.llm.missing);
    for (const record of storeEntries) {
      missing.push(...entryIssues(entryFromStore(record)).map((issue) => `${record.name}: ${issue}`));
    }
    for (const entry of configEntries) {
      missing.push(...entryIssues(entry).map((issue) => `${entry.name}: ${issue}`));
    }
    if (missing.length === 0) {
      missing.push("未配置 LLM（AOS_LLM_MODEL / AOS_LLM_BASE_URL / AOS_LLM_API_KEY）");
    }
  }

  const ios = resolveIosHost(project.config, project.resolver);
  const android = resolveAndroidAdbSocket(project.config, project.resolver);
  const pen = project.resolver.getValue("PEN_CLI_KEY");

  return {
    project,
    configDirAbs: configDirAbs(project.config, project.rootDir),
    stacks: detectProjectStacks(project.rootDir).map((stack) => stack.displayName),
    scan,
    storeEntries,
    configEntryCount: configEntries.length,
    activeName: storeEntries.find((record) => record.isActive)?.name ?? null,
    llmUsable,
    llmMissing: [...new Set(missing)],
    jira: jiraConfigFrom(project.resolver),
    penKeyPresent: pen.value !== null,
    deviceHosts: {
      configured: ios.appiumUrl !== null || android !== null,
      iosAppiumUrl: ios.appiumUrl,
      androidAdbHost: android?.socket ?? null
    }
  };
}

function artifactChecks(configDirAbsValue: string): {
  testsJson: { present: boolean; modifiedAt: string | null };
  testsXlsx: { present: boolean; modifiedAt: string | null };
  xlsxStale: boolean;
} {
  const ddir = designDir(configDirAbsValue);
  const testsJson = statSignature(path.join(ddir, "tests.json"));
  const testsXlsx = statSignature(path.join(ddir, "tests.xlsx"));
  const xlsxStale =
    testsJson.present &&
    testsXlsx.present &&
    Date.parse(testsXlsx.modifiedAt ?? "") < Date.parse(testsJson.modifiedAt ?? "");
  return { testsJson, testsXlsx, xlsxStale };
}

function assetStats(rootPath: string, configDirAbsValue: string): PanelAssetStat[] {
  const ddir = designDir(configDirAbsValue);
  return ASSET_FILES.map(({ id, file }) => {
    const abs = path.join(ddir, file);
    const signature = statSignature(abs);
    return {
      id,
      path: path.relative(rootPath, abs),
      present: signature.present,
      modifiedAt: signature.modifiedAt
    };
  });
}

function batchSummaryFromRead(read: RunManifestRead | null): PanelBatchSummary | null {
  if (read === null) return null;
  if (read.kind === "ok") {
    const manifest = read.manifest;
    return {
      result: "ok",
      runId: manifest.runId,
      source: manifest.source,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      gate: manifest.gate.result,
      summary: {
        total: manifest.summary.total,
        passed: manifest.summary.passed,
        failed: manifest.summary.failed
      },
      note: null
    };
  }
  if (read.kind === "newer") {
    return {
      result: "newer",
      runId: read.base.runId,
      source: null,
      startedAt: read.base.startedAt,
      finishedAt: read.base.finishedAt,
      gate: null,
      summary: read.base.summary,
      note: `清单版本 ${read.version} 高于当前面板（仅展示公共字段）`
    };
  }
  if (read.kind === "invalid") {
    return { result: "invalid", runId: null, source: null, startedAt: null, finishedAt: null, gate: null, summary: null, note: `清单不可读：${read.reason}` };
  }
  return { result: "missing", runId: null, source: null, startedAt: null, finishedAt: null, gate: null, summary: null, note: "清单已清理或不可读" };
}

function batchRowFromRead(read: RunManifestRead): PanelBatchRow {
  const base = batchSummaryFromRead(read)!;
  if (read.kind === "ok") {
    return { ...base, file: read.file.split(path.sep).pop()!, failureDomains: read.manifest.failureDomains };
  }
  return { ...base, file: read.file.split(path.sep).pop()!, failureDomains: null };
}

function standaloneRow(task: TaskStatRecord): PanelStandaloneRow {
  return {
    traceId: task.traceId,
    caseId: task.caseId,
    status: task.status,
    outcome: outcomeOf(task.status),
    model: task.model,
    taskDesc: task.taskDesc,
    submittedAt: task.submittedAt,
    finishedAt: task.finishedAt
  };
}

function buildBatchTrend(batches: PanelBatchRow[]): PanelBatchTrend | null {
  const okRows = batches.filter((row) => row.result === "ok");
  if (okRows.length === 0) return null;
  const points = [...okRows].reverse().map((row) => ({
    runId: row.runId ?? row.file,
    finishedAt: row.finishedAt,
    passed: row.summary?.passed ?? null,
    failed: row.summary?.failed ?? null,
    total: row.summary?.total ?? null,
    gate: row.gate
  }));
  const domainTotals: Record<string, number> = {};
  for (const row of okRows) {
    for (const [domain, count] of Object.entries(row.failureDomains ?? {})) {
      domainTotals[domain] = (domainTotals[domain] ?? 0) + count;
    }
  }
  const latest = points.at(-1) ?? null;
  const recentPassRate =
    latest && latest.total !== null && latest.total > 0 && latest.passed !== null
      ? latest.passed / latest.total
      : null;
  return { points, domainTotals, recentPassRate };
}

async function buildProjectRow(
  deps: PanelDeps,
  input: { record: ProjectRecord | null; name: string; rootPath: string; host: PanelHostStatus; storeDegraded: boolean }
): Promise<PanelProjectRow> {
  const base: PanelProjectRow = {
    name: input.name,
    rootPath: input.rootPath,
    registered: input.record !== null,
    lastSeenAt: input.record?.lastSeenAt ?? null,
    diskReachable: false,
    stacks: [],
    lamp: "gray",
    lampReasons: [],
    latestBatch: null,
    warnings: []
  };
  if (!isDiskReachable(input.rootPath)) {
    return {
      ...base,
      lamp: "gray",
      lampReasons: ["磁盘不可达：仅台账可见（批次清单与设计资产不可读）"],
      warnings: ["磁盘不可达"]
    };
  }

  try {
    const soft = await softReadProject(deps, input.rootPath);
    const figmaPresent = soft.scan.figmaToken !== null || (input.record?.figmaToken ?? null) !== null;
    const artifacts = artifactChecks(soft.configDirAbs);
    const latest = loadLatestRunManifest(soft.configDirAbs);

    const reasons: string[] = [];
    let lamp: PanelLamp = "green";
    if (!soft.llmUsable) {
      lamp = "red";
      reasons.push(`无可用 LLM（setup_required）：${soft.llmMissing.slice(0, 3).join("、")}`);
    } else {
      if (!figmaPresent) reasons.push("Figma token 未配置");
      if (!soft.jira.configured) reasons.push(`Jira 未配置（缺 ${soft.jira.missing.join("、")}）`);
      if (input.host.deps.status === "stale" || input.host.deps.status === "missing") {
        reasons.push(`宿主依赖 ${input.host.deps.status}：运行 doctor --install-deps`);
      }
      if (artifacts.testsJson.present && (!artifacts.testsXlsx.present || artifacts.xlsxStale)) {
        reasons.push("三件套不齐：tests.xlsx 缺失或陈旧");
      }
      if (input.storeDegraded) reasons.push("存储降级（内存）：数据仅当前进程有效");
      if (input.host.buildStale === true) reasons.push("构建陈旧（dist 较进程新）：重启客户端会话");
      if (reasons.length > 0) lamp = "yellow";
    }

    return {
      ...base,
      diskReachable: true,
      stacks: soft.stacks,
      lamp,
      lampReasons: reasons,
      latestBatch: batchSummaryFromRead(latest),
      warnings: []
    };
  } catch (error) {
    return {
      ...base,
      diskReachable: true,
      lamp: "yellow",
      lampReasons: [`读取降级：软读失败（${errorMessage(error)}）`],
      warnings: [errorMessage(error)]
    };
  }
}

function integrationView(soft: SoftProjectRead, record: ProjectRecord | null, host: PanelHostStatus): PanelIntegration {
  const figmaPresent = soft.scan.figmaToken !== null || (record?.figmaToken ?? null) !== null;
  return {
    llm: {
      entries: soft.storeEntries.length + soft.configEntryCount,
      activeName: soft.activeName,
      usable: soft.llmUsable,
      missing: soft.llmMissing
    },
    credentials: {
      figma: figmaPresent,
      jira: {
        configured: soft.jira.configured,
        siteUrl: soft.jira.siteUrl,
        missing: soft.jira.missing
      },
      penKey: soft.penKeyPresent
    },
    validation: {
      errors: soft.project.validation.errors.map((issue) => issue.message),
      warnings: soft.project.validation.warnings.map((issue) => issue.message)
    },
    deviceHosts: soft.deviceHosts,
    assets: assetStats(soft.project.rootDir, soft.configDirAbs),
    host: { serviceRepo: host.serviceRepo, deps: host.deps.status, buildStale: host.buildStale }
  };
}

function listWorkspaceDirs(workspaceRoot: string): Array<{ name: string; rootPath: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, rootPath: path.join(workspaceRoot, entry.name) }));
}

export async function buildPanelOverview(deps: PanelDeps): Promise<PanelOverview> {
  const now = deps.now ?? (() => Date.now());
  const host = hostStatus(deps);
  const storeDegraded = deps.store.kind === "memory";

  const records = await safeStore(() => deps.store.listProjects(), [] as ProjectRecord[]);
  const merged = new Map<string, { record: ProjectRecord | null; name: string; rootPath: string }>();
  for (const record of records) {
    merged.set(record.rootPath, { record, name: record.name, rootPath: record.rootPath });
  }
  if (deps.workspaceRoot) {
    for (const entry of listWorkspaceDirs(deps.workspaceRoot)) {
      if (!merged.has(entry.rootPath)) {
        merged.set(entry.rootPath, { record: null, name: entry.name, rootPath: entry.rootPath });
      }
    }
  }

  const ordered = [...merged.values()].sort((left, right) => {
    const leftSeen = left.record?.lastSeenAt ?? "";
    const rightSeen = right.record?.lastSeenAt ?? "";
    if (leftSeen !== rightSeen) return leftSeen < rightSeen ? 1 : -1;
    return left.name.localeCompare(right.name);
  });

  const projects: PanelProjectRow[] = [];
  for (const entry of ordered) {
    projects.push(
      await buildProjectRow(deps, {
        record: entry.record,
        name: entry.name,
        rootPath: entry.rootPath,
        host,
        storeDegraded
      })
    );
  }

  return {
    ok: true,
    generatedAt: new Date(now()).toISOString(),
    store: { kind: deps.store.kind, degraded: storeDegraded },
    host: { serviceRepo: host.serviceRepo, deps: host.deps.status, buildStale: host.buildStale },
    workspaceRoot: deps.workspaceRoot ?? null,
    projects,
    warnings: []
  };
}

export async function buildPanelProjectDetail(
  deps: PanelDeps,
  rootPath: string,
  options: {
    batchLimit?: number;
    taskScanLimit?: number;
    standaloneLimit?: number;
    /** 深探：显式 iOS 环境检测（spawn 本地 CLI，结果带时间缓存）。 */
    iosProbe?: boolean;
  } = {}
): Promise<PanelProjectDetail | null> {
  const now = deps.now ?? (() => Date.now());
  const record = await safeStore(() => deps.store.getProjectByPath(rootPath), null as ProjectRecord | null);
  const diskReachable = isDiskReachable(rootPath);
  if (record === null && !diskReachable) return null;

  const host = hostStatus(deps);
  const row = await buildProjectRow(deps, {
    record,
    name: record?.name ?? path.basename(rootPath),
    rootPath,
    host,
    storeDegraded: deps.store.kind === "memory"
  });

  const batchLimit = Math.min(
    Math.max(Math.trunc(options.batchLimit ?? PANEL_BATCH_LIMIT_DEFAULT), 1),
    PANEL_BATCH_LIMIT_MAX
  );
  const taskScanLimit = Math.max(Math.trunc(options.taskScanLimit ?? PANEL_TASK_SCAN_LIMIT_DEFAULT), 1);
  const standaloneLimit = Math.max(Math.trunc(options.standaloneLimit ?? PANEL_STANDALONE_LIMIT_DEFAULT), 1);

  const warnings: string[] = [];
  let integration: PanelIntegration | null = null;
  const batches: PanelBatchRow[] = [];
  let trend: PanelBatchTrend | null = null;
  let diskAssets: PanelDiskAssets | null = null;
  let deep: PanelDeepView | null = null;
  let emptyState: { causes: string[] } | null = null;
  const coveredTraceIds = new Set<string>();

  if (diskReachable) {
    try {
      const soft = await softReadProject(deps, rootPath);
      integration = integrationView(soft, record, host);
      const files = runManifestFileNames(soft.configDirAbs).slice(0, batchLimit);
      for (const file of files) {
        const read = loadRunManifest(soft.configDirAbs, file);
        batches.push(batchRowFromRead(read));
        if (read.kind === "ok") {
          for (const entry of read.manifest.cases) {
            if (entry.traceId) coveredTraceIds.add(entry.traceId);
          }
        }
      }
      if (files.length === 0) emptyState = { causes: [...PANEL_BATCH_EMPTY_CAUSES] };
      trend = buildBatchTrend(batches);
      diskAssets = await collectDiskAssets({
        configDirAbs: soft.configDirAbs,
        projectRoot: rootPath,
        nowMs: now()
      });
      if (deps.deepProbe) {
        deep = await deps.deepProbe.build(rootPath, { iosProbe: options.iosProbe === true });
      }
    } catch (error) {
      warnings.push(`软读失败：${errorMessage(error)}`);
    }
  } else {
    warnings.push("磁盘不可达：批次清单与设计资产不可读；台账行按独立运行展示");
  }

  const tasks = await safeStore(
    () => deps.store.listTasks(rootPath, taskScanLimit),
    [] as TaskStatRecord[]
  );
  const standalones = (diskReachable && integration !== null
    ? tasks.filter((task) => !coveredTraceIds.has(task.traceId))
    : tasks
  )
    .slice(0, standaloneLimit)
    .map(standaloneRow);

  const regressionRefs: PanelRegressionRef[] = [];
  try {
    const sets = await deps.store.listCaseSets(rootPath, 50);
    const runs = await deps.store.listSuiteRuns(rootPath, { limit: 50 });
    for (const set of sets) {
      for (const feature of set.features) {
        const latest = runs.find(
          (run) =>
            run.caseSetId === set.id && run.featureKey === feature.key && run.cases.length > 0
        );
        regressionRefs.push({
          caseSetId: set.id,
          featureKey: feature.key,
          featureName: feature.name,
          caseCount: feature.caseCount,
          createdAt: set.createdAt,
          source: set.source,
          jsonPath: feature.jsonPath,
          lastPassRate:
            latest !== undefined && latest.total > 0 ? latest.passed / latest.total : null
        });
      }
    }
  } catch (error) {
    warnings.push(`回归引用读取失败：${errorMessage(error)}`);
  }

  const taskRows: PanelTaskRow[] = [];
  let regressionTaskRecords: RegressionTaskRecord[] = [];
  try {
    regressionTaskRecords = await deps.store.listRegressionTasks(rootPath, 20);
    for (const task of regressionTaskRecords) {
      taskRows.push({
        id: task.id,
        status: task.status,
        refs: task.refs.length,
        platforms: task.platforms,
        runIds: task.runIds.length,
        createdAt: task.createdAt
      });
    }
  } catch (error) {
    warnings.push(`回归任务读取失败：${errorMessage(error)}`);
  }

  const runners: PanelRunnerView[] = [];
  try {
    const ttlMs = runnerTtlFrom(deps.env ?? process.env);
    const nowMs = now();
    for (const record of await deps.store.listRunners(rootPath)) {
      runners.push(runnerView(record, nowMs, ttlMs));
    }
  } catch (error) {
    warnings.push(`执行机读取失败：${errorMessage(error)}`);
  }

  const schedulesView: PanelScheduleView[] = [];
  try {
    for (const schedule of await deps.store.listSchedules(rootPath, 20)) {
      const lastTask =
        regressionTaskRecords.find(
          (task) => task.createdBy === `schedule:${schedule.name}`
        ) ?? null;
      schedulesView.push({
        id: schedule.id,
        name: schedule.name,
        featureKeys: schedule.featureKeys,
        platforms: schedule.platforms,
        baseline: schedule.baseline,
        everyMinutes: schedule.everyMinutes,
        enabled: schedule.enabled,
        lastFiredAt: schedule.lastFiredAt,
        lastNote: schedule.lastNote,
        lastTaskId: lastTask?.id ?? null,
        lastTaskStatus: lastTask?.status ?? null
      });
    }
  } catch (error) {
    warnings.push(`定时回归读取失败：${errorMessage(error)}`);
  }

  return {
    generatedAt: new Date(now()).toISOString(),
    project: row,
    integration,
    batches,
    trend,
    standalones,
    regressionRefs,
    tasks: taskRows,
    runners,
    schedules: schedulesView,
    diskAssets,
    deep,
    emptyState,
    warnings
  };
}

function comparisonView(value: unknown): PanelTaskRunView["comparison"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const number = (key: string): number =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : 0;
  return {
    baseline: typeof record.baseline === "string" ? record.baseline : "unknown",
    fixed: number("fixed"),
    regressed: number("regressed"),
    newFailed: number("newFailed"),
    vanished: number("vanished")
  };
}

/** 回归任务详情（DESIGN：回归服务 §5.4 屏 B）：引用解析 + 子运行 + 跨端差异；
 * 产物路径仅展示（P1 不内联预览）。未知 task → null。 */
export async function buildPanelTaskDetail(
  deps: PanelDeps,
  rootPath: string,
  taskId: string
): Promise<PanelTaskDetail | null> {
  const task = await safeStore(
    () => deps.store.getRegressionTask(rootPath, taskId),
    null as RegressionTaskRecord | null
  );
  if (!task) return null;

  const warnings: string[] = [];
  let sets: Awaited<ReturnType<ProjectStore["listCaseSets"]>> = [];
  try {
    sets = await deps.store.listCaseSets(rootPath, 50);
  } catch (error) {
    warnings.push(`用例集读取失败：${errorMessage(error)}`);
  }
  const setById = new Map(sets.map((set) => [set.id, set]));
  const refs = task.refs.map((ref) => {
    const set = setById.get(ref.caseSetId);
    const feature = set?.features.find((entry) => entry.key === ref.featureKey) ?? null;
    return {
      caseSetId: ref.caseSetId,
      featureKey: ref.featureKey,
      featureName: feature?.name ?? null,
      caseCount: feature?.caseCount ?? null,
      jsonPath: feature?.jsonPath ?? null,
      xlsxPath: feature?.xlsxPath ?? null
    };
  });

  let runs: Awaited<ReturnType<ProjectStore["listSuiteRuns"]>> = [];
  try {
    runs = await deps.store.listSuiteRuns(rootPath, { taskId, limit: 100 });
  } catch (error) {
    warnings.push(`运行读取失败：${errorMessage(error)}`);
  }

  const latestByPlatform = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    if (!latestByPlatform.has(run.platform)) latestByPlatform.set(run.platform, run);
  }
  const crossPlatform = crossPlatformDeltas(
    [...latestByPlatform.entries()].map(([platform, run]) => ({
      platform,
      cases: run.cases.map((entry) => ({
        caseId: entry.caseId,
        name: entry.name,
        outcome: entry.status === "passed" ? ("passed" as const) : ("failed" as const)
      }))
    }))
  );

  const runners: PanelRunnerView[] = [];
  try {
    const ttlMs = runnerTtlFrom(deps.env ?? process.env);
    const nowMs = (deps.now ?? (() => Date.now()))();
    for (const record of await deps.store.listRunners(rootPath)) {
      runners.push(runnerView(record, nowMs, ttlMs));
    }
  } catch (error) {
    warnings.push(`执行机读取失败：${errorMessage(error)}`);
  }
  const runner = task.claimedBy
    ? (runners.find((entry) => entry.id === task.claimedBy) ?? null)
    : null;

  const base = runner?.artifactBaseUrl ?? null;
  const runViews: PanelTaskRunView[] = runs.map((run) => ({
    runId: run.id,
    platform: run.platform,
    device: run.device,
    status: run.status,
    total: run.total,
    passed: run.passed,
    failed: run.failed,
    failureDomains: run.failureDomains,
    comparison: comparisonView(run.comparison),
    manifestPath: run.manifestPath,
    artifacts: { manifestUrl: artifactUrl(base, rootPath, run.manifestPath) },
    createdAt: run.createdAt
  }));
  const refViews = refs.map((ref) => ({
    ...ref,
    jsonUrl: artifactUrl(base, rootPath, ref.jsonPath),
    xlsxUrl: artifactUrl(base, rootPath, ref.xlsxPath)
  }));

  return { task, refs: refViews, runs: runViews, crossPlatform, runner, runners, warnings };
}

/** 归因队列（DESIGN：回归服务 §5.7）：最近 N 次运行的全部失败用例；
 * 未裁决在前，再按运行时间新→旧；evidencePath 为用例 trace 目录（存在性由视图标注两态）。 */
export async function buildPanelReviewQueue(
  deps: PanelDeps,
  rootPath: string,
  options: { limit?: number } = {}
): Promise<{ items: PanelReviewItem[]; warnings: string[] }> {
  const warnings: string[] = [];
  const limit = Math.max(Math.trunc(options.limit ?? 10), 1);
  let runs: Awaited<ReturnType<ProjectStore["listSuiteRuns"]>> = [];
  try {
    runs = await deps.store.listSuiteRuns(rootPath, { limit });
  } catch (error) {
    warnings.push(`运行读取失败：${errorMessage(error)}`);
  }

  let tracesDir = path.join(rootPath, ".artemis", "traces");
  try {
    const soft = await softReadProject(deps, rootPath);
    tracesDir = projectTracesDir(soft.project.config, rootPath, deps.env ?? process.env);
  } catch (error) {
    warnings.push(`项目配置读取失败（证据路径按默认 .artemis/traces 解析）：${errorMessage(error)}`);
  }

  const baseByTaskId = new Map<string, string | null>();
  try {
    const runnerById = new Map(
      (await deps.store.listRunners(rootPath)).map((runner) => [runner.id, runner])
    );
    for (const task of await deps.store.listRegressionTasks(rootPath, 50)) {
      const runner = task.claimedBy === null ? undefined : runnerById.get(task.claimedBy);
      baseByTaskId.set(task.id, runner?.artifactBaseUrl ?? null);
    }
  } catch (error) {
    warnings.push(`执行机读取失败（证据链接不可用）：${errorMessage(error)}`);
  }

  const items: PanelReviewItem[] = [];
  for (const run of runs) {
    const base =
      run.regressionTaskId === null ? null : (baseByTaskId.get(run.regressionTaskId) ?? null);
    for (const entry of run.cases) {
      if (entry.status === "passed") continue;
      const evidencePath =
        entry.traceId === null ? null : path.join(tracesDir, entry.traceId);
      items.push({
        runId: run.id,
        caseId: entry.caseId,
        name: entry.name,
        featureName: run.featureName,
        platform: run.platform,
        device: run.device,
        status: entry.status,
        failureDomain: entry.failureDomain,
        failureConfidence: entry.failureConfidence,
        failureReason: entry.failureReason,
        traceId: entry.traceId,
        evidencePath,
        evidenceUrl: artifactUrl(base, rootPath, evidencePath),
        verdict: entry.verdict,
        verdictBy: entry.verdictBy,
        verdictAt: entry.verdictAt,
        verdictNote: entry.verdictNote,
        createdAt: run.createdAt
      });
    }
  }
  items.sort((a, b) => {
    const aRank = a.verdict === null ? 0 : 1;
    const bRank = b.verdict === null ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0;
  });
  return { items, warnings };
}

/** 统计下钻（DESIGN：回归服务 §5.8）：聚合 + 改进出口三清单（按（份,用例）取最新裁决）。
 * 指引行为静态命令参考（P3 一键流转）。 */
export async function buildPanelStatsView(deps: PanelDeps, rootPath: string): Promise<PanelStatsView> {
  const warnings: string[] = [];
  let runs: Awaited<ReturnType<ProjectStore["listSuiteRuns"]>> = [];
  try {
    runs = await deps.store.listSuiteRuns(rootPath, { limit: 100 });
  } catch (error) {
    warnings.push(`运行读取失败：${errorMessage(error)}`);
  }
  const stats = buildRegressionStats(runs);

  const exits = collectVerdictExits(runs);
  const toItem = (entry: (typeof exits.caseDefects)[number]): PanelImprovementItem => ({
    caseId: entry.caseId,
    name: entry.name,
    featureName: entry.featureName,
    runId: entry.runId,
    platform: entry.platform,
    device: entry.device,
    traceId: entry.traceId,
    jiraKey: entry.jiraKey
  });

  const improvement = {
    caseDefects: exits.caseDefects.map(toItem),
    environment: exits.environment,
    appDefects: exits.appDefects.map(toItem)
  };
  const guidance: string[] = [];
  if (improvement.caseDefects.length > 0) {
    guidance.push(
      "修订用例期望后重新生成（figma_generate_tests / pen 生成工具）；重新生成时响应与 tests.md 会附上轮案例问题提示。"
    );
  }
  if (improvement.environment.length > 0) {
    guidance.push(
      "执行偏差（execution-deviation）：核对环境清单（设备在线 / 网络 / 账号与测试数据）后重跑：node dist/cli.js suite run --task <task-id> --device <serial>。"
    );
  }
  if (improvement.appDefects.length > 0) {
    guidance.push(
      '应用缺陷（app-defect）：建单：node dist/cli.js jira issue create --project <KEY> --type Bug --summary "…"；失败证据可用 jira_evidence_post 附加。'
    );
  }

  return { stats, improvement, guidance, warnings };
}

function evidenceLinks(tracesDir: string, rootPath: string, entry: RunManifest["cases"][number]): PanelEvidenceLink[] {
  const links: PanelEvidenceLink[] = [];
  if (entry.traceId) {
    const dir = path.join(tracesDir, entry.traceId);
    links.push({ kind: "trace", path: dir, status: pathStatus(dir, "dir") });
  }
  const add = (kind: PanelEvidenceLink["kind"], raw: string | null, expect: "dir" | "file") => {
    if (!raw) return;
    const abs = path.isAbsolute(raw) ? raw : path.join(rootPath, raw);
    links.push({ kind, path: abs, status: pathStatus(abs, expect) });
  };
  add("notes", entry.evidence.notesDir, "dir");
  add("stderr", entry.evidence.stderrLog, "file");
  add("stdout", entry.evidence.stdoutLog, "file");
  return links;
}

function emptyBatchDetail(file: string, read: "missing" | "invalid", note: string): PanelBatchDetail {
  return {
    file,
    read,
    note,
    runId: null,
    source: null,
    startedAt: null,
    finishedAt: null,
    taxonomyVersion: null,
    gate: null,
    summary: null,
    failureDomains: null,
    options: null,
    tests: null,
    cases: [],
    warnings: []
  };
}

export async function buildPanelBatchDetail(
  deps: PanelDeps,
  rootPath: string,
  file: string
): Promise<PanelBatchDetail | null> {
  if (path.basename(file) !== file || !file.startsWith("run-") || !file.endsWith(".json")) {
    return emptyBatchDetail(file, "invalid", "非法清单文件名");
  }
  const record = await safeStore(() => deps.store.getProjectByPath(rootPath), null as ProjectRecord | null);
  const diskReachable = isDiskReachable(rootPath);
  if (record === null && !diskReachable) return null;
  if (!diskReachable) {
    return emptyBatchDetail(file, "missing", "磁盘不可达（仅台账）：批次清单不可读");
  }

  let soft: SoftProjectRead;
  try {
    soft = await softReadProject(deps, rootPath);
  } catch (error) {
    return { ...emptyBatchDetail(file, "missing", `软读失败：${errorMessage(error)}`), warnings: [errorMessage(error)] };
  }

  const read = loadRunManifest(soft.configDirAbs, file);
  if (read.kind === "missing") return emptyBatchDetail(file, "missing", "清单已清理或不可读");
  if (read.kind === "invalid") return emptyBatchDetail(file, "invalid", `清单不可读：${read.reason}`);
  if (read.kind === "newer") {
    const base: RunManifestBase = read.base;
    return {
      file,
      read: "newer",
      note: `清单版本 ${read.version} 高于当前面板（仅展示公共字段）`,
      runId: base.runId,
      source: null,
      startedAt: base.startedAt,
      finishedAt: base.finishedAt,
      taxonomyVersion: null,
      gate: null,
      summary: base.summary,
      failureDomains: null,
      options: null,
      tests: null,
      cases: [],
      warnings: []
    };
  }

  const manifest = read.manifest;
  const tracesDir = projectTracesDir(soft.project.config, rootPath, deps.env ?? process.env);
  return {
    file,
    read: "ok",
    note: null,
    runId: manifest.runId,
    source: manifest.source,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    taxonomyVersion: manifest.taxonomyVersion,
    gate: manifest.gate,
    summary: {
      total: manifest.summary.total,
      passed: manifest.summary.passed,
      failed: manifest.summary.failed
    },
    failureDomains: manifest.failureDomains,
    options: manifest.options,
    tests: manifest.tests,
    cases: manifest.cases.map((entry) => ({
      caseId: entry.caseId,
      name: entry.name,
      status: entry.status,
      traceId: entry.traceId,
      error: entry.error,
      failure: entry.failure,
      scriptProvenance: entry.scriptProvenance,
      quarantined: entry.quarantined,
      flaky: entry.retry?.flaky === true,
      evidence: evidenceLinks(tracesDir, rootPath, entry)
    })),
    warnings: []
  };
}
