import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { runWebRunner, runWebRunnerCommand, isWebDeviceUsable } from "../dist/runner/web-agent.js";

const HOST = "web-host-1";
const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const LEASE_TTL = 60_000;

const execFail = async () => ({ code: 1, stdout: "", stderr: "", error: "unavailable" });

function env() {
  return {
    AOS_HOST_ID: HOST,
    AOS_RUNNER_TTL_MS: "90000",
    AOS_DEVICE_LEASE_MS: String(LEASE_TTL)
  };
}

function tools() {
  return {
    adb: true,
    idb: false,
    simctl: true,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false
  };
}

function android(serial, state = "device") {
  return {
    serial,
    name: "",
    model: "Pixel 7",
    osVersion: "14",
    platform: "android",
    kind: "device",
    state
  };
}

function simulator(serial, state = "Booted") {
  return {
    serial,
    name: "iPhone 15",
    model: "iPhone 15",
    osVersion: "17.2",
    platform: "ios",
    kind: "simulator",
    state
  };
}

function inventory(devices) {
  return {
    platforms: [...new Set(devices.map((device) => device.platform))],
    devices,
    tools: tools()
  };
}

function spec(overrides = {}) {
  const platform = overrides.platform ?? "android";
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: HOST,
    deviceSerial: null,
    requirements: { platform, deviceKind: "any" },
    deviceLeaseId: null,
    excelAssetId: "excel-1",
    packageAssetId: "pkg-1",
    materialsAssetId: null,
    scriptSetId: null,
    executionMode: "llm",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: [],
    reassignCount: 0,
    assignmentError: null,
    ...overrides
  };
}

async function makeStore() {
  const store = new MemoryStore();
  const rootPath = `/tmp/aos-web-agent-${randomUUID()}`;
  const project = await store.upsertProject({ rootPath, name: `proj-${randomUUID().slice(0, 8)}` });
  return { store, rootPath, project };
}

async function boundTask(store, rootPath, project, device, overrides = {}, atMs = NOW) {
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: [device.platform],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: spec({
      platform: device.platform,
      deviceSerial: device.serial,
      deviceLeaseId: `${HOST}:${device.serial}`,
      ...overrides
    }),
    deviceSerial: device.serial,
    deviceLeaseId: `${HOST}:${device.serial}`,
    priority: overrides.priority ?? 0
  });
  const leased = await store.acquireDeviceLeases({
    hostId: HOST,
    taskId: task.id,
    projectId: project.id,
    serials: [device.serial],
    ttlMs: LEASE_TTL,
    at: new Date(atMs).toISOString()
  });
  assert.equal(leased.ok, true, "任务设备预占成功");
  return task;
}

function io() {
  const logs = [];
  const errors = [];
  return { logs, errors, io: { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) } };
}

function baseOptions(store, overrides = {}) {
  return {
    centralStore: store,
    name: "web-runner-test",
    env: env(),
    exec: execFail,
    heartbeatMs: 60_000,
    ...overrides
  };
}

function fastEnv() {
  return { ...env(), AOS_RUNNER_POLL_MS: "10" };
}

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("web runner: 两台设备各起一个 worker，并行执行绑定到自己的任务", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const phone = simulator("sim-1");
  const taskA = await boundTask(store, rootPath, project, pixel);
  const taskB = await boundTask(store, rootPath, project, phone);
  const started = new Map();
  const gates = new Map([
    [taskA.id, deferred()],
    [taskB.id, deferred()]
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  const executeJob = async ({ task, device }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.set(task.id, device.serial);
    await gates.get(task.id).promise;
    inFlight -= 1;
    return { status: "completed" };
  };
  const sink = io();
  const running = runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel, phone]),
      executeJob,
      now: () => NOW,
      sleep: async () => {}
    }
  );
  await waitFor(() => started.size === 2, "两个 worker 同时执行");
  assert.equal(maxInFlight, 2, "两台设备并行执行");
  for (const gate of gates.values()) gate.resolve();
  const code = await running;
  assert.equal(code, 0);
  assert.equal(started.get(taskA.id), "pixel-1");
  assert.equal(started.get(taskB.id), "sim-1");
  assert.equal((await store.getRegressionTask(rootPath, taskA.id)).status, "completed");
  assert.equal((await store.getRegressionTask(rootPath, taskB.id)).status, "completed");
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0, "执行后释放租约");
});

