import { randomUUID } from "node:crypto";

import { logWarn } from "../log.js";
import {
  hostAddressHistoryFrom,
  hostSessionRetentionDaysFrom
} from "../host/online.js";
import { hostStrictFrom } from "../host/strict.js";
import { errorMessage } from "../util.js";
import {
  buildUsageEvent,
  isUsageErrorClass,
  normalizeUsageLimit,
  retentionCutoffIso
} from "./usage-event.js";

import type {
  AcquireDeviceLeasesInput,
  ApiReviewSnapshot,
  AcquireDeviceLeasesResult,
  CancelSource,
  CaseSetRecord,
  CreateRegressionTaskInput,
  CreateScheduleInput,
  DeviceLeaseRecord,
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
  RegressionTaskRef,
  RegressionTaskStatus,
  RenewDeviceLeasesInput,
  RunnerDevice,
  RunnerRecord,
  RunnerTools,
  ScheduleRecord,
  SetCaseIssueKeyInput,
  SuiteRunCaseRecord,
  SuiteRunRecord,
  TaskStatRecord,
  UpdateCaseVerdictInput,
  UpsertHostInput,
  UpsertLlmInput,
  UpsertRunnerInput,
  UpsertWebRunnerInput,
  LegacyLedgerImportResult,
  UsageEventQuery,
  UsageEventRecord,
  UsagePrunePolicy,
  AuditEventInput,
  AuditEventRecord,
  AuditQuery,
  CreateWebAssetInput,
  ExcelMappingRecord,
  ExcelWritebackRecord,
  RecordExcelWritebackInput,
  SaveExcelMappingInput,
  WebAssetKind,
  WebAssetRecord,
  WebProjectRecord,
  WebRunnerRecord
} from "./types.js";
import {
  AmbiguousProjectError,
  capabilitiesSatisfyPlatforms,
  deviceLeaseTtlMs,
  isRunnerActive,
  normalizeRegressionTask,
  RUNNER_ACTIVE_DEFAULT_MS,
  RunnerAlreadyActiveError,
  STOPPED_RUNNER_SEEN_AT,
  WebRunnerAlreadyActiveError
} from "./types.js";
import { buildAuditEvent, normalizeAuditLimit } from "./audit-event.js";
import { normalizeSince, payloadBytes, payloadHash } from "../events/payload.js";
import { eventCutoffIso, eventRetentionPolicy } from "../events/retention.js";

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
     host_id TEXT,
     root_path TEXT NOT NULL,
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
     trace_id TEXT,
     host_id TEXT,
     session_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS project_events (
     seq BIGSERIAL,
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     event_id TEXT NOT NULL,
     type TEXT NOT NULL,
     source TEXT NOT NULL,
     run_id TEXT,
     case_id TEXT,
     step INTEGER,
     status TEXT,
     at TEXT NOT NULL,
     received_at TEXT NOT NULL,
     payload TEXT NOT NULL,
     payload_sha256 TEXT NOT NULL,
     payload_bytes INTEGER NOT NULL,
     consumed_at TEXT,
     UNIQUE (project_id, event_id)
   )`,
  `CREATE INDEX IF NOT EXISTS project_events_project_received_idx
     ON project_events (project_id, received_at DESC, seq DESC)`,
  `CREATE INDEX IF NOT EXISTS project_events_project_run_idx
     ON project_events (project_id, run_id, at)`,
  `CREATE INDEX IF NOT EXISTS project_events_project_consumed_idx
     ON project_events (project_id, consumed_at)`,
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
     claimed_by TEXT,
     claimed_at TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     run_ids TEXT NOT NULL DEFAULT '[]',
     target_host_id TEXT,
     created_host_id TEXT,
     claimed_host_id TEXT,
     claimed_instance_id TEXT,
     priority INTEGER NOT NULL DEFAULT 0,
     last_progress_at TEXT,
     started_at TEXT,
     cancel_source TEXT,
     cancelled_by TEXT,
     cancelled_host_id TEXT,
     cancelled_at TEXT,
     cancel_note TEXT,
     cancel_requested_at TEXT,
     job_spec TEXT,
     device_serial TEXT,
     device_lease_id TEXT
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
     runner TEXT,
     run_id TEXT,
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
     comparison TEXT,
     api_review TEXT
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
     jira_issue_key TEXT,
     PRIMARY KEY (run_id, case_id)
    )`,
  `CREATE TABLE IF NOT EXISTS runners (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     hostname TEXT NOT NULL,
     platforms TEXT NOT NULL,
     devices TEXT NOT NULL,
     tools TEXT NOT NULL DEFAULT '{}',
     artifact_base_url TEXT,
     version TEXT,
     host_id TEXT,
     instance_id TEXT,
     last_seen_at TEXT NOT NULL,
     created_at TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS web_runners (
     id TEXT PRIMARY KEY,
     host_id TEXT NOT NULL,
     name TEXT NOT NULL,
     hostname TEXT NOT NULL,
     platforms TEXT NOT NULL,
     devices TEXT NOT NULL,
     tools TEXT NOT NULL DEFAULT '{}',
     artifact_base_url TEXT,
     version TEXT,
     instance_id TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     created_at TEXT NOT NULL
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS web_runners_host_idx ON web_runners(host_id)`,
  `CREATE TABLE IF NOT EXISTS schedules (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     feature_keys TEXT NOT NULL,
     platforms TEXT NOT NULL,
     baseline TEXT NOT NULL DEFAULT 'latest',
     every_minutes INTEGER NOT NULL,
     enabled BOOLEAN NOT NULL DEFAULT TRUE,
     last_fired_at TEXT,
     last_note TEXT,
     created_at TEXT NOT NULL,
     created_by TEXT,
     UNIQUE (project_id, name)
    )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
     id TEXT PRIMARY KEY,
     root_path TEXT NOT NULL,
     at TEXT NOT NULL,
     domain TEXT NOT NULL,
     action TEXT NOT NULL,
     result TEXT NOT NULL,
     summary TEXT NOT NULL,
     refs TEXT NOT NULL DEFAULT '{}',
     actor TEXT,
     actor_host_id TEXT,
     channel TEXT
    )`,
  `CREATE TABLE IF NOT EXISTS hosts (
     id TEXT PRIMARY KEY,
     hardware_id TEXT,
     hostname TEXT NOT NULL,
     username TEXT,
     os_platform TEXT NOT NULL,
     os_version TEXT,
     arch TEXT,
     identity_source TEXT NOT NULL DEFAULT 'file',
     kind TEXT NOT NULL DEFAULT 'other',
     capabilities TEXT NOT NULL DEFAULT '[]',
     env TEXT NOT NULL DEFAULT '{}',
     env_at TEXT,
     ip_primary TEXT,
     label TEXT,
     owner TEXT,
     expected_os TEXT,
     expected_hostname TEXT,
     registered_at TEXT,
     registered_by TEXT,
     client_seen_at TEXT,
     runner_seen_at TEXT,
     last_seen_at TEXT NOT NULL,
     queue_paused BOOLEAN NOT NULL DEFAULT FALSE,
     queue_paused_at TEXT,
     queue_paused_by TEXT,
     first_seen_at TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS host_addresses (
     host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     iface TEXT NOT NULL DEFAULT '',
     family TEXT NOT NULL DEFAULT 'ipv4',
     address TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     PRIMARY KEY (host_id, source, iface, address)
   )`,
  `CREATE TABLE IF NOT EXISTS host_sessions (
     id TEXT PRIMARY KEY,
     host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     root_path TEXT NOT NULL,
     username TEXT,
     client TEXT,
     client_version TEXT,
     pid INTEGER,
     started_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     ended_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS host_sessions_host_seen_idx ON host_sessions(host_id, last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS device_leases (
     host_id TEXT NOT NULL,
     serial TEXT NOT NULL,
     task_id TEXT NOT NULL,
     project_id TEXT,
     acquired_at TEXT NOT NULL,
     renew_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     PRIMARY KEY (host_id, serial)
   )`,
  `CREATE TABLE IF NOT EXISTS web_projects (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     root_path TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     normalized_name TEXT NOT NULL UNIQUE,
     platforms TEXT NOT NULL DEFAULT '[]',
     app_package TEXT,
     customer_name TEXT,
     owner TEXT,
     status TEXT NOT NULL DEFAULT 'active',
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS web_assets (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     root_path TEXT NOT NULL,
     kind TEXT NOT NULL,
     version INTEGER NOT NULL,
     filename TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL,
     storage_path TEXT NOT NULL,
     uploaded_by TEXT,
     created_at TEXT NOT NULL,
     metadata TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS web_assets_root_kind_version_idx ON web_assets(root_path, kind, version)`,
  `CREATE INDEX IF NOT EXISTS web_assets_root_kind_sha_idx ON web_assets(root_path, kind, sha256)`,
  `CREATE TABLE IF NOT EXISTS excel_mappings (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     root_path TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     sheet_name TEXT NOT NULL,
     header_fingerprint TEXT NOT NULL,
     column_map TEXT NOT NULL DEFAULT '{}',
     created_by TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS excel_mappings_root_asset_fp_idx
     ON excel_mappings(root_path, asset_id, header_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS excel_mappings_root_asset_idx ON excel_mappings(root_path, asset_id)`,
  `CREATE TABLE IF NOT EXISTS excel_writeback_journal (
     id TEXT PRIMARY KEY,
     project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
     root_path TEXT NOT NULL,
     asset_id TEXT NOT NULL,
     sheet_name TEXT NOT NULL,
     job_id TEXT,
     case_id TEXT NOT NULL,
     column_key TEXT NOT NULL,
     cell_ref TEXT NOT NULL,
     value TEXT NOT NULL,
     actor TEXT,
     written_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS excel_writeback_journal_lookup_idx
     ON excel_writeback_journal(root_path, asset_id, cell_ref, written_at)`,
  `CREATE INDEX IF NOT EXISTS excel_writeback_journal_cell_key_idx
     ON excel_writeback_journal(root_path, asset_id, sheet_name, case_id, column_key, written_at)`
];

const MIGRATIONS = [
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS host_id TEXT`,
  `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_root_path_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS projects_host_path_idx ON projects(host_id, root_path)`,
  `ALTER TABLE task_stats ADD COLUMN IF NOT EXISTS case_id TEXT`,
  `ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS runner TEXT`,
  `ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS run_id TEXT`,
  `ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS api_review TEXT`,
  `CREATE INDEX IF NOT EXISTS suite_runs_project_run_id_idx ON suite_runs(project_id, run_id)`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_by TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_at TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS target_host_id TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS created_host_id TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_host_id TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS claimed_instance_id TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS last_progress_at TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS started_at TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_source TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_host_id TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancelled_at TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_note TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS cancel_requested_at TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS job_spec TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS device_serial TEXT`,
  `ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS device_lease_id TEXT`,
  `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor TEXT`,
  `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_host_id TEXT`,
  `ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS channel TEXT`,
  `ALTER TABLE suite_run_cases ADD COLUMN IF NOT EXISTS jira_issue_key TEXT`,
  `DELETE FROM runners WHERE id IN (
     SELECT r1.id FROM runners r1
     JOIN runners r2 ON r1.project_id = r2.project_id AND r1.name = r2.name
     WHERE r1.last_seen_at < r2.last_seen_at
        OR (r1.last_seen_at = r2.last_seen_at AND r1.id < r2.id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS runners_project_name_idx ON runners(project_id, name)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS suite_runs_project_manifest_idx ON suite_runs(project_id, manifest_path) WHERE manifest_path IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS audit_events_root_at_idx ON audit_events(root_path, at)`,
  `ALTER TABLE project_events ADD COLUMN IF NOT EXISTS host_id TEXT`,
  `ALTER TABLE runners ADD COLUMN IF NOT EXISTS host_id TEXT`,
  `ALTER TABLE runners ADD COLUMN IF NOT EXISTS instance_id TEXT`,
  `DELETE FROM runners WHERE id IN (
     SELECT r1.id FROM runners r1
     JOIN runners r2 ON r1.project_id = r2.project_id AND r1.host_id = r2.host_id
     WHERE r1.host_id IS NOT NULL
        AND (r1.last_seen_at < r2.last_seen_at
             OR (r1.last_seen_at = r2.last_seen_at AND r1.id < r2.id)))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS runners_project_host_idx ON runners(project_id, host_id)`,
  `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS host_id TEXT`,
  `ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS session_id TEXT`,
  `CREATE INDEX IF NOT EXISTS regression_tasks_web_claim_idx
     ON regression_tasks(status, target_host_id, device_serial)`
];

