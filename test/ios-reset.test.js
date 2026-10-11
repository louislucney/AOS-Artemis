import assert from "node:assert/strict";
import test from "node:test";

import { resetIosApp } from "../dist/device/ios-reset.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";

function fakeDevice({ launchFails = false } = {}) {
  const calls = [];
  return {
    calls,
    async terminate(bundleId) {
      calls.push(["terminate", bundleId]);
      return true;
    },
    async launch(bundleId) {
      calls.push(["launch", bundleId]);
      if (launchFails) throw new Error("idb launch 失败：boom");
    }
  };
}

test("resetIosApp: 非法包名与非 macOS/非 UDID 快速失败", async () => {
  const bad = await resetIosApp({ packageName: "not a package", serial: UDID });
  assert.equal(bad.reason, "invalid-package");

  const linux = await resetIosApp(
    { packageName: "com.apple.Preferences", serial: UDID },
    { platform: "linux" }
  );
  assert.equal(linux.reason, "ios-unsupported");

  const androidSerial = await resetIosApp(
    { packageName: "com.apple.Preferences", serial: "emulator-5554" },
    { platform: "darwin" }
  );
  assert.equal(androidSerial.reason, "ios-unsupported");
});

test("resetIosApp: terminate(best-effort)+launch 成功", async () => {
  const device = fakeDevice();
  const outcome = await resetIosApp(
    { packageName: "com.apple.Preferences", serial: UDID },
    { platform: "darwin", device }
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(device.calls, [
    ["terminate", "com.apple.Preferences"],
    ["launch", "com.apple.Preferences"]
  ]);
  assert.equal(outcome.commands.length, 2);
  assert.equal(outcome.adb.path, null);
});

test("resetIosApp: 真机 UDID 接受（best-effort）", async () => {
  const device = fakeDevice();
  const outcome = await resetIosApp(
    { packageName: "com.apple.Preferences", serial: "00008110-001A2C681E22801E" },
    { platform: "darwin", device }
  );
  assert.equal(outcome.ok, true);
});

test("resetIosApp: 真机 UDID 未注入设备 → 明确报错（不再错造模拟器设备）", async () => {
  await assert.rejects(
    () =>
      resetIosApp(
        { packageName: "com.apple.Preferences", serial: "00008110-001A2C681E22801E" },
        { platform: "darwin" }
      ),
    /WDA provider/
  );
});

test("resetIosApp: launch 失败 → launch-failed", async () => {
  const outcome = await resetIosApp(
    { packageName: "com.apple.Preferences", serial: UDID },
    { platform: "darwin", device: fakeDevice({ launchFails: true }) }
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "launch-failed");
  assert.match(outcome.message, /boom/);
});
