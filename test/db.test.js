import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

test("MemoryStore: project, llm entries, active pointer, task stats", async () => {
  const store = new MemoryStore();
  const project = await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  assert.ok(project.id);

  await store.upsertLlm("/w/p1", {
    name: "a",
    model: "m1",
    baseUrl: "https://x/v1",
    apiKey: "k1",
    makeActive: true
  });
  await store.upsertLlm("/w/p1", {
    name: "b",
    model: "m2",
    baseUrl: "https://x/v1",
    apiKey: "k2"
  });

  let list = await store.listLlms("/w/p1");
  assert.equal(list.length, 2);
  assert.equal(list.find((entry) => entry.name === "a").isActive, true);
  assert.equal(list.find((entry) => entry.name === "b").isActive, false);

  await store.setActiveLlm("/w/p1", "b");
  list = await store.listLlms("/w/p1");
  assert.equal(list.find((entry) => entry.name === "b").isActive, true);
  assert.equal(list.find((entry) => entry.name === "a").isActive, false);

  const updated = await store.upsertLlm("/w/p1", { name: "b", model: "m3", apiKey: "k3" });
  assert.equal(updated.model, "m3");
  list = await store.listLlms("/w/p1");
  assert.equal(list.length, 2);

  await store.setFigmaToken("/w/p1", "figd_x");
  const refreshed = await store.getProjectByPath("/w/p1");
  assert.equal(refreshed.figmaToken, "figd_x");

  await store.recordTask({ rootPath: "/w/p1", traceId: "t1", status: "submitted" });
  await store.recordTask({ rootPath: "/w/p1", traceId: "t2", status: "submitted" });
  assert.equal(store.taskCount(), 2);

  const pending = await store.listPendingTasks("/w/p1");
  assert.equal(pending.length, 2);

  assert.equal((await store.markTaskFinished("/w/p1", "t1", "completed")).valueOf(), true);
  const recent = await store.listTasks("/w/p1", 5);
  assert.equal(recent.find((task) => task.traceId === "t1").status, "completed");
  assert.ok(recent.find((task) => task.traceId === "t1").finishedAt);
  assert.equal((await store.listPendingTasks("/w/p1")).length, 1);
});

test("PostgresStore: schema, upsert idempotency, exclusive active, task stats (pg-mem)", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();

  const project = await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
  assert.ok(project.id);
  assert.equal((await store.ping()).valueOf(), true);

  await store.upsertLlm("/w/p2", {
    name: "a",
    model: "m1",
    baseUrl: "https://x/v1",
    apiKey: "k1",
    makeActive: true
  });
  await store.upsertLlm("/w/p2", {
    name: "b",
    model: "m2",
    baseUrl: "https://x/v1",
    apiKey: "k2"
  });

  let list = await store.listLlms("/w/p2");
  assert.equal(list.length, 2);
  assert.equal(list.filter((entry) => entry.isActive).length, 1);
  assert.equal(list.find((entry) => entry.name === "a").isActive, true);

  await store.setActiveLlm("/w/p2", "b");
  list = await store.listLlms("/w/p2");
  assert.equal(list.filter((entry) => entry.isActive).length, 1);
  assert.equal(list.find((entry) => entry.name === "b").isActive, true);

  await store.upsertLlm("/w/p2", {
    name: "b",
    model: "m3",
    baseUrl: "https://y/v1",
    apiKey: "k3"
  });
  list = await store.listLlms("/w/p2");
  assert.equal(list.length, 2);
  assert.equal(list.find((entry) => entry.name === "b").model, "m3");

  await store.setFigmaToken("/w/p2", "figd_y");
  const refreshed = await store.getProjectByPath("/w/p2");
  assert.equal(refreshed.figmaToken, "figd_y");

  await store.recordTask({
    rootPath: "/w/p2",
    traceId: "t1",
    model: "m3",
    profile: "Flash",
    status: "submitted",
    taskDesc: "hello"
  });
  await store.recordTask({ rootPath: "/w/p2", traceId: "t2", status: "submitted" });
  const count = await pool.query("SELECT COUNT(*) AS c FROM task_stats");
  assert.equal(Number(count.rows[0].c), 2);

  const pending = await store.listPendingTasks("/w/p2");
  assert.equal(pending.length, 2);
  assert.equal((await store.markTaskFinished("/w/p2", "t1", "completed")).valueOf(), true);
  const tasks = await store.listTasks("/w/p2", 10);
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((task) => task.traceId === "t1").status, "completed");
  assert.equal((await store.listPendingTasks("/w/p2")).length, 1);
});
