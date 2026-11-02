import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { WebRunnerAlreadyActiveError } from "../dist/db/types.js";
import { WebRunnerControlService } from "../dist/runner/control/service.js";

const HOST = "web-control-host";
const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const LEASE_TTL = 60_000;
const INSTANCE = "runner-instance-1";

function iso(ms) {
  return new Date(ms).toISOString();
}

function tools() {
  return {
    adb: true,
    idb: false,
    simctl: true,
    ideviceId: false,
    appium: false,
    maestro: true,
    devicectl: false
  };
}

function android(serial = "pixel-1") {
  return {
    serial,
    name: "",
    model: "Pixel 7",
    osVersion: "14",
    platform: "android",
    kind: "device",
    state: "device"
  };
}

function inventory() {
  return { platforms: ["android"], devices: [android()], tools: tools() };
}

function heartbeatInput(overrides = {}) {
  return {
    host: {
      hostname: "web-control",
      username: "qa",
      osPlatform: "darwin",
      osVersion: "14.0",
      arch: "arm64",
      kind: "mac"
    },
    name: "web-control-runner",
    version: "test",
    artifactBaseUrl: null,
    inventory: inventory(),
    active: [],
    ...overrides
  };
}

async function makeStore() {
  const store = new MemoryStore();
  const rootPath = `/tmp/aos-web-control-${Math.random().toString(16).slice(2)}`;
  const project = await store.upsertProject({ rootPath, name: path.basename(rootPath) });
  return { store, rootPath, project };
}

async function makeTask(store, rootPath, project, overrides = {}) {
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: { kind: "web-test" },
    deviceSerial: "pixel-1",
    deviceLeaseId: `${HOST}:pixel-1`,
    ...overrides
  });
  const leased = await store.acquireDeviceLeases({
    hostId: HOST,
    taskId: task.id,
    projectId: project.id,
    serials: ["pixel-1"],
    ttlMs: LEASE_TTL,
    at: iso(NOW)
  });
  assert.equal(leased.ok, true);
  return task;
}

function service(store, instanceId = INSTANCE, now = () => NOW) {
  return new WebRunnerControlService({
    store,
    hostId: HOST,
    instanceId,
    env: {
      AOS_RUNNER_TTL_MS: "90000",
      AOS_DEVICE_LEASE_MS: String(LEASE_TTL),
      AOS_RUNNER_MAX_ATTEMPTS: "3",
      MOBILE_TESTING_RUNNER_STALE_CLAIM_MS: "900000"
    },
    now
  });
}

test("runner control service: heartbeat → claim → begin → terminal 全链路", async () => {
  const { store, rootPath, project } = await makeStore();
  const task = await makeTask(store, rootPath, project);
  const control = service(store);

  const beat = await control.heartbeat(heartbeatInput());
  assert.equal(beat.ok, true);
  assert.equal(beat.queuePaused, false);
  assert.ok(beat.runnerId);

  const claimed = await control.claim("pixel-1");
  assert.equal(claimed.kind, "claimed");
  assert.equal(claimed.task.id, task.id);
  assert.equal(claimed.projectSlug, path.basename(rootPath));
  assert.match(claimed.leaseToken, /^[0-9a-f]{64}$/);

  const began = await control.begin(task.id);
  assert.equal(began.started, true);
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "running");

  const outcome = await control.terminal(task.id, "completed");
  assert.equal(outcome, "written");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.deviceLeaseId, null);

  await control.releaseLease(task.id, "pixel-1", claimed.leaseToken);
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
  await control.stop();
});

test("runner control service: 心跳被另一实例接管 → WebRunnerAlreadyActiveError", async () => {
  const { store } = await makeStore();
  let upserts = 0;
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "upsertWebRunner") {
        return async (input) => {
          upserts += 1;
          if (upserts >= 2) {
            throw new WebRunnerAlreadyActiveError({
              hostId: HOST,
              existingInstanceId: "instance-a",
              incomingInstanceId: String(input.instanceId)
            });
          }
          return target.upsertWebRunner(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const first = service(proxy, "instance-a");
  await first.heartbeat(heartbeatInput());
  const second = service(proxy, "instance-b");
  await assert.rejects(() => second.heartbeat(heartbeatInput()), WebRunnerAlreadyActiveError);
});

test("runner control service: stopping → heartbeat 返回取消 → terminal 确认 cancelled", async () => {
  const { store, rootPath, project } = await makeStore();
  const task = await makeTask(store, rootPath, project);
  const control = service(store);
  await control.heartbeat(heartbeatInput({ active: [{ taskId: task.id, serial: "pixel-1" }] }));
  assert.equal((await control.claim("pixel-1")).kind, "claimed");
  assert.equal((await control.begin(task.id)).started, true);

  await store.cancelRegressionTask({
    rootPath,
    taskId: task.id,
    source: "panel",
    actor: "tester",
    actorHostId: null,
    note: "stop"
  });
  const beat = await control.heartbeat(
    heartbeatInput({ active: [{ taskId: task.id, serial: "pixel-1" }] })
  );
  assert.deepEqual(beat.cancelTaskIds, [task.id]);
  assert.equal(await control.terminal(task.id, "completed"), "cancelled");
  const stored = await store.getRegressionTask(rootPath, task.id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.cancelSource, "panel");
});

test("runner control service: 重试次数耗尽 → exhausted，服务端置 failed 并释放租约", async () => {
  const { store, rootPath, project } = await makeStore();
  const task = await makeTask(store, rootPath, project);
  const control = service(store, INSTANCE, () => NOW + 1_000);
  await control.heartbeat(heartbeatInput());
  const first = await control.claim("pixel-1");
  assert.equal(first.kind, "claimed");
  assert.equal((await control.begin(task.id)).started, true);
  await control.release(task.id, "pending");
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "pending");

  // 第二次领取时 attempts 已由 beginExecution 累加；用 1 次上限使其直接耗尽。
  const strict = new WebRunnerControlService({
    store,
    hostId: HOST,
    instanceId: INSTANCE,
    env: { AOS_RUNNER_MAX_ATTEMPTS: "1", AOS_DEVICE_LEASE_MS: String(LEASE_TTL) },
    now: () => NOW + 2_000
  });
  // 重新预占：release 不释放设备租约，这里仍由第一次租约覆盖。
  const second = await strict.claim("pixel-1");
  assert.equal(second.kind, "exhausted");
  assert.equal(second.cancelled, false);
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "failed");
  assert.equal((await store.listDeviceLeases({ hostId: HOST })).length, 0);
});

test("runner control service: 外部租约占用 → busy=device-busy 并回池", async () => {
  const { store, rootPath, project } = await makeStore();
  const task = await makeTask(store, rootPath, project);
  const control = service(store);
  await control.heartbeat(heartbeatInput());

  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "listDeviceLeases") {
        return async (input) => [
          ...(await target.listDeviceLeases(input)),
          {
            hostId: HOST,
            serial: "pixel-1",
            taskId: "foreign-task",
            projectId: project.id,
            acquiredAt: iso(NOW),
            renewAt: iso(NOW),
            expiresAt: iso(NOW + LEASE_TTL)
          }
        ];
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const proxied = service(proxy);
  const claimed = await proxied.claim("pixel-1");
  assert.equal(claimed.kind, "busy");
  assert.equal(claimed.reason, "device-busy");
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "pending");
});
