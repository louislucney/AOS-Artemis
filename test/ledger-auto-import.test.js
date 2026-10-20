import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

function writeUsage(root, id = "usage-auto-1") {
  const ledger = path.join(root, ".artemis", "ledger");
  fs.mkdirSync(ledger, { recursive: true });
  fs.writeFileSync(
    path.join(ledger, "usage.jsonl"),
    `${JSON.stringify({
      id,
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
    })}\n`,
    "utf-8"
  );
  return ledger;
}

test("ledger auto-import: PG startup imports local usage once and stamps", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const ledger = writeUsage(dir);
  const store = await makePgStore();
  try {
    await loadTestRuntime(dir, { store });
    const events = await store.listUsageEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "usage-auto-1");
    assert.equal(fs.existsSync(path.join(ledger, ".pg-sync.json")), true);

    await loadTestRuntime(dir, { store });
    assert.equal((await store.listUsageEvents(dir)).length, 1);
  } finally {
    await store.close();
  }
});

test("ledger auto-import: AOS_LEDGER_AUTO_IMPORT=0 disables the startup import", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeUsage(dir, "usage-auto-2");
  const store = await makePgStore();
  try {
    await loadTestRuntime(dir, {
      store,
      baseEnv: { ...process.env, AOS_LEDGER_AUTO_IMPORT: "0" }
    });
    assert.equal((await store.listUsageEvents(dir)).length, 0);
  } finally {
    await store.close();
  }
});

test("ledger auto-import: file/memory stores are left untouched", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeUsage(dir, "usage-auto-3");
  const { runtime } = await loadTestRuntime(dir);
  assert.notEqual(runtime.store.kind, "postgres");
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "ledger", ".pg-sync.json")), false);
  assert.equal(fs.readFileSync(path.join(dir, ".artemis", "ledger", "usage.jsonl"), "utf-8").includes("usage-auto-3"), true);
});
