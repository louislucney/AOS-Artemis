import assert from "node:assert/strict";
import test from "node:test";

import { selectTaskDevices } from "../dist/runner/device-selection.js";

const device = (serial, platform, kind) => ({
  serial,
  name: "",
  model: null,
  osVersion: null,
  platform,
  kind,
  state: "device"
});

test("device selection: 每个平台一台，优先真实设备", () => {
  const devices = [
    device("sim-1", "ios", "simulator"),
    device("real-1", "ios", "device"),
    device("emu-1", "android", "emulator"),
    device("android-real", "android", "device")
  ];
  const selected = selectTaskDevices(devices, {
    platforms: ["ios", "android"],
    deviceSerial: null
  });
  assert.deepEqual(
    selected.map((entry) => entry.serial),
    ["real-1", "android-real"]
  );
});

test("device selection: deviceSerial 显式指定时只选该设备", () => {
  const devices = [
    device("sim-1", "ios", "simulator"),
    device("real-1", "ios", "device")
  ];
  assert.deepEqual(
    selectTaskDevices(devices, { platforms: ["ios"], deviceSerial: "sim-1" }).map(
      (entry) => entry.serial
    ),
    ["sim-1"]
  );
  assert.deepEqual(
    selectTaskDevices(devices, { platforms: ["ios"], deviceSerial: "missing" }),
    []
  );
});
