import fs from "node:fs";
import path from "node:path";

import { configDirAbs, projectTracesDir } from "../artemis/assembly.js";
import { depsStatus, type DepsStatus } from "../artemis/bootstrap.js";
import { defaultArtemisRepo, loadProject, type LoadedProject } from "../config/loader.js";
import type {
  DeviceLeaseRecord,
  HostAddressRecord,
  HostRecord,
  HostSessionRecord,
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  RegressionTaskRecord,
  RunnerDevice,
  RunnerRecord,
  RunnerTools,
  SuiteRunRecord,
  TaskStatRecord
} from "../db/types.js";
import { clientTtlFrom, isClientOnline } from "../host/online.js";
import { resolveAndroidAdbSocket, resolveIosHost } from "../device/device-hosts.js";
import { resolveDesignWarnings, type WarningSummary } from "../design/warnings.js";
import { designDir } from "../figma/design-store.js";
import {
  integrationReadinessFromFailures,
  type IntegrationReadiness
} from "../figma/integration-readiness.js";
import { projectExcluded } from "../project-visibility.js";
import type { UiCoverageSummary, UiSummary, UiVerification } from "../ui/verification.js";
import {
  loadLatestRunManifest,
  loadRunManifest,
  runManifestFileNames,
  type RunManifest,
  type RunManifestBase,
  type RunManifestRead
} from "../figma/run-manifest.js";
import { jiraConfigFrom, type ResolvedJiraConfig } from "../jira/config.js";
import { entriesFromConfig, entryFromStore, entryIssues, withEnvKeyFallback } from "../llm/registry.js";
import { scanProjectEnv, type EnvScanResult } from "../projects/scan.js";
import { detectProjectStacks } from "../projects/stack.js";
import { outcomeOf, type TaskOutcome } from "../tasks/outcome.js";
import { crossPlatformDeltas } from "../tasks/run-compare.js";
import {
  collectVerdictExits,
  type VerdictEnvironmentGroup
} from "../tasks/verdict-exits.js";
import { isRunnerOnline, runnerTtlFrom } from "../runner/status.js";
import {
  buildPanelUsageCostView,
  buildRegressionStats,
  type PanelRegressionStats,
  type PanelUsageCostView
} from "./stats.js";
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

/** `ip-shared` 判定窗口：同一 `observed-pg` 地址在 10 分钟内出现于多台主机。 */
export const PANEL_IP_SHARED_WINDOW_MS = 600_000;

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
  /** 主机作用域存储视图（跨主机同路径解析用）；未提供时回退 `store`。 */
  storeForHost?: (hostId: string) => ProjectStore | null;
}

export interface PanelBatchSummary {
  result: "ok" | "missing" | "invalid" | "newer";
  runId: string | null;
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  gate: "pass" | "fail" | null;
  summary: { total: number | null; passed: number | null; failed: number | null } | null;
  /** UI 核验计数；旧清单/不可读时为 null。 */
  ui: UiSummary | null;
  /** UI 访问屏/契约屏覆盖；旧清单无该字段 → null。 */
  uiCoverage?: UiCoverageSummary | null;
  note: string | null;
}

export interface PanelProjectRow {
  name: string;
  rootPath: string;
  hostId: string | null;
  registered: boolean;
  lastSeenAt: string | null;
  diskReachable: boolean;
  stacks: string[];
  /** 执行轴灯（回归可执行）：磁盘/宿主依赖/三件套/存储/构建；不含可选集成。 */
  lamp: PanelLamp;
  lampReasons: string[];
  /** 集成轴就绪（LLM/Figma/Jira）：只报告，不参与执行灯。 */
  integration: { ready: number; total: number; missing: string[] };
  latestBatch: PanelBatchSummary | null;
  /** 当前设计源警告快照；无快照/磁盘不可达 → null（不折算成 0 条）。 */
  designWarnings: WarningSummary | null;
  warnings: string[];
}

export interface PanelOverview {
  ok: true;
  generatedAt: string;
  store: { kind: "postgres" | "file" | "memory"; degraded: boolean };
  host: { serviceRepo: string; deps: DepsStatus["status"]; buildStale: boolean | null };
  workspaceRoot: string | null;
  projects: PanelProjectRow[];
  /** 被 `AOS_PANEL_EXCLUDE_PROJECTS` 从总览/对比隐藏的项目数（直接项目 URL 仍可访问）。 */
  excludedProjects: number;
  /** 接入主机注册表（中心 PG 专属）；无台账时为空，面板显示“单机模式”。 */
  machines: PanelMachineRow[];
  warnings: string[];
}

