import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";

test("MemoryStore events: 幂等、mismatch、seq 与查询", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const input = {
    eventId: "e1",
    type: "case.result",
    caseId: "TC_1",
    status: "failed",
    payload: { b: 2, a: 1 }
  };
  const first = await store.recordProjectEvent("/w/p1", input);
  assert.equal(first.duplicate, false);
  assert.equal(first.record.seq, 1);
  assert.equal(first.record.source, "project");

  const dup = await store.recordProjectEvent("/w/p1", { ...input, payload: { a: 1, b: 2 } });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.payloadMismatch, false);
  assert.equal(dup.record.id, first.record.id);

  const mismatch = await store.recordProjectEvent("/w/p1", { ...input, payload: { a: 2 } });
  assert.equal(mismatch.duplicate, true);
  assert.equal(mismatch.payloadMismatch, true);
  assert.equal(mismatch.record.id, first.record.id);

  const second = await store.recordProjectEvent("/w/p1", {
    eventId: "e2",
    type: "log.entry",
    payload: { message: "x" }
  });
  assert.equal(second.record.seq, 2);

  const all = await store.listProjectEvents("/w/p1", { order: "asc", includePayload: true });
  assert.deepEqual(all.map((event) => event.eventId), ["e1", "e2"]);
  assert.equal(all[0].payload.a, 1);
  const noPayload = await store.listProjectEvents("/w/p1", { runId: "missing" });
  assert.deepEqual(noPayload, []);
  assert.equal(await store.countProjectEvents("/w/p1"), 2);

  const secondsSince = await store.listProjectEvents("/w/p1", {
    since: new Date(Date.parse(all[0].receivedAt) - 1000).toISOString().replace(".000Z", "Z"),
    order: "asc"
  });
  assert.equal(secondsSince.length, 2);
});

test("MemoryStore events: prune 超限删最旧且 seq 不回收", async () => {
  const previous = process.env.AOS_EVENTS_MAX;
  process.env.AOS_EVENTS_MAX = "1";
  try {
    const store = new MemoryStore();
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.recordProjectEvent("/w/p1", { eventId: "e1", type: "log.entry", payload: { m: 1 } });
    await store.recordProjectEvent("/w/p1", { eventId: "e2", type: "log.entry", payload: { m: 2 } });
    const deleted = await store.pruneProjectEvents("/w/p1");
    assert.equal(deleted, 1);
    const left = await store.listProjectEvents("/w/p1", { order: "asc" });
    assert.deepEqual(left.map((event) => event.eventId), ["e2"]);
    const third = await store.recordProjectEvent("/w/p1", {
      eventId: "e3",
      type: "log.entry",
      payload: { m: 3 }
    });
    assert.equal(third.record.seq, 3);
  } finally {
    if (previous === undefined) delete process.env.AOS_EVENTS_MAX;
    else process.env.AOS_EVENTS_MAX = previous;
  }
});
