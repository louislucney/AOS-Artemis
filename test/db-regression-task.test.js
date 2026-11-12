import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { normalizeRegressionTask } from "../dist/db/types.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

function input(rootPath) {
  return {
    rootPath,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "test",
    materialsAssetId: "mat-1"
  };
}

test("regression task: materialsAssetId 往返（Memory + PG）", async () => {
  for (const store of [new MemoryStore(), await makePgStore()]) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const created = await store.createRegressionTask(input("/w/p1"));
    assert.equal(created.materialsAssetId, "mat-1");
    const loaded = await store.getRegressionTask("/w/p1", created.id);
    assert.equal(loaded.materialsAssetId, "mat-1");
  }
});

test("normalizeRegressionTask: 旧行缺 materialsAssetId → null", () => {
  const normalized = normalizeRegressionTask({
    id: "t",
    projectId: "p",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    status: "pending",
    claimedBy: null,
    claimedAt: null,
    attempts: 0,
    runIds: [],
    targetHostId: null,
    createdHostId: null,
    claimedHostId: null,
    claimedInstanceId: null,
    priority: 0,
    lastProgressAt: null,
    startedAt: null,
    cancelSource: null,
    cancelledBy: null,
    cancelledHostId: null,
    cancelledAt: null,
    cancelNote: null,
    cancelRequestedAt: null,
    jobSpec: null,
    executionMode: "maestro",
    deviceSerial: null,
    deviceLeaseId: null,
    appAssetId: null,
    appPackage: null,
    caseIds: [],
    progress: null
  });
  assert.equal(normalized.materialsAssetId, null);
});