export interface PanelMachineRow {
  id: string;
  label: string | null;
  hostname: string;
  kind: string;
  osPlatform: string;
  osVersion: string | null;
  arch: string | null;
  clientOnline: boolean;
  clientSessions: number;
  runnerOnline: boolean;
  lastSeenAt: string;
  ipPrimary: string | null;
  addresses: string[];
  capabilities: string[];
  tools: Record<string, { present: boolean; version: string | null }>;
  queuePaused: boolean;
  pendingTasks: number;
  registered: boolean;
  drift: string[];
  /** IP 变更提示（主地址与历史主地址不同）；仅提示，不参与在线判定。 */
  ipChange: { prior: string; changedAt: string } | null;
  /** observed-pg 地址最近 10 分钟内在 ≥2 台主机出现（NAT/复用），只告警不合并。 */
  ipShared: boolean;
}

/** 主机显示标签（总览/对比同源）：`label（hostname）` → hostname → hostId 前 8 位；NULL＝未归属主机。 */
export function hostDisplayLabel(hostId: string | null, machines: PanelMachineRow[]): string {
  if (hostId === null) return "未归属主机";
  const machine = machines.find((entry) => entry.id === hostId);
  if (!machine) return hostId.slice(0, 8);
  return machine.label !== null && machine.label !== ""
    ? `${machine.label}（${machine.hostname}）`
    : machine.hostname;
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
  priority: number;
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
  /** UI 核验计数；清单缺失/远端不可读 → null。 */
  ui: UiSummary | null;
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

export interface PanelFleetLeaseView {
  hostId: string;
  serial: string;
  taskId: string;
  expiresAt: string;
  expired: boolean;
}

/** 项目页机队摘要：执行机在线/失联、设备容量、任务队列与设备租约。 */
export interface PanelFleetView {
  runners: { online: number; offline: number };
  devices: { total: number; ios: number; android: number; busy: number };
  queue: { pending: number; claimed: number; running: number; stopping: number };
  leases: PanelFleetLeaseView[];
  warnings: string[];
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

async function buildFleetView(
  deps: PanelDeps,
  rootPath: string,
  runners: PanelRunnerView[],
  nowMs: number
): Promise<PanelFleetView> {
  const warnings: string[] = [];
  const queue = { pending: 0, claimed: 0, running: 0, stopping: 0 };
  try {
    for (const task of await deps.store.listRegressionTasks(rootPath, 200)) {
      if (task.status === "pending") queue.pending += 1;
      else if (task.status === "claimed") queue.claimed += 1;
      else if (task.status === "running") queue.running += 1;
      else if (task.status === "stopping") queue.stopping += 1;
    }
  } catch (error) {
    warnings.push(`任务队列读取失败：${errorMessage(error)}`);
  }

  let leases: DeviceLeaseRecord[] = [];
  try {
    leases = await deps.store.listDeviceLeases();
  } catch (error) {
    warnings.push(`设备租约读取失败：${errorMessage(error)}`);
  }
  const activeSerials = new Set<string>();
  const leaseViews: PanelFleetLeaseView[] = leases.map((lease) => {
    const expired = Date.parse(lease.expiresAt) <= nowMs;
    if (!expired) activeSerials.add(`${lease.hostId}:${lease.serial}`);
    return {
      hostId: lease.hostId,
      serial: lease.serial,
      taskId: lease.taskId,
      expiresAt: lease.expiresAt,
      expired
    };
  });

  const devices = { total: 0, ios: 0, android: 0, busy: activeSerials.size };
  for (const runner of runners) {
    for (const device of runner.devices) {
      devices.total += 1;
      if (device.platform === "ios") devices.ios += 1;
      else if (device.platform === "android") devices.android += 1;
    }
  }

  return {
    runners: {
      online: runners.filter((runner) => runner.online).length,
      offline: runners.filter((runner) => !runner.online).length
    },
    devices,
    queue,
    leases: leaseViews,
    warnings
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
  jiraIssueKey: string | null;
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
  usage: PanelUsageCostView;
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
  /** 失败路径数字（最近 10 次运行窗）：未裁决 / 未建单缺陷。 */
  reviewQueue: { undecided: number; unissued: number };
  batches: PanelBatchRow[];
  trend: PanelBatchTrend | null;
  standalones: PanelStandaloneRow[];
  regressionRefs: PanelRegressionRef[];
  tasks: PanelTaskRow[];
  runners: PanelRunnerView[];
  fleet: PanelFleetView;
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
  /** UI 核验状态；旧清单没有该字段 → null。 */
  ui: UiVerification | null;
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
  /** UI 核验计数；旧清单没有该字段 → null。 */
  ui: UiSummary | null;
  /** UI 访问屏/契约屏覆盖；旧清单没有该字段 → null。 */
  uiCoverage: UiCoverageSummary | null;
  failureDomains: Record<string, number> | null;
  options: RunManifest["options"] | null;
  tests: RunManifest["tests"] | null;
  /** 清单冻结的设计源警告摘要；清单无该字段 → null（不回读当前快照）。 */
  designWarnings: RunManifest["designWarnings"];
  /** 运行期 API 说明快照：优先台账，清单兜底；旧记录为 null。 */
  apiReview: RunManifest["apiReview"];
  cases: PanelBatchCaseView[];
  /** 失败证据 → 接入检查（API／页面复用／重写）；无失败或旧记录为空。 */
  readiness: IntegrationReadiness;
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
  /** 主机作用域存储不可用/读取失败（面板照常渲染，但显式告警，不静默当空）。 */
  warnings: string[];
}

function hostScopedRead(deps: PanelDeps, hostId: string | null): { store: ProjectStore; warning: string | null } {
  if (hostId === null) return { store: deps.store, warning: null };
  try {
    const injected = deps.storeForHost?.(hostId);
    if (injected) return { store: injected, warning: null };
    return { store: deps.store.scopeHost(hostId), warning: null };
  } catch (error) {
    return {
      store: deps.store,
      warning: `主机 ${hostId} 作用域存储不可用（${errorMessage(error)}）：已回退公共台账，健康数据可能不完整`
    };
  }
}

async function softReadProject(
  deps: PanelDeps,
  rootPath: string,
  hostId: string | null = null
): Promise<SoftProjectRead> {
  const env = deps.env ?? process.env;
  const project = loadProject({ env: { ...env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" } });
  const scan = scanProjectEnv(project.resolver);
  const scoped = hostScopedRead(deps, hostId);
  const warnings: string[] = scoped.warning === null ? [] : [scoped.warning];
  let storeEntries: ProjectLlmRecord[] = [];
  try {
    storeEntries = await scoped.store.listLlms(rootPath);
  } catch (error) {
    warnings.push(
      `主机 ${hostId ?? "本机"} 台账读取失败（${errorMessage(error)}）：LLM/健康信息可能不完整`
    );
  }
  const configEntries = entriesFromConfig(project.config, project.resolver);

  const storeUsable = storeEntries.some(
    (record) => entryIssues(withEnvKeyFallback(entryFromStore(record), project.resolver)).length === 0
  );
  const configUsable = configEntries.some((entry) => entryIssues(entry).length === 0);
  const envUsable = scan.llm?.complete === true;
  const llmUsable = storeUsable || configUsable || envUsable;

  const missing: string[] = [];
  if (!llmUsable) {
    if (scan.llm) missing.push(...scan.llm.missing);
    for (const record of storeEntries) {
      missing.push(
        ...entryIssues(withEnvKeyFallback(entryFromStore(record), project.resolver)).map(
          (issue) => `${record.name}: ${issue}`
        )
      );
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
    },
    warnings
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

function designWarningsOf(configDirAbsValue: string): WarningSummary | null {
  try {
    const resolved = resolveDesignWarnings(configDirAbsValue);
    return resolved.source === "none" ? null : resolved.summary;
  } catch {
    return null;
  }
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
      ui: manifest.summary.ui ?? null,
      uiCoverage: manifest.summary.uiCoverage ?? null,
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
      ui: null,
      note: `清单版本 ${read.version} 高于当前面板（仅展示公共字段）`
    };
  }
  if (read.kind === "invalid") {
    return { result: "invalid", runId: null, source: null, startedAt: null, finishedAt: null, gate: null, summary: null, ui: null, note: `清单不可读：${read.reason}` };
  }
  return { result: "missing", runId: null, source: null, startedAt: null, finishedAt: null, gate: null, summary: null, ui: null, note: "清单已清理或不可读" };
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
    hostId: input.record?.hostId ?? null,
    registered: input.record !== null,
    lastSeenAt: input.record?.lastSeenAt ?? null,
    diskReachable: false,
    stacks: [],
    lamp: "gray",
    lampReasons: [],
    integration: { ready: 0, total: 3, missing: [] },
    latestBatch: null,
    designWarnings: null,
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
    const soft = await softReadProject(deps, input.rootPath, input.record?.hostId ?? null);
    const figmaPresent = soft.scan.figmaToken !== null || (input.record?.figmaToken ?? null) !== null;
    const artifacts = artifactChecks(soft.configDirAbs);
    const latest = loadLatestRunManifest(soft.configDirAbs);

    const reasons: string[] = [...soft.warnings];
    let lamp: PanelLamp = "green";
    if (input.host.deps.status === "stale" || input.host.deps.status === "missing") {
      reasons.push(`宿主依赖 ${input.host.deps.status}：运行 doctor --install-deps`);
    }
    if (artifacts.testsJson.present && (!artifacts.testsXlsx.present || artifacts.xlsxStale)) {
      reasons.push("三件套不齐：tests.xlsx 缺失或陈旧");
    }
    if (input.storeDegraded) reasons.push("会话内存：数据仅当前进程有效（未配置持久台账）");
    if (input.host.buildStale === true) reasons.push("构建陈旧（dist 较进程新）：重启客户端会话");
    if (reasons.length > 0) lamp = "yellow";

    const integrationMissing: string[] = [];
    if (!soft.llmUsable) integrationMissing.push("LLM");
    if (!figmaPresent) integrationMissing.push("Figma");
    if (!soft.jira.configured) integrationMissing.push("Jira");

    return {
      ...base,
      diskReachable: true,
      stacks: soft.stacks,
      lamp,
      lampReasons: reasons,
      integration: {
        ready: 3 - integrationMissing.length,
        total: 3,
        missing: integrationMissing
      },
      latestBatch: batchSummaryFromRead(latest),
      designWarnings: designWarningsOf(soft.configDirAbs),
      warnings: soft.warnings
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
      errors: soft.project.validation.errors
        .map((issue) => issue.message)
        .filter((message) => !(soft.llmUsable && message.includes("llm.profiles 为空"))),
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

function machineTools(env: Record<string, unknown>): PanelMachineRow["tools"] {
  const tools: PanelMachineRow["tools"] = {};
  const raw = env.tools;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return tools;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const tool = value as { present?: unknown; version?: unknown };
    tools[name] = {
      present: tool.present === true,
      version: typeof tool.version === "string" ? tool.version : null
    };
  }
  return tools;
}

function machineIpChange(host: HostRecord, addresses: HostAddressRecord[]): PanelMachineRow["ipChange"] {
  const primary = host.ipPrimary;
  if (primary === null) return null;
  const primaryFirst =
    addresses
      .filter((entry) => entry.address === primary)
      .map((entry) => Date.parse(entry.firstSeenAt))
      .filter((ms) => Number.isFinite(ms))
      .sort((left, right) => left - right)[0] ?? null;
  const prior =
    addresses
      .filter((entry) => entry.address !== primary)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0] ?? null;
  if (prior === null) return null;
  if (primaryFirst === null) return null;
  const priorLast = Date.parse(prior.lastSeenAt);
  if (!Number.isFinite(priorLast)) return null;
  if (priorLast >= primaryFirst) return null;
  return { prior: prior.address, changedAt: new Date(primaryFirst).toISOString() };
}

/** 主机注册表 → 面板行：双在线（IDE/执行机）、登记漂移、IP 变更/复用、队列待执行数。
 * 全部 best-effort：任何存储读取失败都不阻断总览，仅该主机字段降级为空。 */
async function buildMachineRows(
  deps: PanelDeps,
  projectRoots: string[],
  nowMs: number
): Promise<PanelMachineRow[]> {
  const env = deps.env ?? process.env;
  const clientTtl = clientTtlFrom(env);
  const runnerTtl = runnerTtlFrom(env);

  const hosts = await safeStore(() => deps.store.listHosts(), [] as HostRecord[]);
  if (hosts.length === 0) return [];

  const runnersByHost = new Map<string, RunnerRecord[]>();
  const runnerRootsByHost = new Map<string, Set<string>>();
  const pendingByProject = new Map<string, number>();
  for (const rootPath of projectRoots) {
    let runners: RunnerRecord[] = [];
    try {
      runners = await deps.store.listRunners(rootPath, 100);
    } catch {
      /* runner 读取失败不阻断主机视图 */
    }
    for (const runner of runners) {
      if (runner.hostId === null) continue;
      const bucket = runnersByHost.get(runner.hostId) ?? [];
      bucket.push(runner);
      runnersByHost.set(runner.hostId, bucket);
      const roots = runnerRootsByHost.get(runner.hostId) ?? new Set<string>();
      roots.add(rootPath);
      runnerRootsByHost.set(runner.hostId, roots);
    }
    let pending = 0;
    try {
      pending = (await deps.store.listRegressionTasks(rootPath, 200)).filter(
        (task) => task.status === "pending"
      ).length;
    } catch {
      /* ignore */
    }
    pendingByProject.set(rootPath, pending);
  }

  const observedPgByAddress = new Map<string, number>();
  const addressesByHost = new Map<string, HostAddressRecord[]>();
  const sessionsByHost = new Map<string, HostSessionRecord[]>();
  for (const host of hosts) {
    let addresses: HostAddressRecord[] = [];
    try {
      addresses = await deps.store.listHostAddresses(host.id);
    } catch {
      /* ignore */
    }
    addressesByHost.set(host.id, addresses);
    for (const entry of addresses) {
      if (entry.source !== "observed-pg") continue;
      const at = Date.parse(entry.lastSeenAt);
      if (!Number.isFinite(at) || nowMs - at > PANEL_IP_SHARED_WINDOW_MS) continue;
      observedPgByAddress.set(entry.address, (observedPgByAddress.get(entry.address) ?? 0) + 1);
    }
    let sessions: HostSessionRecord[] = [];
    try {
      sessions = await deps.store.listHostSessions(host.id, { onlineWithinMs: clientTtl, now: nowMs });
    } catch {
      /* ignore */
    }
    sessionsByHost.set(host.id, sessions);
  }

  return hosts.map((host) => {
    const drift: string[] = [];
    if (host.expectedOs !== null && host.expectedOs !== "" && host.expectedOs !== host.osPlatform) {
      drift.push(`OS 与登记不符（登记 ${host.expectedOs}，实际 ${host.osPlatform}）`);
    }
    if (
      host.expectedHostname !== null &&
      host.expectedHostname !== "" &&
      host.expectedHostname !== host.hostname
    ) {
      drift.push(`主机名与登记不符（登记 ${host.expectedHostname}，实际 ${host.hostname}）`);
    }

    const addresses = addressesByHost.get(host.id) ?? [];
    const sessions = sessionsByHost.get(host.id) ?? [];
    const runners = runnersByHost.get(host.id) ?? [];
    const runnerOnline = runners.some((runner) => isRunnerOnline(runner.lastSeenAt, nowMs, runnerTtl));

    const roots = new Set<string>(sessions.map((session) => session.rootPath));
    for (const root of runnerRootsByHost.get(host.id) ?? []) roots.add(root);
    let pendingTasks = 0;
    for (const root of roots) pendingTasks += pendingByProject.get(root) ?? 0;

    const ipShared = addresses.some(
      (entry) => entry.source === "observed-pg" && (observedPgByAddress.get(entry.address) ?? 0) > 1
    );

    return {
      id: host.id,
      label: host.label,
      hostname: host.hostname,
      kind: host.kind,
      osPlatform: host.osPlatform,
      osVersion: host.osVersion,
      arch: host.arch,
      clientOnline: isClientOnline(host.clientSeenAt, nowMs, clientTtl),
      clientSessions: sessions.length,
      runnerOnline,
      lastSeenAt: host.lastSeenAt,
      ipPrimary: host.ipPrimary,
      addresses: addresses.map((entry) => entry.address),
      capabilities: host.capabilities,
      tools: machineTools(host.env),
      queuePaused: host.queuePaused,
      pendingTasks,
      registered: host.registeredAt !== null,
      drift,
      ipChange: machineIpChange(host, addresses),
      ipShared
    };
  });
}

/** 排除名单：逗号分隔的项目名（大小写不敏感）或绝对根路径；不解析相对路径/glob。 */
export const panelProjectExcluded = projectExcluded;

export async function buildPanelOverview(deps: PanelDeps): Promise<PanelOverview> {
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const host = hostStatus(deps);
  const storeDegraded = deps.store.kind === "memory";

  const records = await safeStore(() => deps.store.listProjects(), [] as ProjectRecord[]);
  const merged = new Map<string, { record: ProjectRecord | null; name: string; rootPath: string }>();
  const registeredRoots = new Set<string>();
  for (const record of records) {
    merged.set(`${record.hostId ?? ""}\u0000${record.rootPath}`, {
      record,
      name: record.name,
      rootPath: record.rootPath
    });
    registeredRoots.add(record.rootPath);
  }
  if (deps.workspaceRoot) {
    for (const entry of listWorkspaceDirs(deps.workspaceRoot)) {
      if (!registeredRoots.has(entry.rootPath)) {
        merged.set(`\u0000${entry.rootPath}`, { record: null, name: entry.name, rootPath: entry.rootPath });
      }
    }
  }

  const excludeRaw = (deps.env ?? process.env).AOS_PANEL_EXCLUDE_PROJECTS;
  const allEntries = [...merged.values()];
  const visibleEntries = allEntries.filter((entry) => !panelProjectExcluded(entry, excludeRaw));
  const excludedProjects = allEntries.length - visibleEntries.length;
  const ordered = [...visibleEntries].sort((left, right) => {
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

  const machines = await buildMachineRows(
    deps,
    ordered.map((entry) => entry.rootPath),
    nowMs
  );

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    store: { kind: deps.store.kind, degraded: storeDegraded },
    host: { serviceRepo: host.serviceRepo, deps: host.deps.status, buildStale: host.buildStale },
    workspaceRoot: deps.workspaceRoot ?? null,
    projects,
    excludedProjects,
    machines,
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
        priority: task.priority,
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
  const ttlMs = runnerTtlFrom(deps.env ?? process.env);
  const nowMs = now();
  try {
    for (const record of await deps.store.listRunners(rootPath)) {
      runners.push(runnerView(record, nowMs, ttlMs));
    }
  } catch (error) {
    warnings.push(`执行机读取失败：${errorMessage(error)}`);
  }
  const fleet = await buildFleetView(deps, rootPath, runners, nowMs);
  warnings.push(...fleet.warnings);

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

  const reviewQueue = await buildPanelReviewQueue(deps, rootPath, { limit: 10 })
    .then((queue) => ({
      undecided: queue.items.filter((item) => item.verdict === null).length,
      unissued: queue.items.filter(
        (item) =>
          item.verdict === "app-defect" &&
          (item.jiraIssueKey === null || item.jiraIssueKey === "")
      ).length
    }))
    .catch(() => ({ undecided: 0, unissued: 0 }));

  return {
    generatedAt: new Date(now()).toISOString(),
    project: row,
    integration,
    reviewQueue,
    batches,
    trend,
    standalones,
    regressionRefs,
    tasks: taskRows,
    runners,
    fleet,
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

/** 回归任务详情（DESIGN：回归服务 §5.4 屏 B）：引用解析 + 设备运行 + 跨端差异；
 * 产物路径仅展示（P1 不内联预览）。未知 task → null。 */
/** 任务页的 UI 汇总来自批次清单；远端执行机的清单在本机不可读时如实留空。 */
function taskRunUi(rootPath: string, manifestPath: string | null): UiSummary | null {
  if (manifestPath === null) return null;
  const abs = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(rootPath, manifestPath);
  const read = loadRunManifest(rootPath, abs);
  return read.kind === "ok" ? (read.manifest.summary.ui ?? null) : null;
}

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
    ui: taskRunUi(rootPath, run.manifestPath),
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
        jiraIssueKey: entry.jiraIssueKey ?? null,
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

  let usageEvents: Awaited<ReturnType<ProjectStore["listUsageEvents"]>> = [];
  try {
    const nowMs = (deps.now ?? (() => Date.now()))();
    usageEvents = await deps.store.listUsageEvents(rootPath, {
      since: new Date(nowMs - 7 * 24 * 3600_000).toISOString(),
      limit: 10_000
    });
  } catch (error) {
    warnings.push(`调用统计读取失败：${errorMessage(error)}`);
  }
  const usage = buildPanelUsageCostView(usageEvents, 7);

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

  return { stats, usage, improvement, guidance, warnings };
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

function batchReadiness(cases: PanelBatchCaseView[]): IntegrationReadiness {
  return integrationReadinessFromFailures(
    cases
      .filter((entry) => entry.status !== "passed")
      .map((entry) => ({
        caseId: entry.caseId,
        traceId: entry.traceId,
        domain: entry.failure?.domain ?? null,
        reason: [entry.failure?.reason, entry.error]
          .filter((part): part is string => typeof part === "string" && part.trim() !== "")
          .join(" ")
      }))
  );
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
    ui: null,
    uiCoverage: null,
    failureDomains: null,
    options: null,
    tests: null,
    designWarnings: null,
    apiReview: null,
    cases: [],
    readiness: { needed: false, checks: [] },
    warnings: []
  };
}

function batchDetailFromLedger(
  file: string,
  run: SuiteRunRecord,
  read: "missing" | "invalid",
  note: string
): PanelBatchDetail {
  const gateResult =
    run.gateResult === "pass" || run.gateResult === "fail"
      ? run.gateResult
      : run.exitCode === 0
        ? "pass"
        : "fail";
  const cases: PanelBatchCaseView[] = run.cases.map((entry) => ({
    caseId: entry.caseId,
    name: entry.name,
    status: entry.status,
    traceId: entry.traceId,
    error: null,
    failure:
      entry.failureDomain === null
        ? null
        : {
            domain: entry.failureDomain,
            confidence: entry.failureConfidence ?? "unknown",
            reason: entry.failureReason ?? ""
          },
    scriptProvenance: null,
    ui: null,
    quarantined: entry.quarantined,
    flaky: entry.flaky,
    evidence: []
  }));
  return {
    file,
    read,
    note,
    runId: run.runId ?? run.id,
    source: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    taxonomyVersion: null,
    gate: { result: gateResult, exitCode: run.exitCode, reasons: [] },
    summary: { total: run.total, passed: run.passed, failed: run.failed },
    ui: null,
    uiCoverage: null,
    failureDomains: run.failureDomains,
    options: null,
    tests: null,
    designWarnings: null,
    apiReview: run.apiReview ?? null,
    cases,
    readiness: batchReadiness(cases),
    warnings: [note]
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
  const ledger = await safeStore(
    () => deps.store.getSuiteRunByManifestPath(rootPath, read.file),
    null as SuiteRunRecord | null
  );
  if (read.kind === "missing") {
    return ledger === null
      ? emptyBatchDetail(file, "missing", "清单已清理或不可读")
      : batchDetailFromLedger(file, ledger, "missing", "批次清单已清理或不可读；以下为台账记录");
  }
  if (read.kind === "invalid") {
    return ledger === null
      ? emptyBatchDetail(file, "invalid", `清单不可读：${read.reason}`)
      : batchDetailFromLedger(file, ledger, "invalid", `清单不可读（${read.reason}）；以下为台账记录`);
  }
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
      ui: null,
      uiCoverage: null,
      failureDomains: null,
      options: null,
      tests: null,
      designWarnings: null,
      apiReview: ledger?.apiReview ?? null,
      cases: [],
      readiness: { needed: false, checks: [] },
      warnings: []
    };
  }

  const manifest = read.manifest;
  const tracesDir = projectTracesDir(soft.project.config, rootPath, deps.env ?? process.env);
  const cases: PanelBatchCaseView[] = manifest.cases.map((entry) => ({
    caseId: entry.caseId,
    name: entry.name,
    status: entry.status,
    traceId: entry.traceId,
    error: entry.error,
    failure: entry.failure,
    scriptProvenance: entry.scriptProvenance,
    ui: entry.ui ?? null,
    quarantined: entry.quarantined,
    flaky: entry.retry?.flaky === true,
    evidence: evidenceLinks(tracesDir, rootPath, entry)
  }));
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
    ui: manifest.summary.ui ?? null,
    uiCoverage: manifest.summary.uiCoverage ?? null,
    failureDomains: manifest.failureDomains,
    options: manifest.options,
    tests: manifest.tests,
    designWarnings: manifest.designWarnings ?? null,
    apiReview: ledger?.apiReview ?? manifest.apiReview ?? null,
    cases,
    readiness: batchReadiness(cases),
    warnings: []
  };
}
