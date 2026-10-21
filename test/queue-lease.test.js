import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { runRunnerAgent, clampRunnerHeartbeatMs } from "../dist/runner/agent.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject, TEST_HOST_IDENTITY } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

const STORE_IMPLS = [
  ["Memory", () => new MemoryStore()],
  ["Postgres", () => makePgStore()]
];

function taskInput(rootPath, overrides = {}) {
  return {
    rootPath,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli",
    ...overrides
  };
}

for (const [name, factory] of STORE_IMPLS) {
  test(`[${name}] 设备租约全有或全无`, async () => {
    const store = await factory();
    const first = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t1",
      serials: ["a", "b"],
      at: "2026-10-21T10:00:00.000Z"
    });
    assert.equal(first.ok, true);
    assert.deepEqual(
      first.leases.map((lease) => lease.serial),
      ["a", "b"]
    );
    assert.equal(first.leases[0].taskId, "t1");
    assert.equal(first.leases[0].hostId, "h");
    assert.equal(first.leases[0].expiresAt, "2026-10-21T10:01:30.000Z");

    const second = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["b", "c"],
      at: "2026-10-21T10:00:10.000Z"
    });
    assert.equal(second.ok, false);
    assert.deepEqual(second.busy, ["b"]);

    const retry = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["c"],
      at: "2026-10-21T10:00:10.000Z"
    });
    assert.equal(retry.ok, true);
    assert.deepEqual(
      retry.leases.map((lease) => lease.serial),
      ["c"]
    );
    await store.close();
  });

  test(`[${name}] 过期租约可被抢占、续租延长、释放后可用`, async () => {
    const store = await factory();
    const t0 = "2026-10-21T10:00:00.000Z";
    const first = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t1",
      serials: ["a"],
      ttlMs: 1_000,
      at: t0
    });
    assert.equal(first.ok, true);
    assert.equal(first.leases[0].expiresAt, "2026-10-21T10:00:01.000Z");

    const steal = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["a"],
      ttlMs: 10_000,
      at: "2026-10-21T10:00:02.000Z"
    });
    assert.equal(steal.ok, true);
    assert.equal(steal.leases[0].taskId, "t2");

    const renewed = await store.renewDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["a"],
      ttlMs: 20_000,
      at: "2026-10-21T10:00:05.000Z"
    });
    assert.equal(renewed, 1);

    const stillBusy = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t3",
      serials: ["a"],
      at: "2026-10-21T10:00:10.000Z"
    });
    assert.equal(stillBusy.ok, false);
    assert.deepEqual(stillBusy.busy, ["a"]);

    assert.equal(await store.releaseDeviceLeases({ hostId: "h", taskId: "t2" }), 1);
    const afterRelease = await store.acquireDeviceLeases({
      hostId: "h",
      taskId: "t3",
      serials: ["a"],
      at: "2026-10-21T10:00:10.000Z"
    });
    assert.equal(afterRelease.ok, true);
    await store.close();
  });

  test(`[${name}] 队列暂停时 claim 返回 null；恢复后可领`, async () => {
    const store = await factory();
    await store.upsertHost({ id: "h", hostname: "mac-a" });
    await store.upsertProject({ rootPath: "/w/app", name: "app" });
    await store.createRegressionTask(taskInput("/w/app"));

    await store.setHostQueuePaused({ hostId: "h", paused: true, by: "panel" });
    const paused = await store.claimRegressionTask({
      rootPath: "/w/app",
      runnerId: "r-1",
      platforms: ["android"],
      hostId: "h",
      instanceId: "i-1",
      capabilities: ["android"]
    });
    assert.equal(paused, null);

    await store.setHostQueuePaused({ hostId: "h", paused: false, by: "panel" });
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/app",
      runnerId: "r-1",
      platforms: ["android"],
      hostId: "h",
      instanceId: "i-1",
      capabilities: ["android"]
    });
    assert.ok(claimed);
    assert.equal(claimed.status, "claimed");
    await store.close();
  });
}