/** 迁移 advisory lock 的固定键（避免并发首启各自跑 DDL）。 */
const MIGRATION_LOCK_ID = 89121476;

/** 迁移后置校验：这些索引缺失意味着 DDL best-effort 失败，启动必须失败而不是带病运行。 */
const REQUIRED_INDEXES = [
  "projects_host_path_idx",
  "runners_project_host_idx",
  "web_runners_host_idx"
] as const;

export const MIGRATION_INCOMPLETE_CODE = "AOS_MIGRATION_INCOMPLETE";

/** 迁移未完成：调用方必须显式失败，不能降级到文件台账掩盖 schema 问题。 */
export class MigrationIncompleteError extends Error {
  readonly code = MIGRATION_INCOMPLETE_CODE;

  constructor(readonly missingIndexes: readonly string[]) {
    super(
      `数据库迁移未完成：缺少必需索引 ${missingIndexes.join(", ")}；请检查迁移失败日志（MIGRATIONS 为 best-effort）后重试启动或手工修复`
    );
    this.name = "MigrationIncompleteError";
  }
}

export function isMigrationIncompleteError(error: unknown): boolean {
  return (
    error instanceof MigrationIncompleteError ||
    (error as { code?: unknown } | null)?.code === MIGRATION_INCOMPLETE_CODE
  );
}

async function assertRequiredIndexes(
  run: (text: string, values?: unknown[]) => Promise<QueryResultLike>
): Promise<void> {
  const missing: string[] = [];
  for (const index of REQUIRED_INDEXES) {
    let result: QueryResultLike;
    try {
      result = await run("SELECT 1 FROM pg_indexes WHERE indexname = $1 LIMIT 1", [index]);
    } catch (error) {
      if (isUndefinedFunction(error)) {
        logWarn(
          `迁移后置校验不可用（引擎不支持 pg_indexes），已跳过：${errorMessage(error)}`
        );
        return;
      }
      throw error;
    }
    if (result.rows.length === 0) missing.push(index);
  }
  if (missing.length > 0) {
    throw new MigrationIncompleteError(missing);
  }
}

export class PostgresStore implements ProjectStore {
  readonly kind = "postgres" as const;
  private readonly eventPruneAt = new Map<string, number>();
  private hostId: string | null;

  constructor(
    private readonly pool: PoolLike,
    hostId: string | null = null,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.hostId = hostId;
  }

  get localHostId(): string | null {
    return this.hostId;
  }

  bindHost(hostId: string): void {
    this.hostId = hostId;
  }

