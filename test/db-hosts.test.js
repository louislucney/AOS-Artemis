import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  hostAddressHistoryFrom,
  hostSessionRetentionDaysFrom
} from "../dist/host/online.js";

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  return [new MemoryStore(), pg];
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-host-ledger-"));
}

test("upsertHost: client/runner 两个在线信号独立，lastSeenAt 取最大", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({
      id: "h1", hardwareId: "hw1", hostname: "mac-a", username: "louis",
      osPlatform: "darwin", osVersion: "14.6.1", arch: "arm64",
      identitySource: "file", kind: "mac", capabilities: ["android"],
      env: {}, envAt: null, ipPrimary: "10.0.0.5",
      firstSeenAt: "2026-10-21T09:00:00.000Z"
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
    assert.equal(resumed.queuePausedBy, null);
  }
});

test("FileStore: host/address/session 重启保留（persist 落盘 + 重载还原）", async () => {
  const home = await tempHome();
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    let store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "proj" });
    await store.upsertHost({ id: "h1", hostname: "mac-a", firstSeenAt: "2026-10-21T09:00:00.000Z" });
    await store.upsertHostAddresses({
      hostId: "h1",
      addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" }],
      at: "2026-10-21T10:00:00.000Z"
    });
    await store.touchHostSession({
      id: "s1", hostId: "h1", projectId: null, rootPath: root,
      username: "louis", client: "cursor", clientVersion: "1.0", pid: 42,
      at: "2026-10-21T10:00:00.000Z"
    });
    await store.close();

    store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "proj" });
    assert.equal((await store.listHosts()).length, 1);
    assert.equal((await store.listHostAddresses("h1")).length, 1);
    assert.equal(
      (await store.listHostSessions("h1", {
        onlineWithinMs: 120_000,
        now: Date.parse("2026-10-21T10:01:00.000Z")
      })).length,
      1
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("FileStore: host 合并遵守磁盘胜（陈旧写者不回滚已落盘更新）", async () => {
  const home = await tempHome();
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    const a = await FileStore.create({ homeDir: home });
    await a.upsertProject({ rootPath: root, name: "proj" });
    await a.upsertHost({ id: "h1", hostname: "mac-a", firstSeenAt: "2026-10-21T09:00:00.000Z" });

    const b = await FileStore.create({ homeDir: home });
    await b.upsertProject({ rootPath: root, name: "proj" });
    assert.equal((await b.listHosts())[0].hostname, "mac-a");

    await b.upsertHost({ id: "h1", hostname: "mac-b" });

    await a.upsertHost({ id: "h1", osVersion: "stale" });
    await a.listHosts();

    const c = await FileStore.create({ homeDir: home });
    await c.upsertProject({ rootPath: root, name: "proj" });
    const host = (await c.listHosts())[0];
    assert.equal(host.hostname, "mac-b", "磁盘上的 mac-b 不被陈旧写者 a 回滚");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const RETENTION_NOW = Date.parse("2026-10-21T10:00:00.000Z");

async function seedRetentionSessions(store) {
  await store.upsertHost({ id: "h1", hostname: "mac-a" });
  await store.touchHostSession({
    id: "s-old",
    hostId: "h1",
    projectId: null,
    rootPath: "/w/app",
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 1,
    at: "2026-09-01T10:00:00.000Z"
  });
  await store.endHostSession("s-old", "2026-09-01T10:01:00.000Z");
  await store.touchHostSession({
    id: "s-ended-recent",
    hostId: "h1",
    projectId: null,
    rootPath: "/w/app",
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 2,
    at: "2026-10-20T10:00:00.000Z"
  });
  await store.endHostSession("s-ended-recent", "2026-10-20T10:01:00.000Z");
  await store.touchHostSession({
    id: "s-ended-today",
    hostId: "h1",
    projectId: null,
    rootPath: "/w/app",
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 4,
    at: "2026-09-01T10:00:00.000Z"
  });
  await store.endHostSession("s-ended-today", "2026-10-21T09:59:00.000Z");
  await store.touchHostSession({
    id: "s-current",
    hostId: "h1",
    projectId: null,
    rootPath: "/w/app",
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 3,
    at: "2026-10-21T09:59:00.000Z"
  });
}

test("pruneHostSessions: 只清理过期已结束会话；0 关闭；max(last_seen,ended) 与进行中保留", async () => {
  for (const store of await makeStores()) {
    await seedRetentionSessions(store);
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 0 }),
      0,
      "0 = 关闭清理"
    );
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 7 }),
      1,
      "仅过期已结束会话被删除（今天结束的旧 last_seen 会话保留）"
    );
    const sessions = await store.listHostSessions("h1");
    assert.deepEqual(sessions.map((session) => session.id), ["s-current"]);
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 7 }),
      0,
      "幂等：已清理后不再删除"
    );
  }
});

