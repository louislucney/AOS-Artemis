import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

test("MemoryStore: audit events round-trip, filters, newest-first, summary cap", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/a", name: "a" });

  const first = await store.recordAudit("/w/a", {
    domain: "suite",
    action: "run.recorded",
    result: "ok",
    summary: "批次登记",
    refs: { runId: "r1" },
    at: "2026-10-18T01:00:00.000Z"
  });
  assert.ok(first.id);
  assert.equal(first.rootPath, "/w/a");
  assert.equal(first.at, "2026-10-18T01:00:00.000Z");

  const second = await store.recordAudit("/w/a", {
    domain: "import",
    action: "excel.imported",
    result: "failed",
    summary: "导入失败",
    refs: { file: "x.xlsx" },
    at: "2026-10-18T01:00:01.000Z"
  });

  const all = await store.listAudit("/w/a");
  assert.equal(all.length, 2);
  assert.equal(all[0].id, second.id);
  assert.equal(all[1].id, first.id);
  assert.deepEqual(all[1].refs, { runId: "r1" });

  assert.deepEqual(
    (await store.listAudit("/w/a", { domain: "suite" })).map((event) => event.id),
    [first.id]
  );
  assert.deepEqual(
    (await store.listAudit("/w/a", { result: "failed" })).map((event) => event.id),
    [second.id]
  );
  const limited = await store.listAudit("/w/a", { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].id, second.id);
  assert.deepEqual(await store.listAudit("/w/a", { since: "2030-01-01T00:00:00.000Z" }), []);
  assert.deepEqual(await store.listAudit("/w/b"), []);

  const capped = await store.recordAudit("/w/a", {
    domain: "storage",
    action: "warn",
    result: "skipped",
    summary: "x".repeat(400)
  });
  assert.equal(capped.summary.length, 300);

  const page = await store.listAudit("/w/a", { limit: 1, offset: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, second.id, "offset 分页（新→旧：第三条为 capped，第二位是 second）");
  assert.deepEqual(await store.listAudit("/w/a", { offset: 99 }), []);
});

test("MemoryStore: exportState/importState round-trip", async () => {
  const source = new MemoryStore();
  await source.upsertProject({ rootPath: "/w/e", name: "e" });
  await source.upsertLlm("/w/e", { name: "llm", model: "m", baseUrl: "https://x/v1", apiKey: "k", makeActive: true });
  await source.recordAudit("/w/e", {
    domain: "panel",
    action: "action.tasks",
    result: "ok",
    summary: "s",
    refs: { taskId: "t1" }
  });
  await source.recordUsageEvent("/w/e", { tool: "design_to_test", family: "workflow", ok: true, durationMs: 5 });

  const target = new MemoryStore();
  target.importState(source.exportState());

  const project = await target.getProjectByPath("/w/e");
  assert.equal(project?.name, "e");
  const llms = await target.listLlms("/w/e");
  assert.equal(llms.length, 1);
  assert.equal(llms[0].isActive, true);
  assert.equal((await target.listAudit("/w/e")).length, 1);
  assert.equal((await target.listUsageEvents("/w/e")).length, 1);
});

test("PostgresStore: audit events round-trip (pg-mem)", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();

  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  await store.recordAudit("/w/p", {
    domain: "suite",
    action: "run.recorded",
    result: "ok",
    summary: "s1",
    refs: { runId: "r1" },
    at: "2026-10-18T02:00:00.000Z"
  });
  const second = await store.recordAudit("/w/p", {
    domain: "panel",
    action: "action.tasks",
    result: "ok",
    summary: "s2",
    at: "2026-10-18T02:00:01.000Z"
  });

  const all = await store.listAudit("/w/p");
  assert.equal(all.length, 2);
  assert.equal(all[0].id, second.id);
  assert.equal(all[1].action, "run.recorded");
  assert.deepEqual(all[1].refs, { runId: "r1" });
  assert.deepEqual(
    (await store.listAudit("/w/p", { domain: "panel" })).map((event) => event.id),
    [second.id]
  );
  assert.deepEqual(await store.listAudit("/w/other"), []);
});