  scopeHost(hostId: string | null): ProjectStore {
    return new PostgresStore(this.pool, hostId, this.env);
  }

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
    const client = this.pool.connect ? await this.pool.connect() : null;
    const run = (text: string, values?: unknown[]): Promise<QueryResultLike> =>
      client ? client.query(text, values) : this.pool.query(text, values);
    let locked = false;
    try {
      if (client) {
        try {
          await run("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
          locked = true;
        } catch (error) {
          if (!isUndefinedFunction(error)) throw error;
          /* 引擎不支持 advisory lock（pg-mem）：继续无锁迁移。 */
        }
      }
      for (const statement of SCHEMA) {
        try {
          await run(statement);
        } catch (error) {
          if (!isIdempotentSchemaRace(error)) throw error;
          logWarn(`建表竞态（忽略，已有并发建表者）: ${errorMessage(error)}`);
        }
      }
      for (const statement of MIGRATIONS) {
        try {
          await run(statement);
        } catch (error) {
          /* best effort: fresh schema already carries the column */
          logWarn(`迁移语句失败（忽略）: ${errorMessage(error)}`);
        }
      }
      await assertRequiredIndexes(run);
    } finally {
      if (locked) {
        try {
          await run("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
        } catch {
          /* best effort */
        }
      }
      client?.release?.();
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

  async upsertProject(input: {
    rootPath: string;
    name: string;
    hostId?: string | null;
    updateName?: boolean;
  }): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const hostId = input.hostId !== undefined ? input.hostId : this.hostId;
    const hostClause = hostId === null ? "host_id IS NULL" : "host_id = $1";
    const hostValues: unknown[] = hostId === null ? [] : [hostId];
    const rootParam = hostValues.length + 1;
    const existing = await this.pool.query(
      `SELECT * FROM projects WHERE ${hostClause} AND root_path = $${rootParam}`,
      [...hostValues, input.rootPath]
    );
    if (existing.rows.length > 0) {
      const id = String(existing.rows[0]!.id);
      if (input.updateName === false) {
        await this.pool.query("UPDATE projects SET last_seen_at = $2 WHERE id = $1", [id, now]);
      } else {
        await this.pool.query("UPDATE projects SET name = $2, last_seen_at = $3 WHERE id = $1", [
          id,
          input.name,
          now
        ]);
      }
      const refreshed = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
      return mapProject(refreshed.rows[0]!);
    }
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO projects (id, host_id, root_path, name, figma_token, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, NULL, $5, $5)`,
      [id, hostId, input.rootPath, input.name, now]
    );
    const inserted = await this.pool.query("SELECT * FROM projects WHERE id = $1", [id]);
    return mapProject(inserted.rows[0]!);
  }

  async getProjectByPath(rootPath: string): Promise<ProjectRecord | null> {
    if (this.hostId !== null) {
      const result = await this.pool.query(
        "SELECT * FROM projects WHERE host_id = $1 AND root_path = $2",
        [this.hostId, rootPath]
      );
      return result.rows.length > 0 ? mapProject(result.rows[0]!) : null;
    }
    const result = await this.pool.query("SELECT * FROM projects WHERE root_path = $1", [rootPath]);
    if (result.rows.length > 1) {
      throw new AmbiguousProjectError(rootPath, result.rows.map((row) => mapProject(row)));
    }
    return result.rows.length > 0 ? mapProject(result.rows[0]!) : null;
  }

  async setFigmaToken(rootPath: string, token: string | null): Promise<void> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return;
    await this.pool.query("UPDATE projects SET figma_token = $2 WHERE id = $1", [
      project.id,
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
    const project = await this.upsertProject({
      rootPath,
      name: projectName(rootPath),
      updateName: false
    });
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
    const project = await this.upsertProject({
      rootPath,
      name: projectName(rootPath),
      updateName: false
    });
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

  async listCaseSets(rootPath: string, limit?: number): Promise<CaseSetRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const sets =
      limit === undefined
        ? await this.pool.query(
            "SELECT * FROM case_sets WHERE project_id = $1 ORDER BY created_at DESC",
            [project.id]
          )
        : await this.pool.query(
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
      `INSERT INTO regression_tasks
         (id, project_id, created_at, created_by, refs, platforms, baseline, status, run_ids,
          target_host_id, created_host_id, priority, job_spec, device_serial, device_lease_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        project?.id ?? null,
        createdAt,
        input.createdBy ?? null,
        JSON.stringify(input.refs),
        JSON.stringify(input.platforms),
        input.baseline,
        "pending",
        "[]",
        input.targetHostId ?? null,
        input.createdHostId ?? null,
        typeof input.priority === "number" ? input.priority : 0,
        input.jobSpec === undefined || input.jobSpec === null ? null : JSON.stringify(input.jobSpec),
        input.deviceSerial ?? null,
        input.deviceLeaseId ?? null
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
      claimedBy: null,
      claimedAt: null,
      attempts: 0,
      runIds: [],
      targetHostId: input.targetHostId ?? null,
      createdHostId: input.createdHostId ?? null,
      claimedHostId: null,
      claimedInstanceId: null,
      priority: typeof input.priority === "number" ? input.priority : 0,
      lastProgressAt: null,
      startedAt: null,
      cancelSource: null,
      cancelledBy: null,
      cancelledHostId: null,
      cancelledAt: null,
      cancelNote: null,
      cancelRequestedAt: null,
      jobSpec: input.jobSpec ?? null,
      deviceSerial: input.deviceSerial ?? null,
      deviceLeaseId: input.deviceLeaseId ?? null
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

  async listStoppingTasks(input: {
    rootPath: string;
    deadline?: string;
    limit?: number;
  }): Promise<RegressionTaskRecord[]> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return [];
    const limit = input.limit ?? 1_000;
    const result =
      input.deadline === undefined
        ? await this.pool.query(
            `SELECT * FROM regression_tasks
              WHERE project_id = $1 AND status = 'stopping'
              ORDER BY created_at ASC LIMIT $2`,
            [project.id, limit]
          )
        : await this.pool.query(
            `SELECT * FROM regression_tasks
              WHERE project_id = $1 AND status = 'stopping'
                AND (cancel_requested_at <= $2 OR cancel_requested_at IS NULL)
              ORDER BY created_at ASC LIMIT $3`,
            [project.id, input.deadline, limit]
          );
    return result.rows.map(mapRegressionTask);
  }

  async updateRegressionTask(
    rootPath: string,
    id: string,
    patch: {
      status?: RegressionTaskRecord["status"];
      runIds?: string[];
      claimedBy?: string | null;
      claimedAt?: string | null;
      lastProgressAt?: string | null;
      targetHostId?: string | null;
      jobSpec?: Record<string, unknown> | null;
      deviceSerial?: string | null;
      deviceLeaseId?: string | null;
      claimedHostId?: string | null;
      claimedInstanceId?: string | null;
      startedAt?: string | null;
      expectDeviceSerialEmpty?: boolean;
      expectStatuses?: RegressionTaskStatus[];
    }
  ): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    if (patch.expectStatuses !== undefined && patch.expectStatuses.length === 0) return false;
    const sets: string[] = [];
    const values: unknown[] = [project.id, id];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.runIds !== undefined) add("run_ids", JSON.stringify(patch.runIds));
    if (patch.claimedBy !== undefined) add("claimed_by", patch.claimedBy);
    if (patch.claimedAt !== undefined) add("claimed_at", patch.claimedAt);
    if (patch.lastProgressAt !== undefined) add("last_progress_at", patch.lastProgressAt);
    if (patch.targetHostId !== undefined) add("target_host_id", patch.targetHostId);
    if (patch.jobSpec !== undefined) {
      add("job_spec", patch.jobSpec === null ? null : JSON.stringify(patch.jobSpec));
    }
    if (patch.deviceSerial !== undefined) add("device_serial", patch.deviceSerial);
    if (patch.deviceLeaseId !== undefined) add("device_lease_id", patch.deviceLeaseId);
    if (patch.claimedHostId !== undefined) add("claimed_host_id", patch.claimedHostId);
    if (patch.claimedInstanceId !== undefined) add("claimed_instance_id", patch.claimedInstanceId);
    if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
    const guards: string[] = [];
    if (patch.expectDeviceSerialEmpty === true) guards.push("device_serial IS NULL");
    if (patch.expectStatuses !== undefined) {
      const placeholders = patch.expectStatuses.map((status) => {
        values.push(status);
        return `$${values.length}`;
      });
      guards.push(`status IN (${placeholders.join(", ")})`);
    }
    if (sets.length === 0) {
      if (patch.expectStatuses === undefined) {
        return (await this.getRegressionTask(rootPath, id)) !== null;
      }
      const current = await this.getRegressionTask(rootPath, id);
      return current !== null && patch.expectStatuses.includes(current.status);
    }
    const updated = await this.pool.query(
      `UPDATE regression_tasks SET ${sets.join(", ")}
        WHERE project_id = $1 AND id = $2${guards.length === 0 ? "" : ` AND ${guards.join(" AND ")}`} RETURNING id`,
      values
    );
    return updated.rows.length > 0;
  }

  async cancelRegressionTask(input: {
    rootPath: string;
    taskId: string;
    source: CancelSource;
    actor: string;
    actorHostId: string | null;
    note?: string | null;
    at?: string;
  }): Promise<RegressionTaskRecord | null> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return null;
    const at = input.at ?? new Date().toISOString();
    const note = input.note ?? null;
    const pending = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'cancelled', cancel_source = $3, cancelled_by = $4,
              cancelled_host_id = $5, cancelled_at = $6, cancel_requested_at = $6,
              cancel_note = $7
        WHERE project_id = $1 AND id = $2 AND status = 'pending'
      RETURNING *`,
      [project.id, input.taskId, input.source, input.actor, input.actorHostId, at, note]
    );
    if (pending.rows.length > 0) return mapRegressionTask(pending.rows[0]!);
    const requested = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'stopping', cancel_source = $3, cancelled_by = $4,
              cancelled_host_id = $5, cancel_requested_at = $6, cancel_note = $7
        WHERE project_id = $1 AND id = $2 AND status IN ('claimed', 'running')
      RETURNING *`,
      [project.id, input.taskId, input.source, input.actor, input.actorHostId, at, note]
    );
    if (requested.rows.length > 0) return mapRegressionTask(requested.rows[0]!);
    return this.getRegressionTask(input.rootPath, input.taskId);
  }

  async ackCancellation(input: {
    rootPath: string;
    taskId: string;
    at?: string;
  }): Promise<RegressionTaskRecord | null> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return null;
    const at = input.at ?? new Date().toISOString();
    const updated = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, $3),
              cancel_requested_at = COALESCE(cancel_requested_at, $3)
        WHERE project_id = $1 AND id = $2 AND status = 'stopping'
      RETURNING *`,
      [project.id, input.taskId, at]
    );
    if (updated.rows.length > 0) return mapRegressionTask(updated.rows[0]!);
    return this.getRegressionTask(input.rootPath, input.taskId);
  }

  async finalizeCancellation(input: {
    rootPath: string;
    taskId: string;
    at?: string;
    note?: string | null;
    source?: CancelSource | null;
  }): Promise<RegressionTaskRecord | null> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return null;
    const at = input.at ?? new Date().toISOString();
    const updated = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, $3),
              cancel_source = COALESCE(cancel_source, $4),
              cancel_note = COALESCE($5, cancel_note)
        WHERE project_id = $1 AND id = $2 AND status = 'stopping'
      RETURNING *`,
      [project.id, input.taskId, at, input.source ?? null, input.note ?? null]
    );
    return updated.rows.length > 0 ? mapRegressionTask(updated.rows[0]!) : null;
  }

  async claimRegressionTask(input: {
    rootPath: string;
    runnerId: string;
    platforms: string[];
    onlineBefore?: string;
    allowPartial?: boolean;
    hostId?: string;
    instanceId?: string;
    capabilities: string[];
  }): Promise<RegressionTaskRecord | null> {
    if (hostStrictFrom(this.env) && input.hostId == null) return null;
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return null;
    const hostId = input.hostId ?? null;
    if (hostId !== null) {
      const host = await this.pool.query("SELECT queue_paused FROM hosts WHERE id = $1", [hostId]);
      if (host.rows.length > 0 && Boolean(host.rows[0]!.queue_paused)) return null;
    }
    const capabilities = input.capabilities ?? [];
    const candidates = await this.pool.query(
      `SELECT id, platforms FROM regression_tasks
        WHERE project_id = $1 AND status = 'pending'
          AND (target_host_id IS NULL OR target_host_id = $2)
        ORDER BY priority DESC, created_at ASC`,
      [project.id, hostId]
    );
    const rows = candidates.rows;
    const fullMatch = rows.find((row) => {
      const taskPlatforms = parseStringArray(row.platforms);
      return (
        taskPlatforms.length > 0 &&
        taskPlatforms.every((platform) => input.platforms.includes(platform)) &&
        capabilitiesSatisfyPlatforms(capabilities, taskPlatforms)
      );
    });
    let match = fullMatch;
    if (!match && input.allowPartial === true && input.onlineBefore !== undefined) {
      const online = await this.pool.query(
        `SELECT id, platforms FROM runners
          WHERE project_id = $1 AND last_seen_at > $2`,
        [project.id, input.onlineBefore]
      );
      const otherOnline = online.rows
        .filter((row) => String(row.id) !== input.runnerId)
        .map((row) => parseStringArray(row.platforms));
      for (const row of rows) {
        const taskPlatforms = parseStringArray(row.platforms);
        const intersection = taskPlatforms.filter((platform) =>
          input.platforms.includes(platform)
        );
        if (intersection.length === 0) continue;
        if (!capabilitiesSatisfyPlatforms(capabilities, intersection)) continue;
        const coveredByOther = otherOnline.some((platforms) =>
          taskPlatforms.every((platform) => platforms.includes(platform))
        );
        if (coveredByOther) continue;
        match = row;
        break;
      }
    }
    if (!match) return null;
    const claimed = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'claimed', claimed_by = $2, claimed_at = $3,
              claimed_host_id = $4, claimed_instance_id = $5
        WHERE project_id = $1 AND id = $6 AND status = 'pending'
      RETURNING *`,
      [project.id, input.runnerId, new Date().toISOString(), hostId, input.instanceId ?? null, String(match.id)]
    );
    if (claimed.rows.length === 0) return null;
    return mapRegressionTask(claimed.rows[0]!);
  }

  async beginExecution(input: {
    rootPath: string;
    taskId: string;
    runnerId: string;
    instanceId: string;
    at?: string;
  }): Promise<RegressionTaskRecord | null> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return null;
    const updated = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'running', attempts = attempts + 1, started_at = $3
        WHERE project_id = $1 AND id = $2 AND status = 'claimed'
          AND claimed_instance_id = $4 AND claimed_by = $5
      RETURNING *`,
      [project.id, input.taskId, input.at ?? new Date().toISOString(), input.instanceId, input.runnerId]
    );
    if (updated.rows.length === 0) return null;
    return mapRegressionTask(updated.rows[0]!);
  }

  async releaseRegressionTasks(input: { rootPath: string; runnerId: string }): Promise<number> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return 0;
    const released = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
              claimed_host_id = NULL, claimed_instance_id = NULL, started_at = NULL
        WHERE project_id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running')
      RETURNING id`,
      [project.id, input.runnerId]
    );
    return released.rows.length;
  }

  async releaseRegressionTask(input: {
    rootPath: string;
    runnerId: string | null;
    taskId: string;
    to?: "pending" | "failed";
  }): Promise<boolean> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return false;
    const target = input.to === "failed" ? "failed" : "pending";
    const values: unknown[] = [project.id, input.taskId];
    let runnerClause = "claimed_by IS NULL";
    if (input.runnerId !== null) {
      values.push(input.runnerId);
      runnerClause = "claimed_by = $3";
    }
    const released = await this.pool.query(
      `UPDATE regression_tasks
          SET status = '${target}', claimed_by = NULL, claimed_at = NULL,
              claimed_host_id = NULL, claimed_instance_id = NULL, started_at = NULL
        WHERE project_id = $1 AND id = $2 AND ${runnerClause} AND status IN ('claimed', 'running')
      RETURNING id`,
      values
    );
    return released.rows.length > 0;
  }

  async releaseStaleClaims(input: {
    rootPath: string;
    offlineBefore: string;
    claimedBefore: string;
  }): Promise<number> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return 0;
    const released = await this.pool.query(
      `UPDATE regression_tasks
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
              claimed_host_id = NULL, claimed_instance_id = NULL, started_at = NULL
        WHERE project_id = $1
          AND status IN ('claimed', 'running')
          AND claimed_at IS NOT NULL AND claimed_at <= $2
          AND (claimed_by IS NULL OR claimed_by NOT IN (
                SELECT id FROM runners WHERE project_id = $1 AND last_seen_at > $3))
      RETURNING id`,
      [project.id, input.claimedBefore, input.offlineBefore]
    );
    return released.rows.length;
  }

  private skipLockedUnsupported = false;

  async claimWebJob(input: {
    runnerId: string;
    hostId: string;
    deviceSerial: string;
    instanceId: string;
    nowMs?: number;
  }): Promise<{ task: RegressionTaskRecord; rootPath: string } | null> {
    const host = await this.pool.query("SELECT queue_paused FROM hosts WHERE id = $1", [
      input.hostId
    ]);
    if (host.rows.length > 0 && Boolean(host.rows[0]!.queue_paused)) return null;
    const claimedAt = new Date(input.nowMs ?? Date.now()).toISOString();
    const runClaim = async (skipLocked: boolean): Promise<RegressionTaskRecord | null> => {
      return this.withTransaction(async (run) => {
        const lockClause = skipLocked ? "FOR UPDATE SKIP LOCKED" : "FOR UPDATE";
        const picked = await run(
          `SELECT rt.id FROM regression_tasks rt
            WHERE rt.status = 'pending' AND rt.job_spec IS NOT NULL
              AND rt.target_host_id = $1 AND rt.device_serial = $2
              AND rt.id IN (
                SELECT l.task_id FROM device_leases l
                 WHERE l.host_id = $1 AND l.serial = $2 AND l.expires_at > $3
              )
            ORDER BY rt.priority DESC, rt.created_at ASC
            LIMIT 1 ${lockClause}`,
          [input.hostId, input.deviceSerial, claimedAt]
        );
        if (picked.rows.length === 0) return null;
        const updated = await run(
          `UPDATE regression_tasks
              SET status = 'claimed', claimed_by = $2, claimed_at = $3,
                  claimed_host_id = $1, claimed_instance_id = $4
            WHERE id = $5 AND status = 'pending'
          RETURNING *`,
          [input.hostId, input.runnerId, claimedAt, input.instanceId, String(picked.rows[0]!.id)]
        );
        return updated.rows.length === 0 ? null : mapRegressionTask(updated.rows[0]!);
      });
    };

    let task: RegressionTaskRecord | null = null;
    if (!this.skipLockedUnsupported) {
      try {
        task = await runClaim(true);
      } catch (error) {
        if (!isSkipLockedUnsupported(error)) throw error;
        this.skipLockedUnsupported = true;
        task = await runClaim(false);
      }
    } else {
      task = await runClaim(false);
    }
    if (task === null) return null;
    const rootPath = task.projectId === null ? "" : await this.projectRootPath(task.projectId);
    return { task, rootPath };
  }

  async getWebJobById(
    taskId: string
  ): Promise<{ task: RegressionTaskRecord; rootPath: string } | null> {
    const result = await this.pool.query(
      `SELECT t.*, p.root_path AS project_root_path
         FROM regression_tasks t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1`,
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return {
      task: mapRegressionTask(result.rows[0]!),
      rootPath: nullableString(result.rows[0]!.project_root_path) ?? ""
    };
  }

  async listPendingWebJobs(): Promise<Array<{ task: RegressionTaskRecord; rootPath: string }>> {
    const result = await this.pool.query(
      `SELECT t.*, p.root_path AS project_root_path
         FROM regression_tasks t
         LEFT JOIN projects p ON p.id = t.project_id
        WHERE t.status = 'pending' AND t.job_spec IS NOT NULL
        ORDER BY t.created_at ASC`
    );
    return result.rows
      .map((row) => ({
        task: mapRegressionTask(row),
        rootPath: nullableString(row.project_root_path) ?? ""
      }))
      .filter((entry) => entry.task.jobSpec?.binding !== true);
  }

  private async projectRootPath(projectId: string): Promise<string> {
    const result = await this.pool.query("SELECT root_path FROM projects WHERE id = $1", [
      projectId
    ]);
    return result.rows.length === 0 ? "" : String(result.rows[0]!.root_path);
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
            platform, device, app_version, runner, run_id, status, started_at, finished_at, total, passed, failed,
            flaky, quarantined, failure_domains, gate_result, exit_code, manifest_path, comparison, api_review)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
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
          run.runner ?? null,
          run.runId ?? null,
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
          run.comparison === undefined || run.comparison === null ? null : JSON.stringify(run.comparison),
          run.apiReview === undefined || run.apiReview === null ? null : JSON.stringify(run.apiReview)
        ]
      );
      for (const entry of input.cases) {
        await query(
          `INSERT INTO suite_run_cases
             (run_id, case_id, name, feature_key, platform, status, trace_id, failure_domain, failure_confidence,
              failure_reason, duration_ms, quarantined, flaky, verdict, verdict_by, verdict_at, verdict_note, jira_issue_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
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
            entry.verdictNote,
            entry.jiraIssueKey ?? null
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
    const runIds = runs.rows.map((row) => String(row.id));
    const casesByRun = new Map<string, Array<Record<string, unknown>>>();
    if (runIds.length > 0) {
      const placeholders = runIds.map((_, index) => `$${index + 1}`).join(", ");
      const cases = await this.pool.query(
        `SELECT * FROM suite_run_cases WHERE run_id IN (${placeholders}) ORDER BY run_id ASC, case_id ASC`,
        runIds
      );
      for (const caseRow of cases.rows) {
        const runId = String(caseRow.run_id);
        const bucket = casesByRun.get(runId);
        if (bucket) bucket.push(caseRow);
        else casesByRun.set(runId, [caseRow]);
      }
    }
    return runs.rows.map((row) => mapSuiteRun(row, casesByRun.get(String(row.id)) ?? []));
  }

  async markSuiteRunFinishedByRunId(
    rootPath: string,
    runId: string,
    status: "completed" | "failed"
  ): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const result = await this.pool.query(
      `UPDATE suite_runs SET status = $3 WHERE project_id = $1 AND run_id = $2`,
      [project.id, runId, status]
    );
    return Number(result.rowCount ?? 0) > 0;
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

  async setCaseIssueKey(input: SetCaseIssueKeyInput): Promise<boolean> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return false;
    const updated = await this.pool.query(
      `UPDATE suite_run_cases
          SET jira_issue_key = $3
        WHERE run_id = $1 AND case_id = $2
          AND run_id IN (SELECT id FROM suite_runs WHERE project_id = $4)
        RETURNING case_id`,
      [input.runId, input.caseId, input.jiraKey, project.id]
    );
    return updated.rows.length > 0;
  }

  async getSuiteRun(rootPath: string, runId: string): Promise<SuiteRunRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const runs = await this.pool.query(
      "SELECT * FROM suite_runs WHERE id = $1 AND project_id = $2",
      [runId, project.id]
    );
    const row = runs.rows[0];
    if (!row) return null;
    const cases = await this.pool.query(
      "SELECT * FROM suite_run_cases WHERE run_id = $1 ORDER BY case_id ASC",
      [runId]
    );
    return mapSuiteRun(row, cases.rows);
  }

  async getSuiteRunByManifestPath(
    rootPath: string,
    manifestPath: string
  ): Promise<SuiteRunRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const runs = await this.pool.query(
      "SELECT * FROM suite_runs WHERE project_id = $1 AND manifest_path = $2 ORDER BY created_at DESC LIMIT 1",
      [project.id, manifestPath]
    );
    const row = runs.rows[0];
    if (!row) return null;
    const cases = await this.pool.query(
      "SELECT * FROM suite_run_cases WHERE run_id = $1 ORDER BY case_id ASC",
      [row.id]
    );
    return mapSuiteRun(row, cases.rows);
  }

  async listRegisteredManifestPaths(rootPath: string): Promise<string[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      "SELECT manifest_path FROM suite_runs WHERE project_id = $1 AND manifest_path IS NOT NULL",
      [project.id]
    );
    return result.rows.map((row) => String(row.manifest_path));
  }

  async getEarliestRegistrationCreatedAt(
    rootPath: string
  ): Promise<{ runs: string | null; caseSets: string | null }> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return { runs: null, caseSets: null };
    const runs = await this.pool.query(
      "SELECT MIN(created_at) AS created_at FROM suite_runs WHERE project_id = $1",
      [project.id]
    );
    const caseSets = await this.pool.query(
      "SELECT MIN(created_at) AS created_at FROM case_sets WHERE project_id = $1",
      [project.id]
    );
    return {
      runs: nullableString(runs.rows[0]?.created_at),
      caseSets: nullableString(caseSets.rows[0]?.created_at)
    };
  }

  async upsertRunner(input: UpsertRunnerInput): Promise<RunnerRecord> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) throw new Error(`项目未注册：${input.rootPath}`);
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const hostId = input.hostId ?? null;
    const instanceId = input.instanceId ?? null;
    const activeWithinMs = input.activeWithinMs ?? RUNNER_ACTIVE_DEFAULT_MS;
    const hasIdentity = hostId !== null && instanceId !== null;
    try {
      const inserted = await this.pool.query(
        `INSERT INTO runners
           (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, host_id, instance_id, last_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          randomUUID(),
          project.id,
          input.name,
          input.hostname,
          JSON.stringify(input.platforms),
          JSON.stringify(input.devices),
          JSON.stringify(input.tools),
          input.artifactBaseUrl ?? null,
          input.version ?? null,
          hostId,
          instanceId,
          now,
          now
        ]
      );
      return mapRunner(inserted.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const existing = await this.findRunnerRow(project.id, hostId, input.name, hasIdentity);
      if (!existing) throw error;
      if (!hasIdentity) {
        const updated = await this.pool.query(
          `UPDATE runners
              SET hostname = $3, platforms = $4, devices = $5, tools = $6,
                  artifact_base_url = $7, version = $8, host_id = $9, instance_id = $10,
                  last_seen_at = $11
            WHERE project_id = $1 AND name = $2
          RETURNING *`,
          [
            project.id,
            input.name,
            input.hostname,
            JSON.stringify(input.platforms),
            JSON.stringify(input.devices),
            JSON.stringify(input.tools),
            input.artifactBaseUrl ?? null,
            input.version ?? null,
            hostId,
            instanceId,
            now
          ]
        );
        return mapRunner(updated.rows[0]!);
      }
      const existingInstanceId = nullableString(existing.instance_id);
      if (
        existingInstanceId !== instanceId &&
        isRunnerActive(String(existing.last_seen_at), nowMs, activeWithinMs)
      ) {
        throw new RunnerAlreadyActiveError({
          projectId: project.id,
          hostId,
          existingInstanceId,
          incomingInstanceId: instanceId
        });
      }
      const updated = await this.pool.query(
        `UPDATE runners
            SET hostname = $3, platforms = $4, devices = $5, tools = $6,
                artifact_base_url = $7, version = $8, host_id = $9, instance_id = $10,
                last_seen_at = $11
          WHERE id = $1 AND (instance_id = $2 OR (instance_id IS NULL AND $2 IS NULL))
        RETURNING *`,
        [
          String(existing.id),
          existingInstanceId,
          input.hostname,
          JSON.stringify(input.platforms),
          JSON.stringify(input.devices),
          JSON.stringify(input.tools),
          input.artifactBaseUrl ?? null,
          input.version ?? null,
          hostId,
          instanceId,
          now
        ]
      );
      if (updated.rows.length === 0) {
        throw new RunnerAlreadyActiveError({
          projectId: project.id,
          hostId,
          existingInstanceId,
          incomingInstanceId: instanceId
        });
      }
      return mapRunner(updated.rows[0]!);
    }
  }

  private async findRunnerRow(
    projectId: string,
    hostId: string | null,
    name: string,
    hasIdentity: boolean
  ): Promise<Record<string, unknown> | null> {
    if (hasIdentity) {
      const byHost = await this.pool.query(
        "SELECT * FROM runners WHERE project_id = $1 AND host_id = $2",
        [projectId, hostId]
      );
      if (byHost.rows[0]) return byHost.rows[0] as Record<string, unknown>;
    }
    const byName = await this.pool.query(
      "SELECT * FROM runners WHERE project_id = $1 AND name = $2",
      [projectId, name]
    );
    return (byName.rows[0] as Record<string, unknown>) ?? null;
  }

  async listRunners(rootPath: string, limit = 20): Promise<RunnerRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result = await this.pool.query(
      `SELECT * FROM runners WHERE project_id = $1 ORDER BY last_seen_at DESC LIMIT $2`,
      [project.id, limit]
    );
    return result.rows.map((row) => mapRunner(row));
  }

  async getRunner(rootPath: string, runnerId: string): Promise<RunnerRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const result = await this.pool.query(
      "SELECT * FROM runners WHERE project_id = $1 AND id = $2",
      [project.id, runnerId]
    );
    return result.rows[0] ? mapRunner(result.rows[0]) : null;
  }

  async markRunnerStopped(input: {
    rootPath: string;
    runnerId: string;
    instanceId: string;
    at?: string;
  }): Promise<boolean> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return false;
    const result = await this.pool.query(
      `UPDATE runners SET last_seen_at = $3
        WHERE id = $1 AND project_id = $2 AND instance_id = $4`,
      [
        input.runnerId,
        project.id,
        input.at ?? STOPPED_RUNNER_SEEN_AT,
        input.instanceId
      ]
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async upsertWebRunner(input: UpsertWebRunnerInput): Promise<WebRunnerRecord> {
    const now = input.lastSeenAt ?? new Date().toISOString();
    const activeWithinMs = input.activeWithinMs ?? RUNNER_ACTIVE_DEFAULT_MS;
    try {
      const inserted = await this.pool.query(
        `INSERT INTO web_runners
           (id, host_id, name, hostname, platforms, devices, tools, artifact_base_url, version,
            instance_id, last_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          randomUUID(),
          input.hostId,
          input.name,
          input.hostname,
          JSON.stringify(input.platforms),
          JSON.stringify(input.devices),
          JSON.stringify(input.tools),
          input.artifactBaseUrl,
          input.version,
          input.instanceId,
          now,
          now
        ]
      );
      return mapWebRunner(inserted.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const existing = await this.pool.query("SELECT * FROM web_runners WHERE host_id = $1", [
        input.hostId
      ]);
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw error;
      const existingInstanceId = nullableString(row.instance_id);
      if (
        existingInstanceId !== input.instanceId &&
        activeWithinMs > 0 &&
        isRunnerActive(String(row.last_seen_at), Date.now(), activeWithinMs)
      ) {
        throw new WebRunnerAlreadyActiveError({
          hostId: input.hostId,
          existingInstanceId,
          incomingInstanceId: input.instanceId
        });
      }
      const updated = await this.pool.query(
        `UPDATE web_runners
            SET name = $3, hostname = $4, platforms = $5, devices = $6, tools = $7,
                artifact_base_url = $8, version = $9, instance_id = $10, last_seen_at = $11
          WHERE host_id = $1 AND instance_id = $2
          RETURNING *`,
        [
          input.hostId,
          existingInstanceId,
          input.name,
          input.hostname,
          JSON.stringify(input.platforms),
          JSON.stringify(input.devices),
          JSON.stringify(input.tools),
          input.artifactBaseUrl,
          input.version,
          input.instanceId,
          now
        ]
      );
      if (updated.rows.length === 0) {
        throw new WebRunnerAlreadyActiveError({
          hostId: input.hostId,
          existingInstanceId,
          incomingInstanceId: input.instanceId
        });
      }
      return mapWebRunner(updated.rows[0]!);
    }
  }

  async listWebRunners(): Promise<WebRunnerRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM web_runners ORDER BY last_seen_at DESC"
    );
    return result.rows.map((row) => mapWebRunner(row));
  }

  async getWebRunner(hostId: string): Promise<WebRunnerRecord | null> {
    const result = await this.pool.query("SELECT * FROM web_runners WHERE host_id = $1", [hostId]);
    return result.rows[0] ? mapWebRunner(result.rows[0]) : null;
  }

  async markWebRunnerStopped(input: {
    hostId: string;
    instanceId: string;
    at?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE web_runners SET last_seen_at = $3
        WHERE host_id = $1 AND instance_id = $2`,
      [input.hostId, input.instanceId, input.at ?? STOPPED_RUNNER_SEEN_AT]
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async upsertHost(input: UpsertHostInput): Promise<HostRecord> {
    const now = new Date().toISOString();
    const updated = await this.updateExistingHost(input);
    if (updated !== null) {
      await this.recordObservedPgAddress(input.id);
      return updated;
    }
    const record = hostRecordFromInput(input, now);
    try {
      await this.pool.query(
        `INSERT INTO hosts
           (id, hardware_id, hostname, username, os_platform, os_version, arch, identity_source, kind,
            capabilities, env, env_at, ip_primary, client_seen_at, runner_seen_at, last_seen_at,
            queue_paused, first_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, FALSE, $17, $18)`,
        [
          record.id,
          record.hardwareId,
          record.hostname,
          record.username,
          record.osPlatform,
          record.osVersion,
          record.arch,
          record.identitySource,
          record.kind,
          JSON.stringify(record.capabilities),
          JSON.stringify(record.env),
          record.envAt,
          record.ipPrimary,
          record.clientSeenAt,
          record.runnerSeenAt,
          record.lastSeenAt,
          record.firstSeenAt,
          record.createdAt
        ]
      );
    } catch (error) {
      /* 并发首次心跳：对方已插入 → 重跑合并更新，避免 runner 因 23505 退出。 */
      if ((error as { code?: string } | null)?.code !== "23505") throw error;
      const raced = await this.updateExistingHost(input);
      if (raced === null) throw error;
      await this.recordObservedPgAddress(input.id);
      return raced;
    }
    await this.recordObservedPgAddress(input.id);
    return record;
  }

  /** 既有 host 行的合并更新；行不存在返回 null（并发首写者由调用方处理 23505）。 */
  private async updateExistingHost(input: UpsertHostInput): Promise<HostRecord | null> {
    const existing = await this.pool.query("SELECT * FROM hosts WHERE id = $1", [input.id]);
    if (existing.rows.length === 0) return null;
    const current = mapHost(existing.rows[0]!);
    const sets: string[] = [];
    const values: unknown[] = [input.id];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    const newClientSeenAt =
      input.clientSeenAt === undefined
        ? current.clientSeenAt
        : maxIso(current.clientSeenAt, input.clientSeenAt);
    const newRunnerSeenAt =
      input.runnerSeenAt === undefined
        ? current.runnerSeenAt
        : maxIso(current.runnerSeenAt, input.runnerSeenAt);
    if (input.hostname !== undefined) add("hostname", input.hostname);
    if (input.hardwareId !== undefined) add("hardware_id", input.hardwareId);
    if (input.username !== undefined) add("username", input.username);
    if (input.osPlatform !== undefined) add("os_platform", input.osPlatform);
    if (input.osVersion !== undefined) add("os_version", input.osVersion);
    if (input.arch !== undefined) add("arch", input.arch);
    if (input.identitySource !== undefined) add("identity_source", input.identitySource);
    if (input.kind !== undefined) add("kind", input.kind);
    if (input.capabilities !== undefined) add("capabilities", JSON.stringify(input.capabilities));
    if (input.env !== undefined) add("env", JSON.stringify(input.env));
    if (input.envAt !== undefined) add("env_at", input.envAt);
    if (input.ipPrimary !== undefined) add("ip_primary", input.ipPrimary);
    if (input.clientSeenAt !== undefined) add("client_seen_at", newClientSeenAt);
    if (input.runnerSeenAt !== undefined) add("runner_seen_at", newRunnerSeenAt);
    if (sets.length === 0) return cloneHostRow(current);
    add("last_seen_at", maxIso(current.lastSeenAt, newClientSeenAt, newRunnerSeenAt));
    await this.pool.query(`UPDATE hosts SET ${sets.join(", ")} WHERE id = $1`, values);
    const refreshed = await this.pool.query("SELECT * FROM hosts WHERE id = $1", [input.id]);
    return mapHost(refreshed.rows[0]!);
  }

  /** PG 观测地址（`inet_client_addr()`）：非空则以 `observed-pg` 记录；unix socket（NULL）或报错时跳过。 */
  private async recordObservedPgAddress(hostId: string): Promise<void> {
    try {
      const result = await this.pool.query("SELECT inet_client_addr() AS addr");
      const addr = result.rows[0]?.addr;
      if (typeof addr !== "string" || addr.trim() === "") return;
      await this.upsertHostAddresses({
        hostId,
        addresses: [
          {
            source: "observed-pg",
            iface: "",
            family: addr.includes(":") ? "ipv6" : "ipv4",
            address: addr.trim()
          }
        ],
        ...(hostAddressHistoryFrom(this.env) ? {} : { maxPerSource: 1 })
      });
    } catch {
      /* pg-mem / 无观测能力连接：跳过，不影响自报地址 */
    }
  }

  async getHost(id: string): Promise<HostRecord | null> {
    const result = await this.pool.query("SELECT * FROM hosts WHERE id = $1", [id]);
    return result.rows.length > 0 ? mapHost(result.rows[0]!) : null;
  }

  async listHosts(): Promise<HostRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM hosts ORDER BY last_seen_at DESC, id ASC"
    );
    return result.rows.map(mapHost);
  }

  async updateHostRegistration(input: {
    id: string;
    label?: string | null;
    owner?: string | null;
    expectedOs?: string | null;
    expectedHostname?: string | null;
    registeredBy: string;
  }): Promise<HostRecord | null> {
    const existing = await this.pool.query("SELECT * FROM hosts WHERE id = $1", [input.id]);
    if (existing.rows.length === 0) return null;
    const sets: string[] = ["registered_at = $2", "registered_by = $3"];
    const values: unknown[] = [input.id, new Date().toISOString(), input.registeredBy];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.label !== undefined) add("label", input.label);
    if (input.owner !== undefined) add("owner", input.owner);
    if (input.expectedOs !== undefined) add("expected_os", input.expectedOs);
    if (input.expectedHostname !== undefined) add("expected_hostname", input.expectedHostname);
    await this.pool.query(`UPDATE hosts SET ${sets.join(", ")} WHERE id = $1`, values);
    const refreshed = await this.pool.query("SELECT * FROM hosts WHERE id = $1", [input.id]);
    return mapHost(refreshed.rows[0]!);
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
      await this.pool.query(
        `INSERT INTO host_addresses (host_id, source, iface, family, address, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (host_id, source, iface, address)
         DO UPDATE SET last_seen_at = CASE
           WHEN host_addresses.last_seen_at > EXCLUDED.last_seen_at THEN host_addresses.last_seen_at
           ELSE EXCLUDED.last_seen_at
         END`,
        [input.hostId, address.source, address.iface, address.family, address.address, at]
      );
    }
    if (maxPerSource > 0) {
      const rows = await this.pool.query(
        `SELECT source, iface, address FROM host_addresses WHERE host_id = $1
         ORDER BY last_seen_at DESC, address ASC, iface ASC`,
        [input.hostId]
      );
      const bySource = new Map<string, Array<Record<string, unknown>>>();
      for (const row of rows.rows) {
        const source = String(row.source);
        const bucket = bySource.get(source) ?? [];
        bucket.push(row);
        bySource.set(source, bucket);
      }
      for (const bucket of bySource.values()) {
        for (const row of bucket.slice(maxPerSource)) {
          await this.pool.query(
            `DELETE FROM host_addresses
              WHERE host_id = $1 AND source = $2 AND iface = $3 AND address = $4`,
            [input.hostId, String(row.source), String(row.iface), String(row.address)]
          );
        }
      }
    }
  }

  async listHostAddresses(hostId: string): Promise<HostAddressRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM host_addresses WHERE host_id = $1 ORDER BY last_seen_at DESC, address ASC`,
      [hostId]
    );
    return result.rows.map(mapHostAddress);
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
    await this.pool.query(
      `INSERT INTO host_sessions
         (id, host_id, project_id, root_path, username, client, client_version, pid, started_at, last_seen_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, NULL)
       ON CONFLICT (id)
       DO UPDATE SET last_seen_at = CASE
         WHEN host_sessions.last_seen_at > EXCLUDED.last_seen_at THEN host_sessions.last_seen_at
         ELSE EXCLUDED.last_seen_at
       END, ended_at = NULL`,
      [
        input.id,
        input.hostId,
        input.projectId,
        input.rootPath,
        input.username,
        input.client,
        input.clientVersion,
        input.pid,
        at
      ]
    );
    const result = await this.pool.query("SELECT * FROM host_sessions WHERE id = $1", [input.id]);
    return mapHostSession(result.rows[0]!);
  }

  async endHostSession(id: string, at?: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE host_sessions SET ended_at = $2 WHERE id = $1",
      [id, at ?? new Date().toISOString()]
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async listHostSessions(
    hostId: string,
    options: { limit?: number; onlineWithinMs?: number; now?: number } = {}
  ): Promise<HostSessionRecord[]> {
    const clauses = ["host_id = $1", "ended_at IS NULL"];
    const values: unknown[] = [hostId];
    if (options.onlineWithinMs !== undefined) {
      const nowMs = options.now ?? Date.now();
      values.push(new Date(nowMs - options.onlineWithinMs).toISOString());
      clauses.push(`last_seen_at > $${values.length}`);
    }
    let sql = `SELECT * FROM host_sessions WHERE ${clauses.join(" AND ")}
         ORDER BY last_seen_at DESC, id ASC`;
    if (options.limit !== undefined) {
      values.push(options.limit);
      sql += ` LIMIT $${values.length}`;
    }
    const result = await this.pool.query(sql, values);
    return result.rows.map(mapHostSession);
  }

  async pruneHostSessions(
    input: { now?: number; retentionDays?: number; hostId?: string | null } = {}
  ): Promise<number> {
    const retentionDays = input.retentionDays ?? hostSessionRetentionDaysFrom(this.env);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const hostId = input.hostId !== undefined ? input.hostId : this.hostId;
    const cutoff = new Date(
      (input.now ?? Date.now()) - retentionDays * 86_400_000
    ).toISOString();
    const values: unknown[] = [cutoff];
    const clauses = [
      "ended_at IS NOT NULL",
      "(CASE WHEN ended_at > last_seen_at THEN ended_at ELSE last_seen_at END) < $1"
    ];
    if (hostId !== null) {
      values.push(hostId);
      clauses.push(`host_id = $${values.length}`);
    }
    const result = await this.pool.query(
      `DELETE FROM host_sessions WHERE ${clauses.join(" AND ")}`,
      values
    );
    return Number(result.rowCount ?? 0);
  }

  async setHostQueuePaused(input: {
    hostId: string;
    paused: boolean;
    by: string;
    at?: string;
  }): Promise<HostRecord | null> {
    const updated = await this.pool.query(
      `UPDATE hosts SET queue_paused = $2, queue_paused_at = $3, queue_paused_by = $4
        WHERE id = $1 RETURNING *`,
      [
        input.hostId,
        input.paused,
        input.paused ? input.at ?? new Date().toISOString() : null,
        input.paused ? input.by : null
      ]
    );
    return updated.rows.length > 0 ? mapHost(updated.rows[0]!) : null;
  }

  async acquireDeviceLeases(input: AcquireDeviceLeasesInput): Promise<AcquireDeviceLeasesResult> {
    const ttlMs = input.ttlMs ?? deviceLeaseTtlMs();
    const at = input.at ?? new Date().toISOString();
    const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
    const serials = [...new Set(input.serials)];
    if (serials.length === 0) return { ok: true, leases: [] };
    const placeholders = serials.map((_, index) => `$${index + 2}`).join(", ");
    try {
      return await this.withTransaction(async (run) => {
        await run(
          `DELETE FROM device_leases
            WHERE host_id = $1 AND serial IN (${placeholders}) AND expires_at <= $${serials.length + 2}`,
          [input.hostId, ...serials, at]
        );
        const conflicts = await run(
          `SELECT serial FROM device_leases
            WHERE host_id = $1 AND serial IN (${placeholders}) AND task_id <> $${serials.length + 2}`,
          [input.hostId, ...serials, input.taskId]
        );
        const busy = conflicts.rows.map((row) => String(row.serial));
        if (busy.length > 0) throw new DeviceLeaseBusyError(busy);
        await run(
          `DELETE FROM device_leases
            WHERE host_id = $1 AND serial IN (${placeholders}) AND task_id = $${serials.length + 2}`,
          [input.hostId, ...serials, input.taskId]
        );
        for (const serial of serials) {
          await run(
            `INSERT INTO device_leases
               (host_id, serial, task_id, project_id, acquired_at, renew_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $5, $6)`,
            [input.hostId, serial, input.taskId, input.projectId ?? null, at, expiresAt]
          );
        }
        const rows = await run(
          `SELECT * FROM device_leases
            WHERE host_id = $1 AND task_id = $2 AND serial IN (${serials
              .map((_, index) => `$${index + 3}`)
              .join(", ")})`,
          [input.hostId, input.taskId, ...serials]
        );
        const bySerial = new Map(rows.rows.map((row) => [String(row.serial), mapDeviceLease(row)]));
        return {
          ok: true as const,
          leases: serials
            .map((serial) => bySerial.get(serial))
            .filter((lease): lease is DeviceLeaseRecord => lease !== undefined)
        };
      });
    } catch (error) {
      if (error instanceof DeviceLeaseBusyError) return { ok: false, busy: error.busy };
      if ((error as { code?: string }).code === "23505") {
        const held = await this.pool.query(
          `SELECT serial FROM device_leases
            WHERE host_id = $1 AND serial IN (${placeholders}) AND task_id <> $${serials.length + 2}`,
          [input.hostId, ...serials, input.taskId]
        );
        const busy = held.rows.map((row) => String(row.serial));
        return { ok: false, busy: busy.length > 0 ? busy : serials };
      }
      throw error;
    }
  }

  async renewDeviceLeases(input: RenewDeviceLeasesInput): Promise<number> {
    const ttlMs = input.ttlMs ?? deviceLeaseTtlMs();
    const at = input.at ?? new Date().toISOString();
    const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
    const serials = [...new Set(input.serials)];
    if (serials.length === 0) return 0;
    const placeholders = serials.map((_, index) => `$${index + 3}`).join(", ");
    const renewed = await this.pool.query(
      `UPDATE device_leases
          SET renew_at = $1, expires_at = $2
        WHERE host_id = $${serials.length + 3} AND task_id = $${serials.length + 4}
          AND serial IN (${placeholders})
      RETURNING serial`,
      [at, expiresAt, ...serials, input.hostId, input.taskId]
    );
    return renewed.rows.length;
  }

  async releaseDeviceLeases(input: {
    hostId: string;
    taskId: string;
    serials?: string[];
  }): Promise<number> {
    const serials = input.serials === undefined ? null : [...new Set(input.serials)];
    if (serials !== null && serials.length === 0) return 0;
    const values: unknown[] = [input.hostId, input.taskId];
    let clause = "host_id = $1 AND task_id = $2";
    if (serials !== null) {
      const placeholders = serials.map((serial) => {
        values.push(serial);
        return `$${values.length}`;
      });
      clause += ` AND serial IN (${placeholders.join(", ")})`;
    }
    const released = await this.pool.query(
      `DELETE FROM device_leases WHERE ${clause} RETURNING serial`,
      values
    );
    return released.rows.length;
  }

  async listDeviceLeases(input: { hostId?: string } = {}): Promise<DeviceLeaseRecord[]> {
    const hostId = input.hostId ?? this.hostId;
    const result =
      hostId === null
        ? await this.pool.query(
            "SELECT * FROM device_leases ORDER BY acquired_at DESC, host_id ASC, serial ASC"
          )
        : await this.pool.query(
            "SELECT * FROM device_leases WHERE host_id = $1 ORDER BY acquired_at DESC, serial ASC",
            [hostId]
          );
    return result.rows.map(mapDeviceLease);
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) throw new Error(`项目未注册：${input.rootPath}`);
    const existing = await this.pool.query(
      `SELECT id FROM schedules WHERE project_id = $1 AND name = $2`,
      [project.id, input.name]
    );
    if (existing.rows.length > 0) {
      throw new Error(`同名定时回归已存在：${input.name}（请用 --name 指定其他名称）`);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await this.pool.query(
        `INSERT INTO schedules
           (id, project_id, name, feature_keys, platforms, baseline, every_minutes, enabled,
            last_fired_at, last_note, created_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NULL, NULL, $8, $9)`,
        [
          id,
          project.id,
          input.name,
          JSON.stringify(input.featureKeys),
          JSON.stringify(input.platforms),
          input.baseline,
          input.everyMinutes,
          createdAt,
          input.createdBy ?? null
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error(`同名定时回归已存在：${input.name}（请用 --name 指定其他名称）`);
      }
      throw error;
    }
    return {
      id,
      projectId: project.id,
      name: input.name,
      featureKeys: [...input.featureKeys],
      platforms: [...input.platforms],
      baseline: input.baseline,
      everyMinutes: input.everyMinutes,
      enabled: true,
      lastFiredAt: null,
      lastNote: null,
      createdAt,
      createdBy: input.createdBy ?? null
    };
  }

  async listSchedules(rootPath: string, limit?: number): Promise<ScheduleRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const result =
      limit === undefined
        ? await this.pool.query(
            `SELECT * FROM schedules WHERE project_id = $1 ORDER BY created_at DESC`,
            [project.id]
          )
        : await this.pool.query(
            `SELECT * FROM schedules WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [project.id, limit]
          );
    return result.rows.map((row) => mapSchedule(row));
  }

  async getSchedule(rootPath: string, id: string): Promise<ScheduleRecord | null> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return null;
    const result = await this.pool.query(
      `SELECT * FROM schedules WHERE project_id = $1 AND id = $2`,
      [project.id, id]
    );
    return result.rows.length > 0 ? mapSchedule(result.rows[0]!) : null;
  }

  async updateSchedule(
    rootPath: string,
    id: string,
    patch: { enabled?: boolean; everyMinutes?: number; lastNote?: string | null }
  ): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const sets: string[] = [];
    const values: unknown[] = [project.id, id];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.enabled !== undefined) add("enabled", patch.enabled);
    if (patch.everyMinutes !== undefined) add("every_minutes", patch.everyMinutes);
    if (patch.lastNote !== undefined) add("last_note", patch.lastNote);
    if (sets.length === 0) {
      return (await this.getSchedule(rootPath, id)) !== null;
    }
    const updated = await this.pool.query(
      `UPDATE schedules SET ${sets.join(", ")}
        WHERE project_id = $1 AND id = $2 RETURNING id`,
      values
    );
    return updated.rows.length > 0;
  }

  async deleteSchedule(rootPath: string, id: string): Promise<boolean> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return false;
    const deleted = await this.pool.query(
      `DELETE FROM schedules WHERE project_id = $1 AND id = $2 RETURNING id`,
      [project.id, id]
    );
    return deleted.rows.length > 0;
  }

  async claimScheduleWindow(input: {
    rootPath: string;
    scheduleId: string;
    firedAt: string;
    cutoff: string;
  }): Promise<boolean> {
    const project = await this.getProjectByPath(input.rootPath);
    if (!project) return false;
    const claimed = await this.pool.query(
      `UPDATE schedules SET last_fired_at = $3
        WHERE project_id = $1 AND id = $2 AND enabled
          AND (last_fired_at IS NULL OR last_fired_at <= $4)
      RETURNING id`,
      [project.id, input.scheduleId, input.firedAt, input.cutoff]
    );
    return claimed.rows.length > 0;
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
         (id, project_id, at, tool, family, ok, duration_ms, error_class, error_summary, signals, arg_keys, trace_id, host_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
        record.traceId,
        record.hostId,
        record.sessionId
      ]
    );
    await this.pruneUsageEvents(record.projectId, policy);
    return record;
  }

  async importLegacyLedger(
    rootPath: string,
    input: { usage: UsageEventRecord[]; regressionTasks: RegressionTaskRecord[] },
    dryRun = true
  ): Promise<LegacyLedgerImportResult> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) throw new Error(`PostgresStore: project not registered: ${rootPath}`);

    const usage = { found: input.usage.length, existing: 0, inserted: 0 };
    for (const entry of input.usage) {
      const existing = await this.pool.query("SELECT 1 FROM usage_events WHERE id = $1", [entry.id]);
      if ((existing.rowCount ?? 0) > 0) {
        usage.existing += 1;
        continue;
      }
      if (dryRun) continue;
      const inserted = await this.pool.query(
        `INSERT INTO usage_events
           (id, project_id, at, tool, family, ok, duration_ms, error_class, error_summary, signals, arg_keys, trace_id, host_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          project.id,
          entry.at,
          entry.tool,
          entry.family,
          entry.ok,
          entry.durationMs,
          entry.errorClass,
          entry.errorSummary,
          JSON.stringify(entry.signals),
          JSON.stringify(entry.argKeys),
          entry.traceId,
          entry.hostId ?? null,
          entry.sessionId ?? null
        ]
      );
      usage.inserted += Number(inserted.rowCount ?? 0);
    }

    const regressionTasks = { found: input.regressionTasks.length, existing: 0, inserted: 0 };
    for (const entry of input.regressionTasks) {
      const existing = await this.pool.query("SELECT 1 FROM regression_tasks WHERE id = $1", [
        entry.id
      ]);
      if ((existing.rowCount ?? 0) > 0) {
        regressionTasks.existing += 1;
        continue;
      }
      if (dryRun) continue;
      const inserted = await this.pool.query(
        `INSERT INTO regression_tasks
           (id, project_id, created_at, created_by, refs, platforms, baseline, status, claimed_by, claimed_at,
            run_ids, attempts, cancel_source, cancelled_by, cancelled_host_id, cancelled_at, cancel_note,
            cancel_requested_at, job_spec, device_serial, device_lease_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          entry.id,
          project.id,
          entry.createdAt,
          entry.createdBy,
          JSON.stringify(entry.refs),
          JSON.stringify(entry.platforms),
          entry.baseline,
          entry.status,
          entry.claimedBy,
          entry.claimedAt,
          JSON.stringify(entry.runIds),
          entry.attempts,
          entry.cancelSource,
          entry.cancelledBy,
          entry.cancelledHostId,
          entry.cancelledAt,
          entry.cancelNote,
          entry.cancelRequestedAt,
          entry.jobSpec === null || entry.jobSpec === undefined ? null : JSON.stringify(entry.jobSpec),
          entry.deviceSerial ?? null,
          entry.deviceLeaseId ?? null
        ]
      );
      regressionTasks.inserted += Number(inserted.rowCount ?? 0);
    }

    return { usage, regressionTasks };
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

  async recordProjectEvent(
    rootPath: string,
    input: ProjectEventInput
  ): Promise<RecordProjectEventResult> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) throw new Error(`PostgresStore: project not registered: ${rootPath}`);
    const hash = payloadHash(input.payload);
    const existing = await this.pool.query(
      "SELECT * FROM project_events WHERE project_id = $1 AND event_id = $2",
      [project.id, input.eventId]
    );
    if (existing.rows.length > 0) {
      const record = mapProjectEvent(existing.rows[0]!, true);
      return { record, duplicate: true, payloadMismatch: record.payloadSha256 !== hash };
    }
    const receivedAt = new Date().toISOString();
    const inserted = await this.pool.query(
      `INSERT INTO project_events
         (id, project_id, host_id, event_id, type, source, run_id, case_id, step, status, at, received_at, payload, payload_sha256, payload_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (project_id, event_id) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        project.id,
        project.hostId,
        input.eventId,
        input.type,
        input.source ?? "project",
        input.runId ?? null,
        input.caseId ?? null,
        input.step ?? null,
        input.status ?? null,
        input.at ?? receivedAt,
        receivedAt,
        JSON.stringify(input.payload ?? null),
        hash,
        payloadBytes(input.payload)
      ]
    );
    if (inserted.rows.length > 0) {
      this.scheduleEventPrune(rootPath);
      return {
        record: mapProjectEvent(inserted.rows[0]!, true),
        duplicate: false,
        payloadMismatch: false
      };
    }
    const conflict = await this.pool.query(
      "SELECT * FROM project_events WHERE project_id = $1 AND event_id = $2",
      [project.id, input.eventId]
    );
    if (conflict.rows.length === 0) {
      throw new Error(`PostgresStore: event conflict without existing row: ${input.eventId}`);
    }
    const record = mapProjectEvent(conflict.rows[0]!, true);
    return {
      record,
      duplicate: true,
      payloadMismatch: record.payloadSha256 !== hash
    };
  }

  async listProjectEvents(
    rootPath: string,
    query: ProjectEventQuery = {}
  ): Promise<ProjectEventRecord[]> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return [];
    const clauses = ["project_id = $1"];
    const values: unknown[] = [project.id];
    if (query.runId) {
      values.push(query.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    if (query.caseId) {
      values.push(query.caseId);
      clauses.push(`case_id = $${values.length}`);
    }
    if (query.type) {
      values.push(query.type);
      clauses.push(`type = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      clauses.push(`status = $${values.length}`);
    }
    if (query.since !== undefined) {
      const since = normalizeSince(query.since);
      if (since === null) throw new Error("invalid since");
      values.push(since);
      clauses.push(`received_at > $${values.length}`);
    }
    if (query.afterSeq !== undefined) {
      if (!Number.isInteger(query.afterSeq) || query.afterSeq < 0) {
        throw new Error("invalid afterSeq");
      }
      values.push(query.afterSeq);
      clauses.push(`seq > $${values.length}`);
    }
    if (query.consumed !== undefined) {
      clauses.push(query.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL");
    }
    const includePayload = query.includePayload === true;
    const max = includePayload ? 50 : 200;
    const requested = query.limit ?? 50;
    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, max));
    const order = query.order === "asc" ? "ASC" : "DESC";
    values.push(limit);
    const result = await this.pool.query(
      `SELECT * FROM project_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY received_at ${order}, seq ${order}
       LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => mapProjectEvent(row, includePayload));
  }

  async markProjectEventsConsumed(
    rootPath: string,
    eventIds: string[],
    consumedAt: string = new Date().toISOString()
  ): Promise<number> {
    const project = await this.getProjectByPath(rootPath);
    if (!project || eventIds.length === 0) return 0;
    let changed = 0;
    for (const eventId of eventIds) {
      const result = await this.pool.query(
        `UPDATE project_events
         SET consumed_at = $3
         WHERE project_id = $1 AND event_id = $2 AND consumed_at IS NULL`,
        [project.id, eventId, consumedAt]
      );
      changed += Number(result.rowCount ?? 0);
    }
    return changed;
  }

  async countProjectEvents(rootPath: string): Promise<number> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return 0;
    const result = await this.pool.query(
      "SELECT COUNT(*)::int AS count FROM project_events WHERE project_id = $1",
      [project.id]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async pruneProjectEvents(rootPath: string): Promise<number> {
    const project = await this.getProjectByPath(rootPath);
    if (!project) return 0;
    const policy = eventRetentionPolicy();
    const cutoff = eventCutoffIso(policy.days);
    const expired = await this.pool.query(
      "DELETE FROM project_events WHERE project_id = $1 AND received_at < $2",
      [project.id, cutoff]
    );
    const count = await this.countProjectEvents(rootPath);
    const overflow = Math.max(0, count - policy.max);
    let removed = Number(expired.rowCount ?? 0);
    if (overflow > 0) {
      const overflowRows = await this.pool.query(
        "SELECT id FROM project_events WHERE project_id = $1 ORDER BY seq ASC LIMIT $2",
        [project.id, overflow]
      );
      for (const row of overflowRows.rows) {
        const result = await this.pool.query("DELETE FROM project_events WHERE id = $1", [
          String(row.id)
        ]);
        removed += Number(result.rowCount ?? 0);
      }
    }
    return removed;
  }

  private scheduleEventPrune(rootPath: string): void {
    const now = Date.now();
    const last = this.eventPruneAt.get(rootPath) ?? 0;
    if (now - last < 5 * 60_000) return;
    this.eventPruneAt.set(rootPath, now);
    setImmediate(() => {
      void this.pruneProjectEvents(rootPath).catch((error) => {
        logWarn(`PG 事件裁剪失败（忽略）：${errorMessage(error)}`);
      });
    });
  }

  async recordAudit(rootPath: string, input: AuditEventInput): Promise<AuditEventRecord> {
    const record = buildAuditEvent(rootPath, input);
    await this.pool.query(
      `INSERT INTO audit_events (id, root_path, at, domain, action, result, summary, refs, actor, actor_host_id, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        record.rootPath,
        record.at,
        record.domain,
        record.action,
        record.result,
        record.summary,
        JSON.stringify(record.refs),
        record.actor ?? null,
        record.actorHostId ?? null,
        record.channel ?? null
      ]
    );
    return record;
  }

  async listAudit(rootPath: string, query: AuditQuery = {}): Promise<AuditEventRecord[]> {
    const conditions = ["root_path = $1"];
    const params: unknown[] = [rootPath];
    if (query.domain) {
      params.push(query.domain);
      conditions.push(`domain = $${params.length}`);
    }
    if (query.result) {
      params.push(query.result);
      conditions.push(`result = $${params.length}`);
    }
    if (query.since) {
      params.push(query.since);
      conditions.push(`at >= $${params.length}`);
    }
    params.push(normalizeAuditLimit(query.limit));
    const limitParam = params.length;
    const offset =
      typeof query.offset === "number" && Number.isFinite(query.offset) && query.offset > 0
        ? Math.floor(query.offset)
        : 0;
    params.push(offset);
    const result = await this.pool.query(
      `SELECT * FROM audit_events WHERE ${conditions.join(" AND ")} ORDER BY at DESC, id DESC LIMIT $${limitParam} OFFSET $${params.length}`,
      params
    );
    return result.rows.map(mapAudit);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM projects ORDER BY last_seen_at DESC, name ASC"
    );
    return result.rows.map(mapProject);
  }

  async adoptProjectHost(input: { projectId: string; hostId: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE projects SET host_id = $2
       WHERE id = $1 AND host_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM projects target
           WHERE target.host_id = $2
             AND target.root_path = (SELECT root_path FROM projects WHERE id = $1)
         )`,
      [input.projectId, input.hostId]
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async createWebProject(input: {
    rootPath: string;
    name: string;
    normalizedName: string;
    platforms: string[];
    appPackage?: string | null;
    customerName?: string | null;
    owner?: string | null;
    projectId?: string | null;
  }): Promise<WebProjectRecord> {
    const projectId =
      input.projectId !== undefined
        ? input.projectId
        : ((await this.getProjectByPath(input.rootPath))?.id ?? null);
    const existing = await this.pool.query(
      "SELECT id FROM web_projects WHERE normalized_name = $1",
      [input.normalizedName]
    );
    if (existing.rows.length > 0) {
      throw new Error(`同名 Web 项目已存在：${input.normalizedName}`);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await this.pool.query(
        `INSERT INTO web_projects
           (id, project_id, root_path, name, normalized_name, platforms, app_package,
            customer_name, owner, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)`,
        [
          id,
          projectId,
          input.rootPath,
          input.name,
          input.normalizedName,
          JSON.stringify(input.platforms),
          input.appPackage ?? null,
          input.customerName ?? null,
          input.owner ?? null,
          createdAt
        ]
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error(`Web 项目已存在：${input.normalizedName}`);
      }
      throw error;
    }
    const inserted = await this.pool.query("SELECT * FROM web_projects WHERE id = $1", [id]);
    return mapWebProject(inserted.rows[0]!);
  }

  async getWebProject(rootPath: string): Promise<WebProjectRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM web_projects WHERE root_path = $1",
      [rootPath]
    );
    return result.rows.length > 0 ? mapWebProject(result.rows[0]!) : null;
  }

  async listWebProjects(): Promise<WebProjectRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM web_projects ORDER BY created_at DESC, id DESC"
    );
    return result.rows.map(mapWebProject);
  }

  async archiveWebProject(rootPath: string, _at: string): Promise<boolean> {
    const updated = await this.pool.query(
      "UPDATE web_projects SET status = 'archived' WHERE root_path = $1 RETURNING id",
      [rootPath]
    );
    return updated.rows.length > 0;
  }

  async deleteWebProject(rootPath: string): Promise<boolean> {
    const deleted = await this.pool.query(
      "DELETE FROM web_projects WHERE root_path = $1 RETURNING id",
      [rootPath]
    );
    return deleted.rows.length > 0;
  }

  async linkWebProjectProjectId(rootPath: string, projectId: string): Promise<boolean> {
    const updated = await this.pool.query(
      "UPDATE web_projects SET project_id = $2 WHERE root_path = $1 RETURNING id",
      [rootPath, projectId]
    );
    return updated.rows.length > 0;
  }

  async createWebAsset(input: CreateWebAssetInput): Promise<WebAssetRecord> {
    const projectId =
      input.projectId !== undefined
        ? input.projectId
        : ((await this.getProjectByPath(input.rootPath))?.id ?? null);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    // version 由 `MAX+1` 分配；(root_path, kind, version) 唯一索引兜底并发；冲突时重试。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.withTransaction(async (run) => {
          const next = await run(
            `SELECT COALESCE(MAX(version), 0) + 1 AS next
               FROM web_assets WHERE root_path = $1 AND kind = $2`,
            [input.rootPath, input.kind]
          );
          const version = Number(next.rows[0]?.next ?? 1);
          await run(
            `INSERT INTO web_assets
               (id, project_id, root_path, kind, version, filename, sha256, size,
                storage_path, uploaded_by, created_at, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              id,
              projectId,
              input.rootPath,
              input.kind,
              version,
              input.filename,
              input.sha256,
              input.size,
              input.storagePath,
              input.uploadedBy ?? null,
              createdAt,
              JSON.stringify(input.metadata ?? {})
            ]
          );
          const inserted = await run("SELECT * FROM web_assets WHERE id = $1", [id]);
          return mapWebAsset(inserted.rows[0]!);
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "23505" || attempt >= 2) throw error;
      }
    }
  }

  async listWebAssets(rootPath: string, kind?: WebAssetKind): Promise<WebAssetRecord[]> {
    const result =
      kind === undefined
        ? await this.pool.query(
            "SELECT * FROM web_assets WHERE root_path = $1 ORDER BY version DESC, id DESC",
            [rootPath]
          )
        : await this.pool.query(
            "SELECT * FROM web_assets WHERE root_path = $1 AND kind = $2 ORDER BY version DESC, id DESC",
            [rootPath, kind]
          );
    return result.rows.map(mapWebAsset);
  }

  async getWebAsset(rootPath: string, id: string): Promise<WebAssetRecord | null> {
    const result = await this.pool.query(
      "SELECT * FROM web_assets WHERE root_path = $1 AND id = $2",
      [rootPath, id]
    );
    return result.rows.length > 0 ? mapWebAsset(result.rows[0]!) : null;
  }

  async saveExcelMapping(input: SaveExcelMappingInput): Promise<ExcelMappingRecord> {
    const projectId = (await this.getProjectByPath(input.rootPath))?.id ?? null;
    const columnMap = JSON.stringify(input.columnMap);
    const update = () =>
      this.pool.query(
        `UPDATE excel_mappings
            SET project_id = $1, sheet_name = $2, column_map = $3, created_by = $4
          WHERE root_path = $5 AND asset_id = $6 AND header_fingerprint = $7
          RETURNING *`,
        [
          projectId,
          input.sheetName,
          columnMap,
          input.createdBy ?? null,
          input.rootPath,
          input.assetId,
          input.headerFingerprint
        ]
      );
    const updated = await update();
    if (updated.rows.length > 0) return mapExcelMapping(updated.rows[0]!);

    const id = randomUUID();
    try {
      const inserted = await this.pool.query(
        `INSERT INTO excel_mappings
           (id, project_id, root_path, asset_id, sheet_name, header_fingerprint,
            column_map, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          id,
          projectId,
          input.rootPath,
          input.assetId,
          input.sheetName,
          input.headerFingerprint,
          columnMap,
          input.createdBy ?? null,
          new Date().toISOString()
        ]
      );
      return mapExcelMapping(inserted.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const retried = await update();
      if (retried.rows.length === 0) throw error;
      return mapExcelMapping(retried.rows[0]!);
    }
  }

  async findExcelMapping(
    rootPath: string,
    assetId: string,
    headerFingerprint: string
  ): Promise<ExcelMappingRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM excel_mappings
        WHERE root_path = $1 AND asset_id = $2 AND header_fingerprint = $3`,
      [rootPath, assetId, headerFingerprint]
    );
    return result.rows.length > 0 ? mapExcelMapping(result.rows[0]!) : null;
  }

  async listExcelMappings(rootPath: string, assetId?: string): Promise<ExcelMappingRecord[]> {
    const result =
      assetId === undefined
        ? await this.pool.query(
            "SELECT * FROM excel_mappings WHERE root_path = $1 ORDER BY created_at DESC, id DESC",
            [rootPath]
          )
        : await this.pool.query(
            `SELECT * FROM excel_mappings
              WHERE root_path = $1 AND asset_id = $2
              ORDER BY created_at DESC, id DESC`,
            [rootPath, assetId]
          );
    return result.rows.map(mapExcelMapping);
  }

  async recordExcelWriteback(input: RecordExcelWritebackInput): Promise<ExcelWritebackRecord> {
    const projectId = (await this.getProjectByPath(input.rootPath))?.id ?? null;
    const result = await this.pool.query(
      `INSERT INTO excel_writeback_journal
         (id, project_id, root_path, asset_id, sheet_name, job_id, case_id,
          column_key, cell_ref, value, actor, written_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        randomUUID(),
        projectId,
        input.rootPath,
        input.assetId,
        input.sheetName,
        input.jobId ?? null,
        input.caseId,
        input.columnKey,
        input.cellRef,
        input.value,
        input.actor ?? null,
        input.writtenAt ?? new Date().toISOString()
      ]
    );
    return mapExcelWriteback(result.rows[0]!);
  }

  async lastExcelWriteback(
    rootPath: string,
    assetId: string,
    cellRef: string
  ): Promise<ExcelWritebackRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM excel_writeback_journal
        WHERE root_path = $1 AND asset_id = $2 AND cell_ref = $3
        ORDER BY written_at DESC, id DESC
        LIMIT 1`,
      [rootPath, assetId, cellRef]
    );
    return result.rows.length > 0 ? mapExcelWriteback(result.rows[0]!) : null;
  }

  async lastExcelWritebackByCellKey(
    rootPath: string,
    assetId: string,
    sheetName: string,
    caseId: string,
    columnKey: string
  ): Promise<ExcelWritebackRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM excel_writeback_journal
        WHERE root_path = $1 AND asset_id = $2 AND sheet_name = $3
          AND case_id = $4 AND column_key = $5
        ORDER BY written_at DESC, id DESC
        LIMIT 1`,
      [rootPath, assetId, sheetName, caseId, columnKey]
    );
    return result.rows.length > 0 ? mapExcelWriteback(result.rows[0]!) : null;
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
    traceId: row.trace_id === null || row.trace_id === undefined ? null : String(row.trace_id),
    hostId: nullableString(row.host_id),
    sessionId: nullableString(row.session_id)
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

