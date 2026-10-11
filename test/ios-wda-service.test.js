import assert from "node:assert/strict";
import test from "node:test";

import { captureLiveScreenshot } from "../dist/diff/device-source.js";
import { IosDeviceBusyError } from "../dist/ios/appium/session.js";
import { IosWdaService } from "../dist/ios/appium/service.js";

const SOURCE_XML =
  '<AppiumAUT><XCUIElementTypeApplication label="App" x="0" y="0" width="390" height="844">' +
  '<XCUIElementTypeButton name="ok" label="OK" x="10" y="20" width="100" height="44"/></XCUIElementTypeApplication></AppiumAUT>';

function fakeFetch() {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
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

  const nodes = await service.nodes("00008101-000359440C69001E");
  assert.equal(nodes.ok, true);
  assert.equal(nodes.value.length, 2);
  assert.equal(nodes.value[1].label, "OK");

  const installed = await service.installIpa("00008101-000359440C69001E", "/tmp/app.ipa");
  assert.equal(installed.ok, true);
  const execCall = fetchImpl.calls.find((call) => call.url.endsWith("/execute/sync"));
  assert.ok(execCall);
  assert.equal(JSON.parse(execCall.init.body).script, "mobile: installApp");

  assert.equal(fetchImpl.calls.filter((call) => call.method === "POST").length, 2);

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
      captureWdaPng: async () => ({
        ok: false,
        error: "device busy",
        busy: true,
        cachedFrame: { png: Buffer.from("cached"), capturedAt: "2026-10-11T00:00:00.000Z" }
      })
    }),
    /device_busy[\s\S]*缓存帧/
  );

  await assert.rejects(
    captureLiveScreenshot(runtime, "00008101-000359440C69001E", {
      platform: "ios",
      captureWdaPng: async () => ({ ok: false, error: "wda down" })
    }),
    /Appium\/WDA 可用/
  );
});

test("ios wda service: 观测 busy 转为结构化变体（携带缓存帧）", async () => {
  const service = new IosWdaService({
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" },
    fetchImpl: fakeFetch()
  });
  const frame = { png: Buffer.from("cached"), capturedAt: "2026-10-11T00:00:00.000Z" };
  service.device = async () => {
    throw new IosDeviceBusyError(frame);
  };
  const shot = await service.screenshot("U-1");
  assert.equal(shot.ok, false);
  assert.equal(shot.busy, true);
  assert.deepEqual(shot.cachedFrame, frame);
  const nodes = await service.nodes("U-1");
  assert.equal(nodes.ok, false);
  assert.equal(nodes.busy, true);
  assert.deepEqual(nodes.cachedFrame, frame);
  await service.dispose();
});

test("ios wda service: nodes 解析失败按 AOS_IOS_OBSERVE_RETRY 重试", async () => {
  let sourceCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const json = (payload) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    if (url.endsWith("/status")) return json({ value: { ready: true } });
    if (url.endsWith("/session") && method === "POST") {
      return json({ value: { sessionId: "s-1", capabilities: {} } });
    }
    if (url.endsWith("/source")) {
      sourceCalls += 1;
      return json({ value: sourceCalls === 1 ? "<not-xml" : SOURCE_XML });
    }
    return json({ value: null });
  };
  const service = new IosWdaService({
    env: {
      AOS_APPIUM_URL: "http://127.0.0.1:4723",
      AOS_IOS_XCODE_ORG_ID: "TEAM123",
      AOS_IOS_SESSION_IDLE_MS: "0",
      AOS_IOS_OBSERVE_RETRY: "1"
    },
    fetchImpl,
    sleep: async () => {}
  });
  const nodes = await service.nodes("00008101-000359440C69001E");
  assert.equal(nodes.ok, true);
  assert.equal(nodes.value.length, 2);
  assert.equal(sourceCalls, 2);
  await service.dispose();
});
