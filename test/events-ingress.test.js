import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  EventValidationError,
  listProjectEvents,
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
