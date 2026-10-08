import assert from "node:assert/strict";
import test from "node:test";

import { IosHierarchyParseError, makeWdaDevice } from "../dist/ios/appium/facade.js";
import { AppiumSessionManager } from "../dist/ios/appium/session.js";

const VALID_SOURCE =
  '<AppiumAUT><XCUIElementTypeApplication label="App" x="0" y="0" width="390" height="844">' +
  '<XCUIElementTypeButton name="ok" label="好" x="10" y="20" width="100" height="44"/></XCUIElementTypeApplication></AppiumAUT>';

class FakeWdaClient {
  constructor() {
    this.calls = [];
    this.keyboard = true;
    this.sourceXml = VALID_SOURCE;
    this.screenshotBytes = Buffer.from("png-bytes");
    this.terminateResult = true;
    this.sessions = 0;
  }

  async createSession() {
    this.sessions += 1;
    return { sessionId: "s-1", capabilities: {} };
  }

  async deleteSession() {}

  async actions(sessionId, actions) {
    this.calls.push({ op: "actions", actions });
  }

  async isKeyboardShown() {
    return this.keyboard;
  }

  async typeText(sessionId, text) {
    this.calls.push({ op: "typeText", text });
  }

  async source() {
    return this.sourceXml;
  }

  async screenshot() {
    return this.screenshotBytes;
  }

  async activateApp(sessionId, bundleId) {
    this.calls.push({ op: "activate", bundleId });
  }

  async terminateApp(sessionId, bundleId) {
    this.calls.push({ op: "terminate", bundleId });
    return this.terminateResult;
  }

  async execute(sessionId, script, args) {
    this.calls.push({ op: "execute", script, args });
    return true;
  }
}

function makeFacade(overrides = {}) {
  const client = new FakeWdaClient();
  const manager = new AppiumSessionManager({
    client,
    capabilitiesFor: (udid) => ({ "appium:udid": udid }),
    idleMs: 0,
    observeWaitMs: 50
  });
  const device = makeWdaDevice({
    udid: "U-1",
    manager,
    client,
    leaseMode: "observe",
    keyboardTimeoutMs: 1000,
    keyboardPollMs: 100,
    sleep: async () => {},
    ...overrides
  });
  return { client, manager, device };
}

test("appium facade: tap/swipe 走 W3C actions", async () => {
  const { client, device } = makeFacade();
  await device.tap(10.4, 20.6);
  const tap = client.calls[0];
  assert.equal(tap.op, "actions");
  assert.deepEqual(tap.actions[0].actions[0], { type: "pointerMove", duration: 0, x: 10, y: 21 });
  assert.equal(tap.actions[0].actions[1].type, "pointerDown");

  await device.swipe(1, 2, 3, 4, 500);
  const swipe = client.calls[1].actions[0].actions;
  assert.equal(swipe[3].type, "pointerMove");
  assert.equal(swipe[3].duration, 500);
});

test("appium facade: inputText 先聚焦再等键盘后输入", async () => {
  const { client, device } = makeFacade();
  const result = await device.inputText("你好", { x: 30, y: 40 });
  assert.equal(result.mode, "type");
  assert.equal(client.calls[0].op, "actions", "应先点击输入框聚焦");
  assert.deepEqual(client.calls[1], { op: "typeText", text: "你好" });
});

test("appium facade: 键盘不可见且无坐标 → 可行动错误", async () => {
  const client = new FakeWdaClient();
  client.keyboard = false;
  const manager = new AppiumSessionManager({
    client,
    capabilitiesFor: () => ({}),
    idleMs: 0
  });
  const noKeyboard = makeWdaDevice({
    udid: "U-9",
    manager,
    client,
    keyboardTimeoutMs: 200,
    keyboardPollMs: 100,
    sleep: async () => {}
  });
  await assert.rejects(noKeyboard.inputText("abc"), /键盘未出现/);
});

test("appium facade: nodes/size/screenshot", async () => {
  const { client, manager, device } = makeFacade();
  const nodes = await device.nodes();
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].label, "好");
  const size = await device.size();
  assert.deepEqual(size, { width: 390, height: 844 });

  const png = await device.screenshot();
  assert.deepEqual(png, Buffer.from("png-bytes"));
  const frame = manager.cachedFrame("U-1");
  assert.ok(frame);
  assert.deepEqual(frame.png, Buffer.from("png-bytes"));
  assert.ok(!Number.isNaN(Date.parse(frame.capturedAt)));
  assert.equal(client.sessions, 1);
});

test("appium facade: 层级解析失败抛 IosHierarchyParseError", async () => {
  const { client, device } = makeFacade();
  client.sourceXml = "<a><b></a>";
  await assert.rejects(device.nodes(), (error) => {
    assert.ok(error instanceof IosHierarchyParseError);
    return true;
  });
});

test("appium facade: launch/terminate/openUrl 语义", async () => {
  const { client, device } = makeFacade();
  await device.launch("com.apple.Preferences");
  assert.deepEqual(client.calls[0], { op: "activate", bundleId: "com.apple.Preferences" });
  const terminated = await device.terminate("com.apple.Preferences");
  assert.equal(terminated, true);
  assert.deepEqual(client.calls[1], { op: "terminate", bundleId: "com.apple.Preferences" });
  await device.openUrl("https://example.com");
  assert.equal(client.calls[2].script, "mobile: deepLink");
  assert.deepEqual(client.calls[2].args, [{ url: "https://example.com" }]);
});
