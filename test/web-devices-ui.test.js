import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const SEEN = new Date(NOW - 5_000).toISOString();

function tools(overrides = {}) {
  return {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false,
    ...overrides
  };
}

function device(serial, model, osVersion, state = "device") {
  return {
    serial,
    name: model,
    model,
    osVersion,
    platform: "android",
    kind: "device",
    state
  };
}

async function setup(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-web-devices-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  const project = await store.upsertProject({ rootPath, name: "acme" });
  await store.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android"],
    projectId: project.id
  });
  await store.upsertWebRunner({
    hostId: "host-a",
    name: "runner-a",
    hostname: "host-a.local",
    platforms: ["android"],
    devices: [
      device("emulator-5554", "Pixel 7", "14"),
      device("emulator-5556", "Pixel 8", "15")
    ],
    tools: tools({ adb: true, maestro: true }),
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: "inst-a",
    lastSeenAt: SEEN
  });
  await store.upsertWebRunner({
    hostId: "host-b",
    name: "runner-b",
    hostname: "host-b.local",
    platforms: ["android"],
    devices: [device("R58M12345", "Galaxy S23", "15")],
    tools: tools({ adb: true, maestro: true }),
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: "inst-b",
    lastSeenAt: new Date(NOW - 10 * 60_000).toISOString()
  });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: "host-a",
    deviceSerial: "emulator-5556",
    jobSpec: { kind: "web-test", deviceSerial: "emulator-5556", targetHostId: "host-a" }
  });
  await store.updateRegressionTask(rootPath, task.id, { status: "running" });
  await store.acquireDeviceLeases({
    hostId: "host-a",
    taskId: task.id,
    projectId: project.id,
    serials: ["emulator-5556"],
    ttlMs: 120_000,
    at: new Date(NOW).toISOString()
  });
  return { store, rootPath, task, workspace };
}

function depsFor(store, workspace) {
  return { store, env: {}, workspaceRoot: workspace, buildStale: false, now: () => NOW };
}

async function page(store, workspace, query = "") {
  const response = await handlePanelRequest(
    new URL(`http://x/panel?section=devices${query}`),
    depsFor(store, workspace)
  );
  assert.equal(response.status, 200);
  return response.body;
}

test("devices page: lists idle, busy and offline devices", async (t) => {
  const { store, task, workspace } = await setup(t);
  const html = await page(store, workspace);
  assert.match(html, /<h1>设备<\/h1>/);
  assert.match(html, /href="\/panel\?section=devices"/);
  assert.match(html, /emulator-5554/);
  assert.match(html, /emulator-5556/);
  assert.match(html, /R58M12345/);
  assert.match(html, /Pixel 7/);
  assert.match(html, /Galaxy S23/);
  assert.match(html, /空闲/);
  assert.match(html, /占用/);
  assert.match(html, /离线/);
  assert.match(html, new RegExp(task.id));
  assert.doesNotMatch(html, /AOS_RUNNER_JOB_TOKEN=/);
});

test("devices page: idle/platform filters only hide non-matching rows", async (t) => {
  const { store, workspace } = await setup(t);
  const idle = await page(store, workspace, "&state=idle");
  assert.match(idle, /emulator-5554/);
  assert.doesNotMatch(idle, /emulator-5556/);
  assert.doesNotMatch(idle, /R58M12345/);

  const ios = await page(store, workspace, "&platform=ios");
  assert.match(ios, /当前筛选下没有设备/);
});

test("devices page: a pinned pending job without a lease does not mark the device busy", async (t) => {
  const { store, rootPath, workspace } = await setup(t);
  const pending = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: "host-a",
    deviceSerial: "emulator-5554",
    jobSpec: { kind: "web-test", deviceSerial: "emulator-5554", targetHostId: "host-a" }
  });
  const response = await handlePanelRequest(
    new URL("http://x/panel.json?section=devices"),
    depsFor(store, workspace)
  );
  const body = JSON.parse(response.body);
  const idle = body.devices.find((entry) => entry.serial === "emulator-5554");
  assert.equal(idle.state, "idle");
  assert.equal(idle.jobTaskId, pending.id);
  assert.equal(body.counts.idle, 1);
  assert.equal(body.counts.busy, 1);
});

test("devices page: json exposes counts and device state without secrets", async (t) => {
  const { store, workspace } = await setup(t);
  const response = await handlePanelRequest(
    new URL("http://x/panel.json?section=devices"),
    depsFor(store, workspace)
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.view, "devices");
  assert.equal(body.counts.total, 3);
  assert.equal(body.counts.idle, 1);
  assert.equal(body.counts.busy, 1);
  assert.equal(body.counts.offline, 1);
  assert.equal(body.devices.find((entry) => entry.serial === "emulator-5556").jobTaskId.length > 0, true);
  assert.equal(JSON.stringify(body).includes("AOS_RUNNER_JOB_TOKEN"), false);
});
