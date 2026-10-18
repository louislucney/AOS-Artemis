import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { resolveProject } from "../config/loader.js";
import { errorMessage, log } from "../util.js";
import { MemoryStore, type MemoryStoreState } from "./memory.js";
import { hydrateProjectLedger } from "./hydrate.js";
import { retentionCutoffIso } from "./usage-event.js";
import type {
  AuditEventInput,
  AuditEventRecord,
  AuditQuery,
  CaseSetRecord,
  CreateRegressionTaskInput,
  CreateScheduleInput,
  ModelCacheRecord,
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
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
  private readonly buckets = new Map<string, ProjectBucket>();
  private readonly registry = new Map<string, RegistryEntry>();

  private constructor(homeDir: string, env: NodeJS.ProcessEnv) {
    this.homeDir = homeDir;
    this.env = env;
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

  async upsertProject(input: { rootPath: string; name: string }): Promise<ProjectRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.upsertProject(input);
    const existing = this.registry.get(input.rootPath);
    const now = new Date().toISOString();
    const entry: RegistryEntry = {
      rootPath: input.rootPath,
      name: input.name,
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
    return bucket.mem.getProjectByPath(rootPath);
  }

  async setFigmaToken(rootPath: string, token: string | null): Promise<void> {
    const bucket = await this.bucket(rootPath);
    await bucket.mem.setFigmaToken(rootPath, token);
    await this.persist(bucket, "setFigmaToken");
  }

  async listLlms(rootPath: string): Promise<ProjectLlmRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listLlms(rootPath);
  }

  async upsertLlm(rootPath: string, input: UpsertLlmInput): Promise<ProjectLlmRecord> {
    const bucket = await this.bucket(rootPath);
    const record = await bucket.mem.upsertLlm(rootPath, input);
    await this.persist(bucket, "upsertLlm");
    return record;
  }

  async setActiveLlm(rootPath: string, name: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await bucket.mem.setActiveLlm(rootPath, name);
    if (updated) await this.persist(bucket, "setActiveLlm");
    return updated;
  }

  async getModelCache(rootPath: string, cacheKey: string): Promise<ModelCacheRecord | null> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.getModelCache(rootPath, cacheKey);
  }

  async putModelCache(rootPath: string, input: PutModelCacheInput): Promise<ModelCacheRecord> {
    const bucket = await this.bucket(rootPath);
    const record = await bucket.mem.putModelCache(rootPath, input);
    await this.persist(bucket, "putModelCache");
    return record;
  }

  async recordTask(input: RecordTaskInput): Promise<void> {
    const bucket = await this.bucket(input.rootPath);
    await bucket.mem.recordTask(input);
    await this.persist(bucket, "recordTask");
  }

  async listTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listTasks(rootPath, limit);
  }

  async listPendingTasks(rootPath: string, limit?: number): Promise<TaskStatRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listPendingTasks(rootPath, limit);
  }

  async markTaskFinished(rootPath: string, traceId: string, status: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await bucket.mem.markTaskFinished(rootPath, traceId, status);
    if (updated) await this.persist(bucket, "markTaskFinished");
    return updated;
  }

  async recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.recordCaseSet(input);
    await this.persist(bucket, "recordCaseSet");
    return record;
  }

  async listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listCaseSets(rootPath, limit);
  }

  async createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.createRegressionTask(input);
    await this.persist(bucket, "createRegressionTask");
    return record;
  }

  async getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.getRegressionTask(rootPath, id);
  }

  async listRegressionTasks(rootPath: string, limit?: number): Promise<RegressionTaskRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listRegressionTasks(rootPath, limit);
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
    const updated = await bucket.mem.updateRegressionTask(rootPath, id, patch);
    if (updated) await this.persist(bucket, "updateRegressionTask");
    return updated;
  }

  async claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
  }): Promise<RegressionTaskRecord | null> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.claimRegressionTask(input);
    if (record !== null) await this.persist(bucket, "claimRegressionTask");
    return record;
  }

  async releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number> {
    const bucket = await this.bucket(input.rootPath);
    const released = await bucket.mem.releaseRegressionTasks(input);
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
    const released = await bucket.mem.releaseRegressionTask(input);
    if (released) await this.persist(bucket, "releaseRegressionTask");
    return released;
  }

  async releaseStaleClaims(input: {
    rootPath: string;
    offlineBefore: string;
    claimedBefore: string;
  }): Promise<number> {
    const bucket = await this.bucket(input.rootPath);
    const released = await bucket.mem.releaseStaleClaims(input);
    if (released > 0) await this.persist(bucket, "releaseStaleClaims");
    return released;
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.createSchedule(input);
    await this.persist(bucket, "createSchedule");
    return record;
  }

  async listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listSchedules(rootPath, limit);
  }

  async getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.getSchedule(rootPath, id);
  }

  async updateSchedule(
    rootPath: string,
    id: string,
    patch: { enabled?: boolean; everyMinutes?: number; lastNote?: string | null }
  ): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const updated = await bucket.mem.updateSchedule(rootPath, id, patch);
    if (updated) await this.persist(bucket, "updateSchedule");
    return updated;
  }

  async deleteSchedule(rootPath: string, id: string): Promise<boolean> {
    const bucket = await this.bucket(rootPath);
    const deleted = await bucket.mem.deleteSchedule(rootPath, id);
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
    const won = await bucket.mem.claimScheduleWindow(input);
    if (won) await this.persist(bucket, "claimScheduleWindow");
    return won;
  }

  async recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.recordSuiteRun(input);
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
    return bucket.mem.listSuiteRuns(rootPath, query);
  }

  async updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const updated = await bucket.mem.updateCaseVerdict(input);
    if (updated) await this.persist(bucket, "updateCaseVerdict");
    return updated;
  }

  async setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean> {
    const bucket = await this.bucket(input.rootPath);
    const updated = await bucket.mem.setCaseIssueKey(input);
    if (updated) await this.persist(bucket, "setCaseIssueKey");
    return updated;
  }

  async getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.getSuiteRun(rootPath, runId);
  }

  async listRegisteredManifestPaths(rootPath: string): Promise<string[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listRegisteredManifestPaths(rootPath);
  }

  async getEarliestRegistrationCreatedAt(
    rootPath: string
  ): Promise<{ runs: string | null; caseSets: string | null }> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.getEarliestRegistrationCreatedAt(rootPath);
  }

  async upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord> {
    const bucket = await this.bucket(input.rootPath);
    const record = await bucket.mem.upsertRunner(input);
    await this.persist(bucket, "upsertRunner");
    return record;
  }

  async listRunners(rootPath: string, limit?: number): Promise<RunnerRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listRunners(rootPath, limit);
  }

  async recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy: UsagePrunePolicy = {}
  ): Promise<UsageEventRecord> {
    const bucket = await this.bucket(rootPath);
    const before = bucket.mem.exportState().usageEvents.length;
    const record = await bucket.mem.recordUsageEvent(rootPath, input, policy);
    const after = bucket.mem.exportState().usageEvents.length;
    try {
      await this.ensureDir(bucket);
      await appendFile(bucket.usagePath, `${JSON.stringify(record)}\n`, "utf8");
      bucket.seenUsageMtimeMs = await mtimeMs(bucket.usagePath);
      if (after !== before + 1) await this.rewriteUsage(bucket);
    } catch (error) {
      log(`文件台账写入失败（recordUsageEvent）：${errorMessage(error)}`);
    }
    return record;
  }

  async listUsageEvents(rootPath: string, query: UsageEventQuery = {}): Promise<UsageEventRecord[]> {
    const bucket = await this.bucket(rootPath);
    return bucket.mem.listUsageEvents(rootPath, query);
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
      log(`文件台账写入失败（recordAudit）：${errorMessage(error)}`);
    }
    return record;
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
      mem: new MemoryStore(),
      loaded: false,
      seenStateMtimeMs: null,
      seenUsageMtimeMs: null,
      seenAuditMtimeMs: null
    };
  }

  private async bucket(rootPath: string): Promise<ProjectBucket> {
    const existing = this.buckets.get(rootPath);
    if (existing?.loaded) return existing;
    const bucket = existing ?? this.createBucket(rootPath);
    this.buckets.set(rootPath, bucket);
    await this.loadBucket(bucket);
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
      const merged = unionBy(bucket.mem.exportState().usageEvents, diskUsage, (event) => event.id);
      bucket.mem.importState({ usageEvents: merged });
    }
    bucket.seenUsageMtimeMs = usageMtime ?? bucket.seenUsageMtimeMs;

    const auditMtime = await mtimeMs(bucket.auditPath);
    if (auditMtime !== null && bucket.seenAuditMtimeMs !== null && auditMtime !== bucket.seenAuditMtimeMs) {
      const diskAudit = await readJsonl<AuditEventRecord>(bucket.auditPath);
      const merged = unionBy(bucket.mem.exportState().auditEvents, diskAudit, (event) => event.id);
      bucket.mem.importState({ auditEvents: merged });
    }
    bucket.seenAuditMtimeMs = auditMtime ?? bucket.seenAuditMtimeMs;
  }

  private async persist(bucket: ProjectBucket, op: string): Promise<void> {
    try {
      await this.syncFromDisk(bucket);
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
        schedules: full.schedules
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
      log(`文件台账写入失败（${op}）：${errorMessage(error)}`);
    }
  }

  private async rewriteUsage(bucket: ProjectBucket): Promise<void> {
    const events = bucket.mem.exportState().usageEvents;
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(bucket.usagePath, events.length > 0 ? `${content}\n` : "", "utf8");
    bucket.seenUsageMtimeMs = await mtimeMs(bucket.usagePath);
  }

  private async trimAuditToLimit(bucket: ProjectBucket): Promise<void> {
    const events = bucket.mem.exportState().auditEvents;
    const kept = this.trimAudit(events);
    if (kept.length < events.length) {
      bucket.mem.importState({ auditEvents: kept });
      await this.rewriteAudit(bucket, kept);
    }
  }

  private async rewriteAudit(bucket: ProjectBucket, events: AuditEventRecord[]): Promise<void> {
    const content = events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(bucket.auditPath, events.length > 0 ? `${content}\n` : "", "utf8");
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

function mergeStates(disk: Partial<MemoryStoreState>, local: MemoryStoreState): Partial<MemoryStoreState> {
  const out: Partial<MemoryStoreState> = {};
  if (disk.projects) out.projects = unionBy(local.projects, disk.projects, (project) => project.rootPath);
  if (disk.llms) out.llms = mergeLlmBuckets(local.llms, disk.llms);
  if (disk.modelCaches) out.modelCaches = unionBy(local.modelCaches, disk.modelCaches, (entry) => entry.key);
  if (disk.tasks) out.tasks = unionBy(local.tasks, disk.tasks, (task) => task.id);
  if (disk.caseSets) out.caseSets = unionBy(local.caseSets, disk.caseSets, (set) => set.id);
  if (disk.regressionTasks) {
    out.regressionTasks = unionBy(local.regressionTasks, disk.regressionTasks, (task) => task.id);
  }
  if (disk.suiteRuns) out.suiteRuns = unionBy(local.suiteRuns, disk.suiteRuns, (run) => run.id);
  if (disk.runners) out.runners = unionBy(local.runners, disk.runners, (runner) => runner.id);
  if (disk.schedules) out.schedules = unionBy(local.schedules, disk.schedules, (schedule) => schedule.id);
  return out;
}

function mergeLlmBuckets(
  local: Array<{ rootPath: string; entries: ProjectLlmRecord[] }>,
  disk: Array<{ rootPath: string; entries: ProjectLlmRecord[] }>
): Array<{ rootPath: string; entries: ProjectLlmRecord[] }> {
  const byRoot = new Map<string, ProjectLlmRecord[]>();
  for (const group of [...local, ...disk]) {
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
