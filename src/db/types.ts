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