/** 并发首连建表竞态（PG 的 CREATE TABLE IF NOT EXISTS 可抛 23505/42P07/42710）→ 视为已有并发建表者。 */
function isIdempotentSchemaRace(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "42P07" || code === "42710") return true;
  const message = errorMessage(error);
  return message.includes("duplicate key value") || message.includes("already exists");
}

/** pg-mem 等未实现 advisory lock 的引擎会报 undefined function（42883）。 */
function isUndefinedFunction(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42883") return true;
  return errorMessage(error).includes("does not exist");
}

function mapAudit(row: Record<string, unknown>): AuditEventRecord {
  let refs: Record<string, string | undefined> = {};
  try {
    const parsed = JSON.parse(String(row.refs ?? "{}")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      refs = parsed as Record<string, string | undefined>;
    }
  } catch {
    refs = {};
  }
  return {
    id: String(row.id),
    rootPath: String(row.root_path),
    at: String(row.at),
    domain: String(row.domain),
    action: String(row.action),
    result: String(row.result) as AuditEventRecord["result"],
    summary: String(row.summary),
    refs,
    actor: nullableString(row.actor),
    actorHostId: nullableString(row.actor_host_id),
    channel: nullableString(row.channel)
  };
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row.id),
    hostId: row.host_id === null || row.host_id === undefined ? null : String(row.host_id),
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

