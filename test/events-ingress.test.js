import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  EventValidationError,
  listProjectEvents,
  pollProjectEvents,
  reportProjectEvent
} from "../dist/events/ingress.js";

test("ingress: ack 带 storage/degraded，重复取既有身份", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: "memory fallback" };
  const ack = await reportProjectEvent(ctx, {
    eventId: "e1",
    type: "case.result",
    caseId: "TC_1",
    status: "passed",
    payload: { secret: "x" }
  });
  assert.equal(ack.accepted, true);
  assert.equal(ack.storage, "memory");
  assert.equal(ack.degraded, "memory fallback");
  assert.equal(ack.eventId, "e1");

  const dup = await reportProjectEvent(ctx, {
    eventId: "e1",
    type: "case.result",
    caseId: "TC_1",
    status: "passed",
    payload: { secret: "x" }
  });
  assert.equal(dup.accepted, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.serverId, ack.serverId);
  assert.equal(dup.receivedAt, ack.receivedAt);

  const listed = await listProjectEvents(ctx, { includePayload: false });
  assert.equal(listed.returned, 1);
  assert.equal(listed.nextSeq, listed.events[0].seq);
  assert.equal(listed.events[0].payload, undefined);
  await assert.rejects(
    () => reportProjectEvent(ctx, { eventId: "e2", type: "nope" }),
    EventValidationError
  );
  await assert.rejects(
    () => listProjectEvents(ctx, { since: "bad" }),
    EventValidationError
  );
});

test("ingress: 审计异步写入且不包含 payload", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: null };
  await reportProjectEvent(ctx, {
    eventId: "e-audit",
    type: "log.entry",
    payload: { secret: "do-not-log" }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const audit = await store.listAudit("/w/p1", { domain: "project-event" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "log.entry");
  assert.equal(audit[0].result, "ok");
  assert.equal(audit[0].refs.eventId, "e-audit");
  assert.equal(JSON.stringify(audit[0]).includes("do-not-log"), false);
});

test("ingress: payload.traceId 事件驱动 task_stats 终态", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await store.recordTask({ rootPath: "/w/p1", traceId: "trace-1", status: "running" });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: null };
  await reportProjectEvent(ctx, {
    eventId: "e-task-1",
    type: "case.result",
    caseId: "TC_1",
    status: "failed",
    payload: { traceId: "trace-1", failureDomain: "应用缺陷" }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const tasks = await store.listTasks("/w/p1");
  assert.equal(tasks[0].status, "failed");
  assert.notEqual(tasks[0].finishedAt, null);
});

test("ingress: run.finished 按 manifest runId 回写 suite_runs", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await store.recordSuiteRun({
    rootPath: "/w/p1",
    run: {
      runId: "run-20261020-abc",
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
    },
    cases: []
  });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: null };
  await reportProjectEvent(ctx, {
    eventId: "e-run-finished",
    type: "run.finished",
    runId: "run-20261020-abc",
    status: "failed",
    payload: {}
  });
  await new Promise((resolve) => setImmediate(resolve));
  const runs = await store.listSuiteRuns("/w/p1");
  assert.equal(runs[0].runId, "run-20261020-abc");
  assert.equal(runs[0].status, "failed");
});

test("ingress: pollProjectEvents 按 afterSeq 无丢失推进", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const ctx = { store, rootPath: "/w/p1", storage: "memory", degraded: null };
  await reportProjectEvent(ctx, { eventId: "e1", type: "log.entry", payload: { n: 1 } });
  await reportProjectEvent(ctx, { eventId: "e2", type: "log.entry", payload: { n: 2 } });

  const first = await pollProjectEvents(ctx, { afterSeq: 0, waitMs: 0 });
  assert.deepEqual(first.events.map((event) => event.eventId), ["e1", "e2"]);
  assert.equal(first.nextSeq, 2);

  const consumed = await pollProjectEvents(ctx, { afterSeq: 0, waitMs: 0, consume: true });
  assert.equal(consumed.returned, 2);
  assert.equal(consumed.events.every((event) => event.consumedAt !== null), true);
  const unconsumed = await pollProjectEvents(ctx, { afterSeq: 0, waitMs: 0, consumed: false });
  assert.equal(unconsumed.returned, 0);

  const empty = await pollProjectEvents(ctx, { afterSeq: first.nextSeq, waitMs: 0 });
  assert.equal(empty.returned, 0);
  assert.equal(empty.nextSeq, 2);

  const pending = pollProjectEvents(ctx, { afterSeq: 2, waitMs: 1_000 });
  setTimeout(() => {
    void reportProjectEvent(ctx, { eventId: "e3", type: "log.entry", payload: { n: 3 } });
  }, 50);
  const next = await pending;
  assert.deepEqual(next.events.map((event) => event.eventId), ["e3"]);
  assert.equal(next.nextSeq, 3);

  await assert.rejects(() => pollProjectEvents(ctx, { afterSeq: -1 }), EventValidationError);
});
