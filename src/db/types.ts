export interface ProjectRecord {
  id: string;
  rootPath: string;
  name: string;
  figmaToken: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface ProjectLlmRecord {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  baseUrl: string | null;
  model: string;
  apiKey: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStatRecord {
  id: string;
  projectId: string | null;
  traceId: string;
  caseId: string | null;
  model: string | null;
  profile: string | null;
  status: string;
  taskDesc: string | null;
  submittedAt: string;
  finishedAt: string | null;
}

export type UsageEventFamily = "native" | "figma" | "pen" | "jira" | "mobile" | "unknown";

export type UsageErrorClass =
  | "validation"
  | "figma"
  | "artemis"
  | "timeout"
  | "internal"
  | "unknown";

export interface UsageSignal {
  code: string;
  field?: string;
}

export interface UsageEventRecord {
  id: string;
  projectId: string | null;
  at: string;
  tool: string;
  family: UsageEventFamily;
  ok: boolean;
  durationMs: number;
  errorClass: UsageErrorClass | null;
  errorSummary: string | null;
  signals: UsageSignal[];
  argKeys: string[];
  traceId: string | null;
}

export interface RecordUsageEventInput {
  tool: string;
  family: UsageEventFamily;
  ok: boolean;
  durationMs: number;
  errorClass?: UsageErrorClass | null;
  errorSummary?: string | null;
  signals?: UsageSignal[];
  argKeys?: string[];
  traceId?: string | null;
  at?: string;
}

export interface UsageEventQuery {
  tool?: string;
  status?: "ok" | "error";
  since?: string;
  until?: string;
  limit?: number;
}

export interface UsagePrunePolicy {
  retentionDays?: number;
  maxEvents?: number;
}

export interface ModelCacheRecord {
  id: string;
  projectId: string;
  cacheKey: string;
  baseUrl: string;
  models: string[];
  fetchedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface PutModelCacheInput {
  cacheKey: string;
  baseUrl: string;
  /** Undefined keeps the stored list untouched (used for error-only updates). */
  models?: string[];
  fetchedAt?: string | null;
  lastError?: string | null;
}

export interface UpsertLlmInput {
  name: string;
  provider?: string;
  baseUrl?: string | null;
  model: string;
  apiKey?: string | null;
  makeActive?: boolean;
}

export interface RecordTaskInput {
  rootPath: string;
  traceId: string;
  model?: string | null;
  profile?: string | null;
  status: string;
  taskDesc?: string | null;
  caseId?: string | null;
  finishedAt?: string | null;
}

export interface CaseSetFeatureRecord {
  key: string;
  name: string;
  caseCount: number;
  screens: string[];
  jsonPath: string;
  mdPath: string;
  xlsxPath: string;
}

export interface CaseSetRecord {
  id: string;
  projectId: string | null;
  createdAt: string;
  source: string;
  designName: string | null;
  fingerprint: string | null;
  basename: string;
  features: CaseSetFeatureRecord[];
}

export interface RecordCaseSetInput {
  rootPath: string;
  source: string;
  designName?: string | null;
  fingerprint?: string | null;
  basename: string;
  createdAt?: string;
  features: CaseSetFeatureRecord[];
}

export interface RegressionTaskRef {
  caseSetId: string;
  featureKey: string;
}

export interface RegressionTaskRecord {
  id: string;
  projectId: string | null;
  createdAt: string;
  createdBy: string | null;
  refs: RegressionTaskRef[];
  platforms: string[];
  baseline: "latest" | "none";
  status: "pending" | "claimed" | "running" | "completed" | "partial" | "failed";
  claimedBy: string | null;
  claimedAt: string | null;
  attempts: number;
  runIds: string[];
}

export interface RunnerDevice {
  serial: string;
  name: string;
  platform: "ios" | "android";
  kind: "device" | "emulator" | "simulator";
  state: string;
}

export interface RunnerTools {
  adb: boolean;
  idb: boolean;
  simctl: boolean;
  ideviceId: boolean;
  appium: boolean;
}

export interface RunnerRecord {
  id: string;
  projectId: string | null;
  name: string;
  hostname: string;
  platforms: string[];
  devices: RunnerDevice[];
  tools: RunnerTools;
  artifactBaseUrl: string | null;
  version: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface UpsertRunnerInput {
  rootPath: string;
  name: string;
  hostname: string;
  platforms: string[];
  devices: RunnerDevice[];
  tools: RunnerTools;
  artifactBaseUrl?: string | null;
  version?: string | null;
}

export interface ScheduleRecord {
  id: string;
  projectId: string | null;
  name: string;
  featureKeys: string[];
  platforms: string[];
  baseline: "latest" | "none";
  everyMinutes: number;
  enabled: boolean;
  lastFiredAt: string | null;
  lastNote: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface CreateScheduleInput {
  rootPath: string;
  name: string;
  featureKeys: string[];
  platforms: string[];
  baseline: "latest" | "none";
  everyMinutes: number;
  createdBy?: string | null;
}

export interface SuiteRunCaseRecord {
  caseId: string;
  name: string;
  featureKey: string | null;
  platform: string;
  status: string;
  traceId: string | null;
  failureDomain: string | null;
  failureConfidence: string | null;
  failureReason: string | null;
  durationMs: number | null;
  quarantined: boolean;
  flaky: boolean;
  verdict: string | null;
  verdictBy: string | null;
  verdictAt: string | null;
  verdictNote: string | null;
  jiraIssueKey: string | null;
}

export interface SuiteRunRecord {
  id: string;
  projectId: string | null;
  createdAt: string;
  trigger: string;
  regressionTaskId: string | null;
  caseSetId: string | null;
  featureKey: string | null;
  featureName: string | null;
  platform: string;
  device: string | null;
  appVersion: string | null;
  runner: string | null;
  status: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  quarantined: number;
  failureDomains: Record<string, number>;
  gateResult: string | null;
  exitCode: number;
  manifestPath: string | null;
  comparison: unknown;
  cases: SuiteRunCaseRecord[];
}

export interface RecordSuiteRunInput {
  rootPath: string;
  run: Omit<SuiteRunRecord, "id" | "projectId" | "cases" | "createdAt">;
  cases: SuiteRunCaseRecord[];
  createdAt?: string;
}

export type CaseVerdict = "case-defect" | "execution-deviation" | "app-defect" | "uncertain";

export interface UpdateCaseVerdictInput {
  rootPath: string;
  runId: string;
  caseId: string;
  verdict: CaseVerdict;
  verdictBy?: string | null;
  verdictNote?: string | null;
}

export interface SetCaseIssueKeyInput {
  rootPath: string;
  runId: string;
  caseId: string;
  jiraKey: string | null;
}

export interface CreateRegressionTaskInput {
  rootPath: string;
  refs: RegressionTaskRef[];
  platforms: string[];
  baseline: "latest" | "none";
  createdBy?: string | null;
}

/** Project-scoped persistence for LLM associations, Figma token, and task stats. */
export interface ProjectStore {
  readonly kind: "postgres" | "memory";
  upsertProject(input: { rootPath: string; name: string }): Promise<ProjectRecord>;
  getProjectByPath(rootPath: string): Promise<ProjectRecord | null>;
  setFigmaToken(rootPath: string, token: string | null): Promise<void>;
  listLlms(rootPath: string): Promise<ProjectLlmRecord[]>;
  upsertLlm(rootPath: string, input: UpsertLlmInput): Promise<ProjectLlmRecord>;
  setActiveLlm(rootPath: string, name: string): Promise<boolean>;
  getModelCache(rootPath: string, cacheKey: string): Promise<ModelCacheRecord | null>;
  putModelCache(rootPath: string, input: PutModelCacheInput): Promise<ModelCacheRecord>;
  recordTask(input: RecordTaskInput): Promise<void>;
  listTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]>;
  listPendingTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]>;
  markTaskFinished(rootPath: string, traceId: string, status: string): Promise<boolean>;
  recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord>;
  /** 返回 createdAt 新→旧；`limit` 缺省＝全量（触发解析用；展示/交互路径显式传分页值）。 */
  listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]>;
  createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord>;
  getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null>;
  listRegressionTasks(rootPath: string, limit?: number): Promise<RegressionTaskRecord[]>;
  updateRegressionTask(
    rootPath: string,
    id: string,
    patch: {
      status?: RegressionTaskRecord["status"];
      runIds?: string[];
      claimedBy?: string | null;
      claimedAt?: string | null;
    }
  ): Promise<boolean>;
  /** 原子领取：任务端 ⊆ runner 端且 status='pending' 的最旧任务 → claimed（竞争失败 → null）。
   * `allowPartial === true && onlineBefore 提供` 时，无完全覆盖候选则按交集≥1 部分领取
   * （仅当无他者在线 runner 完全覆盖该任务端时）；否则严格旧行为。 */
  claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
  }): Promise<RegressionTaskRecord | null>;
  /** 释放本 runner 的全部未完成领取（claimed/running）→ pending；返回条数。 */
  releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number>;
  /** 单任务释放（执行异常救济；守卫 claimed_by 与状态，已终态不覆盖）。
   * `to:"failed"`＝达重试上限时直接置 failed；`runnerId:null`＝仅命中 claimed_by 为空的数据异常行（强制救济）。 */
  releaseRegressionTask(input: {
    rootPath: string;
    runnerId: string | null;
    taskId: string;
    to?: "pending" | "failed";
  }): Promise<boolean>;
  /** 失联领取回收：claimed/running 且 claimed_at 超龄、且（claimed_by 为空或指向的 runner 已离线）→ pending；返回回收条数。 */
  releaseStaleClaims(input: {
    rootPath: string;
    offlineBefore: string;
    claimedBefore: string;
  }): Promise<number>;
  createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord>;
  /** 返回 createdAt 新→旧；`limit` 缺省＝全量（firing 用；面板/CLI 显式传分页值）。 */
  listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]>;
  getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null>;
  updateSchedule(
    rootPath: string,
    id: string,
    patch: { enabled?: boolean; everyMinutes?: number; lastNote?: string | null }
  ): Promise<boolean>;
  deleteSchedule(rootPath: string, id: string): Promise<boolean>;
  /** 窗口 CAS：仅当 enabled 且（从未触发或 last_fired_at <= cutoff）时推进 last_fired_at=firedAt。 */
  claimScheduleWindow(input: {
    rootPath: string;
    scheduleId: string;
    firedAt: string;
    cutoff: string;
  }): Promise<boolean>;
  recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord>;
  /** 返回按 createdAt 新→旧（内存与 PG 实现均保证；调用方可依赖该序取「最新」）。 */
  listSuiteRuns(
    rootPath: string,
    query?: {
      taskId?: string;
      caseSetId?: string;
      featureKey?: string;
      platform?: string;
      limit?: number;
    }
  ): Promise<SuiteRunRecord[]>;
  updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean>;
  setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean>;
  getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null>;
  /** 已登记清单路径（仅非 null）；未注册项目 → []。 */
  listRegisteredManifestPaths(rootPath: string): Promise<string[]>;
  /** 最早登记时间：suite_runs 与 case_sets 各自的 MIN(created_at)；无行/未注册项目 → null。 */
  getEarliestRegistrationCreatedAt(
    rootPath: string
  ): Promise<{ runs: string | null; caseSets: string | null }>;
  upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord>;
  listRunners(rootPath: string, limit?: number): Promise<RunnerRecord[]>;
  recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy?: UsagePrunePolicy
  ): Promise<UsageEventRecord>;
  listUsageEvents(rootPath: string, query?: UsageEventQuery): Promise<UsageEventRecord[]>;
  listProjects(): Promise<ProjectRecord[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "orphaned"] as const;
