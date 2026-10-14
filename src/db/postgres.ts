import { randomUUID } from "node:crypto";

import {
  buildUsageEvent,
  isUsageErrorClass,
  normalizeUsageLimit,
  retentionCutoffIso
} from "./usage-event.js";

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
  RegressionTaskRef,
  SuiteRunCaseRecord,
  SuiteRunRecord,
  TaskStatRecord,
  UpdateCaseVerdictInput,
  UpsertLlmInput,
  UsageEventQuery,
  UsageEventRecord,
  UsagePrunePolicy
} from "./types.js";

export interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

export interface PoolClientLike {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
  release?(): void;
}

/** Minimal pool surface — lets tests inject `pg-mem` and keeps SQL portable. */
export interface PoolLike {
  query(text: string, values?: unknown[]): Promise<QueryResultLike>;
  end?(): Promise<void>;
  connect?(): Promise<PoolClientLike>;
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
     case_id TEXT,
     model TEXT,
     profile TEXT,
     status TEXT NOT NULL,
     task_desc TEXT,
     submitted_at TEXT NOT NULL,
     finished_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS usage_events (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     at TEXT NOT NULL,
     tool TEXT NOT NULL,
     family TEXT NOT NULL,
     ok BOOLEAN NOT NULL,
     duration_ms INTEGER NOT NULL,
     error_class TEXT,
     error_summary TEXT,
     signals TEXT NOT NULL DEFAULT '[]',
     arg_keys TEXT NOT NULL DEFAULT '[]',
     trace_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS llm_model_cache (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     cache_key TEXT NOT NULL,
     base_url TEXT NOT NULL,
     models TEXT NOT NULL DEFAULT '[]',
     fetched_at TEXT,
     last_error TEXT,
     updated_at TEXT NOT NULL,
      UNIQUE (project_id, cache_key)
   )`,
  `CREATE TABLE IF NOT EXISTS case_sets (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     source TEXT NOT NULL,
     design_name TEXT,
     fingerprint TEXT,
     basename TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS case_set_features (
     case_set_id TEXT NOT NULL REFERENCES case_sets(id) ON DELETE CASCADE,
     feature_key TEXT NOT NULL,
     name TEXT NOT NULL,
     case_count INTEGER NOT NULL,
     screens TEXT NOT NULL DEFAULT '[]',
     json_path TEXT NOT NULL,
     md_path TEXT NOT NULL,
     xlsx_path TEXT NOT NULL,
     PRIMARY KEY (case_set_id, feature_key)
    )`,
  `CREATE TABLE IF NOT EXISTS regression_tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     created_by TEXT,
     refs TEXT NOT NULL DEFAULT '[]',
     platforms TEXT NOT NULL DEFAULT '[]',
     baseline TEXT NOT NULL DEFAULT 'latest',
     status TEXT NOT NULL DEFAULT 'pending',
     run_ids TEXT NOT NULL DEFAULT '[]'
    )`,
  `CREATE TABLE IF NOT EXISTS suite_runs (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     trigger TEXT NOT NULL,
     regression_task_id TEXT,
     case_set_id TEXT,
     feature_key TEXT,
     feature_name TEXT,
     platform TEXT NOT NULL,
     device TEXT,
     app_version TEXT,
     status TEXT NOT NULL,
     started_at TEXT NOT NULL,
     finished_at TEXT NOT NULL,
     total INTEGER NOT NULL,
     passed INTEGER NOT NULL,
     failed INTEGER NOT NULL,
     flaky INTEGER NOT NULL,
     quarantined INTEGER NOT NULL,
     failure_domains TEXT NOT NULL DEFAULT '{}',
     gate_result TEXT,
     exit_code INTEGER NOT NULL,
     manifest_path TEXT,
     comparison TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS suite_run_cases (
     run_id TEXT NOT NULL REFERENCES suite_runs(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL,
     name TEXT NOT NULL,
     feature_key TEXT,
     platform TEXT NOT NULL,
     status TEXT NOT NULL,
     trace_id TEXT,
     failure_domain TEXT,
     failure_confidence TEXT,
     failure_reason TEXT,
     duration_ms INTEGER,
     quarantined BOOLEAN NOT NULL DEFAULT FALSE,
     flaky BOOLEAN NOT NULL DEFAULT FALSE,
     verdict TEXT,
     verdict_by TEXT,
     verdict_at TEXT,
     verdict_note TEXT,
     PRIMARY KEY (run_id, case_id)
    )`
];

const MIGRATIONS = [`ALTER TABLE task_stats ADD COLUMN IF NOT EXISTS case_id TEXT`];

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
    for (const statement of MIGRATIONS) {
      try {
        await this.pool.query(statement);
      } catch {
        /* best effort: fresh schema already carries the column */
      }
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

  async getModelCache(rootPath: string, cacheKey: string): Promise<ModelCacheRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const result = await this.pool.query(
      "SELECT * FROM llm_model_cache WHERE project_id = $1 AND cache_key = $2",
      [project.id, cacheKey]
    );
    return result.rows.length > 0 ? mapModelCache(result.rows[0]!) : null;
  }

  async putModelCache(rootPath: string, input: PutModelCacheInput): Promise<ModelCacheRecord> {
    const project = await this.upsertProject({ rootPath, name: projectName(rootPath) });
    const now = new Date().toISOString();
    const existing = await this.pool.query(
      "SELECT id FROM llm_model_cache WHERE project_id = $1 AND cache_key = $2",
      [project.id, input.cacheKey]
    );
    let id: string;
    if (existing.rows.length > 0) {
      id = String(existing.rows[0]!.id);
      if (input.models !== undefined) {
        await this.pool.query(
          `UPDATE llm_model_cache
              SET base_url = $3, models = $4, fetched_at = $5, last_error = $6, updated_at = $7
            WHERE id = $1 AND project_id = $2`,
          [
            id,
            project.id,
            input.baseUrl,
            JSON.stringify(input.models),
            input.fetchedAt ?? now,
            input.lastError ?? null,
            now
          ]
        );
      } else {
        await this.pool.query(
          `UPDATE llm_model_cache SET last_error = $3, updated_at = $4
            WHERE id = $1 AND project_id = $2`,
          [id, project.id, input.lastError ?? null, now]
        );
      }
    } else {
      id = randomUUID();
      await this.pool.query(
        `INSERT INTO llm_model_cache
           (id, project_id, cache_key, base_url, models, fetched_at, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          project.id,
          input.cacheKey,
          input.baseUrl,
          JSON.stringify(input.models ?? []),
          input.fetchedAt ?? null,
          input.lastError ?? null,
          now
        ]
      );
    }
    const result = await this.pool.query("SELECT * FROM llm_model_cache WHERE id = $1", [id]);
    return mapModelCache(result.rows[0]!);
  }

