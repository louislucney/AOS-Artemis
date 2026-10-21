import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveProject } from "../config/loader.js";
import { errorMessage, log, writeFileAtomic } from "../util.js";
import { MemoryStore, type MemoryStoreState } from "./memory.js";
import { hydrateProjectLedger } from "./hydrate.js";
import { retentionCutoffIso } from "./usage-event.js";
import { normalizeSince, payloadBytes, payloadHash } from "../events/payload.js";
import { eventCutoffIso, eventRetentionPolicy } from "../events/retention.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditQuery,
  CaseSetRecord,
  CreateRegressionTaskInput,
  CreateScheduleInput,
  HostAddressInput,
  HostAddressRecord,
  HostRecord,
  HostSessionRecord,
  ModelCacheRecord,
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  ProjectEventInput,
  ProjectEventQuery,
  ProjectEventRecord,
  RecordProjectEventResult,
  PutModelCacheInput,
  RecordCaseSetInput,
  RecordSuiteRunInput,
  RecordTaskInput,
  RecordUsageEventInput,
  RegressionTaskRecord,
  RunnerRecord,
  ScheduleRecord,
  SetCaseIssueKeyInput,
  SuiteRunRecord,
  TaskStatRecord,
  UpdateCaseVerdictInput,
  UpsertHostInput,
  UpsertLlmInput,
  UpsertRunnerInput,
  UsageEventQuery,
  UsageEventRecord,
  UsagePrunePolicy
} from "./types.js";

export interface FileStoreOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface RegistryEntry {
  rootPath: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectBucket {
  rootPath: string;
  dir: string;
  statePath: string;
  usagePath: string;
  auditPath: string;
  journalPath: string;
  eventsPath: string;
  eventsMetaPath: string;
  events: Map<string, ProjectEventRecord>;
  eventsLoaded: boolean;
  eventsLoad?: Promise<void>;
  eventQueue: Promise<unknown>;
  nextSeq: number;
  lastEventPruneAt: number;
  mem: MemoryStore;
  loaded: boolean;
  seenStateMtimeMs: number | null;
  seenUsageMtimeMs: number | null;
  seenAuditMtimeMs: number | null;
}

const LEDGER_DIR_SEGMENTS = [".artemis", "ledger"] as const;
const AUDIT_RETENTION_DAYS_DEFAULT = 90;
const AUDIT_MAX_EVENTS_DEFAULT = 50000;
const JOURNAL_MAX_LINES = 2000;

export function resolveLedgerHome(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const explicit = (env.AOS_LEDGER_DIR ?? "").trim();
  if (explicit !== "") return path.resolve(explicit);
  try {
    const project = resolveProject({ env, cwd });
    if (project.configPath !== null || (env.AOS_PROJECT_DIR ?? "").trim() !== "") {
      return path.join(project.rootDir, ...LEDGER_DIR_SEGMENTS);
    }
  } catch {
    /* fall through to home */
  }
  return path.join(homedir(), ".aos", "ledger");
}

export class FileStore implements ProjectStore {
  readonly kind = "file" as const;

  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly eventsFsync: boolean;
  private buckets = new Map<string, ProjectBucket>();
  private registry = new Map<string, RegistryEntry>();
  private hostMem = new MemoryStore();
  private hostId: string | null;
  private failedWrites = 0;
  private lastWriteError: string | null = null;

  private constructor(homeDir: string, env: NodeJS.ProcessEnv, hostId: string | null = null) {
    this.homeDir = homeDir;
    this.env = env;
    this.eventsFsync = (env.AOS_EVENTS_FSYNC ?? "").trim() === "1";
    this.hostId = hostId;
  }

  static async create(options: FileStoreOptions = {}): Promise<FileStore> {
    const env = options.env ?? process.env;
    const homeDir = path.resolve(options.homeDir ?? resolveLedgerHome(env));
    await mkdir(homeDir, { recursive: true });
    await assertWritable(homeDir);
    const store = new FileStore(homeDir, env);
    await store.loadRegistry();
    return store;
  }

  get localHostId(): string | null {
    return this.hostId;
  }

  bindHost(hostId: string): void {
    this.hostId = hostId;
  }

  scopeHost(hostId: string): ProjectStore {
    const view = new FileStore(this.homeDir, this.env, hostId);
    view.buckets = this.buckets;
    view.registry = this.registry;
    view.hostMem = this.hostMem;
    return view;
  }

  private scopedMem(bucket: ProjectBucket, hostId: string | null): MemoryStore {
    return hostId === null ? bucket.mem : (bucket.mem.scopeHost(hostId) as MemoryStore);
  }

  async upsertProject(input: {
    rootPath: string;
    name: string;
    hostId?: string | null;
    updateName?: boolean;
  }): Promise<ProjectRecord> {
    const bucket = await this.bucket(input.rootPath);
    const hostId = input.hostId !== undefined ? input.hostId : this.hostId;
    const record = await this.scopedMem(bucket, hostId).upsertProject(input);
    const existing = this.registry.get(input.rootPath);
    const now = new Date().toISOString();
    const entry: RegistryEntry = {
      rootPath: input.rootPath,
      name: input.updateName === false && existing ? existing.name : input.name,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: now
    };
    this.registry.set(input.rootPath, entry);
    await this.appendRegistry(entry);
    await this.persist(bucket, "upsertProject");
    return record;
  }

