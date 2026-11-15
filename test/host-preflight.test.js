import assert from "node:assert/strict";
import test from "node:test";

import { checkHostDisk } from "../dist/figma/host-preflight.js";

function statfsOf(bsize, blocks, bavail) {
  return async () => ({ bsize, blocks, bavail, bfree: bavail, files: 0, ffree: 0 });
}

test("host preflight: 磁盘低于 10% 阻断", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: {},
    statfsFn: statfsOf(4096, 1000, 50)
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient-disk");
  assert.equal(result.freePercent, 5);
  assert.match(result.message, /AOS_RUNNER_MIN_FREE_DISK_PCT=10%/);
});

test("host preflight: 磁盘充足放行，阈值可配", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: { AOS_RUNNER_MIN_FREE_DISK_PCT: "20" },
    statfsFn: statfsOf(4096, 1000, 300)
  });
  assert.equal(result.ok, true);
  assert.equal(result.freePercent, 30);
  assert.equal(result.reason, null);
});

test("host preflight: 阈值 0 关闭磁盘门禁", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: { AOS_RUNNER_MIN_FREE_DISK_PCT: "0" },
    statfsFn: statfsOf(4096, 1000, 0)
  });
  assert.equal(result.ok, true);
  assert.equal(result.freePercent, 0);
});

test("host preflight: statfs 不可用不阻断", async () => {
  const result = await checkHostDisk({
    rootPath: "/tmp",
    env: {},
    statfsFn: async () => {
      throw new Error("statfs unavailable");
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "unavailable");
  assert.match(result.message, /不阻断/);
});

import { checkAndroidDeviceStorage } from "../dist/figma/host-preflight.js";

function dfExec(stdout) {
  return async () => ({ code: 0, stdout, stderr: "" });
}

test("host preflight: Android /data 低于阈值阻断", async () => {
  const result = await checkAndroidDeviceStorage({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: dfExec("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block 1000 950 50 95% /data\n")
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient-device-disk");
  assert.equal(result.freePercent, 5);
  assert.match(result.message, /AOS_RUNNER_MIN_FREE_DEVICE_PCT=10%/);
});

test("host preflight: Android /data 充足放行，阈值可配", async () => {
  const result = await checkAndroidDeviceStorage({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo", AOS_RUNNER_MIN_FREE_DEVICE_PCT: "20" },
    exec: dfExec("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block 1000 700 300 70% /data\n")
  });
  assert.equal(result.ok, true);
  assert.equal(result.freePercent, 30);
});

test("host preflight: Android df 不可解析不阻断", async () => {
  const result = await checkAndroidDeviceStorage({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: dfExec("garbage")
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "unavailable");
});

import { checkIosDeviceStorage } from "../dist/figma/host-preflight.js";

test("host preflight: iOS 真机 disk_usage 低于阈值阻断", async () => {
  const result = await checkIosDeviceStorage({
    serial: "00008101-000359440C69001E",
    env: { AOS_IDEVICEINFO_PATH: "/bin/echo" },
    exec: dfExec("TotalDataAvailable: 50\nTotalDataCapacity: 1000\n")
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient-device-disk");
  assert.equal(result.freePercent, 5);
  assert.match(result.message, /AOS_RUNNER_MIN_FREE_DEVICE_PCT=10%/);
});

test("host preflight: iOS disk_usage 不可解析不阻断", async () => {
  const result = await checkIosDeviceStorage({
    serial: "00008101-000359440C69001E",
    env: { AOS_IDEVICEINFO_PATH: "/bin/echo" },
    exec: dfExec("unexpected")
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "unavailable");
});

import { checkAndroidBootState } from "../dist/figma/host-preflight.js";

test("host preflight: Android 未完成启动阻断", async () => {
  const result = await checkAndroidBootState({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: async () => ({ code: 0, stdout: "0\n", stderr: "" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "device-not-booted");
});

test("host preflight: Android 启动完成放行，读取失败不阻断", async () => {
  const done = await checkAndroidBootState({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: async () => ({ code: 0, stdout: "1\n", stderr: "" })
  });
  assert.equal(done.ok, true);
  const unknown = await checkAndroidBootState({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: async () => ({ code: 1, stdout: "", stderr: "offline" })
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.reason, "unavailable");
});
