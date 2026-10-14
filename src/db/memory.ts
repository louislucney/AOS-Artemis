import { randomUUID } from "node:crypto";

import { buildUsageEvent, normalizeUsageLimit, retentionCutoffIso } from "./usage-event.js";

import type {
  CaseSetRecord,
  CreateRegressionTaskInput,
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
  SuiteRunRecord,
  TaskStatRecord,
  UpdateCaseVerdictInput,
  UpsertLlmInput,
  UpsertRunnerInput,
  UsageEventQuery,
  UsageEventRecord,
  UsagePrunePolicy
} from "./types.js";

/** In-session fallback when PostgreSQL is unavailable (degraded mode). */
export class MemoryStore implements ProjectStore {
  readonly kind = "memory" as const;
  private projects = new Map<string, ProjectRecord>();
  private llms = new Map<string, ProjectLlmRecord[]>();
  private modelCaches = new Map<string, ModelCacheRecord>();
  private tasks: TaskStatRecord[] = [];
  private usageEvents: UsageEventRecord[] = [];
  private caseSets: CaseSetRecord[] = [];
  private regressionTasks: RegressionTaskRecord[] = [];
  private suiteRuns: SuiteRunRecord[] = [];
  private runners: RunnerRecord[] = [];

  async upsertProject(input: { rootPath: string; name: string }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const existing = this.projects.get(input.rootPath);
    if (existing) {
      existing.name = input.name;
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

  async listCaseSets(rootPath: string, limit = 50): Promise<CaseSetRecord[]> {
    const project = this.projects.get(rootPath);
    if (!project) return [];
    return this.caseSets
      .filter((record) => record.projectId === project.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map(cloneCaseSet);
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
    patch: { status?: RegressionTaskRecord["status"]; runIds?: string[] }
  ): Promise<boolean> {
    const project = this.projects.get(rootPath);
    if (!project) return false;
    const task = this.regressionTasks.find(
      (entry) => entry.projectId === project.id && entry.id === id
    );
    if (!task) return false;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.runIds !== undefined) task.runIds = [...patch.runIds];
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
      cases: input.cases.map((entry) => ({ ...entry }))
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

  async upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord> {
    const project = this.projects.get(input.rootPath);
    if (!project) throw new Error(`项目未注册：${input.rootPath}`);
    const now = new Date().toISOString();
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

function cloneUsageEvent(event: UsageEventRecord): UsageEventRecord {
  return {
    ...event,
    signals: event.signals.map((signal) => ({ ...signal })),
    argKeys: [...event.argKeys]
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
    cases: run.cases.map((entry) => ({ ...entry }))
  };
}

function cloneRunner(record: RunnerRecord): RunnerRecord {
  return {
    ...record,
    platforms: [...record.platforms],
    devices: record.devices.map((device) => ({ ...device })),
    tools: { ...record.tools }
  };
}
