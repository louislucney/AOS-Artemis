import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runRunnerAgent } from "../dist/runner/agent.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };

function inventory() {
  return {
    platforms: ["android", "ios"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" },
      {
        serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
        name: "iPhone 15",
        platform: "ios",
        kind: "simulator",
        state: "Booted"
      }
    ],
    tools: TOOLS
  };
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
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
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

test("runner 心跳写入 hosts.runnerSeenAt、hostId/instanceId、地址", async () => {
  const { runtime, store } = await fixture();
  await runRunnerAgent(baseOptions(runtime));
  const host = await store.getHost("h1");
  assert.equal(host.runnerSeenAt !== null, true);
  assert.equal(host.hostname, "mac-a");
  assert.equal(host.ipPrimary, "10.0.0.5");
  assert.deepEqual(host.capabilities, ["android", "ios-simulator"]);
  const runners = await store.listRunners(runtime.project.rootDir);
  assert.equal(runners[0].hostId, "h1");
  assert.equal(typeof runners[0].instanceId, "string");
  assert.equal((await store.listHostAddresses("h1")).length, 2);
});

test("启动快照在心跳窗口内复用（once 不重复采集）", async () => {
  const { runtime } = await fixture();
  let calls = 0;
  await runRunnerAgent(
    baseOptions(runtime, {
      collectHostSnapshot: async () => {
        calls += 1;
        return snapshot();
      }
    })
  );
  assert.equal(calls, 1);
});