  async recordTask(input: RecordTaskInput): Promise<void> {
    const project = await this.getProjectByPath(input.rootPath);
    await this.pool.query(
      `INSERT INTO task_stats
         (id, project_id, trace_id, case_id, model, profile, status, task_desc, submitted_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        project?.id ?? null,
        input.traceId,
        input.caseId ?? null,
        input.model ?? null,
        input.profile ?? null,
        input.status,
        input.taskDesc ?? null,
        new Date().toISOString(),
        input.finishedAt ?? null
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

  private async withTransaction<T>(
    fn: (run: (text: string, values?: unknown[]) => Promise<QueryResultLike>) => Promise<T>
  ): Promise<T> {
    const client = this.pool.connect ? await this.pool.connect() : null;
    const run = (text: string, values?: unknown[]): Promise<QueryResultLike> =>
      client ? client.query(text, values) : this.pool.query(text, values);
    try {
      if (client) await run("BEGIN");
      const result = await fn(run);
      if (client) await run("COMMIT");
      return result;
    } catch (error) {
      if (client) {
        try {
          await run("ROLLBACK");
        } catch {
          /* best effort */
        }
      }
      throw error;
    } finally {
      client?.release?.();
    }
  }

  async recordCaseSet(input: RecordCaseSetInput): Promise<CaseSetRecord> {
    const project = await this.getProjectByPath(input.rootPath);
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    await this.withTransaction(async (run) => {
      await run(
        `INSERT INTO case_sets (id, project_id, created_at, source, design_name, fingerprint, basename)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          project?.id ?? null,
          createdAt,
          input.source,
          input.designName ?? null,
          input.fingerprint ?? null,
          input.basename
        ]
      );
      for (const feature of input.features) {
        await run(
          `INSERT INTO case_set_features
             (case_set_id, feature_key, name, case_count, screens, json_path, md_path, xlsx_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            feature.key,
            feature.name,
            feature.caseCount,
            JSON.stringify(feature.screens),
            feature.jsonPath,
            feature.mdPath,
            feature.xlsxPath
          ]
        );
      }
    });
    return {
      id,
      projectId: project?.id ?? null,
      createdAt,
      source: input.source,
      designName: input.designName ?? null,
      fingerprint: input.fingerprint ?? null,
      basename: input.basename,
      features: input.features.map((feature) => ({ ...feature, screens: [...feature.screens] }))
    };
  }

  async listCaseSets(rootPath: string, limit = 50): Promise<CaseSetRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const sets = await this.pool.query(
      "SELECT * FROM case_sets WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2",
      [project.id, limit]
    );
    const out: CaseSetRecord[] = [];
    for (const row of sets.rows) {
      const features = await this.pool.query(
        "SELECT * FROM case_set_features WHERE case_set_id = $1 ORDER BY feature_key ASC",
        [String(row.id)]
      );
      out.push(mapCaseSet(row, features.rows));
    }
    return out;
  }

  async createRegressionTask(input: CreateRegressionTaskInput): Promise<RegressionTaskRecord> {
    const project = await this.getProjectByPath(input.rootPath);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO regression_tasks (id, project_id, created_at, created_by, refs, platforms, baseline, status, run_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        project?.id ?? null,
        createdAt,
        input.createdBy ?? null,
        JSON.stringify(input.refs),
        JSON.stringify(input.platforms),
        input.baseline,
        "pending",
        "[]"
      ]
    );
    return {
      id,
      projectId: project?.id ?? null,
      createdAt,
      createdBy: input.createdBy ?? null,
      refs: input.refs.map((ref) => ({ ...ref })),
      platforms: [...input.platforms],
      baseline: input.baseline,
      status: "pending",
      runIds: []
    };
  }

  async getRegressionTask(rootPath: string, id: string): Promise<RegressionTaskRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const result = await this.pool.query(
      "SELECT * FROM regression_tasks WHERE project_id = $1 AND id = $2",
      [project.id, id]
    );
    return result.rows.length > 0 ? mapRegressionTask(result.rows[0]!) : null;
  }

  async listRegressionTasks(rootPath: string, limit = 50): Promise<RegressionTaskRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      "SELECT * FROM regression_tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2",
      [project.id, limit]
    );
    return result.rows.map(mapRegressionTask);
  }

  async updateRegressionTask(
    rootPath: string,
    id: string,
    patch: { status?: RegressionTaskRecord["status"]; runIds?: string[] }
  ): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const current = await this.getRegressionTask(rootPath, id);
    if (!current) return false;
    const updated = await this.pool.query(
      `UPDATE regression_tasks SET status = $3, run_ids = $4
        WHERE project_id = $1 AND id = $2 RETURNING id`,
      [project.id, id, patch.status ?? current.status, JSON.stringify(patch.runIds ?? current.runIds)]
    );
    return updated.rows.length > 0;
  }

  async recordSuiteRun(input: RecordSuiteRunInput): Promise<SuiteRunRecord> {
    const project = await this.getProjectByPath(input.rootPath);
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const { run } = input;
    await this.withTransaction(async (query) => {
      await query(
        `INSERT INTO suite_runs
           (id, project_id, created_at, trigger, regression_task_id, case_set_id, feature_key, feature_name,
            platform, device, app_version, status, started_at, finished_at, total, passed, failed, flaky,
            quarantined, failure_domains, gate_result, exit_code, manifest_path, comparison)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          id,
          project?.id ?? null,
          createdAt,
          run.trigger,
          run.regressionTaskId,
          run.caseSetId,
          run.featureKey,
          run.featureName,
          run.platform,
          run.device,
          run.appVersion,
          run.status,
          run.startedAt,
          run.finishedAt,
          run.total,
          run.passed,
          run.failed,
          run.flaky,
          run.quarantined,
          JSON.stringify(run.failureDomains),
          run.gateResult,
          run.exitCode,
          run.manifestPath,
          run.comparison === undefined || run.comparison === null ? null : JSON.stringify(run.comparison)
        ]
      );
      for (const entry of input.cases) {
        await query(
          `INSERT INTO suite_run_cases
             (run_id, case_id, name, feature_key, platform, status, trace_id, failure_domain, failure_confidence,
              failure_reason, duration_ms, quarantined, flaky, verdict, verdict_by, verdict_at, verdict_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            id,
            entry.caseId,
            entry.name,
            entry.featureKey,
            entry.platform,
            entry.status,
            entry.traceId,
            entry.failureDomain,
            entry.failureConfidence,
            entry.failureReason,
            entry.durationMs,
            entry.quarantined,
            entry.flaky,
            entry.verdict,
            entry.verdictBy,
            entry.verdictAt,
            entry.verdictNote
          ]
        );
      }
    });
    return {
      id,
      projectId: project?.id ?? null,
      createdAt,
      ...run,
      failureDomains: { ...run.failureDomains },
      comparison: run.comparison ?? null,
      cases: input.cases.map((entry) => ({ ...entry }))
    };
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
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const conditions = ["project_id = $1"];
    const values: unknown[] = [project.id];
    if (query.taskId !== undefined) {
      values.push(query.taskId);
      conditions.push(`regression_task_id = $${values.length}`);
    }
    if (query.caseSetId !== undefined) {
      values.push(query.caseSetId);
      conditions.push(`case_set_id = $${values.length}`);
    }
    if (query.featureKey !== undefined) {
      values.push(query.featureKey);
      conditions.push(`feature_key = $${values.length}`);
    }
    if (query.platform !== undefined) {
      values.push(query.platform);
      conditions.push(`platform = $${values.length}`);
    }
    values.push(query.limit ?? 50);
    const runs = await this.pool.query(
      `SELECT * FROM suite_runs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    const out: SuiteRunRecord[] = [];
    for (const row of runs.rows) {
      const cases = await this.pool.query(
        "SELECT * FROM suite_run_cases WHERE run_id = $1 ORDER BY case_id ASC",
        [String(row.id)]
      );
      out.push(mapSuiteRun(row, cases.rows));
    }
    return out;
  }

  async updateCaseVerdict(input: UpdateCaseVerdictInput): Promise<boolean> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return false;
    const updated = await this.pool.query(
      `UPDATE suite_run_cases
          SET verdict = $3, verdict_by = $4, verdict_at = $5, verdict_note = $6
        WHERE run_id = $1 AND case_id = $2
          AND run_id IN (SELECT id FROM suite_runs WHERE project_id = $7)
        RETURNING case_id`,
      [
        input.runId,
        input.caseId,
        input.verdict,
        input.verdictBy ?? null,
        new Date().toISOString(),
        input.verdictNote ?? null,
        project.id
      ]
    );
    return updated.rows.length > 0;
  }

