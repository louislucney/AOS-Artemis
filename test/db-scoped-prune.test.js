import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-scoped-prune-"));
}

function usageInput(overrides = {}) {
  return { tool: "aos_status", family: "native", ok: true, durationMs: 1, ...overrides };
}

test("MemoryStore: scoped view usage 裁剪原地共享数组", async () => {
  const store = new MemoryStore();
  const a = store.scopeHost("h-a");
  const b = store.scopeHost("h-b");
  await a.upsertProject({ rootPath: "/w/app", name: "app" });
  await b.upsertProject({ rootPath: "/w/app", name: "app" });

  for (let i = 0; i < 3; i += 1) {
    await a.recordUsageEvent(
      "/w/app",
      usageInput({ tool: `t${i}`, at: `2026-10-18T00:00:0${i}.000Z` }),
      { maxEvents: 2 }
    );
  }

  assert.equal(store.usageEventCount(), 2);
  assert.equal(a.usageEventCount(), 2);
  assert.equal(b.usageEventCount(), 2);
  assert.deepEqual(
    (await a.listUsageEvents("/w/app")).map((event) => event.tool),
    ["t2", "t1"]
  );
});

test("MemoryStore: scoped view upsertHostAddresses 原地裁剪共享数组", async () => {
  const store = new MemoryStore();
  const a = store.scopeHost("h-a");
  await a.upsertHostAddresses({
    hostId: "h-a",
    addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.1" }],
    at: "2026-01-01T00:00:00.000Z",
    maxPerSource: 1
  });
  await a.upsertHostAddresses({
    hostId: "h-a",
    addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.2" }],
    at: "2026-01-02T00:00:00.000Z",
    maxPerSource: 1
  });

  const base = await store.listHostAddresses("h-a");
  assert.equal(base.length, 1);
  assert.equal(base[0].address, "10.0.0.2");
});

test("MemoryStore: scoped view pruneProjectEvents 原地裁剪共享数组", async () => {
  const previous = process.env.AOS_EVENTS_MAX;
  process.env.AOS_EVENTS_MAX = "1";
  try {
    const store = new MemoryStore();
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    await a.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await a.recordProjectEvent("/w/p1", { eventId: "e1", type: "log.entry", payload: { m: 1 } });
    await a.recordProjectEvent("/w/p1", { eventId: "e2", type: "log.entry", payload: { m: 2 } });

    const deleted = await a.pruneProjectEvents("/w/p1");
    assert.equal(deleted, 1);
    assert.equal(await store.countProjectEvents("/w/p1"), 1);
    assert.equal(await a.countProjectEvents("/w/p1"), 1);
    assert.equal(await b.countProjectEvents("/w/p1"), 0);
    assert.deepEqual(
      (await store.listProjectEvents("/w/p1", { order: "asc" })).map((event) => event.eventId),
      ["e2"]
    );
  } finally {
    if (previous === undefined) delete process.env.AOS_EVENTS_MAX;
    else process.env.AOS_EVENTS_MAX = previous;
  }
});

test("FileStore: scoped host usage 超限触发落盘裁剪", async () => {
  const home = await tempHome();
  try {
    const root = join(home, "proj");
    await mkdir(root, { recursive: true });
    const store = await FileStore.create({ homeDir: home });
    const a = store.scopeHost("h-a");
    await a.upsertProject({ rootPath: root, name: "p" });
    for (let i = 0; i < 3; i += 1) {
      await a.recordUsageEvent(
        root,
        usageInput({ tool: `t${i}`, at: `2026-10-18T00:00:0${i}.000Z` }),
        { maxEvents: 2 }
      );
    }

    assert.equal((await store.listUsageEvents(root)).length, 2);
    assert.equal((await a.listUsageEvents(root)).length, 2);

    const reloaded = await FileStore.create({ homeDir: home });
    assert.deepEqual(
      (await reloaded.scopeHost("h-a").listUsageEvents(root)).map((event) => event.tool),
      ["t2", "t1"]
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
