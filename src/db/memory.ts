import { randomUUID } from "node:crypto";

import { buildAuditEvent, cloneAuditEvent, normalizeAuditLimit } from "./audit-event.js";
import { buildUsageEvent, normalizeUsageLimit, retentionCutoffIso } from "./usage-event.js";
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

export interface MemoryStoreState {
  projects: ProjectRecord[];
  llms: Array<{ rootPath: string; entries: ProjectLlmRecord[] }>;
  modelCaches: Array<{ key: string; record: ModelCacheRecord }>;
  tasks: TaskStatRecord[];
  usageEvents: UsageEventRecord[];
  caseSets: CaseSetRecord[];
  regressionTasks: RegressionTaskRecord[];
  suiteRuns: SuiteRunRecord[];
  runners: RunnerRecord[];
  schedules: ScheduleRecord[];
  auditEvents: AuditEventRecord[];
  hosts: HostRecord[];
  hostAddresses: HostAddressRecord[];
  hostSessions: HostSessionRecord[];
}

/** In-session fallback when PostgreSQL is unavailable (degraded mode). */
export class MemoryStore implements ProjectStore {
  readonly kind = "memory" as const;
  private projects = new Map<string, ProjectRecord>();
  private llms = new Map<string, ProjectLlmRecord[]>();
  private modelCaches = new Map<string, ModelCacheRecord>();
  private tasks: TaskStatRecord[] = [];
  private usageEvents: UsageEventRecord[] = [];
  private projectEvents: ProjectEventRecord[] = [];
  private projectEventSeq = new Map<string, number>();
  private auditEvents: AuditEventRecord[] = [];
  private caseSets: CaseSetRecord[] = [];
  private regressionTasks: RegressionTaskRecord[] = [];
  private suiteRuns: SuiteRunRecord[] = [];
  private runners: RunnerRecord[] = [];
  private schedules: ScheduleRecord[] = [];
  private hosts: HostRecord[] = [];
  private hostAddresses: HostAddressRecord[] = [];
  private hostSessions: HostSessionRecord[] = [];

  async upsertProject(input: {
    rootPath: string;
    name: string;
    updateName?: boolean;
  }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const existing = this.projects.get(input.rootPath);
    if (existing) {
      if (input.updateName !== false) existing.name = input.name;
      existing.lastSeenAt = now;
      return { ...existing };
    }
    const record: ProjectRecord = {
      id: randomUUID(),
      rootPath: input.rootPath,
      name: input.name,
      figmaToken: null,
      createdAt: now,
      lastSeenAt: now
    };
    this.projects.set(input.rootPath, record);
    return { ...record };
  }

  async getProjectByPath(rootPath: string): Promise<ProjectRecord | null> {
    const found = this.projects.get(rootPath);
    return found ? { ...found } : null;
  }

  async setFigmaToken(rootPath: string, token: string | null): Promise<void> {
    const project = this.projects.get(rootPath);
    if (project) project.figmaToken = token;
  }

  async listLlms(rootPath: string): Promise<ProjectLlmRecord[]> {
    return (this.llms.get(rootPath) ?? []).map((entry) => ({ ...entry }));
  }

  async upsertLlm(rootPath: string, input: UpsertLlmInput): Promise<ProjectLlmRecord> {
    const project = this.projects.get(rootPath);
    if (!project) throw new Error(`MemoryStore: project not registered: ${rootPath}`);
    const now = new Date().toISOString();
    const list = this.llms.get(rootPath) ?? [];
    let record = list.find((entry) => entry.name === input.name);
    if (record) {
      record.provider = input.provider ?? record.provider;
      record.baseUrl = input.baseUrl ?? record.baseUrl;
      record.model = input.model;
      record.apiKey = input.apiKey ?? record.apiKey;
      record.updatedAt = now;
    } else {
      record = {
        id: randomUUID(),
        projectId: project.id,
        name: input.name,
        provider: input.provider ?? "custom",
        baseUrl: input.baseUrl ?? null,
        model: input.model,
        apiKey: input.apiKey ?? null,
        isActive: false,
        createdAt: now,
        updatedAt: now
      };
      list.push(record);
    }
    this.llms.set(rootPath, list);
    if (input.makeActive) await this.setActiveLlm(rootPath, input.name);
    return { ...record, isActive: this.activeName(rootPath) === input.name };
  }

  async setActiveLlm(rootPath: string, name: string): Promise<boolean> {
    const list = this.llms.get(rootPath) ?? [];
    const target = list.find((entry) => entry.name === name);
    if (!target) return false;
    for (const entry of list) entry.isActive = false;
    target.isActive = true;
    target.updatedAt = new Date().toISOString();
    return true;
  }

  async getModelCache(rootPath: string, cacheKey: string): Promise<ModelCacheRecord | null> {
    const found = this.modelCaches.get(`${rootPath}\u0000${cacheKey}`);
    return found ? { ...found, models: [...found.models] } : null;
  }