  async getProjectByPath(rootPath: string): Promise<ProjectRecord | null> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
  }

  async setFigmaToken(rootPath: string, token: string | null): Promise<void> {
    const bucket = await this.bucket(rootPath);
    await this.scopedMem(bucket, this.hostId).setFigmaToken(rootPath, token);
    await this.persist(bucket, "setFigmaToken");
  }

  async listLlms(rootPath: string): Promise<ProjectLlmRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listLlms(rootPath);
  }

  async upsertLlm(rootPath: string, input: UpsertLlmInput): Promise<ProjectLlmRecord> {
    const bucket = await this.bucket(rootPath);
    const record = await this.scopedMem(bucket, this.hostId).upsertLlm(rootPath, input);
    await this.persist(bucket, "upsertLlm");
    return record;
  }

  async setActiveLlm(rootPath: string, name: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).setActiveLlm(rootPath, name);
    if (updated) await this.persist(bucket, "setActiveLlm");
    return updated;
  }

  async getModelCache(rootPath: string, cacheKey: string): Promise<ModelCacheRecord | null> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getModelCache(rootPath, cacheKey);
  }

  async putModelCache(rootPath: string, input: PutModelCacheInput): Promise<ModelCacheRecord> {
    const bucket = await this.bucket(rootPath);
    const record = await this.scopedMem(bucket, this.hostId).putModelCache(rootPath, input);
    await this.persist(bucket, "putModelCache");
    return record;
  }

  async recordTask(input: RecordTaskInput): Promise<void> {
    const bucket = await this.bucket(input.rootPath);
    await this.scopedMem(bucket, this.hostId).recordTask(input);
    await this.persist(bucket, "recordTask");
  }

  async listTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listTasks(rootPath, limit);
  }

  async listPendingTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listPendingTasks(rootPath, limit);
  }

  async markTaskFinished(rootPath: string, traceId: string, status: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).markTaskFinished(rootPath, traceId, status);
    if (updated) await this.persist(bucket, "markTaskFinished");
    return updated;
  }

  async recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).recordCaseSet(input);
    await this.persist(bucket, "recordCaseSet");
    return record;
  }

  async listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listCaseSets(rootPath, limit);
  }

  async createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).createRegressionTask(input);
    await this.persist(bucket, "createRegressionTask");
    return record;
  }

  async getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getRegressionTask(rootPath, id);
  }

  async listRegressionTasks(rootPath: string, limit?: number): Promise<RegressionTaskRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listRegressionTasks(rootPath, limit);
  }

  async updateRegressionTask(
    rootPath: string,
    id: string,
    patch: {
      status?: RegressionTaskRecord["status"];
      runIds?: string[];
      claimedBy?: string | null;
      claimedAt?: string | null;
    }
  ): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).updateRegressionTask(rootPath, id, patch);
    if (updated) await this.persist(bucket, "updateRegressionTask");
    return updated;
  }

  async claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
    hostId?: string;
    instanceId?: string;
    capabilities?: string[];
  }): Promise<RegressionTaskRecord | null> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).claimRegressionTask(input);
    if (record !== null) await this.persist(bucket, "claimRegressionTask");
    return record;
  }

  async beginExecution(input: {
    rootPath: string;
    taskId: string;
    runnerId: string;
    instanceId: string;
    at?: string;
  }): Promise<RegressionTaskRecord | null> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).beginExecution(input);
    if (record !== null) await this.persist(bucket, "beginExecution");
    return record;
  }

  async releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number> {
    const bucket = await this.bucket(input.rootPath);
    const released = await this.scopedMem(bucket, this.hostId).releaseRegressionTasks(input);
    if (released > 0) await this.persist(bucket, "releaseRegressionTasks");
    return released;
  }

  async releaseRegressionTask(input: {
    rootPath: string;
    runnerId: string | null;
    taskId: string;
    to?: "pending" | "failed";
  }): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const released = await this.scopedMem(bucket, this.hostId).releaseRegressionTask(input);
    if (released) await this.persist(bucket, "releaseRegressionTask");
    return released;
  }

  async releaseStaleClaims(input: {
    rootPath: string;
    offlineBefore: string;
    claimedBefore: string;
  }): Promise<number> {
    const bucket = await this.bucket(input.rootPath);
    const released = await this.scopedMem(bucket, this.hostId).releaseStaleClaims(input);
    if (released > 0) await this.persist(bucket, "releaseStaleClaims");
    return released;
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).createSchedule(input);
    await this.persist(bucket, "createSchedule");
    return record;
  }

  async listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listSchedules(rootPath, limit);
  }

  async getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getSchedule(rootPath, id);
  }

  async updateSchedule(
    rootPath: string,
    id: string,
    patch: { enabled?: boolean; everyMinutes?: number; lastNote?: string | null }
  ): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).updateSchedule(rootPath, id, patch);
    if (updated) await this.persist(bucket, "updateSchedule");
    return updated;
  }

  async deleteSchedule(rootPath: string, id: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const deleted = await this.scopedMem(bucket, this.hostId).deleteSchedule(rootPath, id);
    if (deleted) await this.persist(bucket, "deleteSchedule");
    return deleted;
  }

  async claimScheduleWindow(input: {
    rootPath: string;
    scheduleId: string;
    firedAt: string;
    cutoff: string;
  }): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const won = await this.scopedMem(bucket, this.hostId).claimScheduleWindow(input);
    if (won) await this.persist(bucket, "claimScheduleWindow");
    return won;
  }

  async recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).recordSuiteRun(input);
    await this.persist(bucket, "recordSuiteRun");
    return record;
  }

  async listSuiteRuns(
    rootPath: string,
    query?: {
      taskId?: string;
      caseSetId?: string;
      featureKey?: string;
      platform?: string;
      limit?: number;
    }
  ): Promise<SuiteRunRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listSuiteRuns(rootPath, query);
  }

  async markSuiteRunFinishedByRunId(
    rootPath: string,
    runId: string,
    status: "completed" | "failed"
  ): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).markSuiteRunFinishedByRunId(rootPath, runId, status);
    if (updated) await this.persist(bucket, "markSuiteRunFinishedByRunId");
    return updated;
  }

  async updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).updateCaseVerdict(input);
    if (updated) await this.persist(bucket, "updateCaseVerdict");
    return updated;
  }

  async setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const updated = await this.scopedMem(bucket, this.hostId).setCaseIssueKey(input);
    if (updated) await this.persist(bucket, "setCaseIssueKey");
    return updated;
  }

  async getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getSuiteRun(rootPath, runId);
  }

  async listRegisteredManifestPaths(rootPath: string): Promise<string[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listRegisteredManifestPaths(rootPath);
  }

  async getEarliestRegistrationCreatedAt(
    rootPath: string
  ): Promise<{ runs: string | null; caseSets: string | null }> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).getEarliestRegistrationCreatedAt(rootPath);
  }

  async upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await this.scopedMem(bucket, this.hostId).upsertRunner(input);
    await this.persist(bucket, "upsertRunner");
    return record;
  }

  async listRunners(rootPath: string, limit?: number): Promise<RunnerRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listRunners(rootPath, limit);
  }

  async upsertHost(input: UpsertHostInput): Promise<HostRecord> {
    await this.syncHostFromDisk();
    const record = await this.hostMem.upsertHost(input);
    await this.persistHostState("upsertHost");
    return record;
  }

  async getHost(id: string): Promise<HostRecord | null> {
    await this.syncHostFromDisk();
    return this.hostMem.getHost(id);
  }

  async listHosts(): Promise<HostRecord[]> {
    await this.syncHostFromDisk();
    return this.hostMem.listHosts();
  }

  async updateHostRegistration(input: {
    id: string;
    label?: string | null;
    owner?: string | null;
    expectedOs?: string | null;
    expectedHostname?: string | null;
    registeredBy: string;
  }): Promise<HostRecord | null> {
    await this.syncHostFromDisk();
    const record = await this.hostMem.updateHostRegistration(input);
    if (record !== null) await this.persistHostState("updateHostRegistration");
    return record;
  }

  async upsertHostAddresses(input: {
    hostId: string;
    addresses: HostAddressInput[];
    at?: string;
    maxPerSource?: number;
  }): Promise<void> {
    await this.syncHostFromDisk();
    await this.hostMem.upsertHostAddresses(input);
    await this.persistHostState("upsertHostAddresses");
  }

  async listHostAddresses(hostId: string): Promise<HostAddressRecord[]> {
    await this.syncHostFromDisk();
    return this.hostMem.listHostAddresses(hostId);
  }

  async touchHostSession(input: {
    id: string;
    hostId: string;
    projectId: string | null;
    rootPath: string;
    username: string | null;
    client: string | null;
    clientVersion: string | null;
    pid: number | null;
    at?: string;
  }): Promise<HostSessionRecord> {
    await this.syncHostFromDisk();
    const record = await this.hostMem.touchHostSession(input);
    await this.persistHostState("touchHostSession");
    return record;
  }

  async endHostSession(id: string, at?: string): Promise<boolean> {
    await this.syncHostFromDisk();
    const ended = await this.hostMem.endHostSession(id, at);
    if (ended) await this.persistHostState("endHostSession");
    return ended;
  }

  async listHostSessions(
    hostId: string,
    options?: { limit?: number; onlineWithinMs?: number; now?: number }
  ): Promise<HostSessionRecord[]> {
    await this.syncHostFromDisk();
    return this.hostMem.listHostSessions(hostId, options);
  }

  async setHostQueuePaused(input: {
    hostId: string;
    paused: boolean;
    by: string;
    at?: string;
  }): Promise<HostRecord | null> {
    await this.syncHostFromDisk();
    const record = await this.hostMem.setHostQueuePaused(input);
    if (record !== null) await this.persistHostState("setHostQueuePaused");
    return record;
  }

  async recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy: UsagePrunePolicy = {}
  ): Promise<UsageEventRecord> {
    const bucket = await this.bucket(rootPath);
    const before = bucket.mem.exportState().usageEvents.length;
    const record = await this.scopedMem(bucket, this.hostId).recordUsageEvent(rootPath, input, policy);
    const after = bucket.mem.exportState().usageEvents.length;
    try {
      await this.ensureDir(bucket);
      await appendFile(bucket.usagePath, `${JSON.stringify(record)}\n`, "utf8");
      bucket.seenUsageMtimeMs = await mtimeMs(bucket.usagePath);
      if (after !== before + 1) await this.rewriteUsage(bucket, policy);
    } catch (error) {
      this.noteWriteFailure(error);
      log(`文件台账写入失败（recordUsageEvent）：${errorMessage(error)}`);
    }
    return record;
  }

  async listUsageEvents(rootPath: string, query: UsageEventQuery = {}): Promise<UsageEventRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.scopedMem(bucket, this.hostId).listUsageEvents(rootPath, query);
  }

  async recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord> {
    const bucket = await this.bucket(rootPath);
    const record = await bucket.mem.recordAudit(rootPath, input);
    try {
      await this.ensureDir(bucket);
      await appendFile(bucket.auditPath, `${JSON.stringify(record)}\n`, "utf8");
      bucket.seenAuditMtimeMs = await mtimeMs(bucket.auditPath);
      await this.trimAuditToLimit(bucket);
    } catch (error) {
      this.noteWriteFailure(error);
      log(`文件台账写入失败（recordAudit）：${errorMessage(error)}`);
    }
    return record;
  }

  async recordProjectEvent(
    rootPath: string,
    input: ProjectEventInput
  ): Promise<RecordProjectEventResult> {
    const bucket = await this.bucket(rootPath);
    return this.withEventQueue(bucket, async () => {
      await this.ensureEventsLoaded(bucket);
      const project = await this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
      if (!project) throw new Error(`FileStore: project not registered: ${rootPath}`);

      const hash = payloadHash(input.payload);
      const existing = bucket.events.get(input.eventId);
      if (existing) {
        return {
          record: cloneProjectEvent(existing),
          duplicate: true,
          payloadMismatch: existing.payloadSha256 !== hash
        };
      }

      const seq = bucket.nextSeq;
      const receivedAt = new Date().toISOString();
      const record: ProjectEventRecord = {
        seq,
        id: randomUUID(),
        projectId: project.id,
        hostId: project.hostId,
        eventId: input.eventId,
        type: input.type,
        source: input.source ?? "project",
        runId: input.runId ?? null,
        caseId: input.caseId ?? null,
        step: input.step ?? null,
        status: input.status ?? null,
        at: input.at ?? receivedAt,
        receivedAt,
        payload: input.payload ?? null,
        payloadSha256: hash,
        payloadBytes: payloadBytes(input.payload),
        consumedAt: null
      };

      try {
        await this.ensureDir(bucket);
        await writeFileAtomic(bucket.eventsMetaPath, `${JSON.stringify({ nextSeq: seq + 1 })}\n`);
        await appendFile(bucket.eventsPath, `${JSON.stringify(record)}\n`, "utf8");
        if (this.eventsFsync) {
          await fsyncPath(bucket.eventsPath);
          await fsyncPath(bucket.eventsMetaPath);
        }
      } catch (error) {
        this.noteWriteFailure(error);
        throw error;
      }

      bucket.nextSeq = seq + 1;
      bucket.events.set(record.eventId, record);
      this.scheduleEventPrune(rootPath);
      return { record: cloneProjectEvent(record), duplicate: false, payloadMismatch: false };
    });
  }

  async listProjectEvents(
    rootPath: string,
    query: ProjectEventQuery = {}
  ): Promise<ProjectEventRecord[]> {
    const bucket = await this.bucket(rootPath);
    return this.withEventQueue(bucket, async () => {
      await this.ensureEventsLoaded(bucket);
      const project = await this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
      if (!project) return [];
      const since = query.since === undefined ? null : normalizeSince(query.since);
      if (query.since !== undefined && since === null) throw new Error("invalid since");
      const afterSeq = query.afterSeq === undefined ? null : query.afterSeq;
      if (afterSeq !== null && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
        throw new Error("invalid afterSeq");
      }
      const includePayload = query.includePayload === true;
      const limit = includePayload ? 50 : 200;
      const requested = query.limit ?? 50;
      const capped = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, limit));
      const order = query.order === "asc" ? "asc" : "desc";
      return [...bucket.events.values()]
        .filter((event) => event.projectId === project.id)
        .filter((event) => !query.runId || event.runId === query.runId)
        .filter((event) => !query.caseId || event.caseId === query.caseId)
        .filter((event) => !query.type || event.type === query.type)
        .filter((event) => !query.status || event.status === query.status)
        .filter((event) => afterSeq === null || event.seq > afterSeq)
        .filter(
          (event) =>
            query.consumed === undefined || (event.consumedAt !== null) === query.consumed
        )
        .filter((event) => since === null || event.receivedAt > since)
        .sort((left, right) =>
          order === "asc"
            ? left.receivedAt.localeCompare(right.receivedAt) || left.seq - right.seq
            : right.receivedAt.localeCompare(left.receivedAt) || right.seq - left.seq
        )
        .slice(0, capped)
        .map((event) => cloneProjectEvent(event, !includePayload));
    });
  }

  async markProjectEventsConsumed(
    rootPath: string,
    eventIds: string[],
    consumedAt: string = new Date().toISOString()
  ): Promise<number> {
    const bucket = await this.bucket(rootPath);
    return this.withEventQueue(bucket, async () => {
      await this.ensureEventsLoaded(bucket);
      const project = await this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
      if (!project) return 0;
      const ids = new Set(eventIds);
      const changed: ProjectEventRecord[] = [];
      for (const event of bucket.events.values()) {
        if (event.projectId !== project.id || !ids.has(event.eventId) || event.consumedAt !== null) {
          continue;
        }
        event.consumedAt = consumedAt;
        changed.push(event);
      }
      if (changed.length === 0) return 0;
      try {
        await writeFileAtomicAsync(
          bucket.eventsPath,
          `${[...bucket.events.values()].map((event) => JSON.stringify(event)).join("\n")}\n`
        );
        if (this.eventsFsync) await fsyncPath(bucket.eventsPath);
      } catch (error) {
        for (const event of changed) event.consumedAt = null;
        this.noteWriteFailure(error);
        log(`文件台账写入失败（markProjectEventsConsumed）：${errorMessage(error)}`);
        return 0;
      }
      return changed.length;
    });
  }

  async countProjectEvents(rootPath: string): Promise<number> {
    const bucket = await this.bucket(rootPath);
    return this.withEventQueue(bucket, async () => {
      await this.ensureEventsLoaded(bucket);
      const project = await this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
      if (!project) return 0;
      return [...bucket.events.values()].filter((event) => event.projectId === project.id).length;
    });
  }

  async pruneProjectEvents(rootPath: string): Promise<number> {
    const bucket = await this.bucket(rootPath);
    return this.withEventQueue(bucket, async () => {
      await this.ensureEventsLoaded(bucket);
      const project = await this.scopedMem(bucket, this.hostId).getProjectByPath(rootPath);
      if (!project) return 0;
      const policy = eventRetentionPolicy(this.env);
      const cutoff = eventCutoffIso(policy.days);
      const current = [...bucket.events.values()].filter((event) => event.projectId === project.id);
      const recent = current
        .filter((event) => event.receivedAt >= cutoff)
        .sort((left, right) => left.seq - right.seq);
      const keep = new Set(
        recent.slice(Math.max(0, recent.length - policy.max)).map((event) => event.id)
      );
      const kept = [...bucket.events.values()].filter(
        (event) => event.projectId !== project.id || keep.has(event.id)
      );
      const deleted = bucket.events.size - kept.length;
      if (deleted === 0) return 0;
      try {
        await writeFileAtomicAsync(
          bucket.eventsPath,
          kept.length > 0 ? `${kept.map((event) => JSON.stringify(event)).join("\n")}\n` : ""
        );
        if (this.eventsFsync) await fsyncPath(bucket.eventsPath);
      } catch (error) {
        this.noteWriteFailure(error);
        log(`文件台账写入失败（pruneProjectEvents）：${errorMessage(error)}`);
        return 0;
      }
      bucket.events = new Map(kept.map((event) => [event.eventId, event]));
      return deleted;
    });
  }

  private async ensureEventsLoaded(bucket: ProjectBucket): Promise<void> {
    if (bucket.eventsLoaded) return;
    if (bucket.eventsLoad === undefined) {
      bucket.eventsLoad = (async () => {
        const events = new Map<string, ProjectEventRecord>();
        let maxSeq = 0;
        const raw = await readIfExists(bucket.eventsPath);
        if (raw !== null) {
          for (const line of raw.split(/\r?\n/)) {
            if (line.trim() === "") continue;
            try {
              const record = JSON.parse(line) as ProjectEventRecord;
              if (
                typeof record.eventId !== "string" ||
                typeof record.seq !== "number" ||
                typeof record.id !== "string"
              ) {
                log(`文件台账 events.jsonl 形状异常（忽略一行）：${bucket.eventsPath}`);
                continue;
              }
              events.set(record.eventId, record);
              maxSeq = Math.max(maxSeq, record.seq);
            } catch (error) {
              log(`文件台账 events.jsonl 解析失败（忽略一行）：${errorMessage(error)}`);
            }
          }
        }
        let metaNext = 1;
        const metaRaw = await readIfExists(bucket.eventsMetaPath);
        if (metaRaw !== null) {
          try {
            const parsed = JSON.parse(metaRaw) as { nextSeq?: unknown };
            if (
              typeof parsed.nextSeq === "number" &&
              Number.isInteger(parsed.nextSeq) &&
              parsed.nextSeq > 0
            ) {
              metaNext = parsed.nextSeq;
            }
          } catch (error) {
            log(`文件台账 events.meta.json 解析失败（忽略）：${errorMessage(error)}`);
          }
        }
        bucket.events = events;
        bucket.nextSeq = Math.max(maxSeq + 1, metaNext);
        bucket.eventsLoaded = true;
      })();
      bucket.eventsLoad = bucket.eventsLoad.catch((error) => {
        bucket.eventsLoad = undefined;
        throw error;
      });
    }
    await bucket.eventsLoad;
  }

  private withEventQueue<T>(bucket: ProjectBucket, fn: () => Promise<T>): Promise<T> {
    const run = bucket.eventQueue.then(fn, fn);
    bucket.eventQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private scheduleEventPrune(rootPath: string): void {
    const bucket = this.buckets.get(rootPath);
    if (!bucket) return;
    const now = Date.now();
    if (now - bucket.lastEventPruneAt < 5 * 60_000) return;
    bucket.lastEventPruneAt = now;
    setImmediate(() => {
      void this.pruneProjectEvents(rootPath).catch((error) => {
        log(`文件台账事件裁剪失败（忽略）：${errorMessage(error)}`);
      });
    });
  }

  async listAudit(rootPath: string, query: AuditQuery = {}): Promise<AuditEventRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listAudit(rootPath, query);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.registry.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
      .map((entry) => ({
        id: `file:${entry.rootPath}`,
        hostId: null,
        rootPath: entry.rootPath,
        name: entry.name,
        figmaToken: null,
        createdAt: entry.createdAt,
        lastSeenAt: entry.updatedAt
      }));
  }

  async ping(): Promise<boolean> {
    return true;
  }

  /** 运行期写失败计数（对外如实信号；aos_status 经 Runtime.storeError 展示）。 */
  writeErrors(): { count: number; lastError: string | null } {
    return { count: this.failedWrites, lastError: this.lastWriteError };
  }

  private noteWriteFailure(error: unknown): void {
    this.failedWrites += 1;
    this.lastWriteError = errorMessage(error);
  }

  async close(): Promise<void> {
    /* 写路径逐次落盘，无需收尾 */
  }

  private async loadRegistry(): Promise<void> {
    const registryPath = path.join(this.homeDir, "registry.jsonl");
    const entries = await readJsonl<RegistryEntry>(registryPath);
    for (const entry of entries) {
      if (!entry?.rootPath) continue;
      const existing = this.registry.get(entry.rootPath);
      if (!existing || entry.updatedAt >= existing.updatedAt) this.registry.set(entry.rootPath, entry);
    }
    await this.trimJournalIfLarge(registryPath);
  }

  private async appendRegistry(entry: RegistryEntry): Promise<void> {
    try {
      await appendFile(path.join(this.homeDir, "registry.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      log(`文件台账注册表写入失败：${errorMessage(error)}`);
    }
  }

  private createBucket(rootPath: string): ProjectBucket {
    const dir = path.join(rootPath, ...LEDGER_DIR_SEGMENTS);
    return {
      rootPath,
      dir,
      statePath: path.join(dir, "state.json"),
      usagePath: path.join(dir, "usage.jsonl"),
      auditPath: path.join(dir, "audit.jsonl"),
      journalPath: path.join(dir, "journal.jsonl"),
      eventsPath: path.join(dir, "events.jsonl"),
      eventsMetaPath: path.join(dir, "events.meta.json"),
      events: new Map(),
      eventsLoaded: false,
      eventQueue: Promise.resolve(),
      nextSeq: 1,
      lastEventPruneAt: 0,
      mem: new MemoryStore(),
      loaded: false,
      seenStateMtimeMs: null,
      seenUsageMtimeMs: null,
      seenAuditMtimeMs: null
    };
  }

  private async bucket(rootPath: string): Promise<ProjectBucket> {
    const existing = this.buckets.get(rootPath);
    if (existing?.loaded) {
      await this.syncFromDisk(existing);
      return existing;
    }
    const bucket = existing ?? this.createBucket(rootPath);
    this.buckets.set(rootPath, bucket);
    await this.loadBucket(bucket);
    await this.syncFromDisk(bucket);
    return bucket;
  }

  private async loadBucket(bucket: ProjectBucket): Promise<void> {
    bucket.loaded = true;
    try {
      await this.ensureDir(bucket);
      await cleanStaleTemps(bucket);
      const stateRaw = await readIfExists(bucket.statePath);
      if (stateRaw !== null) {
        try {
          const parsed = JSON.parse(stateRaw) as { v?: number; state?: Partial<MemoryStoreState> };
          if (parsed && typeof parsed === "object" && parsed.state && typeof parsed.state === "object") {
            bucket.mem.importState(parsed.state);
            this.hydrateHostState(parsed.state);
          } else {
            log(`文件台账 state.json 形状异常（忽略）：${bucket.statePath}`);
          }
        } catch (error) {
          log(`文件台账 state.json 解析失败（忽略）：${errorMessage(error)}`);
        }
      }
      const usage = await readJsonl<UsageEventRecord>(bucket.usagePath);
      bucket.mem.importState({ usageEvents: usage });
      const audit = await readJsonl<AuditEventRecord>(bucket.auditPath);
      const keptAudit = this.trimAudit(audit);
      if (keptAudit.length !== audit.length) await this.rewriteAudit(bucket, keptAudit);
      bucket.mem.importState({ auditEvents: keptAudit });
      bucket.seenStateMtimeMs = await mtimeMs(bucket.statePath);
      bucket.seenUsageMtimeMs = await mtimeMs(bucket.usagePath);
      bucket.seenAuditMtimeMs = await mtimeMs(bucket.auditPath);
      await this.trimJournalIfLarge(bucket.journalPath);
      try {
        await hydrateProjectLedger(this, bucket.rootPath);
      } catch (error) {
        log(`用例集自愈失败（忽略）：${errorMessage(error)}`);
      }
    } catch (error) {
      log(`文件台账加载失败（${bucket.rootPath}）：${errorMessage(error)}`);
    }
  }

  private async ensureDir(bucket: ProjectBucket): Promise<void> {
    await mkdir(bucket.dir, { recursive: true });
  }

  private async syncFromDisk(bucket: ProjectBucket): Promise<void> {
    const stateMtime = await mtimeMs(bucket.statePath);
    if (stateMtime !== null && bucket.seenStateMtimeMs !== null && stateMtime !== bucket.seenStateMtimeMs) {
      const raw = await readIfExists(bucket.statePath);
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { state?: Partial<MemoryStoreState> };
          if (parsed && typeof parsed === "object" && parsed.state) {
            const merged = mergeStates(parsed.state, bucket.mem.exportState());
            bucket.mem.importState(merged);
            this.hydrateHostState(parsed.state);
          }
        } catch (error) {
          log(`文件台账合并读取失败（忽略）：${errorMessage(error)}`);
        }
      }
    }
    bucket.seenStateMtimeMs = stateMtime ?? bucket.seenStateMtimeMs;

    const usageMtime = await mtimeMs(bucket.usagePath);
    if (usageMtime !== null && bucket.seenUsageMtimeMs !== null && usageMtime !== bucket.seenUsageMtimeMs) {
      const diskUsage = await readJsonl<UsageEventRecord>(bucket.usagePath);
      const merged = unionBy(diskUsage, bucket.mem.exportState().usageEvents, (event) => event.id);
      bucket.mem.importState({ usageEvents: merged });
    }
    bucket.seenUsageMtimeMs = usageMtime ?? bucket.seenUsageMtimeMs;

    const auditMtime = await mtimeMs(bucket.auditPath);
    if (auditMtime !== null && bucket.seenAuditMtimeMs !== null && auditMtime !== bucket.seenAuditMtimeMs) {
      const diskAudit = await readJsonl<AuditEventRecord>(bucket.auditPath);
      const merged = unionBy(diskAudit, bucket.mem.exportState().auditEvents, (event) => event.id);
      bucket.mem.importState({ auditEvents: merged });
    }
    bucket.seenAuditMtimeMs = auditMtime ?? bucket.seenAuditMtimeMs;
  }

  private hydrateHostState(disk: Partial<MemoryStoreState>): void {
    if (!disk.hosts && !disk.hostAddresses && !disk.hostSessions) return;
    const local = this.hostMem.exportState();
    this.hostMem.importState({
      hosts: disk.hosts ? unionBy(disk.hosts, local.hosts, (host) => host.id) : undefined,
      hostAddresses: disk.hostAddresses
        ? unionBy(disk.hostAddresses, local.hostAddresses, hostAddressKey)
        : undefined,
      hostSessions: disk.hostSessions
        ? unionBy(disk.hostSessions, local.hostSessions, (session) => session.id)
        : undefined
    });
  }

  private async syncHostFromDisk(): Promise<void> {
    for (const bucket of this.buckets.values()) {
      if (!bucket.loaded) continue;
      await this.syncFromDisk(bucket);
    }
  }

  private async persistHostState(op: string): Promise<void> {
    for (const bucket of this.buckets.values()) {
      if (!bucket.loaded) continue;
      await this.persist(bucket, op);
    }
  }

  private async persist(bucket: ProjectBucket, op: string): Promise<void> {
    try {
      const full = bucket.mem.exportState();
      const snapshot: Partial<MemoryStoreState> = {
        projects: full.projects.map((project) => ({ ...project, figmaToken: null })),
        llms: full.llms.map((bucketEntry) => ({
          rootPath: bucketEntry.rootPath,
          entries: bucketEntry.entries.map((entry) => ({ ...entry, apiKey: null }))
        })),
        modelCaches: full.modelCaches,
        tasks: full.tasks,
        caseSets: full.caseSets,
        regressionTasks: full.regressionTasks,
        suiteRuns: full.suiteRuns,
        runners: full.runners,
        schedules: full.schedules,
        hosts: this.hostMem.exportState().hosts,
        hostAddresses: this.hostMem.exportState().hostAddresses,
        hostSessions: this.hostMem.exportState().hostSessions
      };
      await this.ensureDir(bucket);
      const payload = JSON.stringify({
        v: 1,
        rootPath: bucket.rootPath,
        updatedAt: new Date().toISOString(),
        state: snapshot
      });
      const tmp = `${bucket.statePath}.tmp-${randomUUID()}`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, bucket.statePath);
      bucket.seenStateMtimeMs = await mtimeMs(bucket.statePath);
      await appendFile(
        bucket.journalPath,
        `${JSON.stringify({ at: new Date().toISOString(), op, rootPath: bucket.rootPath })}\n`,
        "utf8"
      );
    } catch (error) {
      this.noteWriteFailure(error);
      log(`文件台账写入失败（${op}）：${errorMessage(error)}`);
    }
  }

  private async rewriteUsage(bucket: ProjectBucket, policy: UsagePrunePolicy = {}): Promise<void> {
    const disk = await readJsonl<UsageEventRecord>(bucket.usagePath);
    const merged = unionBy(disk, bucket.mem.exportState().usageEvents, (event) => event.id);
    const kept = pruneUsageEvents(merged, policy);
    const content = kept.map((event) => JSON.stringify(event)).join("\n");
    await writeFileAtomic(bucket.usagePath, kept.length > 0 ? `${content}\n` : "");
    bucket.seenUsageMtimeMs = await mtimeMs(bucket.usagePath);
    bucket.mem.importState({ usageEvents: kept });
  }

  private async trimAuditToLimit(bucket: ProjectBucket): Promise<void> {
    const disk = await readJsonl<AuditEventRecord>(bucket.auditPath);
    const merged = unionBy(disk, bucket.mem.exportState().auditEvents, (event) => event.id);
    const kept = this.trimAudit(merged);
    if (kept.length >= merged.length) return;
    await this.rewriteAudit(bucket, kept);
    bucket.mem.importState({ auditEvents: kept });
  }

  private async rewriteAudit(bucket: ProjectBucket, events: AuditEventRecord[]): Promise<void> {
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFileAtomic(bucket.auditPath, events.length > 0 ? `${content}\n` : "");
    bucket.seenAuditMtimeMs = await mtimeMs(bucket.auditPath);
  }

  private trimAudit(events: AuditEventRecord[]): AuditEventRecord[] {
    const retentionDays = envInt(this.env, "AOS_AUDIT_RETENTION_DAYS", AUDIT_RETENTION_DAYS_DEFAULT);
    const maxEvents = envInt(this.env, "AOS_AUDIT_MAX_EVENTS", AUDIT_MAX_EVENTS_DEFAULT);
    let kept = events;
    if (retentionDays > 0) {
      const cutoff = retentionCutoffIso(retentionDays);
      kept = kept.filter((event) => event.at >= cutoff);
    }
    if (maxEvents > 0 && kept.length > maxEvents) {
      kept = [...kept]
        .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
        .slice(0, maxEvents);
    }
    return kept;
  }

  private async trimJournalIfLarge(filePath: string): Promise<void> {
    try {
      const raw = await readIfExists(filePath);
      if (raw === null) return;
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      if (lines.length <= JOURNAL_MAX_LINES) return;
      const kept = lines.slice(-JOURNAL_MAX_LINES / 2);
      await writeFile(filePath, `${kept.join("\n")}\n`, "utf8");
    } catch (error) {
      log(`文件台账日志裁剪失败（忽略）：${errorMessage(error)}`);
    }
  }
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function unionBy<T>(local: T[], disk: T[], key: (value: T) => string): T[] {
  const out = [...local];
  const seen = new Set(local.map(key));
  for (const item of disk) {
    const itemKey = key(item);
    if (!seen.has(itemKey)) {
      out.push(item);
      seen.add(itemKey);
    }
  }
  return out;
}