  async recordUsageEvent(
    rootPath: string,
    input: RecordUsageEventInput,
    policy: UsagePrunePolicy = {}
  ): Promise<UsageEventRecord> {
    const project = await this.getProjectByPath(rootPath);
    const record = buildUsageEvent(input, project?.id ?? null);
    await this.pool.query(
      `INSERT INTO usage_events
         (id, project_id, at, tool, family, ok, duration_ms, error_class, error_summary, signals, arg_keys, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.id,
        record.projectId,
        record.at,
        record.tool,
        record.family,
        record.ok,
        record.durationMs,
        record.errorClass,
        record.errorSummary,
        JSON.stringify(record.signals),
        JSON.stringify(record.argKeys),
        record.traceId
      ]
    );
    await this.pruneUsageEvents(record.projectId, policy);
    return record;
  }

  async listUsageEvents(rootPath: string, query: UsageEventQuery = {}): Promise<UsageEventRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const clauses = ["project_id = $1"];
    const values: unknown[] = [project.id];
    if (query.tool) {
      values.push(query.tool);
      clauses.push(`tool = $${values.length}`);
    }
    if (query.status === "ok") clauses.push("ok = TRUE");
    if (query.status === "error") clauses.push("ok = FALSE");
    if (query.since) {
      values.push(query.since);
      clauses.push(`at >= $${values.length}`);
    }
    if (query.until) {
      values.push(query.until);
      clauses.push(`at <= $${values.length}`);
    }
    values.push(normalizeUsageLimit(query.limit));
    const result = await this.pool.query(
      `SELECT * FROM usage_events WHERE ${clauses.join(" AND ")}
        ORDER BY at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map(mapUsageEvent);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM projects ORDER BY last_seen_at DESC, name ASC"
    );
    return result.rows.map(mapProject);
  }

