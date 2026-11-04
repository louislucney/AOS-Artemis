import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayInstaller } from "../dist/web/llm/gateway-install.js";

const SHA = "a".repeat(64);

function request(overrides = {}) {
  return {
    hostId: "host-a",
    deviceSerial: "pixel-1",
    platform: "android",
    assetId: "asset-1",
    sha256: SHA,
    filename: "app.apk",
    downloadUrl: "http://center/assets/1",
    ...overrides
  };
}

test("gateway installer: 首次安装，第二次按 host/device/sha 命中缓存", async () => {
  let calls = 0;
  const installer = createGatewayInstaller({
    async install() {
      calls += 1;
      return { packageName: "com.example", version: "1.0" };
    }
  });
  const first = await installer.install(request());
  const second = await installer.install(request());
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  await installer.install(request({ deviceSerial: "pixel-2" }));
  assert.equal(calls, 2, "不同设备不共享缓存");
});

test("gateway installer: 非法 sha/资产直接拒绝", async () => {
  const installer = createGatewayInstaller({
    async install() {
      throw new Error("must not call backend");
    }
  });
  assert.equal((await installer.install(request({ sha256: "bad" }))).reason, "invalid-sha256");
  assert.equal((await installer.install(request({ filename: "" }))).reason, "invalid-asset");
});
