import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { migrateLegacyLedger, readLegacyLedger } from "../dist/ledger/migrate.js";
import { makeTempDir } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

const USAGE = [
  {
    id: "usage-1",
    projectId: "legacy-project",
    at: "2026-10-01T00:00:00.000Z",
    tool: "aos_status",
    family: "native",
    ok: true,
    durationMs: 12,
    errorClass: null,
    errorSummary: null,
    signals: [],
    argKeys: [],
    traceId: null
  },
  {
    id: "usage-2",
    projectId: "legacy-project",
    at: "2026-10-01T00:01:00.000Z",
    tool: "mobile_run_task",
    family: "mobile",
    ok: false,
    durationMs: 30,
    errorClass: "artemis",
    errorSummary: "boom",
    signals: [{ code: "setup_required" }],
    argKeys: ["task_desc"],
    traceId: "trace-1"
  }
];

const TASK = {
  id: "task-1",
  projectId: "legacy-project",
  createdAt: "2026-10-01T00:02:00.000Z",
  createdBy: "cli",
  refs: [{ caseSetId: "set-1", featureKey: "f-1" }],
  platforms: ["android"],
  baseline: "latest",
  status: "completed",
  claimedBy: null,
  claimedAt: null,
  attempts: 1,
  runIds: ["run-1"]
};

function makeLegacyProject() {
  const dir = makeTempDir("aos-ledger-migrate-");
  const ledger = path.join(dir, ".artemis", "ledger");
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(
    path.join(ledger, "usage.jsonl"),
    `${USAGE.map((entry) => JSON.stringify(entry)).join("\n")}\nnot-json\n`,
    "utf-8"
  );
  fs.writeFileSync(
    path.join(ledger, "state.json"),
    JSON.stringify({ v: 1, state: { regressionTasks: [TASK] } }),
    "utf-8"
  );
  return dir;
}

test("ledger migrate: dryRun、幂等写入与 warning", async () => {
  const dir = makeLegacyProject();
  const snapshot = readLegacyLedger(dir);
  assert.equal(snapshot.usage.length, 2);
  assert.equal(snapshot.regressionTasks.length, 1);
  assert.equal(snapshot.warnings.length, 1);

  const store = await makePgStore();
  try {
    await store.upsertProject({ rootPath: dir, name: "demo" });

    const dry = await migrateLegacyLedger(store, dir, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.counts?.usage, { found: 2, existing: 0, inserted: 0 });
    assert.deepEqual(dry.counts?.regressionTasks, { found: 1, existing: 0, inserted: 0 });
    assert.equal((await store.listUsageEvents(dir)).length, 0);

    const first = await migrateLegacyLedger(store, dir, { dryRun: false });
    assert.equal(first.ok, true);
    assert.deepEqual(first.counts?.usage, { found: 2, existing: 0, inserted: 2 });
    assert.deepEqual(first.counts?.regressionTasks, { found: 1, existing: 0, inserted: 1 });
    assert.equal((await store.listUsageEvents(dir)).length, 2);
    assert.equal((await store.listRegressionTasks(dir)).length, 1);

    const second = await migrateLegacyLedger(store, dir, { dryRun: false });
    assert.deepEqual(second.counts?.usage, { found: 2, existing: 2, inserted: 0 });
    assert.deepEqual(second.counts?.regressionTasks, { found: 1, existing: 1, inserted: 0 });
  } finally {
    await store.close();
  }
});

test("ledger migrate: 非 PG 存储显式不可用", async () => {
  const dir = makeLegacyProject();
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: dir, name: "demo" });
  const result = await migrateLegacyLedger(store, dir, { dryRun: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /PostgreSQL/);
});
