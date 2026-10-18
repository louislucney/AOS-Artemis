import assert from "node:assert/strict";
import test from "node:test";

import { PostgresStore } from "../dist/db/postgres.js";

function fakePool(onQuery) {
  const calls = [];
  return {
    calls,
    pool: {
      async query(text) {
        calls.push(text);
        return onQuery(text);
      }
    }
  };
}

test("PostgresStore.init: 并发建表竞态（duplicate key 23505）被容忍且继续", async () => {
  const { calls, pool } = fakePool((text) => {
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
