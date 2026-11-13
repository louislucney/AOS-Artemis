import assert from "node:assert/strict";
import test from "node:test";

import { buildIosCapabilities } from "../dist/ios/appium/capabilities.js";
import { AppiumServerManager } from "../dist/ios/appium/server.js";

class FakeChild {
  constructor(exitCode = null) {
    this.exitCode = exitCode;
    this.killed = false;
    this.stdout = null;
    this.stderr = null;
  }

  kill() {
    this.killed = true;
    this.exitCode = 0;
  }
}

function okStatus() {
  return new Response(JSON.stringify({ value: { ready: true } }), { status: 200 });
}

test("ios capabilities: 默认值与 env 覆盖", () => {
  const defaults = buildIosCapabilities({ udid: "U-1", env: {} });
  assert.equal(defaults.platformName, "iOS");
  assert.equal(defaults["appium:automationName"], "XCUITest");
  assert.equal(defaults["appium:udid"], "U-1");
  assert.equal(defaults["appium:useNewWDA"], false);
  assert.equal(defaults["appium:allowProvisioningDeviceRegistration"], true);
  assert.equal(defaults["appium:updatedWDABundleId"], "com.aos.mcp.wda");
  assert.equal(defaults["appium:xcodeSigningId"], "Apple Development");
  assert.equal("appium:xcodeOrgId" in defaults, false);

  const custom = buildIosCapabilities({
    udid: "U-2",
    env: {
      AOS_IOS_WDA_BUNDLE_ID: "com.example.wda",
      AOS_IOS_XCODE_SIGNING_ID: "iPhone Developer",
      AOS_IOS_XCODE_ORG_ID: "TEAM123"
    }
  });
  assert.equal(custom["appium:updatedWDABundleId"], "com.example.wda");
  assert.equal(custom["appium:xcodeSigningId"], "iPhone Developer");
  assert.equal(custom["appium:xcodeOrgId"], "TEAM123");
});

test("appium server: AOS_APPIUM_URL 直连", async () => {
  const manager = new AppiumServerManager({
    env: { AOS_APPIUM_URL: "http://127.0.0.1:9999/" },
    fetchImpl: async () => okStatus()
  });
  const handle = await manager.ensureReady();
  assert.deepEqual(handle, { baseUrl: "http://127.0.0.1:9999", managed: false });
  assert.equal(manager.current().state, "direct");

  const failing = new AppiumServerManager({
    env: { AOS_APPIUM_URL: "http://127.0.0.1:9999" },
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  await assert.rejects(failing.ensureReady(), /ECONNREFUSED/);
});

test("appium server: 托管启动轮询就绪并回收", async () => {
  let calls = 0;
  const children = [];
  const manager = new AppiumServerManager({
    env: { AOS_IOS_APPIUM_PORT: "4799" },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED");
      return okStatus();
    },
    spawnImpl: (command, args) => {
      const child = new FakeChild();
      children.push({ command, args, child });
      return child;
    },
    sleep: async () => {}
  });
  const handle = await manager.ensureReady();
  assert.equal(handle.baseUrl, "http://127.0.0.1:4799");
  assert.equal(handle.managed, true);
  assert.equal(children[0].command, "appium");
  assert.deepEqual(children[0].args, ["--port", "4799"]);
  assert.equal(manager.current().state, "running");

  await manager.dispose();
  assert.equal(children[0].child.killed, true);
  assert.equal(manager.current().state, "stopped");
});

test("appium server: 显式 AOS_APPIUM_REUSE_EXISTING=1 才复用外部实例", async () => {
  let spawned = 0;
  const manager = new AppiumServerManager({
    env: { AOS_IOS_APPIUM_PORT: "4799", AOS_APPIUM_REUSE_EXISTING: "1" },
    fetchImpl: async () => okStatus(),
    spawnImpl: () => {
      spawned += 1;
      return new FakeChild();
    },
    sleep: async () => {}
  });
  const handle = await manager.ensureReady();
  assert.deepEqual(handle, { baseUrl: "http://127.0.0.1:4799", managed: false });
  assert.equal(spawned, 0);
});

test("appium server: 端口被外部实例占用时改用托管实例（不静默复用旧服务）", async () => {
  const ready = new Set([4799]);
  const spawned = [];
  const manager = new AppiumServerManager({
    env: { AOS_IOS_APPIUM_PORT: "4799" },
    fetchImpl: async (url) => {
      const port = Number(/127\.0\.0\.1:(\d+)/.exec(url)?.[1] ?? 0);
      if (ready.has(port)) return okStatus();
      throw new Error("ECONNREFUSED");
    },
    spawnImpl: (command, args) => {
      const port = Number(args[args.indexOf("--port") + 1]);
      spawned.push(port);
      ready.add(port);
      return new FakeChild();
    },
    sleep: async () => {}
  });
  const handle = await manager.ensureReady();
  assert.deepEqual(handle, { baseUrl: "http://127.0.0.1:4800", managed: true });
  assert.deepEqual(spawned, [4800], "跳过被占用的 4799，在 4800 启动托管实例");
});

test("appium server: 启动失败与非法端口", async () => {
  const crashed = new AppiumServerManager({
    env: {},
    spawnImpl: () => new FakeChild(1),
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    sleep: async () => {}
  });
  await assert.rejects(crashed.ensureReady(), /启动失败/);

  const invalid = new AppiumServerManager({
    env: { AOS_IOS_APPIUM_PORT: "abc" },
    spawnImpl: () => new FakeChild(),
    fetchImpl: async () => okStatus()
  });
  await assert.rejects(invalid.ensureReady(), /非法/);
});