class DeviceLeaseBusyError extends Error {
  readonly busy: string[];
  constructor(busy: string[]) {
    super(`device-busy: ${busy.join(",")}`);
    this.name = "DeviceLeaseBusyError";
    this.busy = busy;
  }
}

function mapDeviceLease(row: Record<string, unknown>): DeviceLeaseRecord {
  return {
    hostId: String(row.host_id),
    serial: String(row.serial),
    taskId: String(row.task_id),
    projectId: nullableString(row.project_id),
    acquiredAt: String(row.acquired_at),
    renewAt: String(row.renew_at),
    expiresAt: String(row.expires_at)
  };
}

function mapRegressionTask(row: Record<string, unknown>): RegressionTaskRecord {
  return normalizeRegressionTask({
    id: String(row.id),
    projectId: nullableString(row.project_id),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by),
    refs: parseTaskRefs(row.refs),
    platforms: parseStringArray(row.platforms),
    baseline: row.baseline === "none" ? "none" : "latest",
    status: String(row.status) as RegressionTaskRecord["status"],
    claimedBy: nullableString(row.claimed_by),
    claimedAt: nullableString(row.claimed_at),
    attempts:
      row.attempts === null || row.attempts === undefined ? 0 : Number(row.attempts),
    runIds: parseStringArray(row.run_ids),
    targetHostId: nullableString(row.target_host_id),
    createdHostId: nullableString(row.created_host_id),
    claimedHostId: nullableString(row.claimed_host_id),
    claimedInstanceId: nullableString(row.claimed_instance_id),
    priority: row.priority === null || row.priority === undefined ? 0 : Number(row.priority),
    lastProgressAt: nullableString(row.last_progress_at),
    startedAt: nullableString(row.started_at),
    cancelSource: nullableString(row.cancel_source) as CancelSource | null,
    cancelledBy: nullableString(row.cancelled_by),
    cancelledHostId: nullableString(row.cancelled_host_id),
    cancelledAt: nullableString(row.cancelled_at),
    cancelNote: nullableString(row.cancel_note),
    cancelRequestedAt: nullableString(row.cancel_requested_at),
    jobSpec: parseJobSpec(row.job_spec),
    deviceSerial: nullableString(row.device_serial),
    deviceLeaseId: nullableString(row.device_lease_id)
  });
}