test("FileStore pruneHostSessions: 落盘清理且重启后不回潮", async () => {
  const home = await tempHome();
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    let store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "proj" });
    await seedRetentionSessions(store);
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 7 }),
      1
    );
    await store.close();

    store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "proj" });
    assert.deepEqual(
      (await store.listHostSessions("h1")).map((session) => session.id),
      ["s-current"]
    );
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 7 }),
      0
    );
    await store.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function seedOldSession(store, hostId, id) {
  await store.upsertHost({ id: hostId, hostname: hostId });
  await store.touchHostSession({
    id,
    hostId,
    projectId: null,
    rootPath: "/w/app",
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 1,
    at: "2026-09-01T10:00:00.000Z"
  });
  await store.endHostSession(id, "2026-09-01T10:01:00.000Z");
}

test("pruneHostSessions: scoped store 只删本主机会话；未绑定仍全局", async () => {
  for (const store of await makeStores()) {
    await seedOldSession(store, "h-a", "s-a-old");
    await seedOldSession(store, "h-b", "s-b-old");
    assert.equal(
      await store.scopeHost("h-a").pruneHostSessions({
        now: RETENTION_NOW,
        retentionDays: 7
      }),
      1,
      "h-a 作用域只删自己的 1 条"
    );
    assert.equal(
      await store.scopeHost("h-b").pruneHostSessions({
        now: RETENTION_NOW,
        retentionDays: 7
      }),
      1,
      "h-b 会话仍在，直到自己的作用域清理"
    );
    assert.equal(
      await store.pruneHostSessions({ now: RETENTION_NOW, retentionDays: 7 }),
      0,
      "全中心作用域此时无剩余可删"
    );
  }
});

test("FileStore pruneHostSessions: scoped store 只删本主机会话", async () => {
  const home = await tempHome();
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    const store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "proj" });
    await seedOldSession(store, "h-a", "s-a-old");
    await seedOldSession(store, "h-b", "s-b-old");
    assert.equal(
      await store.scopeHost("h-a").pruneHostSessions({
        now: RETENTION_NOW,
        retentionDays: 7
      }),
      1
    );
    assert.equal(
      await store.scopeHost("h-b").pruneHostSessions({
        now: RETENTION_NOW,
        retentionDays: 7
      }),
      1
    );
    await store.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("hostSessionRetentionDaysFrom: 默认 7、非法/小数/溢出回退 7、0 关闭", () => {
  assert.equal(hostSessionRetentionDaysFrom({}), 7);
  assert.equal(hostSessionRetentionDaysFrom({ AOS_CLIENT_SESSION_RETENTION_DAYS: "3" }), 3);
  assert.equal(hostSessionRetentionDaysFrom({ AOS_CLIENT_SESSION_RETENTION_DAYS: "0" }), 0);
  for (const invalid of ["-1", "abc", "NaN", "0.5", "1.9", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.equal(
      hostSessionRetentionDaysFrom({ AOS_CLIENT_SESSION_RETENTION_DAYS: invalid }),
      7,
      invalid
    );
  }
});

test("hostAddressHistoryFrom: 仅字面 0/false 关闭", () => {
  assert.equal(hostAddressHistoryFrom({}), true);
  assert.equal(hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: "1" }), true);
  assert.equal(hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: "0" }), false);
  assert.equal(hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: "false" }), false);
  assert.equal(hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: " FALSE " }), false);
  assert.equal(hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: "no" }), true);
});