test("web runner: 同一 serial 同时只有一个 active job（第二条留待后续轮次）", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const first = await boundTask(store, rootPath, project, pixel, { priority: 2 });
  const second = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: spec({ platform: "android", deviceSerial: "pixel-1" }),
    deviceSerial: "pixel-1",
    deviceLeaseId: null,
    priority: 1
  });
  const gate = deferred();
  let calls = 0;
  const claim = store.claimWebJob.bind(store);
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "claimWebJob") {
        return async (input) => {
          calls += 1;
          return claim(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const sink = io();
  const running = runWebRunner(
    baseOptions(proxy, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => {
        await gate.promise;
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  await waitFor(() => calls === 1, "首个任务进入执行");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1, "执行期间不再领取第二条");
  assert.equal((await store.getRegressionTask(rootPath, second.id)).status, "pending");
  gate.resolve();
  assert.equal(await running, 0);
  assert.equal((await store.getRegressionTask(rootPath, first.id)).status, "completed");
});

test("web runner: once 先跑一轮心跳/选机，pending 任务被绑定并执行", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    jobSpec: spec({
      platform: "android",
      assignment: "auto",
      devicePinned: false,
      targetHostId: null,
      deviceSerial: null
    })
  });
  const seen = { runner: null, taskId: null };
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true, artifactBaseUrl: "http://10.0.0.9:9999" }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async (input) => {
        seen.runner = await store.getWebRunner(HOST);
        seen.taskId = input.task.id;
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  assert.equal(seen.taskId, task.id, "选机后同一轮即可被 worker 领取执行");
  assert.ok(seen.runner, "心跳已登记 web runner");
  assert.equal(seen.runner.lastSeenAt, new Date(NOW).toISOString());
  assert.deepEqual(seen.runner.devices.map((device) => device.serial), ["pixel-1"]);
  assert.equal(seen.runner.artifactBaseUrl, "http://10.0.0.9:9999");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.targetHostId, HOST);
  assert.equal(stored.deviceSerial, "pixel-1");
  const runner = await store.getWebRunner(HOST);
  assert.equal(runner.lastSeenAt, "1970-01-01T00:00:00.000Z", "once 结束标记 stopped");
});

test("web runner: 心跳把过期预占任务回池并重新选机", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: spec({
      platform: "android",
      assignment: "auto",
      devicePinned: false,
      targetHostId: null,
      deviceSerial: "pixel-1"
    }),
    deviceSerial: "pixel-1",
    deviceLeaseId: `${HOST}:pixel-1`
  });
  const stale = await store.acquireDeviceLeases({
    hostId: HOST,
    taskId: task.id,
    projectId: project.id,
    serials: ["pixel-1"],
    ttlMs: LEASE_TTL,
    at: new Date(NOW - 5 * LEASE_TTL).toISOString()
  });
  assert.equal(stale.ok, true);
  const executed = [];
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async (input) => {
        executed.push(input.task.id);
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  assert.deepEqual(executed, [task.id], "回池后重新绑定并在本轮回池执行");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "completed");
  assert.ok(stored.jobSpec.reassignCount >= 1, "过期预占计入改派");
  assert.equal(stored.deviceSerial, "pixel-1");
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
});

