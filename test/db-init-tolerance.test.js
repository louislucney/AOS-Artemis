import assert from "node:assert/strict";
import test from "node:test";

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