  async putModelCache(rootPath: string, input: PutModelCacheInput): Promise<ModelCacheRecord> {
    const project = this.projects.get(rootPath);
    if (!project) throw new Error(`MemoryStore: project not registered: ${rootPath}`);
    const key = `${rootPath}\u0000${input.cacheKey}`;
    const now = new Date().toISOString();
    const existing = this.modelCaches.get(key);
    const record: ModelCacheRecord = existing
      ? {
          ...existing,
          baseUrl: input.baseUrl,
          models: input.models !== undefined ? [...input.models] : existing.models,
          fetchedAt:
            input.models !== undefined
              ? (input.fetchedAt ?? now)
              : existing.fetchedAt,
          lastError: input.lastError ?? null,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          projectId: project.id,
          cacheKey: input.cacheKey,
          baseUrl: input.baseUrl,
          models: input.models ? [...input.models] : [],
          fetchedAt: input.fetchedAt ?? null,
          lastError: input.lastError ?? null,
          updatedAt: now
        };
    this.modelCaches.set(key, record);
    return { ...record, models: [...record.models] };
  }

  async recordTask(input: RecordTaskInput): Promise<void> {
    const project = this.projects.get(input.rootPath);
    this.tasks.push({
      id: randomUUID(),
      projectId: project?.id ?? null,
      traceId: input.traceId,
      caseId: input.caseId ?? null,
      model: input.model ?? null,
      profile: input.profile ?? null,
      status: input.status,
      taskDesc: input.taskDesc ?? null,
      submittedAt: new Date().toISOString(),
      finishedAt: input.finishedAt ?? null
    });
  }

