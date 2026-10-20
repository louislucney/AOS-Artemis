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

function suiteRun(runId) {
  return {
    runId,
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: null,
    featureKey: null,
    featureName: null,
    platform: "android",
    device: null,
    appVersion: null,
    runner: null,
    status: "completed",
    startedAt: "2026-10-20T00:00:00.000Z",
    finishedAt: "2026-10-20T00:01:00.000Z",
    total: 1,
    passed: 1,
    failed: 0,
    flaky: 0,
    quarantined: 0,
    failureDomains: {},
    gateResult: "pass",
    exitCode: 0,
    manifestPath: null,
    comparison: null
  };
}

test("PostgresStore suite runs: run_id 持久化与按 runId 回写", async () => {
  const store = await makePgStore();
  try {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const recorded = await store.recordSuiteRun({
      rootPath: "/w/p1",
      run: suiteRun("run-pg-1"),
      cases: []
    });
    assert.equal(recorded.runId, "run-pg-1");
    assert.equal(await store.markSuiteRunFinishedByRunId("/w/p1", "run-pg-1", "failed"), true);
    const runs = await store.listSuiteRuns("/w/p1");
    assert.equal(runs[0].runId, "run-pg-1");
    assert.equal(runs[0].status, "failed");
    assert.equal(await store.markSuiteRunFinishedByRunId("/w/p1", "missing", "failed"), false);
  } finally {
    await store.close();
  }
});

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
    const sinceSeconds = new Date(
      Math.floor(Date.parse(first.record.receivedAt) / 1000) * 1000
    )
      .toISOString()
      .replace(".000Z", "Z");
    const sameSecond = await store.listProjectEvents("/w/p1", { since: sinceSeconds, order: "asc" });
    assert.equal(sameSecond.length, 2, "秒级 since 不丢同秒事件");

    const afterFirst = await store.listProjectEvents("/w/p1", {
      afterSeq: first.record.seq,
      order: "asc"
    });
    assert.deepEqual(afterFirst.map((event) => event.eventId), ["e2"]);
    await assert.rejects(
      () => store.listProjectEvents("/w/p1", { afterSeq: -1 }),
      /invalid afterSeq/
    );

    assert.equal(await store.markProjectEventsConsumed("/w/p1", ["e1"]), 1);
    assert.equal(await store.markProjectEventsConsumed("/w/p1", ["e1"]), 0);
    const unconsumed = await store.listProjectEvents("/w/p1", { consumed: false, order: "asc" });
    assert.deepEqual(unconsumed.map((event) => event.eventId), ["e2"]);
    const consumed = await store.listProjectEvents("/w/p1", { consumed: true, order: "asc" });
    assert.deepEqual(consumed.map((event) => event.eventId), ["e1"]);

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
