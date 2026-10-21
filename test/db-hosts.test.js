import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  return [new MemoryStore(), pg];
}

test("upsertHost: client/runner 两个在线信号独立，lastSeenAt 取最大", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({
      id: "h1", hardwareId: "hw1", hostname: "mac-a", username: "louis",
      osPlatform: "darwin", osVersion: "14.6.1", arch: "arm64",
      identitySource: "file", kind: "mac", capabilities: ["android"],
      env: {}, envAt: null, ipPrimary: "10.0.0.5"
    });
    await store.upsertHost({ id: "h1", hostname: "mac-a", clientSeenAt: "2026-10-21T10:00:00.000Z" });
    const host = await store.upsertHost({ id: "h1", hostname: "mac-a", runnerSeenAt: "2026-10-21T10:01:00.000Z" });
    assert.equal(host.clientSeenAt, "2026-10-21T10:00:00.000Z");
    assert.equal(host.runnerSeenAt, "2026-10-21T10:01:00.000Z");
    assert.equal(host.lastSeenAt, "2026-10-21T10:01:00.000Z");
  }
});

test("host_addresses: 同键 upsert 更新 lastSeenAt，不同来源保留", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    await store.upsertHostAddresses({ hostId: "h1", addresses: [
      { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" },
      { source: "observed-pg", iface: "", family: "ipv4", address: "10.0.0.9" }
    ], at: "2026-10-21T10:00:00.000Z" });
    await store.upsertHostAddresses({ hostId: "h1", addresses: [
      { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" }
    ], at: "2026-10-21T10:05:00.000Z" });
    const rows = await store.listHostAddresses("h1");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.source === "self").lastSeenAt, "2026-10-21T10:05:00.000Z");
  }
});

test("host_sessions: 在线窗口 + endedAt", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    await store.touchHostSession({
      id: "s1", hostId: "h1", projectId: null, rootPath: "/w/app",
      username: "louis", client: "cursor", clientVersion: "1.0", pid: 42,
      at: "2026-10-21T10:00:00.000Z"
    });
    const online = await store.listHostSessions("h1", {
      onlineWithinMs: 120_000,
      now: Date.parse("2026-10-21T10:01:00.000Z")
    });
    assert.equal(online.length, 1);
    await store.endHostSession("s1", "2026-10-21T10:02:00.000Z");
    assert.equal((await store.listHostSessions("h1", { onlineWithinMs: 120_000, now: Date.parse("2026-10-21T10:03:00.000Z") })).length, 0);
  }
});

test("setHostQueuePaused 写入/恢复", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h1", hostname: "mac-a" });
    const paused = await store.setHostQueuePaused({ hostId: "h1", paused: true, by: "panel" });
    assert.equal(paused.queuePaused, true);
    assert.equal(paused.queuePausedBy, "panel");
    const resumed = await store.setHostQueuePaused({ hostId: "h1", paused: false, by: "panel" });
    assert.equal(resumed.queuePaused, false);
  }
});
