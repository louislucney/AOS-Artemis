import assert from "node:assert/strict";
import test from "node:test";

import { resolveIosDevice } from "../dist/device/ios-facade.js";

const SIM_UDID = "65584900-E161-4125-8928-587499DD6457";
const DEVICE_UDID = "00008110-001A2C681E22801E";

test("resolveIosDevice: 非 iOS serial → null（不触任何 provider）", async () => {
  let wdaCalls = 0;
  const results = await Promise.all([
    resolveIosDevice("emulator-5554", {
      wdaDevice: async () => {
        wdaCalls += 1;
        throw new Error("不应调用");
      }
    }),
    resolveIosDevice(""),
    resolveIosDevice("not-a-serial")
  ]);
  assert.deepEqual(results, [null, null, null]);
  assert.equal(wdaCalls, 0);
});

test("resolveIosDevice: 模拟器 serial → 本机构造且不触 WDA", async () => {
  let wdaCalls = 0;
  const device = await resolveIosDevice(SIM_UDID, {
    wdaDevice: async () => {
      wdaCalls += 1;
      throw new Error("不应调用");
    }
  });
  assert.equal(wdaCalls, 0);
  assert.equal(device?.platform, "ios");
  assert.equal(device?.serial, SIM_UDID);
  assert.deepEqual(device?.capabilities, { back: "none" });
});

test("resolveIosDevice: simulatorOptions 透传（platform=linux → 动作报错）", async () => {
  const device = await resolveIosDevice(SIM_UDID, { simulatorOptions: { platform: "linux" } });
  await assert.rejects(() => device.tap(1, 1), /仅支持 macOS/);
});

test("resolveIosDevice: 真机 serial → 走 WDA provider", async () => {
  const fake = { serial: DEVICE_UDID, platform: "ios", capabilities: { back: "none" } };
  const seen = [];
  const device = await resolveIosDevice(DEVICE_UDID, {
    wdaDevice: async (udid) => {
      seen.push(udid);
      return fake;
    }
  });
  assert.equal(device, fake);
  assert.deepEqual(seen, [DEVICE_UDID]);
});

test("resolveIosDevice: 真机无 provider → 明确抛错", async () => {
  await assert.rejects(() => resolveIosDevice(DEVICE_UDID, {}), /WDA provider/);
});
