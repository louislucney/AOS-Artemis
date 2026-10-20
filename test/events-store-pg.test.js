import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("PostgresStore events: 幂等、mismatch、查询与裁剪", async () => {
  const previousMax = process.env.AOS_EVENTS_MAX;
  const store = await makePgStore();
  try {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const first = await store.recordProjectEvent("/w/p1", {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "failed",
      payload: { a: 1, b: 2 }
    });
    assert.equal(first.record.seq, 1);
    assert.equal(first.duplicate, false);

    const dup = await store.recordProjectEvent("/w/p1", {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "failed",
      payload: { b: 2, a: 1 }
    });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.payloadMismatch, false);
    assert.equal(dup.record.id, first.record.id);

    const mismatch = await store.recordProjectEvent("/w/p1", {
      eventId: "e1",
      type: "case.result",
      caseId: "TC_1",
      status: "failed",
      payload: { a: 2 }
    });
    assert.equal(mismatch.duplicate, true);
    assert.equal(mismatch.payloadMismatch, true);

    const all = await store.listProjectEvents("/w/p1", { order: "asc", includePayload: true });
    assert.equal(all.length, 1);
    assert.equal(all[0].payload.a, 1);

    const second = await store.recordProjectEvent("/w/p1", {
      eventId: "e2",
      type: "log.entry",
      payload: { message: "second" }
    });
    assert.equal(second.record.seq, 2);
    const noPayload = await store.listProjectEvents("/w/p1", { order: "asc" });
    assert.equal(noPayload[0].payload, undefined);

    process.env.AOS_EVENTS_MAX = "1";
    const deleted = await store.pruneProjectEvents("/w/p1");
    assert.equal(deleted, 1);
    const left = await store.listProjectEvents("/w/p1", { order: "asc" });
    assert.deepEqual(left.map((event) => event.eventId), ["e2"]);
    const third = await store.recordProjectEvent("/w/p1", {
      eventId: "e3",
      type: "log.entry",
      payload: { message: "third" }
    });
    assert.equal(third.record.seq, 3);
    assert.equal(await store.countProjectEvents("/w/p1"), 2);
  } finally {
    if (previousMax === undefined) delete process.env.AOS_EVENTS_MAX;
    else process.env.AOS_EVENTS_MAX = previousMax;
    await store.close();
  }
});
