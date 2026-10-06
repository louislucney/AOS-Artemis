import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makeStores() {
  const memory = new MemoryStore();
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const pg = new PostgresStore(pool);
  await pg.init();
  return { memory, pg, pool };
}

function usageInput(overrides = {}) {
  return {
    tool: "aos_status",
    family: "native",
    ok: true,
    durationMs: 12,
    ...overrides
  };
}

test("usage events: record, filter, order, limit, roundtrip (memory + pg-mem)", async () => {
  const { memory, pg } = await makeStores();
  for (const store of [memory, pg]) {
    await store.upsertProject({ rootPath: "/w/u1", name: "u1" });
    assert.deepEqual(await store.listUsageEvents("/w/u1"), []);
    const first = await store.recordUsageEvent(
      "/w/u1",
      usageInput({ tool: "figma_extract_flows", at: "2026-01-01T00:00:00.000Z" })
    );
    assert.ok(first.id);
    assert.ok(first.projectId);
    assert.equal(first.at, "2026-01-01T00:00:00.000Z");

    await store.recordUsageEvent(
      "/w/u1",
      usageInput({
        tool: "mobile_run_task",
        family: "mobile",
        ok: false,
        durationMs: 900,
        errorClass: "unknown",
        errorSummary: "boom",
        signals: [{ code: "vision_degraded" }, { code: "param_ignored", field: "model" }],
        argKeys: ["task_desc", "model"],
        traceId: "ios-1",
        at: "2026-01-01T00:01:00.000Z"
      })
    );
    await store.recordUsageEvent(
      "/w/u1",
      usageInput({ tool: "figma_extract_flows", ok: false, at: "2026-01-01T00:02:00.000Z" })
    );

    const all = await store.listUsageEvents("/w/u1");
    assert.equal(all.length, 3);
    assert.equal(all[0].at, "2026-01-01T00:02:00.000Z");
    assert.equal(all[2].id, first.id);
    const failed = all.find((event) => event.tool === "mobile_run_task");
    assert.equal(failed.ok, false);
    assert.equal(failed.errorClass, "unknown");
    assert.equal(failed.errorSummary, "boom");
    assert.equal(failed.traceId, "ios-1");
    assert.deepEqual(failed.signals, [
      { code: "vision_degraded" },
      { code: "param_ignored", field: "model" }
    ]);
    assert.deepEqual(failed.argKeys, ["task_desc", "model"]);
    assert.equal(failed.family, "mobile");

    assert.equal((await store.listUsageEvents("/w/u1", { tool: "figma_extract_flows" })).length, 2);
    assert.equal((await store.listUsageEvents("/w/u1", { status: "error" })).length, 2);
    assert.equal((await store.listUsageEvents("/w/u1", { status: "ok" })).length, 1);
    assert.equal(
      (await store.listUsageEvents("/w/u1", { since: "2026-01-01T00:00:30.000Z" })).length,
      2
    );
    assert.equal(
      (await store.listUsageEvents("/w/u1", { until: "2026-01-01T00:00:30.000Z" })).length,
      1
    );
    assert.equal((await store.listUsageEvents("/w/u1", { limit: 1 })).length, 1);
    assert.equal((await store.listUsageEvents("/w/u1", { limit: 0 })).length, 3);
    assert.equal((await store.listUsageEvents("/w/u1", { limit: -5 })).length, 3);

    const orphan = await store.recordUsageEvent(
      "/w/never-registered",
      usageInput({ tool: "aos_usage", at: "2026-01-01T00:03:00.000Z" })
    );
    assert.equal(orphan.projectId, null);
    assert.equal((await store.listUsageEvents("/w/never-registered")).length, 0);
  }
});