test("web runner: 执行前设备掉线 → device-unavailable，释放 claim/lease 不执行", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  let calls = 0;
  let executed = 0;
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => {
        calls += 1;
        return calls === 1 ? inventory([pixel]) : inventory([]);
      },
      executeJob: async () => {
        executed += 1;
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  assert.equal(executed, 0, "设备不可用不执行");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "pending", "回池等待");
  assert.equal(stored.claimedBy, null);
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0, "释放预占");
  assert.ok(sink.logs.some((line) => line.includes("device-unavailable")), "记录 device-unavailable");
});

test("web runner: 执行前设备被其他任务占用 → device-busy，不执行", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  const foreignLease = {
    hostId: HOST,
    serial: "pixel-1",
    taskId: "other-task",
    projectId: project.id,
    acquiredAt: new Date(NOW).toISOString(),
    renewAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + LEASE_TTL).toISOString()
  };
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "listDeviceLeases") {
        return async (input) => {
          const rows = await target.listDeviceLeases(input);
          return [...rows, foreignLease];
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  let executed = 0;
  const sink = io();
  const code = await runWebRunner(
    baseOptions(proxy, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => {
        executed += 1;
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  assert.equal(executed, 0);
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "pending");
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0, "本任务租约已释放");
  assert.ok(sink.logs.some((line) => line.includes("device-busy")), "记录 device-busy");
});

test("web runner: 执行器抛错 → releaseRegressionTask(to:pending) 并释放租约", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => {
        throw new Error("boom");
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "pending", "异常不留 running");
  assert.equal(stored.claimedBy, null);
  assert.equal(stored.startedAt, null);
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
  assert.ok(sink.errors.some((line) => line.includes("boom")));
});

test("web runner: 执行结果 failed/partial 写回任务终态（不伪造 runIds）", async () => {
  const { store, rootPath, project } = await makeStore();
  const devices = [android("pixel-1"), android("pixel-2")];
  const failed = await boundTask(store, rootPath, project, devices[0], { priority: 2 });
  const partial = await boundTask(store, rootPath, project, devices[1], { priority: 2 });
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory(devices),
      executeJob: async ({ device }) => ({
        status: device.serial === "pixel-1" ? "failed" : "partial",
        detail: "demo"
      }),
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  const a = await store.getRegressionTask(rootPath, failed.id);
  const b = await store.getRegressionTask(rootPath, partial.id);
  assert.equal(a.status, "failed");
  assert.equal(b.status, "partial");
  assert.deepEqual(a.runIds, []);
  assert.deepEqual(b.runIds, []);
});

test("web runner: 非 once 可控停止 → markWebRunnerStopped 置 lastSeen 纪元", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  let stop = false;
  const timer = setTimeout(() => {
    stop = true;
  }, 80);
  try {
    const sink = io();
    const code = await runWebRunner(
      baseOptions(store, { once: false }),
      sink.io,
      {
        collectInventory: async () => inventory([pixel]),
        executeJob: async () => ({ status: "completed" }),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        shouldStop: () => stop
      }
    );
    assert.equal(code, 0);
    const stored = await store.getRegressionTask(rootPath, task.id);
    assert.equal(stored.status, "completed");
    const runner = await store.getWebRunner(HOST);
    assert.equal(runner.lastSeenAt, "1970-01-01T00:00:00.000Z");
    assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
  } finally {
    clearTimeout(timer);
  }
});

test("web runner CLI: 没有中心 PG → exit 2 且提示 MOBILE_TESTING_DATABASE_URL", async () => {
  const sink = io();
  const code = await runWebRunnerCommand(["--name", "cli", "--once"], sink.io, {
    env: {
      AOS_PANEL_BASE_URL: "http://center.local:8765",
      AOS_RUNNER_JOB_TOKEN: "runner-job-token-0123456789abcdef"
    }
  });
  assert.equal(code, 2);
  assert.ok(sink.errors.some((line) => line.includes("MOBILE_TESTING_DATABASE_URL")), sink.errors.join("\n"));
});