test("FileStore 设备租约随主机状态持久化并可释放", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "aos-lease-"));
  const rootPath = path.join(home, "app");
  try {
    const first = await FileStore.create({ homeDir: home, env: {} });
    await first.upsertProject({ rootPath, name: "app" });
    await first.upsertHost({ id: "h", hostname: "h" });
    await first.createRegressionTask({
      rootPath,
      refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
      platforms: ["android"],
      baseline: "latest",
      createdBy: "cli"
    });
    await first.setHostQueuePaused({ hostId: "h", paused: true, by: "cli" });
    const claimInput = {
      rootPath,
      runnerId: "r-1",
      platforms: ["android"],
      hostId: "h",
      instanceId: "i-1",
      capabilities: ["android"]
    };
    assert.equal(await first.claimRegressionTask(claimInput), null);
    await first.setHostQueuePaused({ hostId: "h", paused: false, by: "cli" });
    assert.ok(await first.claimRegressionTask(claimInput));

    const acquired = await first.acquireDeviceLeases({
      hostId: "h",
      taskId: "t1",
      serials: ["a"],
      at: "2026-10-21T10:00:00.000Z"
    });
    assert.equal(acquired.ok, true);

    const reopened = await FileStore.create({ homeDir: home, env: {} });
    assert.ok(await reopened.getProjectByPath(rootPath));
    const busy = await reopened.acquireDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["a"],
      at: "2026-10-21T10:00:10.000Z"
    });
    assert.equal(busy.ok, false);
    assert.deepEqual(busy.busy, ["a"]);
    assert.equal(await reopened.releaseDeviceLeases({ hostId: "h", taskId: "t1" }), 1);

    const third = await FileStore.create({ homeDir: home, env: {} });
    assert.ok(await third.getProjectByPath(rootPath));
    const afterRelease = await third.acquireDeviceLeases({
      hostId: "h",
      taskId: "t2",
      serials: ["a"],
      at: "2026-10-21T10:00:20.000Z"
    });
    assert.equal(afterRelease.ok, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };
const TEST_HOST_ID = TEST_HOST_IDENTITY.id;
const TEST_INSTANCE_ID = "inst-1";

function inventory() {
  return {
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: TOOLS
  };
}

function snapshot() {
  return {
    identity: TEST_HOST_IDENTITY,
    env: { collectedAt: "2026-10-21T09:00:00.000Z" },
    capabilities: ["android"],
    ipPrimary: "10.0.0.5",
    addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" }]
  };
}

async function setupRunnerFixture() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  return { dir, runtime, store: runtime.store, inventory: inventory() };
}

function makeRunnerOptions(runtime, inv, overrides = {}) {
  const logs = [];
  const errors = [];
  const options = {
    projectDir: runtime.project.rootDir,
    name: "runner-1",
    once: true,
    env: {},
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    executeSuite: async () => 0,
    collectInventory: async () => inv,
    collectHostSnapshot: async () => snapshot(),
    instanceId: TEST_INSTANCE_ID,
    io: { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) },
    sleep: async () => {},
    ...overrides
  };
  return { options, logs, errors };
}