  private async pruneUsageEvents(
    projectId: string | null,
    policy: UsagePrunePolicy
  ): Promise<void> {
    const scope =
      projectId === null
        ? { sql: "project_id IS NULL", values: [] as unknown[] }
        : { sql: "project_id = $1", values: [projectId] as unknown[] };
    const retentionDays = policy.retentionDays ?? 0;
    if (retentionDays > 0) {
      await this.pool.query(
        `DELETE FROM usage_events WHERE ${scope.sql} AND at < $${scope.values.length + 1}`,
        [...scope.values, retentionCutoffIso(retentionDays)]
      );
    }
    const maxEvents = policy.maxEvents ?? 0;
    if (maxEvents > 0) {
      await this.pool.query(
        `DELETE FROM usage_events WHERE ${scope.sql} AND id NOT IN (
           SELECT id FROM usage_events WHERE ${scope.sql}
           ORDER BY at DESC, id DESC LIMIT $${scope.values.length + 1}
         )`,
        [...scope.values, maxEvents]
      );
    }
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

function mapUsageEvent(row: Record<string, unknown>): UsageEventRecord {
  return {
    id: String(row.id),
    projectId:
      row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    at: String(row.at),
    tool: String(row.tool),
    family: String(row.family) as UsageEventRecord["family"],
    ok: Boolean(row.ok),
    durationMs: Number(row.duration_ms),
    errorClass: isUsageErrorClass(row.error_class) ? row.error_class : null,
    errorSummary:
      row.error_summary === null || row.error_summary === undefined
        ? null
        : String(row.error_summary),
    signals: parseJsonArray(row.signals, isUsageSignal),
    argKeys: parseJsonArray(row.arg_keys, (item): item is string => typeof item === "string"),
    traceId: row.trace_id === null || row.trace_id === undefined ? null : String(row.trace_id)
  };
}

function isUsageSignal(value: unknown): value is { code: string; field?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function parseJsonArray<T>(raw: unknown, guard: (item: unknown) => item is T): T[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
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

function mapModelCache(row: Record<string, unknown>): ModelCacheRecord {
  let models: string[] = [];
  const raw = row.models;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        models = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      models = [];
    }
  }
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    cacheKey: String(row.cache_key),
    baseUrl: String(row.base_url),
    models,
    fetchedAt: row.fetched_at === null || row.fetched_at === undefined ? null : String(row.fetched_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    updatedAt: String(row.updated_at)
  };
}

function mapTask(row: Record<string, unknown>): TaskStatRecord {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    traceId: String(row.trace_id),
    caseId: row.case_id === null || row.case_id === undefined ? null : String(row.case_id),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    profile: row.profile === null || row.profile === undefined ? null : String(row.profile),
    status: String(row.status),
    taskDesc: row.task_desc === null || row.task_desc === undefined ? null : String(row.task_desc),
    submittedAt: String(row.submitted_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at)
  };
}

function parseStringArray(value: unknown): string[] {
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(source)
    ? source.filter((item): item is string => typeof item === "string")
    : [];
}

function mapCaseSet(
  row: Record<string, unknown>,
  featureRows: Array<Record<string, unknown>>
): CaseSetRecord {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    createdAt: String(row.created_at),
    source: String(row.source),
    designName:
      row.design_name === null || row.design_name === undefined ? null : String(row.design_name),
    fingerprint:
      row.fingerprint === null || row.fingerprint === undefined ? null : String(row.fingerprint),
    basename: String(row.basename),
    features: featureRows.map((feature) => ({
      key: String(feature.feature_key),
      name: String(feature.name),
      caseCount: Number(feature.case_count),
      screens: parseStringArray(feature.screens),
      jsonPath: String(feature.json_path),
      mdPath: String(feature.md_path),
      xlsxPath: String(feature.xlsx_path)
    }))
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseNumberMap(value: unknown): Record<string, number> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function parseTaskRefs(value: unknown): RegressionTaskRef[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      const record = entry as { caseSetId?: unknown; featureKey?: unknown };
      if (typeof record.caseSetId !== "string" || typeof record.featureKey !== "string") return null;
      return { caseSetId: record.caseSetId, featureKey: record.featureKey };
    })
    .filter((entry): entry is RegressionTaskRef => entry !== null);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapRegressionTask(row: Record<string, unknown>): RegressionTaskRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
    refs: parseTaskRefs(row.refs),
    platforms: parseStringArray(row.platforms),
    baseline: row.baseline === "none" ? "none" : "latest",
    status: String(row.status) as RegressionTaskRecord["status"],
    runIds: parseStringArray(row.run_ids)
  };
}

