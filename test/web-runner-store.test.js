import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  RUNNER_ACTIVE_DEFAULT_MS,
  STOPPED_RUNNER_SEEN_AT,
  WebRunnerAlreadyActiveError
} from "../dist/db/types.js";
import { isRunnerOnline, RUNNER_TTL_DEFAULT_MS } from "../dist/runner/status.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  return store;
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-web-runner-"));
}

const DEVICES = [
  {
    serial: "emulator-5554",
    name: "",
    model: null,
    osVersion: null,
    platform: "android",
    kind: "emulator",
    state: "device"
  },
  {
    serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
    name: "iPhone Louis",
    model: null,
    osVersion: null,
    platform: "ios",
    kind: "device",
    state: "Booted"
  }
];

const TOOLS = {
  adb: true,
  idb: true,
  simctl: true,
  ideviceId: true,
  appium: false,
  maestro: false,
  devicectl: false
};

function webRunnerInput(overrides = {}) {
  return {
    hostId: "host-a",
    name: "web-runner-a",
    hostname: "web-a.local",
    platforms: ["android", "ios"],
    devices: DEVICES,
    tools: TOOLS,
    artifactBaseUrl: "http://web-a.local:8770",
    version: "0.1.0",
    instanceId: "inst-1",
    ...overrides
  };
}

function activeRunStores() {
  return [new MemoryStore(), makePgStore()];
}

test("upsertWebRunner: 新 host 落一行，字段完整往返（memory + pg-mem）", async () => {
  for (const store of await Promise.all(activeRunStores())) {
    const record = await store.upsertWebRunner(webRunnerInput());
    assert.ok(record.id);
    assert.equal(record.hostId, "host-a");
    assert.equal(record.name, "web-runner-a");
    assert.equal(record.hostname, "web-a.local");
    assert.deepEqual(record.platforms, ["android", "ios"]);
    assert.deepEqual(record.devices, DEVICES);
    assert.deepEqual(record.tools, TOOLS);
    assert.equal(record.artifactBaseUrl, "http://web-a.local:8770");
    assert.equal(record.version, "0.1.0");
    assert.equal(record.instanceId, "inst-1");
    assert.equal(record.createdAt, record.lastSeenAt);

    const listed = await store.listWebRunners();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, record.id);
  }
});

test("upsertWebRunner: 同 host 心跳更新 devices/tools/lastSeenAt，不新增行（memory + pg-mem）", async () => {
  for (const store of await Promise.all(activeRunStores())) {
    const first = await store.upsertWebRunner(
      webRunnerInput({ lastSeenAt: "2026-10-28T10:00:00.000Z" })
    );
    const second = await store.upsertWebRunner(
      webRunnerInput({
        devices: [DEVICES[0]],
        tools: { ...TOOLS, maestro: true },
        artifactBaseUrl: null,
        version: null,
        lastSeenAt: "2026-10-28T10:00:30.000Z"
      })
    );
    assert.equal(second.id, first.id, "同 host 心跳复用同一行");
    assert.equal(second.createdAt, first.createdAt, "createdAt 不随心跳变化");
    assert.equal(second.lastSeenAt, "2026-10-28T10:00:30.000Z");
    assert.deepEqual(second.platforms, ["android", "ios"]);
    assert.deepEqual(second.devices, [DEVICES[0]]);
    assert.equal(second.tools.maestro, true);
    assert.equal(second.artifactBaseUrl, null);
    assert.equal(second.version, null);

    const listed = await store.listWebRunners();
    assert.equal(listed.length, 1, "心跳不产生新行");
  }
});

test("upsertWebRunner: 新实例在 TTL 内被拒（WebRunnerAlreadyActiveError），过期可接管（memory + pg-mem）", async () => {
  for (const store of await Promise.all(activeRunStores())) {
    await store.upsertWebRunner(webRunnerInput({ instanceId: "inst-1" }));
    await assert.rejects(
      () => store.upsertWebRunner(webRunnerInput({ instanceId: "inst-2" })),
      (error) => {
        assert.ok(error instanceof WebRunnerAlreadyActiveError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, "WebRunnerAlreadyActiveError");
        assert.equal(error.hostId, "host-a");
        assert.equal(error.existingInstanceId, "inst-1");
        assert.equal(error.incomingInstanceId, "inst-2");
        assert.match(error.message, /host-a/);
        assert.match(error.message, /inst-1/);
        assert.match(error.message, /inst-2/);
        return true;
      }
    );

    const stale = new Date(Date.now() - RUNNER_ACTIVE_DEFAULT_MS - 60_000).toISOString();
    await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-b", instanceId: "inst-old", lastSeenAt: stale })
    );
    const taken = await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-b", instanceId: "inst-new" })
    );
    assert.equal(taken.instanceId, "inst-new", "TTL 过期后新实例可接管");
    assert.equal((await store.listWebRunners()).length, 2);

    await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-c", instanceId: "inst-c1", activeWithinMs: 0 })
    );
    const immediate = await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-c", instanceId: "inst-c2", activeWithinMs: 0 })
    );
    assert.equal(immediate.instanceId, "inst-c2", "activeWithinMs 显式覆盖默认 TTL");
  }
});