function parseJobSpec(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isSkipLockedUnsupported(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return false;
  if (/skip locked/i.test(message)) {
    return /not supported|syntax|query planner|failed to parse/i.test(message);
  }
  return false;
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
    verdictNote: nullableString(row.verdict_note),
    jiraIssueKey: nullableString(row.jira_issue_key)
  };
}

function parseApiReview(value: unknown): ApiReviewSnapshot | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    change: typeof record.change === "string" ? record.change : "unknown",
    status: typeof record.status === "string" ? record.status : "unknown",
    specSha256: typeof record.specSha256 === "string" ? record.specSha256 : null,
    designFingerprint: typeof record.designFingerprint === "string" ? record.designFingerprint : null,
    carriedForward: record.carriedForward === true,
    designChanged: record.designChanged === true
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
    runner: nullableString(row.runner),
    runId: nullableString(row.run_id),
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
    apiReview: parseApiReview(row.api_review),
    cases: caseRows.map(mapSuiteRunCase)
  };
}

function mapRunner(row: Record<string, unknown>): RunnerRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    name: String(row.name),
    hostname: String(row.hostname),
    platforms: parseStringArray(row.platforms),
    devices: parseRunnerDevices(row.devices),
    tools: parseRunnerTools(row.tools),
    artifactBaseUrl: nullableString(row.artifact_base_url),
    version: nullableString(row.version),
    hostId: nullableString(row.host_id),
    instanceId: nullableString(row.instance_id),
    lastSeenAt: String(row.last_seen_at),
    createdAt: String(row.created_at)
  };
}

