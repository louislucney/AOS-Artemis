import assert from "node:assert/strict";
import test from "node:test";

import { AppiumClient, AppiumError } from "../dist/ios/appium/client.js";

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function clientWith(fetchImpl, overrides = {}) {
  return new AppiumClient({
    baseUrl: "http://127.0.0.1:4723/",
    fetchImpl,
    timeoutMs: 1000,
    ...overrides
  });
}

test("appium client: status 与 createSession/deleteSession", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    if (url.endsWith("/status")) return jsonResponse({ value: { ready: true } });
    if (url.endsWith("/session")) {
      return jsonResponse({ value: { sessionId: "s-1", capabilities: { platformName: "iOS" } } });
    }
    return jsonResponse({ value: null });
  });
  const client = clientWith(fetchImpl);
  const status = await client.status();
  assert.equal(status.ready, true);

  const session = await client.createSession({ platformName: "iOS", "appium:udid": "U-1" });
  assert.equal(session.sessionId, "s-1");
  assert.equal(session.capabilities.platformName, "iOS");
  const createCall = fetchImpl.calls[1];
  assert.equal(createCall.url, "http://127.0.0.1:4723/session");
  assert.equal(createCall.init.method, "POST");
  assert.deepEqual(JSON.parse(createCall.init.body), {
    capabilities: { alwaysMatch: { platformName: "iOS", "appium:udid": "U-1" } }
  });

  await client.deleteSession("s-1");
  const deleteCall = fetchImpl.calls[2];
  assert.equal(deleteCall.url, "http://127.0.0.1:4723/session/s-1");
  assert.equal(deleteCall.init.method, "DELETE");
});

test("appium client: createSession 缺 sessionId 报错", async () => {
  const fetchImpl = fakeFetch(async () => jsonResponse({ value: {} }));
  const client = clientWith(fetchImpl);
  await assert.rejects(client.createSession({}), (error) => {
    assert.ok(error instanceof AppiumError);
    assert.match(error.message, /sessionId/);
    return true;
  });
});

test("appium client: screenshot 解码与 source 透传", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    if (url.endsWith("/screenshot")) return jsonResponse({ value: Buffer.from("png").toString("base64") });
    return jsonResponse({ value: "<AppiumAUT/>" });
  });
  const client = clientWith(fetchImpl);
  const png = await client.screenshot("s-1");
  assert.deepEqual(png, Buffer.from("png"));
  const source = await client.source("s-1");
  assert.equal(source, "<AppiumAUT/>");
  assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:4723/session/s-1/source");
});

test("appium client: W3C actions / typeText / 键盘状态 / 应用生命周期 payload", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    if (url.endsWith("/is_keyboard_shown")) return jsonResponse({ value: true });
    return jsonResponse({ value: null });
  });
  const client = clientWith(fetchImpl);

  const actions = [
    {
      type: "pointer",
      id: "finger1",
      parameters: { pointerType: "touch" },
      actions: [
        { type: "pointerMove", duration: 0, x: 10, y: 20 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 }
      ]
    }
  ];
  await client.actions("s-1", actions);
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:4723/session/s-1/actions");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { actions });

  await client.typeText("s-1", "你好");
  assert.equal(fetchImpl.calls[1].url, "http://127.0.0.1:4723/session/s-1/keys");
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body), { value: ["你", "好"] });

  assert.equal(await client.isKeyboardShown("s-1"), true);
  assert.equal(
    fetchImpl.calls[2].url,
    "http://127.0.0.1:4723/session/s-1/appium/device/is_keyboard_shown"
  );

  await client.terminateApp("s-1", "com.apple.Preferences");
  assert.deepEqual(JSON.parse(fetchImpl.calls[3].init.body), {
    script: "mobile: terminateApp",
    args: [{ bundleId: "com.apple.Preferences" }]
  });
  await client.activateApp("s-1", "com.apple.Preferences");
  assert.equal(JSON.parse(fetchImpl.calls[4].init.body).script, "mobile: activateApp");
  await client.installApp("s-1", "/tmp/app.ipa");
  assert.deepEqual(JSON.parse(fetchImpl.calls[5].init.body), {
    script: "mobile: installApp",
    args: [{ app: "/tmp/app.ipa" }]
  });
});

test("appium client: WebDriver 错误映射", async () => {
  const fetchImpl = fakeFetch(async () =>
    jsonResponse(
      { value: { error: "invalid session id", message: "A session is either terminated or not started" } },
      404
    )
  );
  const client = clientWith(fetchImpl);
  await assert.rejects(client.screenshot("gone"), (error) => {
    assert.ok(error instanceof AppiumError);
    assert.equal(error.status, 404);
    assert.equal(error.wdError, "invalid session id");
    assert.match(error.message, /terminated/);
    return true;
  });
});

test("appium client: 网络错误与超时映射为 AppiumError", async () => {
  const failing = clientWith(async () => {
    throw new Error("connect ECONNREFUSED");
  });
  await assert.rejects(failing.status(), (error) => {
    assert.ok(error instanceof AppiumError);
    assert.equal(error.status, null);
    assert.match(error.message, /ECONNREFUSED/);
    return true;
  });

  const hanging = clientWith(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        const hold = setTimeout(() => {}, 500);
        init.signal.addEventListener("abort", () => {
          clearTimeout(hold);
          reject(new Error("aborted"));
        });
      }),
    { timeoutMs: 20 }
  );
  await assert.rejects(hanging.status(), (error) => {
    assert.ok(error instanceof AppiumError);
    assert.equal(error.status, null);
    return true;
  });
});