test("markWebRunnerStopped: lastSeenAt 置纪元、isRunnerOnline=false、幂等、host+instance 精确匹配（memory + pg-mem）", async () => {
  for (const store of await Promise.all(activeRunStores())) {
    await store.upsertWebRunner(webRunnerInput());
    assert.equal(
      await store.markWebRunnerStopped({ hostId: "host-a", instanceId: "other" }),
      false,
      "instance 不匹配 → false"
    );
    assert.equal(
      await store.markWebRunnerStopped({ hostId: "host-other", instanceId: "inst-1" }),
      false,
      "host 不匹配 → false"
    );

    assert.equal(
      await store.markWebRunnerStopped({ hostId: "host-a", instanceId: "inst-1" }),
      true
    );
    const stopped = await store.getWebRunner("host-a");
    assert.equal(stopped.lastSeenAt, STOPPED_RUNNER_SEEN_AT);
    assert.equal(isRunnerOnline(stopped.lastSeenAt, Date.now(), RUNNER_TTL_DEFAULT_MS), false);

    assert.equal(
      await store.markWebRunnerStopped({ hostId: "host-a", instanceId: "inst-1" }),
      true,
      "重复停机幂等"
    );
    assert.equal((await store.listWebRunners()).length, 1);

    const takeover = await store.upsertWebRunner(webRunnerInput({ instanceId: "inst-2" }));
    assert.equal(takeover.instanceId, "inst-2", "停机后新实例立即可接管");
  }
});

test("listWebRunners: lastSeenAt 新→旧；getWebRunner 按 hostId 精确取（memory + pg-mem）", async () => {
  for (const store of await Promise.all(activeRunStores())) {
    await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-a", instanceId: "inst-a", lastSeenAt: "2026-10-28T10:00:00.000Z" })
    );
    await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-b", instanceId: "inst-b", lastSeenAt: "2026-10-28T11:00:00.000Z" })
    );
    await store.upsertWebRunner(
      webRunnerInput({ hostId: "host-c", instanceId: "inst-c", lastSeenAt: "2026-10-28T09:00:00.000Z" })
    );
    const listed = await store.listWebRunners();
    assert.deepEqual(
      listed.map((record) => record.hostId),
      ["host-b", "host-a", "host-c"]
    );
    assert.equal((await store.getWebRunner("host-a")).instanceId, "inst-a");
    assert.equal(await store.getWebRunner("host-missing"), null);
  }
});

test("FileStore: web runner 落在 host 级 state，重启后仍可读（不依赖项目目录）", async () => {
  const home = await tempHome();
  try {
    let store = await FileStore.create({ homeDir: home });
    await store.upsertWebRunner(webRunnerInput({ lastSeenAt: "2026-10-28T10:00:00.000Z" }));

    store = await FileStore.create({ homeDir: home });
    const listed = await store.listWebRunners();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hostId, "host-a");
    assert.deepEqual(listed[0].devices, DEVICES);
    assert.equal(listed[0].tools.maestro, false);

    const heartbeat = await store.upsertWebRunner(
      webRunnerInput({ lastSeenAt: "2026-10-28T10:00:30.000Z", version: "0.2.0" })
    );
    assert.equal(heartbeat.createdAt, listed[0].createdAt);
    assert.equal(heartbeat.version, "0.2.0");
    assert.equal((await store.listWebRunners()).length, 1);
    assert.equal(
      await store.markWebRunnerStopped({ hostId: "host-a", instanceId: "inst-1" }),
      true
    );

    store = await FileStore.create({ homeDir: home });
    const stopped = await store.getWebRunner("host-a");
    assert.equal(stopped.version, "0.2.0");
    assert.equal(stopped.lastSeenAt, STOPPED_RUNNER_SEEN_AT);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("FileStore: 第二个实例在 TTL 内仍被拒（跨进程重启的双启保护）", async () => {
  const home = await tempHome();
  try {
    let store = await FileStore.create({ homeDir: home });
    await store.upsertWebRunner(webRunnerInput({ instanceId: "inst-1" }));

    store = await FileStore.create({ homeDir: home });
    await assert.rejects(
      () => store.upsertWebRunner(webRunnerInput({ instanceId: "inst-2" })),
      (error) => error instanceof WebRunnerAlreadyActiveError
    );
    assert.equal((await store.listWebRunners()).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
