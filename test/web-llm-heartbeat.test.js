import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  getLlmWorkerStatus,
  recordLlmWorkerHeartbeat
} from "../dist/web/llm/heartbeat.js";

test("llm worker heartbeat: 写入后在线，超过 TTL 离线", async () => {
  const store = new MemoryStore();
  const now = Date.parse("2026-11-04T10:00:00.000Z");
  await recordLlmWorkerHeartbeat({
    store,
    hostId: "center",
    instanceId: "worker-1",
    nowMs: now
  });
  const online = await getLlmWorkerStatus({ store, nowMs: now + 10_000, ttlMs: 90_000 });
  assert.equal(online.online, true);
  assert.equal(online.instanceId, "worker-1");

  const stale = await getLlmWorkerStatus({ store, nowMs: now + 120_000, ttlMs: 90_000 });
  assert.equal(stale.online, false);
  assert.equal(stale.lastSeenAt, "2026-11-04T10:00:00.000Z");
});
