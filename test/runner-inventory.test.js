import assert from "node:assert/strict";
import test from "node:test";

import { collectRunnerInventory } from "../dist/runner/inventory.js";

function makeExec(routes) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    for (const route of routes) {
      if (route.match(command, args)) return route.result;
    }
    return { code: 1, stdout: "", stderr: "ENOENT", error: "ENOENT" };
  };
  return { exec, calls };
}

test("android：adb devices → 设备清单（emulator-* kind emulator；offline 不计）", async () => {
  const { exec } = makeExec([
    {
      match: (command, args) => command === "adb" && args[0] === "devices",
      result: {
        code: 0,
        stdout:
          "List of devices attached\nemulator-5554\tdevice\nR58M12ABCD\tdevice\nbroken-1\toffline\n",
        stderr: ""
      }
    },
    { match: (command) => command.endsWith("xcrun"), result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" } },
    { match: (command) => command === "idevice_id", result: { code: 1, stdout: "", stderr: "no devices" } }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });
  assert.deepEqual(inventory.platforms, ["android"]);
  assert.equal(inventory.devices.length, 2);
  const emulator = inventory.devices.find((device) => device.serial === "emulator-5554");
  assert.deepEqual(emulator, {
    serial: "emulator-5554",
    name: "",
    platform: "android",
    kind: "emulator",
    state: "device"
  });
  assert.equal(
    inventory.devices.find((device) => device.serial === "R58M12ABCD").kind,
    "device"
  );
  assert.equal(
    inventory.devices.some((device) => device.serial === "broken-1"),
    false,
    "offline 不计"
  );
  assert.equal(inventory.tools.adb, true);
});

test("ios（darwin）：simctl 仅 Booted 可用模拟器 + idevice_id 真机；离线状态排除", async () => {
  const simctlJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        {
          udid: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
          name: "iPhone 15",
          state: "Booted",
          isAvailable: true
        },
        {
          udid: "11111111-2222-3333-4444-555555555555",
          name: "iPhone 14",
          state: "Shutdown",
          isAvailable: true
        },
        {
          udid: "99999999-8888-7777-6666-555555555555",
          name: "iPhone 13",
          state: "Booted",
          isAvailable: false
        }
      ]
    }
  });
  const { exec } = makeExec([
    { match: (command) => command === "adb", result: { code: 0, stdout: "", stderr: "" } },
    { match: (command) => command.endsWith("xcrun"), result: { code: 0, stdout: simctlJson, stderr: "" } },
    {
      match: (command) => command === "idevice_id",
      result: { code: 0, stdout: "00008101-000A1B2C3D4E001E\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "darwin", env: {} });
  assert.deepEqual(inventory.platforms, ["ios"]);
  assert.deepEqual(
    inventory.devices.map((device) => device.serial),
    ["00008101-000A1B2C3D4E001E", "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"]
  );
  const real = inventory.devices.find((device) => device.serial.startsWith("0000"));
  assert.equal(real.kind, "device");
  const simulator = inventory.devices.find((device) => device.serial.startsWith("4E0A"));
  assert.equal(simulator.kind, "simulator");
  assert.equal(simulator.name, "iPhone 15");
  assert.equal(inventory.tools.ideviceId, true);
  assert.equal(inventory.tools.simctl, true);
});

test("tools：adb 缺失不炸；idb 经 --version 探测；appium＝AOS_APPIUM_URL 非空", async () => {
  const { exec } = makeExec([
    { match: (command) => command === "adb", result: { code: null, stdout: "", stderr: "", error: "ENOENT" } },
    { match: (command) => command.endsWith("xcrun"), result: { code: 0, stdout: JSON.stringify({ devices: {} }), stderr: "" } },
    { match: (command) => command === "idevice_id", result: { code: null, stdout: "", stderr: "", error: "ENOENT" } },
    { match: (command) => command.endsWith("idb"), result: { code: 0, stdout: "idb 1.1.8", stderr: "" } }
  ]);
  const inventory = await collectRunnerInventory({
    exec,
    platform: "darwin",
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" }
  });
  assert.equal(inventory.tools.adb, false, "adb 缺失");
  assert.equal(inventory.tools.idb, true);
  assert.equal(inventory.tools.ideviceId, false);
  assert.equal(inventory.tools.simctl, true);
  assert.equal(inventory.tools.appium, true);
  assert.deepEqual(inventory.devices, []);
});

test("AOS_RUNNER_DEVICES 覆盖全部来源（平台按 classifyIosSerial；空项忽略；不触设备来源）", async () => {
  const { exec, calls } = makeExec([]);
  const inventory = await collectRunnerInventory({
    exec,
    platform: "darwin",
    env: {
      AOS_RUNNER_DEVICES:
        "emulator-5554, 4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B, , 00008101-000A1B2C3D4E001E"
    }
  });
  assert.deepEqual(
    inventory.devices.map((device) => [device.platform, device.kind, device.serial]),
    [
      ["android", "emulator", "emulator-5554"],
      ["ios", "device", "00008101-000A1B2C3D4E001E"],
      ["ios", "simulator", "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"]
    ]
  );
  assert.deepEqual(inventory.platforms, ["android", "ios"]);
  assert.ok(inventory.devices.every((device) => device.name === ""));
  assert.equal(calls.length, 0, "覆盖模式不调用设备来源");
});

test("非 darwin：无 iOS 设备且不调 iOS 工具", async () => {
  const { exec, calls } = makeExec([
    {
      match: (command) => command === "adb",
      result: { code: 0, stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" }
    }
  ]);
  const inventory = await collectRunnerInventory({ exec, platform: "linux", env: {} });
  assert.deepEqual(inventory.platforms, ["android"]);
  assert.equal(inventory.tools.simctl, false);
  assert.equal(inventory.tools.ideviceId, false);
  assert.equal(inventory.tools.idb, false);
  assert.ok(calls.every((call) => call.command === "adb"), "不调 iOS 工具");
});
