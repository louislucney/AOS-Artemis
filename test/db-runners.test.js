import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  RUNNER_TTL_DEFAULT_MS,
  isRunnerOnline,
  runnerTtlFrom
} from "../dist/runner/status.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  return { store, pool };
}

const DEVICES = [
  {
    serial: "emulator-5554",
    name: "",
    platform: "android",
    kind: "emulator",
    state: "device"
  },
  {
    serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
    name: "iPhone Louis",
    platform: "ios",
    kind: "device",
    state: "Booted"
  }
];

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };

function runnerInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    name: "runner-a",
    hostname: "mac-a.local",
    platforms: ["android", "ios"],
    devices: DEVICES,
    tools: TOOLS,
    artifactBaseUrl: "http://mac-a.local:8770",
    version: "0.1.0",
    ...overrides
  };
}

test("upsertRunner: 首次落库 + 二次更新同一条（id 稳定、devices 覆盖、createdAt 不变、lastSeenAt 变新）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const first = await store.upsertRunner(runnerInput());
    assert.ok(first.id);
    assert.ok(first.projectId);
    assert.equal(first.name, "runner-a");
    assert.equal(first.hostname, "mac-a.local");
    assert.deepEqual(first.platforms, ["android", "ios"]);
    assert.deepEqual(first.devices, DEVICES);
    assert.deepEqual(first.tools, TOOLS);
    assert.equal(first.artifactBaseUrl, "http://mac-a.local:8770");
    assert.equal(first.version, "0.1.0");
    assert.ok(first.lastSeenAt);
    assert.equal(first.createdAt, first.lastSeenAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.upsertRunner(
      runnerInput({
        platforms: ["android"],
        devices: [DEVICES[0]],
        tools: { ...TOOLS, appium: true },
        artifactBaseUrl: null,
        version: null
      })
    );
    assert.equal(second.id, first.id, "同项目同名 → 同一行");
    assert.equal(second.createdAt, first.createdAt, "createdAt 不随心跳变化");
    assert.notEqual(second.lastSeenAt, first.lastSeenAt, "lastSeenAt 刷新");
    assert.deepEqual(second.platforms, ["android"]);
    assert.deepEqual(second.devices, [DEVICES[0]]);
    assert.equal(second.tools.appium, true);
    assert.equal(second.artifactBaseUrl, null);
    assert.equal(second.version, null);

    const listed = await store.listRunners("/w/p1");
    assert.equal(listed.length, 1, "同名 upsert 不产生新行");
  }
});

test("upsertRunner: 未注册项目 → 抛错（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await assert.rejects(store.upsertRunner(runnerInput()), /未注册/);
  }
});

test("listRunners: 按 lastSeenAt 新→旧 + limit；未知项目 → []", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.upsertRunner(runnerInput({ name: "old" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsertRunner(runnerInput({ name: "new" }));
    const all = await store.listRunners("/w/p1");
    assert.deepEqual(
      all.map((entry) => entry.name),
      ["new", "old"]
    );
    assert.equal((await store.listRunners("/w/p1", 1)).length, 1);
    assert.deepEqual(await store.listRunners("/w/p2"), []);
  }
});

test("runners: devices.name 与 tools 往返一致；PG 侧旧格式行宽容解析（tools 全 false、name 空串）", async () => {
  const { store, pool } = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const seeded = await store.upsertRunner(runnerInput({ name: "seed" }));
  assert.equal(seeded.devices[1].name, "iPhone Louis");
  assert.deepEqual(seeded.tools, TOOLS);

  await pool.query(
    `INSERT INTO runners
       (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, last_seen_at, created_at)
     VALUES ('r-legacy', $1, 'legacy', 'host-b', '["android"]',
             '[{"serial":"x1","platform":"android","kind":"device","state":"device"}]',
             '{}', NULL, NULL, $2, $2)`,
    [seeded.projectId, "2026-10-14T00:00:00.000Z"]
  );
  const listed = await store.listRunners("/w/p1");
  const legacy = listed.find((entry) => entry.name === "legacy");
  assert.ok(legacy);
  assert.equal(legacy.devices[0].name, "", "缺 name → 空串");
  assert.deepEqual(legacy.tools, {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false
  });
  assert.equal(legacy.artifactBaseUrl, null);
  assert.equal(legacy.version, null);
});

test("isRunnerOnline: TTL 边界；runnerTtlFrom: 默认与合法值", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  assert.equal(isRunnerOnline("2026-10-14T11:58:30.000Z", now, 90_000), true, "恰等于 TTL 在线");
  assert.equal(isRunnerOnline("2026-10-14T11:58:29.999Z", now, 90_000), false, "超 1ms 离线");
  assert.equal(isRunnerOnline("2026-10-14T12:00:30.000Z", now, 90_000), true, "未来时间视为在线");
  assert.equal(isRunnerOnline("not-a-date", now, 90_000), false, "非法时间 → 离线");
  assert.equal(runnerTtlFrom({}), RUNNER_TTL_DEFAULT_MS);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "60000" }), 60_000);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "abc" }), RUNNER_TTL_DEFAULT_MS);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "0" }), RUNNER_TTL_DEFAULT_MS);
});