test("web runner CLI: --once 走中心 PG 执行一轮", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  const rootPath = `/tmp/aos-web-agent-cli-${randomUUID()}`;
  const project = await store.upsertProject({ rootPath, name: `cli-${randomUUID().slice(0, 8)}` });
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  const sink = io();
  const code = await runWebRunnerCommand(
    ["--name", "cli-runner", "--artifact-base-url", "http://host:1", "--once"],
    sink.io,
    {
      env: env(),
      store,
      exec: execFail,
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => ({ status: "completed" }),
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "completed");
  assert.ok(sink.logs.length > 0, "日志走 io");
});

test("web runner: 执行中被取消 → ackCancellation，不用 completed 覆盖", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => {
        await store.cancelRegressionTask({
          rootPath,
          taskId: task.id,
          source: "panel",
          actor: "tester",
          actorHostId: null,
          note: "stop"
        });
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "cancelled", "取消优先，不写 completed");
  assert.equal(stored.cancelSource, "panel");
  assert.deepEqual(stored.runIds, []);
  assert.ok(
    sink.logs.some((line) => line.includes("ackCancellation")),
    sink.logs.join("\n")
  );
});

test("web runner: 终态写入前已取消 → 保留 cancelled，不写结果", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel);
  const sink = io();
  const code = await runWebRunner(
    baseOptions(store, { once: true }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async () => {
        await store.cancelRegressionTask({
          rootPath,
          taskId: task.id,
          source: "panel",
          actor: "tester",
          actorHostId: null,
          note: "stop-now"
        });
        await store.ackCancellation({ rootPath, taskId: task.id });
        return { status: "completed" };
      },
      now: () => NOW,
      sleep: async () => {}
    }
  );
  assert.equal(code, 0);
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "cancelled");
  assert.deepEqual(stored.runIds, []);
  assert.ok(
    sink.logs.some((line) => line.includes("终态未写入") || line.includes("保留原状态")),
    sink.logs.join("\n")
  );
});

test("web runner: isWebDeviceUsable 状态矩阵（configured Android 可用）", () => {
  assert.equal(isWebDeviceUsable(android("a1", "device")), true);
  assert.equal(isWebDeviceUsable(android("a1", "configured")), true, "AOS_RUNNER_DEVICES 登记设备可用");
  assert.equal(isWebDeviceUsable(android("a1", "offline")), false);
  assert.equal(isWebDeviceUsable(android("a1", "unauthorized")), false);
  assert.equal(isWebDeviceUsable(simulator("s1", "Booted")), true);
  assert.equal(isWebDeviceUsable(simulator("s1", "configured")), true);
  assert.equal(isWebDeviceUsable(simulator("s1", "Shutdown")), false);
  assert.equal(isWebDeviceUsable({ ...simulator("r1", "device"), kind: "device" }), true);
  assert.equal(isWebDeviceUsable({ ...simulator("r2", "connected"), kind: "device" }), true);
  assert.equal(isWebDeviceUsable({ ...simulator("r3", "configured"), kind: "device" }), true);
  assert.equal(isWebDeviceUsable({ ...simulator("r4", "offline"), kind: "device" }), false);
});

test("web runner: 心跳发现新设备 → 启动 worker 并领取其任务", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-2");
  const task = await boundTask(store, rootPath, project, pixel, {}, Date.now());
  let devices = [];
  let stop = false;
  let executed = 0;
  const sink = io();
  const running = runWebRunner(
    baseOptions(store, { once: false, heartbeatMs: 20, env: fastEnv() }),
    sink.io,
    {
      collectInventory: async () => inventory(devices),
      executeJob: async () => {
        executed += 1;
        return { status: "completed" };
      },
      now: () => Date.now(),
      sleep: realSleep,
      shouldStop: () => stop
    }
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    devices = [pixel];
    await waitFor(() => executed === 1, "新设备 worker 领取执行");
    stop = true;
    const code = await running;
    assert.equal(code, 0);
    assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "completed");
    const runner = await store.getWebRunner(HOST);
    assert.deepEqual(runner.devices.map((device) => device.serial), ["pixel-2"], "心跳广播新设备");
    assert.ok(sink.logs.some((line) => line.includes("启动 worker")), sink.logs.join("\n"));
  } finally {
    stop = true;
    await running.catch(() => 0);
  }
});

