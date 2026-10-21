export interface ProjectRecord {
  id: string;
  hostId: string | null;
  rootPath: string;
  name: string;
  figmaToken: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** 未绑定 host 的 store 按 root_path 查询命中多行（跨主机同路径）时的歧义错误。 */
export class AmbiguousProjectError extends Error {
  readonly rootPath: string;
  readonly candidates: ProjectRecord[];
  constructor(rootPath: string, candidates: ProjectRecord[]) {
    super(`项目路径跨主机重复：${rootPath}（${candidates.length} 行）`);
    this.name = "AmbiguousProjectError";
    this.rootPath = rootPath;
    this.candidates = candidates;
  }
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

export type UsageEventFamily =
  | "native"
  | "figma"
  | "pen"
  | "jira"
  | "mobile"
  | "workflow"
  | "unknown";

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
  hostId: string | null;
  sessionId: string | null;
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
  hostId?: string | null;
  sessionId?: string | null;
  at?: string;
}

export interface UsageEventQuery {
  tool?: string;
  status?: "ok" | "error";
  since?: string;
  until?: string;
  limit?: number;
}

export interface LegacyLedgerImportCounts {
  found: number;
  existing: number;
  inserted: number;
}

export interface LegacyLedgerImportResult {
  usage: LegacyLedgerImportCounts;
  regressionTasks: LegacyLedgerImportCounts;
}

export interface UsagePrunePolicy {
  retentionDays?: number;
  maxEvents?: number;
}

export interface ProjectEventInput {
  eventId: string;
  type: string;
  source?: string;
  at?: string;
  runId?: string | null;
  caseId?: string | null;
  step?: number | null;
  status?: string | null;
  payload?: unknown;
}

export interface ProjectEventRecord {
  seq: number;
  id: string;
  projectId: string;
  hostId: string | null;
  eventId: string;
  type: string;
  source: string;
  runId: string | null;
  caseId: string | null;
  step: number | null;
  status: string | null;
  at: string;
  receivedAt: string;
  payload: unknown;
  payloadSha256: string;
  payloadBytes: number;
  consumedAt: string | null;
}

export interface RecordProjectEventResult {
  record: ProjectEventRecord;
  duplicate: boolean;
  payloadMismatch: boolean;
}

export interface ProjectEventQuery {
  runId?: string;
  caseId?: string;
  type?: string;
  status?: string;
  since?: string;
  /** 无丢失游标：只返回 seq 严格大于该值的事件（P1）。 */
  afterSeq?: number;
  /** P1 消费态过滤：true=已消费，false=未消费。 */
  consumed?: boolean;
  order?: "asc" | "desc";
  limit?: number;
  includePayload?: boolean;
}

export interface AuditEventInput {
  domain: string;
  action: string;
  result: "ok" | "skipped" | "failed";
  /** 已由调用方脱敏；超 300 字符截断。 */
  summary: string;
  refs?: Record<string, string | undefined>;
  /** 操作人（面板固定 `panel`；CLI/MCP 取 `AOS_ACTOR` 或系统用户名）。 */
  actor?: string | null;
  /** 操作发起宿主；本机未绑定主机时为 null。 */
  actorHostId?: string | null;
  /** 调用通道：`panel` / `cli` / `mcp` / `runner`。 */
  channel?: string | null;
  /** 显式时间（测试/导入）；缺省＝当前时间。 */
  at?: string;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  rootPath: string;
  at: string;
  refs: Record<string, string | undefined>;
}

export interface AuditQuery {
  domain?: string;
  result?: AuditEventInput["result"];
  since?: string;
  limit?: number;
  /** 分页偏移（配合 limit；审计页翻页用）。 */
  offset?: number;
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

export type CancelSource = "panel" | "local-cli" | "local-mcp" | "runner" | "admin";

export type RegressionTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "stopping"
  | "stopped"
  | "cancelled"
  | "completed"
  | "partial"
  | "failed";

export interface RegressionTaskRecord {
  id: string;
  projectId: string | null;
  createdAt: string;
  createdBy: string | null;
  refs: RegressionTaskRef[];
  platforms: string[];
  baseline: "latest" | "none";
  status: RegressionTaskStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  attempts: number;
  runIds: string[];
  targetHostId: string | null;
  createdHostId: string | null;
  claimedHostId: string | null;
  claimedInstanceId: string | null;
  priority: number;
  lastProgressAt: string | null;
  startedAt: string | null;
  cancelSource: CancelSource | null;
  cancelledBy: string | null;
  cancelledHostId: string | null;
  cancelledAt: string | null;
  cancelNote: string | null;
  cancelRequestedAt: string | null;
}

/** 旧 `stopped` 行对外统一读作 `cancelled`（`cancelSource=panel` 仅作历史来源标注）。 */
export function normalizeRegressionTask(record: RegressionTaskRecord): RegressionTaskRecord {
  const legacy = record.status === "stopped";
  return {
    ...record,
    status: legacy ? "cancelled" : record.status,
    cancelSource: record.cancelSource ?? (legacy ? "panel" : null),
    cancelledBy: record.cancelledBy ?? null,
    cancelledHostId: record.cancelledHostId ?? null,
    cancelledAt: record.cancelledAt ?? (legacy ? (record.startedAt ?? null) : null),
    cancelNote: record.cancelNote ?? (legacy ? "legacy stopped" : null),
    cancelRequestedAt: record.cancelRequestedAt ?? null
  };
}

/** 能力门禁（fail-closed）：任务平台 ⊆ 本机能力（`ios` 需 `ios-simulator`/`ios-real` 之一；`android` 需 `android`）。
 * `capabilities` 缺失（历史调用方）按空集处理——任何 `ios`/`android` 任务都不通过。 */
export function capabilitiesSatisfyPlatforms(capabilities: string[], platforms: string[]): boolean {
  const has = new Set(capabilities);
  return platforms.every((platform) => {
    if (platform === "ios") return has.has("ios-simulator") || has.has("ios-real");
    if (platform === "android") return has.has("android");
    return true;
  });
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
  hostId: string | null;
  instanceId: string | null;
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
  hostId?: string | null;
  instanceId?: string | null;
  /** 双启保护的活跃窗口（默认 90s，与 runner 心跳 TTL 对齐）。 */
  activeWithinMs?: number;
}

/** runner 双启保护活跃窗口默认值。 */
export const RUNNER_ACTIVE_DEFAULT_MS = 90_000;

/** lastSeenAt 距 nowMs 仍在活跃窗口内（非法时间视为陈旧，允许接管）。 */
export function isRunnerActive(lastSeenAt: string, nowMs: number, activeWithinMs: number): boolean {
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen <= activeWithinMs;
}

/** 同 host+project 已有活跃实例在心跳时，第二个进程接管被拒（双启保护）。 */
export class RunnerAlreadyActiveError extends Error {
  readonly projectId: string;
  readonly hostId: string | null;
  readonly existingInstanceId: string | null;
  readonly incomingInstanceId: string | null;
  constructor(input: {
    projectId: string;
    hostId: string | null;
    existingInstanceId: string | null;
    incomingInstanceId: string | null;
  }) {
    super(
      `runner 已在该主机活跃（host=${input.hostId ?? "<null>"}，已有实例 ${input.existingInstanceId ?? "<null>"}，拒绝 ${input.incomingInstanceId ?? "<null>"} 接管）`
    );
    this.name = "RunnerAlreadyActiveError";
    this.projectId = input.projectId;
    this.hostId = input.hostId;
    this.existingInstanceId = input.existingInstanceId;
    this.incomingInstanceId = input.incomingInstanceId;
  }
}

export type HostAddressSource = "self" | "observed-pg" | "observed-http";
export type HostAddressFamily = "ipv4" | "ipv6";

export interface HostAddressInput {
  source: HostAddressSource;
  iface: string;
  family: HostAddressFamily;
  address: string;
}

export interface HostAddressRecord {
  hostId: string;
  source: string;
  iface: string;
  family: string;
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface HostRecord {
  id: string;
  hardwareId: string | null;
  hostname: string;
  username: string | null;
  osPlatform: string;
  osVersion: string | null;
  arch: string | null;
  identitySource: string;
  kind: string;
  capabilities: string[];
  env: Record<string, unknown>;
  envAt: string | null;
  ipPrimary: string | null;
  label: string | null;
  owner: string | null;
  expectedOs: string | null;
  expectedHostname: string | null;
  registeredAt: string | null;
  registeredBy: string | null;
  clientSeenAt: string | null;
  runnerSeenAt: string | null;
  lastSeenAt: string;
  queuePaused: boolean;
  queuePausedAt: string | null;
  queuePausedBy: string | null;
  firstSeenAt: string;
  createdAt: string;
}

export interface UpsertHostInput {
  id: string;
  hostname?: string;
  hardwareId?: string | null;
  username?: string | null;
  osPlatform?: string;
  osVersion?: string | null;
  arch?: string | null;
  identitySource?: string;
  kind?: string;
  capabilities?: string[];
  env?: Record<string, unknown>;
  envAt?: string | null;
  ipPrimary?: string | null;
  clientSeenAt?: string | null;
  runnerSeenAt?: string | null;
  firstSeenAt?: string | null;
  createdAt?: string | null;
}

export interface HostSessionRecord {
  id: string;
  hostId: string;
  projectId: string | null;
  rootPath: string;
  username: string | null;
  client: string | null;
  clientVersion: string | null;
  pid: number | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
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
  /** 批次清单 runId（`run-<stamp>-<suffix>`）；用于项目事件回写。 */
  runId: string | null;
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
  targetHostId?: string | null;
  priority?: number;
  createdHostId?: string | null;
}

/** Project-scoped persistence for LLM associations, Figma token, and task stats. */
export interface ProjectStore {
  readonly kind: "postgres" | "file" | "memory";
  /** 绑定到本机 host（若无显式 hostId，写入/查询都以它作用域）；未绑定＝legacy NULL。 */
  readonly localHostId: string | null;
  /** 就地绑定本 store 到 host（下一个写入/查询生效；对同一实例生效）。 */
  bindHost(hostId: string): void;
  /** 返回共享同一底层存储但绑定到 hostId 的新视图（不改动父 store 的 hostId）。 */
  scopeHost(hostId: string): ProjectStore;
  /** `updateName: false` keeps an existing display name (used by incidental
   * records such as model-cache writes that only know the directory basename). */
  upsertProject(input: {
    rootPath: string;
    name: string;
    hostId?: string | null;
    updateName?: boolean;
  }): Promise<ProjectRecord>;
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
  /** 返回 createdAt 新→旧；`limit` 缺省＝全量（**口径：正确性/触发路径按全量读取，展示路径显式分页**）。 */
  listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]>;
  createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord>;
  getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null>;
  listRegressionTasks(rootPath: string, limit?: number): Promise<RegressionTaskRecord[]>;
  /** 取消任务（先写先赢）：`pending` → `cancelled`（同时写 `cancelledAt`）；`claimed`/`running` →
   * `stopping`（只写请求时间，等执行机 `ackCancellation`）；`stopping`/`cancelled`/终态保持原状。
   * 未知任务 → null。 */
  cancelRegressionTask(input: {
    rootPath: string;
    taskId: string;
    source: CancelSource;
    actor: string;
    actorHostId: string | null;
    note?: string | null;
    at?: string;
  }): Promise<RegressionTaskRecord | null>;
  /** 执行机确认停止请求：`stopping` → `cancelled`（保留取消元数据，补 `cancelledAt`；幂等）。 */
  ackCancellation(input: {
    rootPath: string;
    taskId: string;
    at?: string;
  }): Promise<RegressionTaskRecord | null>;
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
   * （仅当无他者在线 runner 完全覆盖该任务端时）；否则严格旧行为。
   * 定向任务仅目标主机可领（`targetHostId`）；`capabilities` 再做 OS/工具门禁（fail-closed）。 */
  claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
    hostId?: string;
    instanceId?: string;
    capabilities: string[];
  }): Promise<RegressionTaskRecord | null>;
  /** 领取 → 执行开始：`claimed` 且 `claimed_by`/`claimed_instance_id` 相符才 CAS 置 `running`、`attempts+1`、写 `started_at`；失败 → null。 */
  beginExecution(input: {
    rootPath: string;
    taskId: string;
    runnerId: string;
    instanceId: string;
    at?: string;
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
  /** 项目事件回写（P2）：按批次清单 runId 更新终态；未命中 → false。 */
  markSuiteRunFinishedByRunId(
    rootPath: string,
    runId: string,
    status: "completed" | "failed"
  ): Promise<boolean>;
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
  upsertHost(input: UpsertHostInput): Promise<HostRecord>;
  getHost(id: string): Promise<HostRecord | null>;
  listHosts(): Promise<HostRecord[]>;
  updateHostRegistration(input: {
    id: string;
    label?: string | null;
    owner?: string | null;
    expectedOs?: string | null;
    expectedHostname?: string | null;
    registeredBy: string;
  }): Promise<HostRecord | null>;
  upsertHostAddresses(input: {
    hostId: string;
    addresses: HostAddressInput[];
    at?: string;
    maxPerSource?: number;
  }): Promise<void>;
  listHostAddresses(hostId: string): Promise<HostAddressRecord[]>;
  touchHostSession(input: {
    id: string;
    hostId: string;
    projectId: string | null;
    rootPath: string;
    username: string | null;
    client: string | null;
    clientVersion: string | null;
    pid: number | null;
    at?: string;
  }): Promise<HostSessionRecord>;
  endHostSession(id: string, at?: string): Promise<boolean>;
  listHostSessions(
    hostId: string,
    options?: { limit?: number; onlineWithinMs?: number; now?: number }
  ): Promise<HostSessionRecord[]>;
  setHostQueuePaused(input: {
    hostId: string;
    paused: boolean;
    by: string;
    at?: string;
  }): Promise<HostRecord | null>;
  recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy?: UsagePrunePolicy
  ): Promise<UsageEventRecord>;
  /** P1 历史文件台账迁移（仅中心 PG 实现；保留原 id 幂等插入）。 */
  importLegacyLedger?(
    rootPath: string,
    input: { usage: UsageEventRecord[]; regressionTasks: RegressionTaskRecord[] },
    dryRun?: boolean
  ): Promise<LegacyLedgerImportResult>;
  recordProjectEvent(rootPath: string, input: ProjectEventInput): Promise<RecordProjectEventResult>;
  listProjectEvents(rootPath: string, query?: ProjectEventQuery): Promise<ProjectEventRecord[]>;
  markProjectEventsConsumed(
    rootPath: string,
    eventIds: string[],
    consumedAt?: string
  ): Promise<number>;
  countProjectEvents(rootPath: string): Promise<number>;
  pruneProjectEvents(rootPath: string): Promise<number>;
  listUsageEvents(rootPath: string, query?: UsageEventQuery): Promise<UsageEventRecord[]>;
  recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord>;
  /** 新→旧（at DESC, id DESC）；`limit` 缺省＝200。 */
  listAudit(rootPath: string, query?: AuditQuery): Promise<AuditEventRecord[]>;
  listProjects(): Promise<ProjectRecord[]>;
  /** 把 legacy（host_id 为空）项目行认领到 hostId；目标 host 已有同路径行时不重复创建（返回 false）。 */
  adoptProjectHost(input: { projectId: string; hostId: string }): Promise<boolean>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "orphaned"] as const;
