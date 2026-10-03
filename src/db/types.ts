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
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled", "orphaned"] as const;