function mapWebRunner(row: Record<string, unknown>): WebRunnerRecord {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    name: String(row.name),
    hostname: String(row.hostname),
    platforms: parseStringArray(row.platforms),
    devices: parseRunnerDevices(row.devices),
    tools: parseRunnerTools(row.tools),
    artifactBaseUrl: nullableString(row.artifact_base_url),
    version: nullableString(row.version),
    instanceId: String(row.instance_id),
    lastSeenAt: String(row.last_seen_at),
    createdAt: String(row.created_at)
  };
}

function parseRunnerDevices(value: unknown): RunnerDevice[] {
  let data: unknown;
  try {
    data = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const devices: RunnerDevice[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.serial !== "string") continue;
    const platform =
      record.platform === "ios" || record.platform === "android" ? record.platform : null;
    if (platform === null) continue;
    const kind =
      record.kind === "device" || record.kind === "emulator" || record.kind === "simulator"
        ? record.kind
        : "device";
    devices.push({
      serial: record.serial,
      name: typeof record.name === "string" ? record.name : "",
      model: typeof record.model === "string" ? record.model : null,
      osVersion: typeof record.osVersion === "string" ? record.osVersion : null,
      platform,
      kind,
      state: typeof record.state === "string" ? record.state : ""
    });
  }
  return devices;
}