test("host_addresses: 默认保留历史；AOS_HOST_ADDR_HISTORY=0 只保留每来源最新", async () => {
  for (const store of await makeStores()) {
    await store.upsertHost({ id: "h-default", hostname: "mac-a" });
    await store.upsertHostAddresses({
      hostId: "h-default",
      addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.1" }],
      at: "2026-10-20T10:00:00.000Z",
      maxPerSource: hostAddressHistoryFrom({}) ? undefined : 1
    });
    await store.upsertHostAddresses({
      hostId: "h-default",
      addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.2" }],
      at: "2026-10-21T10:00:00.000Z",
      maxPerSource: hostAddressHistoryFrom({}) ? undefined : 1
    });
    assert.equal((await store.listHostAddresses("h-default")).length, 2);

    const off = hostAddressHistoryFrom({ AOS_HOST_ADDR_HISTORY: "0" });
    await store.upsertHost({ id: "h-off", hostname: "mac-b" });
    await store.upsertHostAddresses({
      hostId: "h-off",
      addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.1" }],
      at: "2026-10-20T10:00:00.000Z",
      maxPerSource: off ? undefined : 1
    });
    await store.upsertHostAddresses({
      hostId: "h-off",
      addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.2" }],
      at: "2026-10-21T10:00:00.000Z",
      maxPerSource: off ? undefined : 1
    });
    const rows = await store.listHostAddresses("h-off");
    assert.deepEqual(rows.map((row) => row.address), ["10.0.0.2"]);

    await store.upsertHost({ id: "h-tie", hostname: "mac-c" });
    await store.upsertHostAddresses({
      hostId: "h-tie",
      addresses: [
        { source: "self", iface: "en1", family: "ipv4", address: "10.0.0.9" },
        { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.2" }
      ],
      at: "2026-10-21T10:00:00.000Z",
      maxPerSource: 1
    });
    assert.deepEqual(
      (await store.listHostAddresses("h-tie")).map((row) => row.address),
      ["10.0.0.2"],
      "同一时间戳的多网卡按 address 升序确定（PG/Memory/File 一致）"
    );
  }
});

function hostRow(overrides = {}) {
  return {
    id: "h1",
    hardware_id: null,
    hostname: "mac-a",
    username: null,
    os_platform: "darwin",
    os_version: null,
    arch: null,
    identity_source: "file",
    kind: "mac",
    capabilities: "[]",
    env: "{}",
    env_at: null,
    ip_primary: null,
    label: null,
    owner: null,
    expected_os: null,
    expected_hostname: null,
    registered_at: null,
    registered_by: null,
    client_seen_at: null,
    runner_seen_at: null,
    last_seen_at: "2026-10-21T10:00:00.000Z",
    queue_paused: false,
    queue_paused_at: null,
    queue_paused_by: null,
    first_seen_at: "2026-10-21T09:00:00.000Z",
    created_at: "2026-10-21T09:00:00.000Z",
    ...overrides
  };
}

test("PostgresStore.upsertHost: 并发首写 INSERT 撞 23505 → 合并更新而不是抛错", async () => {
  let selects = 0;
  let updates = 0;
  const pool = {
    async query(text) {
      if (text.startsWith("SELECT * FROM hosts WHERE id = $1")) {
        selects += 1;
        if (selects === 1) return { rows: [], rowCount: 0 };
        return { rows: [hostRow({ hostname: updates > 0 ? "mac-b" : "mac-a" })], rowCount: 1 };
      }
      if (text.includes("INSERT INTO hosts")) {
        const error = new Error('duplicate key value violates unique constraint "hosts_pkey"');
        error.code = "23505";
        throw error;
      }
      if (text.startsWith("UPDATE hosts SET")) {
        updates += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("inet_client_addr")) return { rows: [{ addr: null }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
  };
  const store = new PostgresStore(pool);
  const host = await store.upsertHost({ id: "h1", hostname: "mac-b" });
  assert.equal(host.hostname, "mac-b");
  assert.equal(selects, 3, "首查 → 冲突后重查 → 更新后回读");
  assert.equal(updates, 1, "走更新分支而非第二次插入");
});
