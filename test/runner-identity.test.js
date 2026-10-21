import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { runRunnerAgent } from "../dist/runner/agent.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };
const DEVICES = [
  { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" },
  {
    serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
    name: "iPhone 15",
    platform: "ios",
    kind: "simulator",
    state: "Booted"
  }
];

function inventory() {
  return { platforms: ["android", "ios"], devices: DEVICES, tools: TOOLS };
}

function snapshot() {
  return {
    identity: {
      id: "h1",
      hardwareId: "hw1",
      hostname: "mac-a",
      username: "louis",
      osPlatform: "darwin",
      osVersion: "14.6.1",
      arch: "arm64",
      kind: "mac",
      identitySource: "file"
    },
    env: {
      collectedAt: "2026-10-21T09:00:00.000Z",
      node: "v22.0.0",
      aos: "0.0.0",
      cpu: { model: "Apple M1", count: 8 },
      memory: { totalBytes: 17179869184 },
      disk: { path: "/w/app", freeBytes: 100, totalBytes: 200 },
      tools: {
        adb: { present: true, version: null, path: null },
        xcodebuild: { present: true, version: null, path: null },
        simctl: { present: true, version: null, path: null },
        idb: { present: true, version: null, path: null },
        ideviceId: { present: true, version: null, path: null },
        idevicesyslog: { present: false, version: null, path: null },
        appium: { present: false, version: null, path: null },
        uv: { present: false, version: null, path: null }
      }
    },
    capabilities: ["android", "ios-simulator"],
    ipPrimary: "10.0.0.5",
    addresses: [
      { source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" },
      { source: "self", iface: "en1", family: "ipv4", address: "10.0.0.6" }
    ]
  };
}

async function fixture() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { runtime, store };
}

function baseOptions(runtime, overrides = {}) {
  return {
    projectDir: runtime.project.rootDir,
    name: "runner-1",
    once: true,
    env: {},
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    executeSuite: async () => 0,
    collectInventory: async () => inventory(),
    collectHostSnapshot: async () => snapshot(),
    io: { log: () => {}, errorLog: () => {} },
    ...overrides
  };
}

test("同机同项目第二个 runner 启动 → exit 2，不覆写第一实例", async () => {
  const { runtime, store } = await fixture();
  const root = runtime.project.rootDir;
  const first = await runRunnerAgent(baseOptions(runtime, { instanceId: "i-1" }));
  assert.equal(first, 0);

  const errors = [];
  const second = await runRunnerAgent(
    baseOptions(runtime, {
      instanceId: "i-2",
      io: { log: () => {}, errorLog: (line) => errors.push(line) }
    })
  );
  assert.equal(second, 2, "第二个实例应被双启保护拒绝");
  assert.ok(errors.some((line) => line.includes("runner")), "记录错误日志");

  const runners = await store.listRunners(root);
  assert.equal(runners.length, 1, "不覆写第一实例 → 仍单行");
  assert.equal(runners[0].instanceId, "i-1", "instanceId 保持第一实例");
});

test("陈旧行（lastSeen 超 TTL）可被新实例 CAS 接管", async () => {
  const { runtime, store } = await fixture();
  const root = runtime.project.rootDir;
  const project = await store.getProjectByPath(root);
  const stale = new Date(Date.now() - 3600_000).toISOString();
  store.importState({
    runners: [
      {
        id: "r-old",
        projectId: project.id,
        name: "runner-1",
        hostname: "mac-a",
        platforms: ["android", "ios"],
        devices: DEVICES,
        tools: TOOLS,
        artifactBaseUrl: null,
        version: null,
        hostId: "h1",
        instanceId: "i-old",
        lastSeenAt: stale,
        createdAt: stale
      }
    ]
  });

  const code = await runRunnerAgent(baseOptions(runtime, { instanceId: "i-new" }));
  assert.equal(code, 0);
  const runners = await store.listRunners(root);
  assert.equal(runners.length, 1);
  assert.equal(runners[0].instanceId, "i-new", "陈旧行被新实例接管");
  assert.equal(runners[0].id, "r-old", "CAS 接管保留原行 id");
});

test("直接 upsertRunner 无 hostId/instanceId → 仍按 (project_id,name) 更新（legacy）", async () => {
  const { runtime, store } = await fixture();
  const root = runtime.project.rootDir;
  const first = await store.upsertRunner({
    rootPath: root,
    name: "runner-legacy",
    hostname: "mac-legacy",
    platforms: ["android"],
    devices: [DEVICES[0]],
    tools: TOOLS,
    artifactBaseUrl: null,
    version: null
  });
  assert.equal(first.hostId, null);
  assert.equal(first.instanceId, null);

  const second = await store.upsertRunner({
    rootPath: root,
    name: "runner-legacy",
    hostname: "mac-legacy-2",
    platforms: ["ios"],
    devices: [DEVICES[1]],
    tools: TOOLS,
    artifactBaseUrl: null,
    version: null
  });
  assert.equal(second.id, first.id, "同名 → 盲更新同一行");
  assert.equal(second.hostname, "mac-legacy-2");
  assert.equal(second.hostId, null);
  assert.equal((await store.listRunners(root)).length, 1);
});

test("直接 upsertRunner 同 host 不同实例且活跃 → 抛 RunnerAlreadyActiveError", async () => {
  const { runtime, store } = await fixture();
  const root = runtime.project.rootDir;
  await store.upsertRunner({
    rootPath: root,
    name: "runner-a",
    hostname: "mac-a",
    platforms: [],
    devices: [],
    tools: TOOLS,
    hostId: "h1",
    instanceId: "i-1"
  });
  await assert.rejects(
    store.upsertRunner({
      rootPath: root,
      name: "runner-a",
      hostname: "mac-a",
      platforms: [],
      devices: [],
      tools: TOOLS,
      hostId: "h1",
      instanceId: "i-2"
    }),
    (error) => error?.name === "RunnerAlreadyActiveError"
  );
});

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  return { store, pool };
}

function pgRunnerInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    name: "runner-1",
    hostname: "mac-a",
    platforms: ["android"],
    devices: [DEVICES[0]],
    tools: TOOLS,
    hostId: "h1",
    instanceId: "i-1",
    ...overrides
  };
}

test("PG upsertRunner：同 host 不同实例且活跃 → 抛；陈旧 → CAS 接管；legacy 仍按 name 更新", async () => {
  const { store, pool } = await makePgStore();
  const project = await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const seeded = await store.upsertRunner(pgRunnerInput());
  assert.equal(seeded.hostId, "h1");
  assert.equal(seeded.instanceId, "i-1");

  await assert.rejects(
    store.upsertRunner(pgRunnerInput({ instanceId: "i-2" })),
    (error) => error?.name === "RunnerAlreadyActiveError"
  );

  await pool.query("UPDATE runners SET last_seen_at = $1 WHERE id = $2", [
    new Date(Date.now() - 3600_000).toISOString(),
    seeded.id
  ]);
  const taken = await store.upsertRunner(pgRunnerInput({ instanceId: "i-new" }));
  assert.equal(taken.id, seeded.id, "CAS 接管保留原行");
  assert.equal(taken.instanceId, "i-new");

  const legacy = await store.upsertRunner(
    pgRunnerInput({ name: "legacy", hostId: null, instanceId: null })
  );
  assert.equal(legacy.instanceId, null);
  const legacyAgain = await store.upsertRunner(
    pgRunnerInput({ name: "legacy", hostId: null, instanceId: null, hostname: "mac-b" })
  );
  assert.equal(legacyAgain.id, legacy.id, "legacy 同名盲更新");
  assert.equal(legacyAgain.hostname, "mac-b");

  const rows = await pool.query("SELECT id, host_id, instance_id FROM runners ORDER BY name");
  assert.equal(rows.rows.length, 2, "h1 与 legacy 各一行");
  assert.equal(project.id.length > 0, true);
});

test("PG upsertRunner：同 host 不同 name → 撞 host 唯一索引 → 抛 RunnerAlreadyActiveError", async () => {
  const { store, pool } = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await store.upsertRunner(pgRunnerInput({ name: "runner-a", instanceId: "i-1" }));

  await assert.rejects(
    store.upsertRunner(pgRunnerInput({ name: "runner-b", instanceId: "i-2" })),
    (error) => error?.name === "RunnerAlreadyActiveError",
    "同名之外的同 host 行也由 host 唯一索引拦截"
  );

  const listed = await store.listRunners("/w/p1");
  assert.equal(listed.length, 1, "不产生第二行");
  assert.equal(listed[0].name, "runner-a");
});

test("PG 迁移顺序：旧 runners 表（无 host_id 列）init 后 host 唯一索引生效（先建列后建索引）", async () => {
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY, root_path TEXT NOT NULL, name TEXT NOT NULL,
       figma_token TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`
  );
  await pool.query(
    `CREATE TABLE runners (
       id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, hostname TEXT NOT NULL,
       platforms TEXT NOT NULL, devices TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '{}',
       artifact_base_url TEXT, version TEXT, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL)`
  );
  await pool.query(
    `INSERT INTO projects (id, root_path, name, figma_token, created_at, last_seen_at)
     VALUES ('proj-1', '/w/p1', 'p1', NULL, $1, $1)`,
    ["2026-10-01T00:00:00.000Z"]
  );

  const store = new PostgresStore(pool);
  await store.init();

  await store.upsertRunner(pgRunnerInput({ name: "runner-a", instanceId: "i-1" }));
  await assert.rejects(
    store.upsertRunner(pgRunnerInput({ name: "runner-b", instanceId: "i-2" })),
    (error) => error?.name === "RunnerAlreadyActiveError",
    "迁移后 host 唯一索引应拦截同 host 不同 name"
  );
});
