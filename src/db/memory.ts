import { randomUUID } from "node:crypto";

import type {
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  RecordTaskInput,
  TaskStatRecord,
  UpsertLlmInput
} from "./types.js";

/** In-session fallback when PostgreSQL is unavailable (degraded mode). */
export class MemoryStore implements ProjectStore {
  readonly kind = "memory" as const;
  private projects = new Map<string, ProjectRecord>();
  private llms = new Map<string, ProjectLlmRecord[]>();
  private tasks: TaskStatRecord[] = [];

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

  async recordTask(input: RecordTaskInput): Promise<void> {
    const project = this.projects.get(input.rootPath);
    this.tasks.push({
      id: randomUUID(),
      projectId: project?.id ?? null,
      traceId: input.traceId,
      model: input.model ?? null,
      profile: input.profile ?? null,
      status: input.status,
      taskDesc: input.taskDesc ?? null,
      submittedAt: new Date().toISOString(),
      finishedAt: null
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