test("设备忙：释放回 pending 且 attempts 不增加、不执行", async () => {
  const { runtime, store, inventory: inv } = await setupRunnerFixture();
  const rootPath = runtime.project.rootDir;
  await store.upsertHost({ id: TEST_HOST_ID, hostname: "test-machine" });
  const held = await store.acquireDeviceLeases({
    hostId: TEST_HOST_ID,
    taskId: "other-task",
    serials: ["emulator-5554"],
    ttlMs: 600_000
  });
  assert.equal(held.ok, true);
  const task = await store.createRegressionTask(taskInput(rootPath));
  let executed = 0;
  const { options, logs } = makeRunnerOptions(runtime, inv, {
    executeSuite: async () => {
      executed += 1;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(executed, 0);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending");
  assert.equal(after.attempts, 0);
  assert.equal(after.claimedBy, null);
  assert.ok(logs.some((line) => line.includes("device-busy")));
});

test("设备忙期间取消：确认 cancelled，不落回 pending", async () => {
  const { runtime, store, inventory: inv } = await setupRunnerFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  store.acquireDeviceLeases = async () => {
    await store.cancelRegressionTask({
      rootPath,
      taskId: task.id,
      source: "panel",
      actor: "panel",
      actorHostId: null
    });
    return { ok: false, busy: ["emulator-5554"] };
  };
  const { options, logs } = makeRunnerOptions(runtime, inv);
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.attempts, 0);
  assert.ok(logs.some((line) => line.includes("已确认 cancelled")));
});

test("beginExecution 失败：释放租约并释放回 pending", async () => {
  const { runtime, store, inventory: inv } = await setupRunnerFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  store.beginExecution = async () => null;
  const { options } = makeRunnerOptions(runtime, inv);
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending");
  assert.equal(after.attempts, 0);
  assert.equal(after.claimedBy, null);
  const probe = await store.acquireDeviceLeases({
    hostId: TEST_HOST_ID,
    taskId: "probe",
    serials: ["emulator-5554"]
  });
  assert.equal(probe.ok, true);
});

test("租约续期丢失：中止执行、错误日志并在收尾释放", async () => {
  const { runtime, store, inventory: inv } = await setupRunnerFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  const sleep = async (ms) => {
    clock += ms;
  };
  store.renewDeviceLeases = async () => 0;
  let stop = false;
  let aborted = false;
  const { options, errors } = makeRunnerOptions(runtime, inv, {
    once: false,
    heartbeatMs: 30_000,
    now: () => clock,
    sleep,
    shouldStop: () => stop,
    executeSuite: async (_argv, execOptions) => {
      for (let index = 0; index < 1200; index += 1) {
        await sleep(250);
        if (execOptions.shouldAbort()) {
          aborted = true;
          stop = true;
          return 2;
        }
      }
      stop = true;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(aborted, true);
  assert.ok(errors.some((line) => line.includes("设备租约丢失")));
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending");
  assert.equal(after.attempts, 1);
  const probe = await store.acquireDeviceLeases({
    hostId: TEST_HOST_ID,
    taskId: "probe",
    serials: ["emulator-5554"]
  });
  assert.equal(probe.ok, true);
});

test("心跳间隔按设备租约 TTL/3 收敛", () => {
  assert.equal(clampRunnerHeartbeatMs(60_000, { AOS_DEVICE_LEASE_MS: "90000" }), 30_000);
  assert.equal(clampRunnerHeartbeatMs(10_000, { AOS_DEVICE_LEASE_MS: "90000" }), 10_000);
  assert.equal(clampRunnerHeartbeatMs(60_000, {}), 30_000);
  assert.equal(clampRunnerHeartbeatMs(60_000, { AOS_DEVICE_LEASE_MS: "3000" }), 1_000);
  assert.equal(clampRunnerHeartbeatMs(60_000, { AOS_DEVICE_LEASE_MS: "0" }), 30_000);
});

test("长执行统一 tick：心跳在线、租约续期、lastProgressAt 前进、attempts 不变", async () => {
  const { runtime, store, inventory: inv } = await setupRunnerFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  const sleep = async (ms) => {
    clock += ms;
  };
  const renewCalls = [];
  const originalRenew = store.renewDeviceLeases.bind(store);
  store.renewDeviceLeases = async (input) => {
    const count = await originalRenew(input);
    renewCalls.push({ at: input.at ?? null, count });
    return count;
  };
  let stop = false;
  let observed = null;
  const runnerLastSeenAt = [];
  const originalHeartbeat = store.upsertRunner.bind(store);
  store.upsertRunner = async (input) => {
    const record = await originalHeartbeat(input);
    runnerLastSeenAt.push(record.lastSeenAt);
    return record;
  };
  const { options } = makeRunnerOptions(runtime, inv, {
    once: false,
    heartbeatMs: 30_000,
    now: () => clock,
    sleep,
    shouldStop: () => stop,
    executeSuite: async () => {
      const before = await store.getRegressionTask(rootPath, task.id);
      for (let index = 0; index < 1200; index += 1) await sleep(250);
      const after = await store.getRegressionTask(rootPath, task.id);
      const runners = await store.listRunners(rootPath);
      observed = {
        beforeProgress: before.lastProgressAt,
        afterProgress: after.lastProgressAt,
        attempts: after.attempts,
        status: after.status,
        runnerSeenAt: runners[0]?.lastSeenAt ?? null
      };
      stop = true;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.ok(observed);
  assert.equal(observed.attempts, 1);
  assert.ok(renewCalls.length >= 2, `tick 续租次数 ${renewCalls.length}`);
  assert.ok(renewCalls.every((call) => call.count === 1));
  const firstRenew = Date.parse(renewCalls[0].at);
  const lastRenew = Date.parse(renewCalls[renewCalls.length - 1].at);
  assert.ok(Number.isFinite(firstRenew) && Number.isFinite(lastRenew));
  assert.ok(lastRenew - firstRenew >= 30_000);
  assert.ok(observed.afterProgress);
  const start = Date.parse("2026-10-21T10:00:00.000Z");
  assert.ok(Date.parse(observed.afterProgress) > start);
  assert.ok(runnerLastSeenAt.length >= 2);
  assert.ok(Number.isFinite(Date.parse(observed.runnerSeenAt)));
  const host = await store.getHost(TEST_HOST_ID);
  assert.ok(host?.runnerSeenAt);
  assert.ok(Date.parse(host.runnerSeenAt) > start);
  const probe = await store.acquireDeviceLeases({
    hostId: TEST_HOST_ID,
    taskId: "probe",
    serials: ["emulator-5554"]
  });
  assert.equal(probe.ok, true);
});

async function setupCliRuntime() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  return { store: runtime.store, runtime, rootPath: runtime.project.rootDir };
}

function runLocalQueue(runtime, args) {
  const logs = [];
  const errors = [];
  return runSuiteCommand(args, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    env: { AOS_ACTOR: "tester" }
  }).then((code) => ({ code, logs, errors }));
}

test("CLI suite queue：本机 status/pause/resume 与审计", async () => {
  const { store, runtime, rootPath } = await setupCliRuntime();
  await store.createRegressionTask(taskInput(rootPath));

  const before = await runLocalQueue(runtime, ["queue", "status"]);
  assert.equal(before.code, 0, before.errors.join("\n"));
  assert.ok(before.logs.some((line) => line.includes("运行") && line.includes("待执行 1")));
  assert.equal(await store.getHost(TEST_HOST_ID), null, "status 不自动登记主机");

  const paused = await runLocalQueue(runtime, ["queue", "pause"]);
  assert.equal(paused.code, 0, paused.errors.join("\n"));
  const host = await store.getHost(TEST_HOST_ID);
  assert.equal(host.queuePaused, true);
  assert.equal(host.queuePausedBy, "tester");
  assert.ok(paused.logs.some((line) => line.includes("已暂停")));
  const audit = await store.listAudit(rootPath, { domain: "suite" });
  const pauseAudit = audit.find((entry) => entry.action === "action.queue.pause");
  assert.ok(pauseAudit);
  assert.equal(pauseAudit.channel, "cli");
  assert.equal(pauseAudit.actor, "tester");

  const status = await runLocalQueue(runtime, ["queue", "status", "--json"]);
  assert.equal(status.code, 0, status.errors.join("\n"));
  const payload = JSON.parse(status.logs[0]);
  assert.equal(payload.paused, true);
  assert.equal(payload.pending, 1);

  const resumed = await runLocalQueue(runtime, ["queue", "resume"]);
  assert.equal(resumed.code, 0, resumed.errors.join("\n"));
  assert.equal((await store.getHost(TEST_HOST_ID)).queuePaused, false);
  assert.ok(resumed.logs.some((line) => line.includes("已恢复")));
});

test("CLI suite queue --host：中心 status/pause/resume 不建本地 Runtime", async () => {
  const store = await makePgStore();
  await store.upsertHost({ id: "h-b", hostname: "mac-b" });
  await store.upsertHost({ id: "h-a", hostname: "mac-a" });
  const scoped = store.scopeHost("h-b");
  await scoped.upsertProject({ rootPath: "/w/app", name: "app" });
  await scoped.createRegressionTask(taskInput("/w/app"));
  const logs = [];
  const errors = [];
  const run = (args) =>
    runSuiteCommand(args, {
      buildRuntime: () => {
        throw new Error("should not build local Runtime");
      },
      log: (line) => logs.push(line),
      errorLog: (line) => errors.push(line),
      env: { AOS_ACTOR: "tester" },
      center: { store }
    });

  assert.equal(await run(["queue", "status", "--host", "mac-b", "--json"]), 0, errors.join("\n"));
  let payload = JSON.parse(logs[logs.length - 1]);
  assert.equal(payload.hostId, "h-b");
  assert.equal(payload.paused, false);
  assert.equal(payload.pending, 1);

  assert.equal(await run(["queue", "pause", "--host", "h-b"]), 0, errors.join("\n"));
  assert.equal((await store.getHost("h-b")).queuePaused, true);
  assert.equal((await store.getHost("h-a")).queuePaused, false);
  const audit = await scoped.listAudit("/w/app", { domain: "suite" });
  assert.ok(audit.some((entry) => entry.action === "action.queue.pause"));

  assert.equal(await run(["queue", "resume", "--host", "h-b"]), 0, errors.join("\n"));
  assert.equal((await store.getHost("h-b")).queuePaused, false);

  assert.equal(await run(["queue", "pause", "--host", "unknown"]), 2);
  await store.close();
});

function panelRequest(pathname, body) {
  return { method: "POST", url: new URL(`http://localhost${pathname}`), body };
}

function panelBody(response) {
  return JSON.parse(response.body);
}

test("panel API 队列暂停/恢复：host 级、审计、400/404", async () => {
  const store = new MemoryStore();
  await store.upsertHost({ id: "h-a", hostname: "mac-a" });
  const deps = { store, env: {} };

  const missing = await handlePanelActionRequest(
    panelRequest("/panel/api/queue/pause", {}),
    deps
  );
  assert.equal(missing.status, 400);

  const unknown = await handlePanelActionRequest(
    panelRequest("/panel/api/queue/pause", { host: "nope" }),
    deps
  );
  assert.equal(unknown.status, 404);

  const paused = await handlePanelActionRequest(
    panelRequest("/panel/api/queue/pause", { host: "h-a", note: "维护窗口" }),
    deps
  );
  assert.equal(paused.status, 200, paused.body);
  assert.equal(panelBody(paused).host.queuePaused, true);
  const audit = await store.listAudit("", { domain: "panel" });
  const pauseAudit = audit.find(
    (entry) => entry.action === "action.queue.pause" && entry.result === "ok"
  );
  assert.ok(pauseAudit);
  assert.equal(pauseAudit.actor, "panel");
  assert.equal(pauseAudit.channel, "panel");
  assert.equal(pauseAudit.refs.hostId, "h-a");
  assert.equal(pauseAudit.refs.note, "维护窗口");

  const resumed = await handlePanelActionRequest(
    panelRequest("/panel/api/queue/resume", { host: "mac-a" }),
    deps
  );
  assert.equal(resumed.status, 200, resumed.body);
  assert.equal(panelBody(resumed).host.queuePaused, false);
  assert.ok(
    (await store.listAudit("", { domain: "panel" })).some(
      (entry) => entry.action === "action.queue.resume" && entry.result === "ok"
    )
  );

  const originalGetHost = store.getHost.bind(store);
  store.getHost = async () => {
    throw new Error("db down");
  };
  await assert.rejects(
    () => handlePanelActionRequest(panelRequest("/panel/api/queue/pause", { host: "h-a" }), deps),
    /db down/
  );
  store.getHost = originalGetHost;
});