test("web runner: 设备消失 → 停止 worker 且不再广播", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  let devices = [pixel];
  let stop = false;
  let claims = 0;
  const claim = store.claimWebJob.bind(store);
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "claimWebJob") {
        return async (input) => {
          claims += 1;
          return claim(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const sink = io();
  const running = runWebRunner(
    baseOptions(proxy, { once: false, heartbeatMs: 20, env: fastEnv() }),
    sink.io,
    {
      collectInventory: async () => inventory(devices),
      executeJob: async () => ({ status: "completed" }),
      now: () => Date.now(),
      sleep: realSleep,
      shouldStop: () => stop
    }
  );
  try {
    await waitFor(() => claims >= 1, "worker 空转领取一次");
    devices = [];
    await new Promise((resolve) => setTimeout(resolve, 30));
    let advertised = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      advertised = await store.getWebRunner(HOST);
      if (advertised !== null && advertised.devices.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(advertised.devices, [], "心跳不再广播已消失设备");
    const late = await boundTask(store, rootPath, project, pixel, {}, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = claims;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(claims, after, "worker 已停止，不再领取");
    assert.equal((await store.getRegressionTask(rootPath, late.id)).status, "pending");
    stop = true;
    const code = await running;
    assert.equal(code, 0);
    assert.ok(sink.logs.some((line) => line.includes("已移除")), sink.logs.join("\n"));
  } finally {
    stop = true;
    await running.catch(() => 0);
  }
});

test("web runner: 执行中租约续期丢失 → shouldAbort、回池且不写成功结果", async () => {
  const { store, rootPath, project } = await makeStore();
  const pixel = android("pixel-1");
  const task = await boundTask(store, rootPath, project, pixel, {}, Date.now());
  let stop = false;
  let abortedSeen = false;
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "renewDeviceLeases") {
        return async () => 0;
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const sink = io();
  const code = await runWebRunner(
    baseOptions(proxy, { once: false, heartbeatMs: 20, env: fastEnv() }),
    sink.io,
    {
      collectInventory: async () => inventory([pixel]),
      executeJob: async ({ shouldAbort }) => {
        const deadline = Date.now() + 2_000;
        while (!(shouldAbort?.() === true) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        abortedSeen = shouldAbort?.() === true;
        stop = true;
        return { status: "completed" };
      },
      now: () => Date.now(),
      sleep: realSleep,
      shouldStop: () => stop
    }
  );
  assert.equal(code, 0);
  assert.equal(abortedSeen, true, "执行器收到中止信号");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "pending", "租约丢失不写 completed");
  assert.deepEqual(stored.runIds, []);
  assert.equal(stored.claimedBy, null);
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
  assert.ok(
    sink.errors.some((line) => line.includes("租约")),
    sink.errors.join("\n")
  );
});

test("web runner: 心跳登记失败 → 停止 runner 并返回 2", async () => {
  const { store } = await makeStore();
  let upserts = 0;
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "upsertWebRunner") {
        return async (input) => {
          upserts += 1;
          if (upserts >= 2) throw new Error("db-down");
          return target.upsertWebRunner(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const sink = io();
  const code = await runWebRunner(
    baseOptions(proxy, { once: false, heartbeatMs: 10, env: fastEnv() }),
    sink.io,
    {
      collectInventory: async () => inventory([]),
      executeJob: async () => ({ status: "completed" }),
      now: () => Date.now(),
      sleep: realSleep,
      shouldStop: () => false
    }
  );
  assert.equal(code, 2);
  assert.ok(
    sink.errors.some((line) => line.includes("心跳") && line.includes("db-down")),
    sink.errors.join("\n")
  );
});
