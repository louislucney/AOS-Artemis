import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";

function fakePool(onQuery) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(text, values) {
        calls.push(text);
        return onQuery(text, values);
      }
    }
  };
}

function presentIndexes(values) {
  return { rows: values?.[0] ? [{ "?column?": 1 }] : [], rowCount: 1 };
}

test("PostgresStore.init: 并发建表竞态（duplicate key 23505）被容忍且继续", async () => {
  const { calls, pool } = fakePool((text, values) => {
    if (text.includes("FROM pg_indexes")) return presentIndexes(values);
    if (text.includes("CREATE TABLE IF NOT EXISTS projects")) {
      const error = new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"');
      error.code = "23505";
      throw error;
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  await store.init();
  assert.ok(
    calls.some((text) => text.includes("CREATE TABLE IF NOT EXISTS audit_events")),
    "竞态后继续执行后续建表"
  );
});

test("PostgresStore.init: 非竞态错误照常抛出", async () => {
  const { pool } = fakePool((text) => {
    if (text.includes("CREATE TABLE IF NOT EXISTS task_stats")) {
      throw new Error("permission denied");
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  await assert.rejects(() => store.init(), /permission denied/);
});

test("PostgresStore.init: 必需索引缺失 → 明确报错（不再带病启动）", async () => {
  const { pool } = fakePool((text, values) => {
    if (text.includes("FROM pg_indexes")) {
      return { rows: values?.[0] === "runners_project_host_idx" ? [{}] : [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  await assert.rejects(
    () => store.init(),
    /数据库迁移未完成：缺少必需索引 projects_host_path_idx/
  );
});

test("PostgresStore.init: 引擎不支持 pg_indexes → 跳过校验（WARN，不阻断）", async () => {
  const { pool } = fakePool((text) => {
    if (text.includes("FROM pg_indexes")) {
      throw new Error('relation "pg_indexes" does not exist');
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  await store.init();
});

test("PostgresStore.init: 迁移顺序——regression_tasks 先补 device_serial 再建依赖索引", async () => {
  const { calls, pool } = fakePool((text, values) => {
    if (text.includes("FROM pg_indexes")) return presentIndexes(values);
    return { rows: [], rowCount: 0 };
  });
  const store = new PostgresStore(pool);
  await store.init();
  const alter = calls.findIndex((text) =>
    text.includes("ALTER TABLE regression_tasks ADD COLUMN IF NOT EXISTS device_serial")
  );
  const index = calls.findIndex((text) => text.includes("regression_tasks_execution_mode_idx"));
  assert.ok(alter >= 0, "存在补列语句");
  assert.ok(index > alter, "依赖 device_serial 的索引在补列之后创建");
});

test("PostgresStore.init: 存量 excel_writeback_journal 缺 status 列 → 先补列再建索引，不阻断启动", async () => {
  // noAstCoverageCheck：旧表已存在时 pg-mem 会因未读取的 AST 约束直接报错，这里只关注迁移结果
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    `CREATE TABLE excel_writeback_journal (
       id TEXT PRIMARY KEY,
       project_id TEXT,
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
     )`
  );
  const store = new PostgresStore(pool);
  await store.init();
  const columns = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'excel_writeback_journal'"
  );
  assert.ok(
    columns.rows.some((row) => row.column_name === "status"),
    "存量表由 MIGRATIONS 补 status 列"
  );
});
