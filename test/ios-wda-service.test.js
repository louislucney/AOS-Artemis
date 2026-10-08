import assert from "node:assert/strict";
import test from "node:test";

import { captureLiveScreenshot } from "../dist/diff/device-source.js";
import { IosWdaService } from "../dist/ios/appium/service.js";

const SOURCE_XML =
  '<AppiumAUT><XCUIElementTypeApplication label="App" x="0" y="0" width="390" height="844">' +
  '<XCUIElementTypeButton name="ok" label="OK" x="10" y="20" width="100" height="44"/></XCUIElementTypeApplication></AppiumAUT>';

function fakeFetch() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url });
    const json = (payload) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    if (url.endsWith("/status")) return json({ value: { ready: true } });
    if (url.endsWith("/session") && method === "POST") {
      return json({ value: { sessionId: "s-1", capabilities: {} } });
    }
    if (url.endsWith("/screenshot")) return json({ value: Buffer.from("png").toString("base64") });
    if (url.endsWith("/source")) return json({ value: SOURCE_XML });
    return json({ value: null });
  };
  impl.calls = calls;
  return impl;
}

test("ios wda service: 直连模式截图/层级/回收", async () => {
  const fetchImpl = fakeFetch();
  const service = new IosWdaService({
    env: {
      AOS_APPIUM_URL: "http://127.0.0.1:4723",
      AOS_IOS_XCODE_ORG_ID: "TEAM123",
      AOS_IOS_SESSION_IDLE_MS: "0"
    },
    fetchImpl
  });

  const shot = await service.screenshot("00008101-000359440C69001E");
  assert.equal(shot.ok, true);
  assert.deepEqual(shot.value, Buffer.from("png"));
  assert.ok(service.cachedFrame("00008101-000359440C69001E"));

  const nodes = await service.nodes("00008101-000359440C69001E");
  assert.equal(nodes.ok, true);
  assert.equal(nodes.value.length, 2);
  assert.equal(nodes.value[1].label, "OK");

  assert.equal(fetchImpl.calls.filter((call) => call.method === "POST").length, 1);

  await service.dispose();
  assert.ok(fetchImpl.calls.some((call) => call.method === "DELETE"));
});

test("ios wda service: 会话创建失败返回结构化错误", async () => {
  const service = new IosWdaService({
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" },
    fetchImpl: async (url) => {
      if (url.endsWith("/status")) {
        return new Response(JSON.stringify({ value: { ready: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: { error: "session not created", message: "boom" } }), {
        status: 500
      });
    }
  });
  const shot = await service.screenshot("U-1");
  assert.equal(shot.ok, false);
  assert.match(shot.error, /boom/);
});

test("device-source: 真机走 WDA 分支与失败指引", async () => {
  const runtime = {};
  const captured = await captureLiveScreenshot(runtime, "00008101-000359440C69001E", {
    platform: "ios",
    captureWdaPng: async () => ({ ok: true, value: Buffer.from("wda-png") })
  });
  assert.deepEqual(captured.bytes, Buffer.from("wda-png"));
  assert.match(captured.note, /真机 WDA/);

  await assert.rejects(
    captureLiveScreenshot(runtime, "00008101-000359440C69001E", {
      platform: "ios",
      captureWdaPng: async () => ({ ok: false, error: "device busy" })
    }),
    /busy|占用/
  );
});
