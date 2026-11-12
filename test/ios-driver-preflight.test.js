import assert from "node:assert/strict";
import test from "node:test";

import { iosDriverPreflight } from "../dist/ios/appium/preflight.js";

const DEVICE = "00008110-001A2C681E22801E";
const SIMULATOR = "CC8A4E1E-F87F-4EED-ADFB-A218C4294C2A";

function detection({ found = true, installed = false } = {}) {
  return {
    appium: { found, path: found ? "appium" : null, version: found ? "2.11.0" : null },
    xcuitest: { installed, version: installed ? "7.26.0" : null },
    guidance: []
  };
}

test("iOS 预检：无真机（仅模拟器/空）不阻断", () => {
  assert.equal(iosDriverPreflight({ devices: [], detection: detection() }).ok, true);
  assert.equal(iosDriverPreflight({ devices: [SIMULATOR], detection: detection() }).ok, true);
});

test("iOS 预检：Appium 已装但缺 XCUITest 驱动 → 阻断并给安装命令", () => {
  const result = iosDriverPreflight({ devices: [DEVICE], detection: detection() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "appium-driver-missing");
  assert.match(result.message, /appium driver install xcuitest/);
  assert.ok(result.message.includes(DEVICE));
});

test("iOS 预检：驱动已安装不阻断", () => {
  const result = iosDriverPreflight({
    devices: [DEVICE],
    detection: detection({ installed: true })
  });
  assert.equal(result.ok, true);
});

test("iOS 预检：直连 AOS_APPIUM_URL 时本地 CLI 探测不阻断", () => {
  const result = iosDriverPreflight({
    devices: [DEVICE],
    detection: detection(),
    appiumUrl: "http://10.0.0.9:4723"
  });
  assert.equal(result.ok, true);
});

test("iOS 预检：探测不到 Appium 时不在预检阻断（交给托管启动报错）", () => {
  const result = iosDriverPreflight({
    devices: [DEVICE],
    detection: detection({ found: false })
  });
  assert.equal(result.ok, true);
  assert.equal(iosDriverPreflight({ devices: [DEVICE], detection: null }).ok, true);
});