function parseRunnerTools(value: unknown): RunnerTools {
  let data: unknown;
  try {
    data = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    data = null;
  }
  const record =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  return {
    adb: record.adb === true,
    idb: record.idb === true,
    simctl: record.simctl === true,
    ideviceId: record.ideviceId === true,
    appium: record.appium === true,
    maestro: record.maestro === true,
    devicectl: record.devicectl === true
  };
}

function mapSchedule(row: Record<string, unknown>): ScheduleRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    name: String(row.name),
    featureKeys: parseStringArray(row.feature_keys),
    platforms: parseStringArray(row.platforms),
    baseline: row.baseline === "none" ? "none" : "latest",
    everyMinutes: Number(row.every_minutes),
    enabled: Boolean(row.enabled),
    lastFiredAt: nullableString(row.last_fired_at),
    lastNote: nullableString(row.last_note),
    createdAt: String(row.created_at),
    createdBy: nullableString(row.created_by)
  };
}

function mapWebProject(row: Record<string, unknown>): WebProjectRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    rootPath: String(row.root_path),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    platforms: parseStringArray(row.platforms),
    appPackage: nullableString(row.app_package),
    customerName: nullableString(row.customer_name),
    owner: nullableString(row.owner),
    status: row.status === "archived" ? "archived" : "active",
    createdAt: String(row.created_at)
  };
}

function mapWebAsset(row: Record<string, unknown>): WebAssetRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    rootPath: String(row.root_path),
    kind: String(row.kind) as WebAssetKind,
    version: Number(row.version),
    filename: String(row.filename),
    sha256: String(row.sha256),
    size: Number(row.size),
    storagePath: String(row.storage_path),
    uploadedBy: nullableString(row.uploaded_by),
    createdAt: String(row.created_at),
    metadata: parseJsonObject(row.metadata)
  };
}

function mapExcelMapping(row: Record<string, unknown>): ExcelMappingRecord {
  const columnMap: Record<string, string> = {};
  for (const [field, header] of Object.entries(parseJsonObject(row.column_map))) {
    if (typeof header === "string") columnMap[field] = header;
  }
  return {
    id: String(row.id),
    rootPath: String(row.root_path),
    assetId: String(row.asset_id),
    sheetName: String(row.sheet_name),
    headerFingerprint: String(row.header_fingerprint),
    columnMap,
    createdBy: nullableString(row.created_by),
    createdAt: String(row.created_at)
  };
}

function mapExcelWriteback(row: Record<string, unknown>): ExcelWritebackRecord {
  return {
    id: String(row.id),
    projectId: nullableString(row.project_id),
    rootPath: String(row.root_path),
    assetId: String(row.asset_id),
    sheetName: String(row.sheet_name),
    jobId: nullableString(row.job_id),
    caseId: String(row.case_id),
    columnKey: String(row.column_key),
    cellRef: String(row.cell_ref),
    value: String(row.value),
    actor: nullableString(row.actor),
    writtenAt: String(row.written_at)
  };
}

function mapHost(row: Record<string, unknown>): HostRecord {
  return {
    id: String(row.id),
    hardwareId: nullableString(row.hardware_id),
    hostname: String(row.hostname),
    username: nullableString(row.username),
    osPlatform: String(row.os_platform),
    osVersion: nullableString(row.os_version),
    arch: nullableString(row.arch),
    identitySource: String(row.identity_source),
    kind: String(row.kind),
    capabilities: parseStringArray(row.capabilities),
    env: parseJsonObject(row.env),
    envAt: nullableString(row.env_at),
    ipPrimary: nullableString(row.ip_primary),
    label: nullableString(row.label),
    owner: nullableString(row.owner),
    expectedOs: nullableString(row.expected_os),
    expectedHostname: nullableString(row.expected_hostname),
    registeredAt: nullableString(row.registered_at),
    registeredBy: nullableString(row.registered_by),
    clientSeenAt: nullableString(row.client_seen_at),
    runnerSeenAt: nullableString(row.runner_seen_at),
    lastSeenAt: String(row.last_seen_at),
    queuePaused: Boolean(row.queue_paused),
    queuePausedAt: nullableString(row.queue_paused_at),
    queuePausedBy: nullableString(row.queue_paused_by),
    firstSeenAt: String(row.first_seen_at),
    createdAt: String(row.created_at)
  };
}

function mapHostAddress(row: Record<string, unknown>): HostAddressRecord {
  return {
    hostId: String(row.host_id),
    source: String(row.source),
    iface: String(row.iface),
    family: String(row.family),
    address: String(row.address),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at)
  };
}

function mapHostSession(row: Record<string, unknown>): HostSessionRecord {
  return {
    id: String(row.id),
    hostId: String(row.host_id),
    projectId: nullableString(row.project_id),
    rootPath: String(row.root_path),
    username: nullableString(row.username),
    client: nullableString(row.client),
    clientVersion: nullableString(row.client_version),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    startedAt: String(row.started_at),
    lastSeenAt: String(row.last_seen_at),
    endedAt: nullableString(row.ended_at)
  };
}

function hostRecordFromInput(input: UpsertHostInput, now: string): HostRecord {
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
  record.lastSeenAt = maxIso(record.lastSeenAt, record.clientSeenAt, record.runnerSeenAt);
  return record;
}

function cloneHostRow(record: HostRecord): HostRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    env: { ...record.env }
  };
}

function maxIso(...values: Array<string | null | undefined>): string {
  let best = "";
  for (const value of values) {
    if (typeof value === "string" && value > best) best = value;
  }
  return best;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function mapProjectEvent(row: Record<string, unknown>, includePayload: boolean): ProjectEventRecord {
  const payload = JSON.parse(String(row.payload));
  return {
    seq: Number(row.seq),
    id: String(row.id),
    projectId: String(row.project_id),
    hostId: row.host_id === null || row.host_id === undefined ? null : String(row.host_id),
    eventId: String(row.event_id),
    type: String(row.type),
    source: String(row.source),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    caseId: row.case_id === null || row.case_id === undefined ? null : String(row.case_id),
    step: row.step === null || row.step === undefined ? null : Number(row.step),
    status: row.status === null || row.status === undefined ? null : String(row.status),
    at: String(row.at),
    receivedAt: String(row.received_at),
    payload: includePayload ? payload : undefined,
    payloadSha256: String(row.payload_sha256),
    payloadBytes: Number(row.payload_bytes),
    consumedAt:
      row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at)
  };
}