function hostAddressKey(address: HostAddressRecord): string {
  return `${address.hostId}\u0000${address.source}\u0000${address.iface}\u0000${address.address}`;
}

function mergeStates(disk: Partial<MemoryStoreState>, local: MemoryStoreState): Partial<MemoryStoreState> {
  const out: Partial<MemoryStoreState> = {};
  if (disk.projects) out.projects = unionBy(disk.projects, local.projects, (project) => `${project.hostId ?? "legacy"}\u0000${project.rootPath}`);
  if (disk.llms) out.llms = mergeLlmBuckets(disk.llms, local.llms);
  if (disk.modelCaches) out.modelCaches = unionBy(disk.modelCaches, local.modelCaches, (entry) => entry.key);
  if (disk.tasks) out.tasks = unionBy(disk.tasks, local.tasks, (task) => task.id);
  if (disk.caseSets) out.caseSets = unionBy(disk.caseSets, local.caseSets, (set) => set.id);
  if (disk.regressionTasks) {
    out.regressionTasks = unionBy(disk.regressionTasks, local.regressionTasks, (task) => task.id);
  }
  if (disk.suiteRuns) out.suiteRuns = unionBy(disk.suiteRuns, local.suiteRuns, (run) => run.id);
  if (disk.runners) out.runners = unionBy(disk.runners, local.runners, (runner) => runner.id);
  if (disk.schedules) out.schedules = unionBy(disk.schedules, local.schedules, (schedule) => schedule.id);
  return out;
}

