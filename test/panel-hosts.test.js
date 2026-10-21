import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { buildPanelOverview } from "../dist/panel/overview.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { makeTempDir } from "./helpers.js";

const T0 = Date.now() + 3_600_000;

async function makeHostsHarness() {
  const store = new MemoryStore();
  const workspace = makeTempDir("aos-panel-hosts-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  await store.upsertProject({ rootPath: projectDir, name: "demo" });

  await store.upsertHost({
    id: "h1",
    hostname: "MacBook-A",
    username: "louis",
    osPlatform: "darwin",
    osVersion: "14.6.1",
    arch: "arm64",
    kind: "mac",
    capabilities: ["ios-simulator", "android"],
    env: { tools: { adb: { present: true, version: "1.0.41" } } },
    ipPrimary: "10.0.0.5",
    clientSeenAt: new Date(T0 - 60_000).toISOString(),
    firstSeenAt: new Date(T0 - 86_400_000).toISOString()
  });
  await store.updateHostRegistration({
    id: "h1",
    label: "Mac 主机",
    expectedOs: "linux",
    expectedHostname: "MacBook-A",
    registeredBy: "ops"
  });
  await store.touchHostSession({
    id: "s1",
    hostId: "h1",
    projectId: null,
    rootPath: projectDir,
    username: "louis",
    client: "cursor",
    clientVersion: "1.0",
    pid: 42,
    at: new Date(T0 - 60_000).toISOString()
  });
  await store.upsertRunner({
    rootPath: projectDir,
    name: "runner-1",
    hostname: "MacBook-A",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    hostId: "h1",
    instanceId: "i1"
  });

  const deps = { store, workspaceRoot: workspace, now: () => T0 };
  return { store, projectDir, deps };
}

test("面板总览渲染主机名/Mac/双在线/IP/漂移", async () => {
  const { deps } = await makeHostsHarness();

  const overview = await buildPanelOverview(deps);
  assert.equal(overview.machines.length, 1);
  const machine = overview.machines[0];
  assert.equal(machine.hostname, "MacBook-A");
  assert.equal(machine.kind, "mac");
  assert.equal(machine.clientOnline, true);
  assert.equal(machine.clientSessions, 1);
  assert.equal(machine.runnerOnline, false);
  assert.equal(machine.ipPrimary, "10.0.0.5");
  assert.equal(machine.registered, true);
  assert.ok(machine.drift.some((line) => line.includes("OS 与登记不符")));

  const res = await handlePanelRequest(new URL("http://127.0.0.1/panel"), deps);
  const html = String(res.body);
  assert.match(html, /MacBook-A/);
  assert.match(html, /Mac/);
  assert.match(html, /IDE 在线/);
  assert.match(html, /执行机离线/);
  assert.match(html, /10\.0\.0\.5/);
  assert.match(html, /OS 与登记不符/);
});

test("无主机台账时总览显示单机模式", async () => {
  const store = new MemoryStore();
  const workspace = makeTempDir("aos-panel-hosts-empty-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  await store.upsertProject({ rootPath: projectDir, name: "demo" });
  const deps = { store, workspaceRoot: workspace };

  const overview = await buildPanelOverview(deps);
  assert.deepEqual(overview.machines, []);
  const res = await handlePanelRequest(new URL("http://127.0.0.1/panel"), deps);
  assert.match(String(res.body), /单机模式（无中心台账）/);
});
