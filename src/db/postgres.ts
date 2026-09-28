import { randomUUID } from "node:crypto";

import type {
  ProjectLlmRecord,
  ProjectRecord,
  ProjectStore,
  RecordTaskInput,
  TaskStatRecord,
  UpsertLlmInput
} from "./types.js";

/** Minimal pool surface — lets tests inject `pg-mem` and keeps SQL portable. */
export interface PoolLike {
  query(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  end?(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     root_path TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     figma_token TEXT,
     created_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS project_llms (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     provider TEXT NOT NULL DEFAULT 'custom',
     base_url TEXT,
     model TEXT NOT NULL,
     api_key TEXT,
     is_active BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (project_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS task_stats (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     trace_id TEXT NOT NULL,
     model TEXT,
     profile TEXT,
     status TEXT NOT NULL,
     task_desc TEXT,
     submitted_at TEXT NOT NULL,
     finished_at TEXT
   )`
];

export class PostgresStore implements ProjectStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: PoolLike) {}

  static async create(connectionString: string): Promise<PostgresStore> {
    const pgModule = await import("pg");
    const Pool = (pgModule as { default?: { Pool: new (config: unknown) => unknown } }).default
      ?.Pool ?? (pgModule as unknown as { Pool: new (config: unknown) => unknown }).Pool;
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, max: 5 });
    const store = new PostgresStore(pool as unknown as PoolLike);
    await store.init();
    return store;
  }

  async init(): Promise<void> {
    for (const statement of SCHEMA) {
      await this.pool.query(statement);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async upsertProject(input: { rootPath: string; name: string }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const existing = await this.pool.query("SELECT * FROM projects WHERE root_path = $1", [
      input.rootPath
    ]);
    if (existing.rows.length > 0) {
      await this.pool.query("UPDATE projects SET name = $2, last_seen_at = $3 WHERE root_path = $1", [
        input.rootPath,
        input.name,
        now
      ]);
      const refreshed = await this.pool.query("SELECT * FROM projects WHERE root_path = $1", [
        input.rootPath
      ]);
      return mapProject(refreshed.rows[0]!);
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO projects (id, root_path, name, figma_token, created_at, last_seen_at)
       VALUES ($1, $2, $3, NULL, $4, $4)`,
      [id, input.rootPath, input.name, now]
    );
    const inserted = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    return mapProject(inserted.rows[0]!);
  }

  async getProjectByPath(rootPath: string): Promise<ProjectRecord | null> {
    const result = await this.pool.query("SELECT * FROM projects WHERE root_path = $1", [rootPath]);
    return result.rows.length > 0 ? mapProject(result.rows[0]!) : null;
  }

  async setFigmaToken(rootPath: string, token: string | null): Promise<void> {
    await this.pool.query("UPDATE projects SET figma_token = $2 WHERE root_path = $1", [
      rootPath,
      token
    ]);
  }

  async listLlms(rootPath: string): Promise<ProjectLlmRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      "SELECT * FROM project_llms WHERE project_id = $1 ORDER BY created_at ASC, name ASC",
      [project.id]
    );
    return result.rows.map(mapLlm);
  }

  async upsertLlm(rootPath: string, input: UpsertLlmInput): Promise<ProjectLlmRecord> {
    const project = await this.upsertProject({ rootPath, name: projectName(rootPath) });
    const now = new Date().toISOString();
    const existing = await this.pool.query(
      "SELECT * FROM project_llms WHERE project_id = $1 AND name = $2",
      [project.id, input.name]
    );

    let id: string;
    if (existing.rows.length > 0) {
      id = String(existing.rows[0]!.id);
      await this.pool.query(
        `UPDATE project_llms
            SET provider = $3, base_url = $4, model = $5, api_key = $6, updated_at = $7
          WHERE id = $1 AND project_id = $2`,
        [
          id,
          project.id,
          input.provider ?? "custom",
          input.baseUrl ?? null,
          input.model,
          input.apiKey ?? null,
          now
        ]
      );
    } else {
      id = randomUUID();
      await this.pool.query(
        `INSERT INTO project_llms
           (id, project_id, name, provider, base_url, model, api_key, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $8)`,
        [
          id,
          project.id,
          input.name,
          input.provider ?? "custom",
          input.baseUrl ?? null,
          input.model,
          input.apiKey ?? null,
          now
        ]
      );
    }

    if (input.makeActive) {
      await this.setActiveLlm(rootPath, input.name);
    }

    const result = await this.pool.query("SELECT * FROM project_llms WHERE id = $1", [id]);
    return mapLlm(result.rows[0]!);
  }

  async setActiveLlm(rootPath: string, name: string): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const now = new Date().toISOString();
    await this.pool.query(
      "UPDATE project_llms SET is_active = FALSE WHERE project_id = $1 AND is_active = TRUE",
      [project.id]
    );
    const updated = await this.pool.query(
      `UPDATE project_llms SET is_active = TRUE, updated_at = $3
        WHERE project_id = $1 AND name = $2 RETURNING id`,
      [project.id, name, now]
    );
    return updated.rows.length > 0;
  }

  async recordTask(input: RecordTaskInput): Promise<void> {
    const project = await this.getProjectByPath(input.rootPath);
    await this.pool.query(
      `INSERT INTO task_stats
         (id, project_id, trace_id, model, profile, status, task_desc, submitted_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
      [
        randomUUID(),
        project?.id ?? null,
        input.traceId,
        input.model ?? null,
        input.profile ?? null,
        input.status,
        input.taskDesc ?? null,
        new Date().toISOString()
      ]
    );
  }

  async listTasks(rootPath: string, limit = 20): Promise<TaskStatRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      "SELECT * FROM task_stats WHERE project_id = $1 ORDER BY submitted_at DESC LIMIT $2",
      [project.id, limit]
    );
    return result.rows.map(mapTask);
  }

  async listPendingTasks(rootPath: string, limit = 20): Promise<TaskStatRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      "SELECT * FROM task_stats WHERE project_id = $1 AND status = 'submitted' ORDER BY submitted_at ASC LIMIT $2",
      [project.id, limit]
    );
    return result.rows.map(mapTask);
  }

  async markTaskFinished(rootPath: string, traceId: string, status: string): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const updated = await this.pool.query(
      `UPDATE task_stats SET status = $3, finished_at = $4
        WHERE project_id = $1 AND trace_id = $2 AND status = 'submitted' RETURNING id`,
      [project.id, traceId, status, new Date().toISOString()]
    );
    return updated.rows.length > 0;
  }

  async close(): Promise<void> {
    try {
      await this.pool.end?.();
    } catch {
      /* best effort */
    }
  }
}

function projectName(rootPath: string): string {
  const parts = rootPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? rootPath;
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    rootPath: String(row.root_path),
    name: String(row.name),
    figmaToken: row.figma_token === null || row.figma_token === undefined ? null : String(row.figma_token),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at)
  };
}

function mapLlm(row: Record<string, unknown>): ProjectLlmRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    provider: String(row.provider),
    baseUrl: row.base_url === null || row.base_url === undefined ? null : String(row.base_url),
    model: String(row.model),
    apiKey: row.api_key === null || row.api_key === undefined ? null : String(row.api_key),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapTask(row: Record<string, unknown>): TaskStatRecord {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    traceId: String(row.trace_id),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    profile: row.profile === null || row.profile === undefined ? null : String(row.profile),
    status: String(row.status),
    taskDesc: row.task_desc === null || row.task_desc === undefined ? null : String(row.task_desc),
    submittedAt: String(row.submitted_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at)
  };
}
