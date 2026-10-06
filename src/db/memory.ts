import { randomUUID } from "node:crypto";

import { buildUsageEvent, normalizeUsageLimit, retentionCutoffIso } from "./usage-event.js";

import type {
  ModelCacheRecord,
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  PutModelCacheInput,
  RecordTaskInput,
  RecordUsageEventInput,
  TaskStatRecord,
  UpsertLlmInput,
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