test("usage events: retention prunes by age, 0 disables (memory + pg-mem)", async () => {
  const { memory, pg } = await makeStores();
  for (const store of [memory, pg]) {
    await store.upsertProject({ rootPath: "/w/u2", name: "u2" });
    await store.recordUsageEvent(
      "/w/u2",
      usageInput({ tool: "old", at: "2000-01-01T00:00:00.000Z" })
    );
    await store.recordUsageEvent("/w/u2", usageInput({ tool: "new" }), { retentionDays: 30 });
    let events = await store.listUsageEvents("/w/u2");
    assert.deepEqual(events.map((event) => event.tool), ["new"]);

    await store.recordUsageEvent(
      "/w/u2",
      usageInput({ tool: "old2", at: "2000-01-02T00:00:00.000Z" }),
      { retentionDays: 0 }
    );
    events = await store.listUsageEvents("/w/u2");
    assert.equal(events.length, 2);
    assert.ok(events.some((event) => event.tool === "old2"));
  }
});

test("usage events: per-project cap keeps newest and isolates projects (memory + pg-mem)", async () => {
  const { memory, pg } = await makeStores();
  for (const store of [memory, pg]) {
    await store.upsertProject({ rootPath: "/w/u3a", name: "u3a" });
    await store.upsertProject({ rootPath: "/w/u3b", name: "u3b" });
    for (const [index, at] of [
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:01:00.000Z",
      "2026-02-01T00:02:00.000Z"
    ].entries()) {
      await store.recordUsageEvent(
        "/w/u3a",
        usageInput({ tool: `t${index}`, at }),
        { maxEvents: 2 }
      );
    }
    await store.recordUsageEvent("/w/u3b", usageInput({ tool: "keep" }), { maxEvents: 2 });

    const projectA = await store.listUsageEvents("/w/u3a");
    assert.deepEqual(projectA.map((event) => event.tool), ["t2", "t1"]);
    const projectB = await store.listUsageEvents("/w/u3b");
    assert.deepEqual(projectB.map((event) => event.tool), ["keep"]);
  }
});

test("usage events: errorSummary truncates to 300 chars (memory + pg-mem)", async () => {
  const { memory, pg } = await makeStores();
  for (const store of [memory, pg]) {
    await store.upsertProject({ rootPath: "/w/u4", name: "u4" });
    await store.recordUsageEvent(
      "/w/u4",
      usageInput({ ok: false, errorClass: "unknown", errorSummary: "x".repeat(400) })
    );
    const [event] = await store.listUsageEvents("/w/u4");
    assert.equal(event.errorSummary.length, 300);
  }
});

test("usage events: orphan bucket is pruned by policy (memory + pg-mem)", async () => {
  const { memory, pg, pool } = await makeStores();
  for (const store of [memory, pg]) {
    const count = async () =>
      store === memory
        ? memory.usageEventCount()
        : Number((await pool.query("SELECT COUNT(*) AS c FROM usage_events WHERE project_id IS NULL")).rows[0].c);
    await store.recordUsageEvent(
      "/w/ghost",
      usageInput({ tool: "g1", at: "2000-01-01T00:00:00.000Z" }),
      { maxEvents: 1 }
    );
    await store.recordUsageEvent(
      "/w/ghost",
      usageInput({ tool: "g2", at: "2000-01-02T00:00:00.000Z" }),
      { maxEvents: 1 }
    );
    assert.equal(await count(), 1);
    await store.recordUsageEvent(
      "/w/ghost",
      usageInput({ tool: "g3", at: "2000-01-03T00:00:00.000Z" }),
      { retentionDays: 30 }
    );
    assert.equal(await count(), 0);
  }
});

test("listProjects: recency order with stable tie-break (memory + pg-mem)", async () => {
  const { memory, pg } = await makeStores();
  for (const store of [memory, pg]) {
    await store.upsertProject({ rootPath: "/w/lp2", name: "lp2" });
    await store.upsertProject({ rootPath: "/w/lp1", name: "lp1" });
    await store.upsertProject({ rootPath: "/w/lp1", name: "lp1" });
    const projects = await store.listProjects();
    assert.deepEqual(
      projects.map((project) => project.rootPath),
      ["/w/lp1", "/w/lp2"]
    );
  }
});