  async listTasks(rootPath: string, limit = 20): Promise<TaskStatRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.tasks
      .filter((task) => task.projectId === project.id)
      .slice(-limit)
      .reverse()
      .map((task) => ({ ...task }));
  }

  async listPendingTasks(rootPath: string, limit = 20): Promise<TaskStatRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.tasks
      .filter((task) => task.projectId === project.id && task.status === "submitted")
      .slice(0, limit)
      .map((task) => ({ ...task }));
  }

  async markTaskFinished(rootPath: string, traceId: string, status: string): Promise<boolean> {
    const project = this.projects.get(rootPath);
    if (!project) return false;
    let updated = false;
    for (const task of this.tasks) {
      if (task.projectId === project.id && task.traceId === traceId) {
        task.status = status;
        task.finishedAt = new Date().toISOString();
        updated = true;
      }
    }
    return updated;
  }

  async recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord> {
    const project = this.projects.get(input.rootPath);
    const record: CaseSetRecord = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      source: input.source,
      designName: input.designName ?? null,
      fingerprint: input.fingerprint ?? null,
      basename: input.basename,
      features: input.features.map((feature) => ({ ...feature, screens: [...feature.screens] }))
    };
    this.caseSets.push(record);
    return cloneCaseSet(record);
  }

  async listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    const all = this.caseSets
      .filter((record) => record.projectId === project.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return (limit === undefined ? all : all.slice(0, limit)).map(cloneCaseSet);
  }

  async createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord> {
    const project = this.projects.get(input.rootPath);
    const record: RegressionTaskRecord = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null,
      refs: input.refs.map((ref) => ({ ...ref })),
      platforms: [...input.platforms],
      baseline: input.baseline,
      status: "pending",
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      runIds: []
    };
    this.regressionTasks.push(record);
    return cloneRegressionTask(record);
  }

  async getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null> {
    const project = this.projects.get(rootPath);
    if (!project) return null;
    const found = this.regressionTasks.find(
      (task) => task.projectId === project.id && task.id === id
    );
    return found ? cloneRegressionTask(found) : null;
  }

  async listRegressionTasks(rootPath: string, limit = 50): Promise<RegressionTaskRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.regressionTasks
      .filter((task) => task.projectId === project.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map(cloneRegressionTask);
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
    const project = this.projects.get(rootPath);
    if (!project) return false;
    const task = this.regressionTasks.find(
      (entry) => entry.projectId === project.id && entry.id === id
    );
    if (!task) return false;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.runIds !== undefined) task.runIds = [...patch.runIds];
    if (patch.claimedBy !== undefined) task.claimedBy = patch.claimedBy;
    if (patch.claimedAt !== undefined) task.claimedAt = patch.claimedAt;
    return true;
  }

  async claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
  }): Promise<RegressionTaskRecord | null> {
    const project = this.projects.get(input.rootPath);
    if (!project) return null;
    const candidates = this.regressionTasks
      .filter((task) => task.projectId === project.id && task.status === "pending")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const fullMatch = candidates.find(
      (task) =>
        task.platforms.length > 0 &&
        task.platforms.every((platform) => input.platforms.includes(platform))
    );
    let match = fullMatch;
    if (!match && input.allowPartial === true && input.onlineBefore !== undefined) {
      const onlineBefore = input.onlineBefore;
      const otherOnline = this.runners
        .filter(
          (runner) =>
            runner.projectId === project.id &&
            runner.id !== input.runnerId &&
            runner.lastSeenAt > onlineBefore
        )
        .map((runner) => runner.platforms);
      for (const task of candidates) {
        const intersection = task.platforms.filter((platform) =>
          input.platforms.includes(platform)
        );
        if (intersection.length === 0) continue;
        const coveredByOther = otherOnline.some((platforms) =>
          task.platforms.every((platform) => platforms.includes(platform))
        );
        if (coveredByOther) continue;
        match = task;
        break;
      }
    }
    if (!match) return null;
    match.status = "claimed";
    match.claimedBy = input.runnerId;
    match.claimedAt = new Date().toISOString();
    match.attempts += 1;
    return cloneRegressionTask(match);
  }

  async releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number> {
    const project = this.projects.get(input.rootPath);
    if (!project) return 0;
    let released = 0;
    for (const task of this.regressionTasks) {
      if (task.projectId !== project.id || task.claimedBy !== input.runnerId) continue;
      if (task.status !== "claimed" && task.status !== "running") continue;
      task.status = "pending";
      task.claimedBy = null;
      task.claimedAt = null;
      released += 1;
    }
    return released;
  }

  async releaseRegressionTask(input: {
    rootPath: string;
    runnerId: string | null;
    taskId: string;
    to?: "pending" | "failed";
  }): Promise<boolean> {
    const project = this.projects.get(input.rootPath);
    if (!project) return false;
    const task = this.regressionTasks.find(
      (entry) =>
        entry.projectId === project.id &&
        entry.id === input.taskId &&
        (input.runnerId === null ? entry.claimedBy === null : entry.claimedBy === input.runnerId)
    );
    if (!task || (task.status !== "claimed" && task.status !== "running")) return false;
    task.status = input.to === "failed" ? "failed" : "pending";
    task.claimedBy = null;
    task.claimedAt = null;
    return true;
  }

  async releaseStaleClaims(input: {
    rootPath: string;
    offlineBefore: string;
    claimedBefore: string;
  }): Promise<number> {
    const project = this.projects.get(input.rootPath);
    if (!project) return 0;
    const onlineRunnerIds = new Set(
      this.runners
        .filter(
          (runner) => runner.projectId === project.id && runner.lastSeenAt > input.offlineBefore
        )
        .map((runner) => runner.id)
    );
    let released = 0;
    for (const task of this.regressionTasks) {
      if (task.projectId !== project.id) continue;
      if (task.status !== "claimed" && task.status !== "running" && task.status !== "stopping")
        continue;
      if (task.claimedAt === null || task.claimedAt > input.claimedBefore) continue;
      if (task.claimedBy !== null && onlineRunnerIds.has(task.claimedBy)) continue;
      task.status = "pending";
      task.claimedBy = null;
      task.claimedAt = null;
      released += 1;
    }
    return released;
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const project = this.projects.get(input.rootPath);
    if (!project) throw new Error(`项目未注册：${input.rootPath}`);
    const existing = this.schedules.find(
      (entry) => entry.projectId === project.id && entry.name === input.name
    );
    if (existing) {
      throw new Error(`同名定时回归已存在：${input.name}（请用 --name 指定其他名称）`);
    }
    const record: ScheduleRecord = {
      id: randomUUID(),
      projectId: project.id,
      name: input.name,
      featureKeys: [...input.featureKeys],
      platforms: [...input.platforms],
      baseline: input.baseline,
      everyMinutes: input.everyMinutes,
      enabled: true,
      lastFiredAt: null,
      lastNote: null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null
    };
    this.schedules.push(record);
    return cloneSchedule(record);
  }

  async listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    const all = this.schedules
      .filter((entry) => entry.projectId === project.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return (limit === undefined ? all : all.slice(0, limit)).map(cloneSchedule);
  }

  async getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null> {
    const project = this.projects.get(rootPath);
    if (!project) return null;
    const found = this.schedules.find(
      (entry) => entry.projectId === project.id && entry.id === id
    );
    return found ? cloneSchedule(found) : null;
  }

  async updateSchedule(
    rootPath: string,
    id: string,
    patch: { enabled?: boolean; everyMinutes?: number; lastNote?: string | null }
  ): Promise<boolean> {
    const project = this.projects.get(rootPath);
    if (!project) return false;
    const schedule = this.schedules.find(
      (entry) => entry.projectId === project.id && entry.id === id
    );
    if (!schedule) return false;
    if (patch.enabled !== undefined) schedule.enabled = patch.enabled;
    if (patch.everyMinutes !== undefined) schedule.everyMinutes = patch.everyMinutes;
    if (patch.lastNote !== undefined) schedule.lastNote = patch.lastNote;
    return true;
  }

  async deleteSchedule(rootPath: string, id: string): Promise<boolean> {
    const project = this.projects.get(rootPath);
    if (!project) return false;
    const index = this.schedules.findIndex(
      (entry) => entry.projectId === project.id && entry.id === id
    );
    if (index < 0) return false;
    this.schedules.splice(index, 1);
    return true;
  }

  async claimScheduleWindow(input: {
    rootPath: string;
    scheduleId: string;
    firedAt: string;
    cutoff: string;
  }): Promise<boolean> {
    const project = this.projects.get(input.rootPath);
    if (!project) return false;
    const schedule = this.schedules.find(
      (entry) => entry.projectId === project.id && entry.id === input.scheduleId
    );
    if (!schedule || !schedule.enabled) return false;
    if (schedule.lastFiredAt !== null && schedule.lastFiredAt > input.cutoff) return false;
    schedule.lastFiredAt = input.firedAt;
    return true;
  }

  async recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord> {
    const project = this.projects.get(input.rootPath);
    const record: SuiteRunRecord = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      ...input.run,
      runner: input.run.runner ?? null,
      failureDomains: { ...input.run.failureDomains },
      comparison: input.run.comparison ?? null,
      cases: input.cases.map((entry) => ({ ...entry, jiraIssueKey: entry.jiraIssueKey ?? null }))
    };
    this.suiteRuns.push(record);
    return cloneSuiteRun(record);
  }

  async listSuiteRuns(
    rootPath: string,
    query: {
      taskId?: string;
      caseSetId?: string;
      featureKey?: string;
      platform?: string;
      limit?: number;
    } = {}
  ): Promise<SuiteRunRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.suiteRuns
      .filter((run) => run.projectId === project.id)
      .filter((run) => query.taskId === undefined || run.regressionTaskId === query.taskId)
      .filter((run) => query.caseSetId === undefined || run.caseSetId === query.caseSetId)
      .filter((run) => query.featureKey === undefined || run.featureKey === query.featureKey)
      .filter((run) => query.platform === undefined || run.platform === query.platform)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, query.limit ?? 50)
      .map(cloneSuiteRun);
  }

  async markSuiteRunFinishedByRunId(
    rootPath: string,
    runId: string,
    status: "completed" | "failed"
  ): Promise<boolean> {
    const project = this.projects.get(rootPath);
    if (!project) return false;
    let updated = false;
    for (const run of this.suiteRuns) {
      if (run.projectId === project.id && run.runId === runId) {
        run.status = status;
        updated = true;
      }
    }
    return updated;
  }

  async updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean> {
    const project = this.projects.get(input.rootPath);
    if (!project) return false;
    const run = this.suiteRuns.find(
      (entry) => entry.projectId === project.id && entry.id === input.runId
    );
    if (!run) return false;
    const target = run.cases.find((entry) => entry.caseId === input.caseId);
    if (!target) return false;
    target.verdict = input.verdict;
    target.verdictBy = input.verdictBy ?? null;
    target.verdictAt = new Date().toISOString();
    target.verdictNote = input.verdictNote ?? null;
    return true;
  }

  async setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean> {
    const project = this.projects.get(input.rootPath);
    if (!project) return false;
    const run = this.suiteRuns.find(
      (entry) => entry.projectId === project.id && entry.id === input.runId
    );
    if (!run) return false;
    const target = run.cases.find((entry) => entry.caseId === input.caseId);
    if (!target) return false;
    target.jiraIssueKey = input.jiraKey;
    return true;
  }

  async getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null> {
    const project = this.projects.get(rootPath);
    if (!project) return null;
    const run = this.suiteRuns.find(
      (entry) => entry.projectId === project.id && entry.id === runId
    );
    return run ? cloneSuiteRun(run) : null;
  }

  async listRegisteredManifestPaths(rootPath: string): Promise<string[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.suiteRuns.flatMap((run) =>
      run.projectId === project.id && run.manifestPath !== null ? [run.manifestPath] : []
    );
  }

  async getEarliestRegistrationCreatedAt(
    rootPath: string
  ): Promise<{ runs: string | null; caseSets: string | null }> {
    const project = this.projects.get(rootPath);
    if (!project) return { runs: null, caseSets: null };
    const runTimes = this.suiteRuns
      .filter((run) => run.projectId === project.id)
      .map((run) => run.createdAt);
    const caseSetTimes = this.caseSets
      .filter((set) => set.projectId === project.id)
      .map((set) => set.createdAt);
    return {
      runs: minIso(runTimes),
      caseSets: minIso(caseSetTimes)
    };
  }

  async upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord> {
    const project = this.projects.get(input.rootPath);
    if (!project) throw new Error(`项目未注册：${input.rootPath}`);
    const now = new Date().toISOString();
    const hostId = input.hostId ?? null;
    const instanceId = input.instanceId ?? null;
    const existing = this.runners.find(
      (entry) => entry.projectId === project.id && entry.name === input.name
    );
    if (existing) {
      existing.hostname = input.hostname;
      existing.platforms = [...input.platforms];
      existing.devices = input.devices.map((device) => ({ ...device }));
      existing.tools = { ...input.tools };
      existing.artifactBaseUrl = input.artifactBaseUrl ?? null;
      existing.version = input.version ?? null;
      existing.hostId = hostId;
      existing.instanceId = instanceId;
      existing.lastSeenAt = now;
      return cloneRunner(existing);
    }
    const record: RunnerRecord = {
      id: randomUUID(),
      projectId: project.id,
      name: input.name,
      hostname: input.hostname,
      platforms: [...input.platforms],
      devices: input.devices.map((device) => ({ ...device })),
      tools: { ...input.tools },
      artifactBaseUrl: input.artifactBaseUrl ?? null,
      version: input.version ?? null,
      hostId,
      instanceId,
      lastSeenAt: now,
      createdAt: now
    };
    this.runners.push(record);
    return cloneRunner(record);
  }

  async listRunners(rootPath: string, limit = 20): Promise<RunnerRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.runners
      .filter((entry) => entry.projectId === project.id)
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
      .slice(0, limit)
      .map(cloneRunner);
  }

  async upsertHost(input: UpsertHostInput): Promise<HostRecord> {
    const now = new Date().toISOString();
    const existing = this.hosts.find((host) => host.id === input.id);
    if (existing) {
      if (input.hostname !== undefined) existing.hostname = input.hostname;
      if (input.hardwareId !== undefined) existing.hardwareId = input.hardwareId;
      if (input.username !== undefined) existing.username = input.username;
      if (input.osPlatform !== undefined) existing.osPlatform = input.osPlatform;
      if (input.osVersion !== undefined) existing.osVersion = input.osVersion;
      if (input.arch !== undefined) existing.arch = input.arch;
      if (input.identitySource !== undefined) existing.identitySource = input.identitySource;
      if (input.kind !== undefined) existing.kind = input.kind;
      if (input.capabilities !== undefined) existing.capabilities = [...input.capabilities];
      if (input.env !== undefined) existing.env = { ...input.env };
      if (input.envAt !== undefined) existing.envAt = input.envAt;
      if (input.ipPrimary !== undefined) existing.ipPrimary = input.ipPrimary;
      if (input.clientSeenAt !== undefined) {
        existing.clientSeenAt = maxIso(existing.clientSeenAt, input.clientSeenAt);
      }
      if (input.runnerSeenAt !== undefined) {
        existing.runnerSeenAt = maxIso(existing.runnerSeenAt, input.runnerSeenAt);
      }
      existing.lastSeenAt = maxIso(existing.lastSeenAt, existing.clientSeenAt, existing.runnerSeenAt);
      return cloneHost(existing);
    }
    const record: HostRecord = {
      id: input.id,
      hardwareId: input.hardwareId ?? null,
      hostname: input.hostname ?? "",
      username: input.username ?? null,
      osPlatform: input.osPlatform ?? "other",
      osVersion: input.osVersion ?? null,
      arch: input.arch ?? null,
      identitySource: input.identitySource ?? "file",
      kind: input.kind ?? "other",
      capabilities: [...(input.capabilities ?? [])],
      env: { ...(input.env ?? {}) },
      envAt: input.envAt ?? null,
      ipPrimary: input.ipPrimary ?? null,
      label: null,
      owner: null,
      expectedOs: null,
      expectedHostname: null,
      registeredAt: null,
      registeredBy: null,
      clientSeenAt: input.clientSeenAt ?? null,
      runnerSeenAt: input.runnerSeenAt ?? null,
      lastSeenAt: input.firstSeenAt ?? now,
      queuePaused: false,
      queuePausedAt: null,
      queuePausedBy: null,
      firstSeenAt: input.firstSeenAt ?? now,
      createdAt: input.createdAt ?? now
    };
    record.lastSeenAt = maxIso(
      record.lastSeenAt,
      record.clientSeenAt,
      record.runnerSeenAt
    );
    this.hosts.push(record);
    return cloneHost(record);
  }

  async getHost(id: string): Promise<HostRecord | null> {
    const found = this.hosts.find((host) => host.id === id);
    return found ? cloneHost(found) : null;
  }

  async listHosts(): Promise<HostRecord[]> {
    return [...this.hosts]
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))
      .map(cloneHost);
  }

  async updateHostRegistration(input: {
    id: string;
    label?: string | null;
    owner?: string | null;
    expectedOs?: string | null;
    expectedHostname?: string | null;
    registeredBy: string;
  }): Promise<HostRecord | null> {
    const host = this.hosts.find((entry) => entry.id === input.id);
    if (!host) return null;
    if (input.label !== undefined) host.label = input.label;
    if (input.owner !== undefined) host.owner = input.owner;
    if (input.expectedOs !== undefined) host.expectedOs = input.expectedOs;
    if (input.expectedHostname !== undefined) host.expectedHostname = input.expectedHostname;
    host.registeredAt = new Date().toISOString();
    host.registeredBy = input.registeredBy;
    return cloneHost(host);
  }

  async upsertHostAddresses(input: {
    hostId: string;
    addresses: HostAddressInput[];
    at?: string;
    maxPerSource?: number;
  }): Promise<void> {
    const at = input.at ?? new Date().toISOString();
    const maxPerSource = input.maxPerSource ?? 20;
    for (const address of input.addresses) {
      const existing = this.hostAddresses.find(
        (row) =>
          row.hostId === input.hostId &&
          row.source === address.source &&
          row.iface === address.iface &&
          row.address === address.address
      );
      if (existing) {
        existing.lastSeenAt = maxIso(existing.lastSeenAt, at);
      } else {
        this.hostAddresses.push({
          hostId: input.hostId,
          source: address.source,
          iface: address.iface,
          family: address.family,
          address: address.address,
          firstSeenAt: at,
          lastSeenAt: at
        });
      }
    }
    if (maxPerSource > 0) {
      const bySource = new Map<string, HostAddressRecord[]>();
      for (const row of this.hostAddresses) {
        if (row.hostId !== input.hostId) continue;
        const bucket = bySource.get(row.source) ?? [];
        bucket.push(row);
        bySource.set(row.source, bucket);
      }
      const keep = new Set<HostAddressRecord>();
      for (const rows of bySource.values()) {
        rows.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
        for (const row of rows.slice(0, maxPerSource)) keep.add(row);
      }
      this.hostAddresses = this.hostAddresses.filter(
        (row) => row.hostId !== input.hostId || keep.has(row)
      );
    }
  }

  async listHostAddresses(hostId: string): Promise<HostAddressRecord[]> {
    return this.hostAddresses
      .filter((row) => row.hostId === hostId)
      .sort(
        (a, b) =>
          b.lastSeenAt.localeCompare(a.lastSeenAt) || a.address.localeCompare(b.address)
      )
      .map(cloneHostAddress);
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
    const at = input.at ?? new Date().toISOString();
    const existing = this.hostSessions.find((session) => session.id === input.id);
    if (existing) {
      existing.lastSeenAt = maxIso(existing.lastSeenAt, at);
      existing.endedAt = null;
      return cloneHostSession(existing);
    }
    const record: HostSessionRecord = {
      id: input.id,
      hostId: input.hostId,
      projectId: input.projectId,
      rootPath: input.rootPath,
      username: input.username,
      client: input.client,
      clientVersion: input.clientVersion,
      pid: input.pid,
      startedAt: at,
      lastSeenAt: at,
      endedAt: null
    };
    this.hostSessions.push(record);
    return cloneHostSession(record);
  }

  async endHostSession(id: string, at?: string): Promise<boolean> {
    const session = this.hostSessions.find((entry) => entry.id === id);
    if (!session) return false;
    session.endedAt = at ?? new Date().toISOString();
    return true;
  }

  async listHostSessions(
    hostId: string,
    options: { limit?: number; onlineWithinMs?: number; now?: number } = {}
  ): Promise<HostSessionRecord[]> {
    const nowMs = options.now ?? Date.now();
    const cutoff =
      options.onlineWithinMs === undefined
        ? null
        : new Date(nowMs - options.onlineWithinMs).toISOString();
    const rows = this.hostSessions
      .filter((session) => session.hostId === hostId && session.endedAt === null)
      .filter((session) => cutoff === null || session.lastSeenAt > cutoff)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.id.localeCompare(a.id));
    return (options.limit === undefined ? rows : rows.slice(0, options.limit)).map(
      cloneHostSession
    );
  }

  async setHostQueuePaused(input: {
    hostId: string;
    paused: boolean;
    by: string;
    at?: string;
  }): Promise<HostRecord | null> {
    const host = this.hosts.find((entry) => entry.id === input.hostId);
    if (!host) return null;
    host.queuePaused = input.paused;
    host.queuePausedAt = input.paused ? input.at ?? new Date().toISOString() : null;
    host.queuePausedBy = input.paused ? input.by : null;
    return cloneHost(host);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy: UsagePrunePolicy = {}
  ): Promise<UsageEventRecord> {
    const project = this.projects.get(rootPath);
    const record = buildUsageEvent(input, project?.id ?? null);
    this.usageEvents.push(record);
    this.pruneUsageEvents(record.projectId, policy);
    return cloneUsageEvent(record);
  }

  async listUsageEvents(rootPath: string, query: UsageEventQuery = {}): Promise<UsageEventRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.usageEvents
      .filter((event) => event.projectId === project.id)
      .filter((event) => !query.tool || event.tool === query.tool)
      .filter((event) => !query.status || (query.status === "ok" ? event.ok : !event.ok))
      .filter((event) => !query.since || event.at >= query.since)
      .filter((event) => !query.until || event.at <= query.until)
      .sort(byNewestUsageEvent)
      .slice(0, normalizeUsageLimit(query.limit))
      .map(cloneUsageEvent);
  }

  async recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord> {
    const record = buildAuditEvent(rootPath, input);
    this.auditEvents.push(record);
    return cloneAuditEvent(record);
  }

  async recordProjectEvent(
    rootPath: string,
    input: ProjectEventInput
  ): Promise<RecordProjectEventResult> {
    const project = this.projects.get(rootPath);
    if (!project) throw new Error(`MemoryStore: project not registered: ${rootPath}`);
    const hash = payloadHash(input.payload);
    const existing = this.projectEvents.find(
      (event) => event.projectId === project.id && event.eventId === input.eventId
    );
    if (existing) {
      return {
        record: cloneProjectEvent(existing),
        duplicate: true,
        payloadMismatch: existing.payloadSha256 !== hash
      };
    }
    const seq = (this.projectEventSeq.get(rootPath) ?? 0) + 1;
    this.projectEventSeq.set(rootPath, seq);
    const receivedAt = new Date().toISOString();
    const record: ProjectEventRecord = {
      seq,
      id: randomUUID(),
      projectId: project.id,
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
    this.projectEvents.push(record);
    return { record: cloneProjectEvent(record), duplicate: false, payloadMismatch: false };
  }

  async listProjectEvents(
    rootPath: string,
    query: ProjectEventQuery = {}
  ): Promise<ProjectEventRecord[]> {
    const project = this.projects.get(rootPath);
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
    return this.projectEvents
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
  }

  async markProjectEventsConsumed(
    rootPath: string,
    eventIds: string[],
    consumedAt: string = new Date().toISOString()
  ): Promise<number> {
    const project = this.projects.get(rootPath);
    if (!project) return 0;
    const ids = new Set(eventIds);
    let changed = 0;
    for (const event of this.projectEvents) {
      if (event.projectId !== project.id || !ids.has(event.eventId) || event.consumedAt !== null) {
        continue;
      }
      event.consumedAt = consumedAt;
      changed += 1;
    }
    return changed;
  }

  async countProjectEvents(rootPath: string): Promise<number> {
    const project = this.projects.get(rootPath);
    if (!project) return 0;
    return this.projectEvents.filter((event) => event.projectId === project.id).length;
  }

  async pruneProjectEvents(rootPath: string): Promise<number> {
    const project = this.projects.get(rootPath);
    if (!project) return 0;
    const policy = eventRetentionPolicy();
    const cutoff = eventCutoffIso(policy.days);
    const before = this.projectEvents.length;
    this.projectEvents = this.projectEvents.filter(
      (event) => event.projectId !== project.id || event.receivedAt >= cutoff
    );
    const remaining = this.projectEvents
      .filter((event) => event.projectId === project.id)
      .sort((left, right) => left.seq - right.seq);
    const overflow = Math.max(0, remaining.length - policy.max);
    if (overflow > 0) {
      const remove = new Set(remaining.slice(0, overflow).map((event) => event.id));
      this.projectEvents = this.projectEvents.filter((event) => !remove.has(event.id));
    }
    return before - this.projectEvents.length;
  }

  async listAudit(rootPath: string, query: AuditQuery = {}): Promise<AuditEventRecord[]> {
    const offset =
      typeof query.offset === "number" && Number.isFinite(query.offset) && query.offset > 0
        ? Math.floor(query.offset)
        : 0;
    return this.auditEvents
      .filter((event) => event.rootPath === rootPath)
      .filter((event) => !query.domain || event.domain === query.domain)
      .filter((event) => !query.result || event.result === query.result)
      .filter((event) => !query.since || event.at >= query.since)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .slice(offset, offset + normalizeAuditLimit(query.limit))
      .map(cloneAuditEvent);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .sort(
        (a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.name.localeCompare(b.name)
      )
      .map((project) => ({ ...project }));
  }

  usageEventCount(): number {
    return this.usageEvents.length;
  }

  exportState(): MemoryStoreState {
    return {
      projects: [...this.projects.values()].map((project) => ({ ...project })),
      llms: [...this.llms.entries()].map(([rootPath, entries]) => ({
        rootPath,
        entries: entries.map((entry) => ({ ...entry }))
      })),
      modelCaches: [...this.modelCaches.entries()].map(([key, record]) => ({
        key,
        record: { ...record, models: [...record.models] }
      })),
      tasks: this.tasks.map((task) => ({ ...task })),
      usageEvents: this.usageEvents.map(cloneUsageEvent),
      caseSets: this.caseSets.map(cloneCaseSet),
      regressionTasks: this.regressionTasks.map(cloneRegressionTask),
      suiteRuns: this.suiteRuns.map(cloneSuiteRun),
      runners: this.runners.map(cloneRunner),
      schedules: this.schedules.map(cloneSchedule),
      auditEvents: this.auditEvents.map(cloneAuditEvent),
      hosts: this.hosts.map(cloneHost),
      hostAddresses: this.hostAddresses.map(cloneHostAddress),
      hostSessions: this.hostSessions.map(cloneHostSession)
    };
  }

  importState(data: Partial<MemoryStoreState>): void {
    if (data.projects) {
      this.projects = new Map(data.projects.map((project) => [project.rootPath, { ...project }]));
    }
    if (data.llms) {
      this.llms = new Map(
        data.llms.map((bucket) => [bucket.rootPath, bucket.entries.map((entry) => ({ ...entry }))])
      );
    }
    if (data.modelCaches) {
      this.modelCaches = new Map(
        data.modelCaches.map((entry) => [entry.key, { ...entry.record, models: [...entry.record.models] }])
      );
    }
    if (data.tasks) this.tasks = data.tasks.map((task) => ({ ...task }));
    if (data.usageEvents) this.usageEvents = data.usageEvents.map(cloneUsageEvent);
    if (data.caseSets) this.caseSets = data.caseSets.map(cloneCaseSet);
    if (data.regressionTasks) this.regressionTasks = data.regressionTasks.map(cloneRegressionTask);
    if (data.suiteRuns) this.suiteRuns = data.suiteRuns.map(cloneSuiteRun);
    if (data.runners) this.runners = data.runners.map(cloneRunner);
    if (data.schedules) this.schedules = data.schedules.map(cloneSchedule);
    if (data.auditEvents) this.auditEvents = data.auditEvents.map(cloneAuditEvent);
    if (data.hosts) this.hosts = data.hosts.map(cloneHost);
    if (data.hostAddresses) this.hostAddresses = data.hostAddresses.map(cloneHostAddress);
    if (data.hostSessions) this.hostSessions = data.hostSessions.map(cloneHostSession);
  }

  private pruneUsageEvents(projectId: string | null, policy: UsagePrunePolicy): void {
    const inBucket = (event: UsageEventRecord): boolean => event.projectId === projectId;
    const retentionDays = policy.retentionDays ?? 0;
    if (retentionDays > 0) {
      const cutoff = retentionCutoffIso(retentionDays);
      this.usageEvents = this.usageEvents.filter(
        (event) => !inBucket(event) || event.at >= cutoff
      );
    }
    const maxEvents = policy.maxEvents ?? 0;
    if (maxEvents > 0) {
      const keep = new Set(
        this.usageEvents
          .filter(inBucket)
          .sort(byNewestUsageEvent)
          .slice(0, maxEvents)
          .map((event) => event.id)
      );
      this.usageEvents = this.usageEvents.filter(
        (event) => !inBucket(event) || keep.has(event.id)
      );
    }
  }

  async close(): Promise<void> {
    /* nothing to do */
  }

  taskCount(): number {
    return this.tasks.length;
  }

  private activeName(rootPath: string): string | null {
    const list = this.llms.get(rootPath) ?? [];
    return list.find((entry) => entry.isActive)?.name ?? null;
  }
}

function byNewestUsageEvent(a: UsageEventRecord, b: UsageEventRecord): number {
  return b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
}

function minIso(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => (a < b ? a : b));
}