function mapSuiteRunCase(row: Record<string, unknown>): SuiteRunCaseRecord {
  return {
    caseId: String(row.case_id),
    name: String(row.name),
    featureKey: nullableString(row.feature_key),
    platform: String(row.platform),
    status: String(row.status),
    traceId: nullableString(row.trace_id),
    failureDomain: nullableString(row.failure_domain),
    failureConfidence: nullableString(row.failure_confidence),
    failureReason: nullableString(row.failure_reason),
    durationMs:
      row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    quarantined: Boolean(row.quarantined),
    flaky: Boolean(row.flaky),
    verdict: nullableString(row.verdict),
    verdictBy: nullableString(row.verdict_by),
    verdictAt: nullableString(row.verdict_at),
    verdictNote: nullableString(row.verdict_note)
  };
}

function mapSuiteRun(
  row: Record<string, unknown>,
  caseRows: Array<Record<string, unknown>>
): SuiteRunRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    createdAt: String(row.created_at),
    trigger: String(row.trigger),
    regressionTaskId: nullableString(row.regression_task_id),
    caseSetId: nullableString(row.case_set_id),
    featureKey: nullableString(row.feature_key),
    featureName: nullableString(row.feature_name),
    platform: String(row.platform),
    device: nullableString(row.device),
    appVersion: nullableString(row.app_version),
    status: String(row.status),
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    total: Number(row.total),
    passed: Number(row.passed),
    failed: Number(row.failed),
    flaky: Number(row.flaky),
    quarantined: Number(row.quarantined),
    failureDomains: parseNumberMap(row.failure_domains),
    gateResult: nullableString(row.gate_result),
    exitCode: Number(row.exit_code),
    manifestPath: nullableString(row.manifest_path),
    comparison: parseJsonValue(row.comparison),
    cases: caseRows.map(mapSuiteRunCase)
  };
}