function mergeLlmBuckets(
  primary: Array<{ rootPath: string; entries: ProjectLlmRecord[] }>,
  secondary: Array<{ rootPath: string; entries: ProjectLlmRecord[] }>
): Array<{ rootPath: string; entries: ProjectLlmRecord[] }> {
  const byRoot = new Map<string, ProjectLlmRecord[]>();
  for (const group of [...primary, ...secondary]) {
    const list = byRoot.get(group.rootPath) ?? [];
    const names = new Set(list.map((entry) => entry.name));
    for (const entry of group.entries) {
      if (!names.has(entry.name)) {
        list.push(entry);
        names.add(entry.name);
      }
    }
    byRoot.set(group.rootPath, list);
  }
  return [...byRoot.entries()].map(([rootPath, entries]) => ({ rootPath, entries }));
}
async function assertWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.aos-write-probe-${randomUUID()}`);
  try {
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
  } catch (error) {
    throw new Error(`文件台账目录不可写: ${dir}（${errorMessage(error)}）`);
  }
}

async function cleanStaleTemps(bucket: ProjectBucket): Promise<void> {
  try {
    const names = await readdir(bucket.dir);
    for (const name of names) {
      if (name.startsWith("state.json.tmp-")) {
        await rm(path.join(bucket.dir, name), { force: true });
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readIfExists(filePath);
  if (raw === null) return [];
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

async function mtimeMs(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.mtimeMs;
  } catch {
    return null;
  }
}

function pruneUsageEvents(
  events: UsageEventRecord[],
  policy: UsagePrunePolicy
): UsageEventRecord[] {
  let kept = events;
  const retentionDays = policy.retentionDays ?? 0;
  if (retentionDays > 0) {
    const cutoff = retentionCutoffIso(retentionDays);
    kept = kept.filter((event) => event.at >= cutoff);
  }
  const maxEvents = policy.maxEvents ?? 0;
  if (maxEvents > 0 && kept.length > maxEvents) {
    kept = [...kept]
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(0, maxEvents);
  }
  return kept;
}

function cloneProjectEvent(record: ProjectEventRecord, omitPayload = false): ProjectEventRecord {
  return {
    ...record,
    hostId: record.hostId ?? null,
    payload: omitPayload ? undefined : record.payload
  };
}

async function fsyncPath(file: string): Promise<void> {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileAtomicAsync(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