function cloneUsageEvent(event: UsageEventRecord): UsageEventRecord {
  return {
    ...event,
    signals: event.signals.map((signal) => ({ ...signal })),
    argKeys: [...event.argKeys],
    hostId: event.hostId ?? null,
    sessionId: event.sessionId ?? null
  };
}

function cloneCaseSet(record: CaseSetRecord): CaseSetRecord {
  return {
    ...record,
    features: record.features.map((feature) => ({ ...feature, screens: [...feature.screens] }))
  };
}

function cloneRegressionTask(task: RegressionTaskRecord): RegressionTaskRecord {
  return {
    ...task,
    refs: task.refs.map((ref) => ({ ...ref })),
    platforms: [...task.platforms],
    runIds: [...task.runIds]
  };
}

function cloneSuiteRun(run: SuiteRunRecord): SuiteRunRecord {
  return {
    ...run,
    failureDomains: { ...run.failureDomains },
    cases: run.cases.map((entry) => ({ ...entry, jiraIssueKey: entry.jiraIssueKey ?? null }))
  };
}

function cloneRunner(record: RunnerRecord): RunnerRecord {
  return {
    ...record,
    platforms: [...record.platforms],
    devices: record.devices.map((device) => ({ ...device })),
    tools: { ...record.tools },
    hostId: record.hostId ?? null,
    instanceId: record.instanceId ?? null
  };
}

function cloneSchedule(record: ScheduleRecord): ScheduleRecord {
  return {
    ...record,
    featureKeys: [...record.featureKeys],
    platforms: [...record.platforms]
  };
}

function cloneHost(record: HostRecord): HostRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    env: { ...record.env }
  };
}

function cloneHostAddress(record: HostAddressRecord): HostAddressRecord {
  return { ...record };
}

function cloneHostSession(record: HostSessionRecord): HostSessionRecord {
  return { ...record };
}

function maxIso(...values: Array<string | null | undefined>): string {
  let best = "";
  for (const value of values) {
    if (typeof value === "string" && value > best) best = value;
  }
  return best;
}

function cloneProjectEvent(record: ProjectEventRecord, omitPayload = false): ProjectEventRecord {
  return {
    ...record,
    payload: omitPayload ? undefined : record.payload
  };
}
