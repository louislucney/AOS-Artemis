import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { executeCase } from "../dist/figma/case-runner.js";
import { makeTempDir } from "./helpers.js";

const SIM = "11111111-1111-1111-1111-111111111111";

function node(id, label, value, x, y) {
  return { id, label, value, type: "Button", rect: { x, y, width: 120, height: 44 } };
}

function fakeDevice(initial, onTap = () => initial) {
  let nodes = initial;
  const calls = [];
  return {
    calls,
    serial: SIM,
    platform: "ios",
    capabilities: { back: "none" },
    async size() {
      return { width: 402, height: 874 };
    },
    async nodes() {
      return nodes;
    },
    async tap(x, y) {
      calls.push({ action: "tap", x, y });
      nodes = onTap(x, y, nodes);
    },
    async inputText(text) {
      calls.push({ action: "type", text });
    },
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
}

function nativeCase(overrides = {}) {
  return {
    id: "TC_NATIVE",
    name: "iOS native case",
    semanticId: "sem-native",
    displayId: "TC_NATIVE",
    preconditions: [],
    taskDesc: "不应提交给 mobile_run_task",
    screens: ["登录", "首页"],
    feature: null,
    exploreSteps: [],
    hintScreens: [],
    scriptProvenance: { asserts: 1, explores: 0 },
    engine: "native",
    engineReason: null,
    actions: [
      {
        stepIndex: 0,
        action: "tap",
        target: { kind: "resource-id", value: "login_button" },
        expect: { screen: "首页", hints: ["首页"] }
      }
    ],
    ...overrides
  };
}

function runtimeStub(device) {
  const root = makeTempDir("aos-ios-native-case-");
  const calls = [];
  const submissions = [];
  const results = [];
  return {
    root,
    calls,
    submissions,
    results,
    runtime: {
      configDirAbs: root,
      project: { rootDir: root, dotenvValues: {} },
      store: {},
      proxy: {
        isRunning: () => false,
        callTool: async (name) => {
          calls.push(name);
          throw new Error(`不应调用 proxy: ${name}`);
        }
      },
      traceDir: (traceId) => path.join(root, ".artemis", "traces", traceId),
      iosDevice: async () => device,
      recordTaskSubmission: async (entry) => submissions.push(entry),
      recordTaskResult: async (entry) => results.push(entry),
      syncTaskStatuses: async () => {},
      flushCrashScans: async () => {}
    }
  };
}

function contextStub(runtime, overrides = {}) {
  let tick = 1_000;
  return {
    runtime,
    model: null,
    deviceSerial: SIM,
    lockedAppPackage: null,
    appPath: null,
    regressionTaskId: null,
    quarantined: false,
    failOnApiErrors: false,
    apiCatalog: null,
    resetFn: async () => ({
      ok: true,
      serial: SIM,
      adb: { path: null, source: "missing" },
      commands: []
    }),
    iosDeviceWda: null,
    sleep: async () => {},
    now: () => (tick += 100),
    pollIntervalMs: 1,
    pollTimeoutMs: 2_000,
    collectLogcat: async () => ({ status: "unsupported", reason: "test" }),
    collectIosLogs: async () => ({ status: "unsupported", reason: "test" }),
    ...overrides
  };
}

test("case-runner: iOS engine=native 直接走 structured runner，不提交 mobile_run_task", async () => {
  const login = [node("login_button", "登录", "", 20, 200)];
  const home = [node("home_title", "首页", "首页", 20, 40)];
  const device = fakeDevice(login, () => home);
  const { runtime, calls, submissions, results, root } = runtimeStub(device);
  try {
    const outcome = await executeCase(nativeCase(), contextStub(runtime));
    assert.equal(outcome.submitted, true);
    assert.equal(outcome.result.status, "passed");
    assert.equal(outcome.result.engine, "native-ios");
    assert.equal(outcome.result.failure, null);
    assert.ok(outcome.result.traceId);
    assert.deepEqual(calls, [], "不得调用 Artemis proxy");
    assert.equal(submissions.length, 1);
    assert.equal(results.length, 1);
    assert.equal(device.calls[0].action, "tap");
    const traceDir = runtime.traceDir(outcome.result.traceId);
    const status = JSON.parse(fs.readFileSync(path.join(traceDir, "status.json"), "utf8"));
    assert.equal(status.status, "completed");
    assert.equal(status.message, "engine=native-ios");
    const native = JSON.parse(fs.readFileSync(path.join(traceDir, "native-ios.json"), "utf8"));
    assert.equal(native.engine, "native-ios");
    assert.equal(native.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("case-runner: iOS native 断言失败不回退 Artemis", async () => {
  const device = fakeDevice([node("login_button", "登录", "", 20, 200)], () => [
    node("home_title", "错误页", "", 20, 40)
  ]);
  const { runtime, calls, root } = runtimeStub(device);
  try {
    const outcome = await executeCase(nativeCase(), contextStub(runtime));
    assert.equal(outcome.submitted, true);
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.failure.domain, "behavior-or-design");
    assert.deepEqual(calls, [], "失败也不得重跑 Artemis");
    const statusPath = path.join(runtime.traceDir(outcome.result.traceId), "status.json");
    assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf8")).status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("case-runner: iOS native 设备错误归 environment", async () => {
  const device = fakeDevice([]);
  device.nodes = async () => {
    throw new Error("idb connection failed");
  };
  const { runtime, root } = runtimeStub(device);
  try {
    const outcome = await executeCase(nativeCase(), contextStub(runtime));
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.failure.domain, "environment");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
