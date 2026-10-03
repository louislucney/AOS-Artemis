import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { AdbCrashCollector, resolveAdbPath } from "../dist/crash/collect.js";

import { logcatTime } from "./fixtures/logcat.mjs";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "", error) {
  return { code: 1, stdout: "", stderr, error };
}

function makeExec({
  calls,
  devices = "emulator-5554\tdevice",
  crash = ok(""),
  main = ok(""),
  deviceNowMs = Date.now()
}) {
  return async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const joined = args.join(" ");
    if (joined === "devices") return typeof devices === "function" ? devices() : ok(`List of devices attached\n${devices}\n`);
    if (joined.includes("shell date")) return ok(`${Math.floor(deviceNowMs / 1000)}\n`);
    if (joined.includes("-b crash")) return typeof crash === "function" ? crash() : crash;
    if (joined.includes("-T")) return typeof main === "function" ? main() : main;
    return ok("");
  };
}

test("resolveAdbPath: explicit env, SDK root, then PATH", () => {
  assert.deepEqual(resolveAdbPath({ AOS_ADB_PATH: "C:/tools/adb.exe" }, "win32"), {
    path: "C:/tools/adb.exe",
    source: "env"
  });
  const sdkAdb = path.join("/sdk", "platform-tools", "adb");
  assert.deepEqual(
    resolveAdbPath({ ANDROID_HOME: "/sdk" }, "linux", (candidate) => candidate === sdkAdb),
    { path: sdkAdb, source: "sdk" }
  );
  assert.deepEqual(resolveAdbPath({}, "win32", () => false), { path: "adb", source: "path" });
});

test("collect: crash buffer hit returns text with the resolved serial", async () => {
  const calls = [];
  const deviceNow = Math.floor(Date.now() / 1000) * 1000;
  const exec = makeExec({
    calls,
    deviceNowMs: deviceNow,
    crash: ok("05-03 11:11:11.123  1000  1000 F libc    : Fatal signal 11")
  });
  const collector = new AdbCrashCollector({
    env: { AOS_ADB_PATH: "adb", AOS_CRASH_TIMEOUT_MS: "9000" },
    exec,
    now: () => deviceNow
  });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: deviceNow - 60_000,
    windowEndMs: deviceNow,
    targetPackage: null
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "crash-buffer");
  assert.equal(result.serial, "emulator-5554");
  assert.equal(result.clockOffsetMs, 0);
  assert.equal(result.clockWarning, false);
  assert.ok(calls.some((call) => call.args.includes("devices")));
  const bufferCall = calls.find((call) => call.args.includes("-b"));
  assert.ok(bufferCall);
  assert.equal(bufferCall.options.timeoutMs, 9000);
});

test("collect: empty crash buffer falls back to the main buffer with -T", async () => {
  const calls = [];
  const deviceNow = Math.floor(Date.now() / 1000) * 1000;
  const windowStartMs = deviceNow - 60_000;
  const exec = makeExec({
    calls,
    deviceNowMs: deviceNow,
    crash: ok(""),
    main: ok("05-03 11:11:11.123  1  1 E AndroidRuntime: x")
  });
  const collector = new AdbCrashCollector({
    env: { AOS_ADB_PATH: "adb" },
    exec,
    now: () => deviceNow
  });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs,
    windowEndMs: deviceNow,
    targetPackage: null
  });

  assert.equal(result.status, "ok");
  assert.equal(result.source, "main-buffer");
  const mainCall = calls.find((call) => call.args.includes("-T"));
  assert.ok(mainCall);
  assert.equal(mainCall.args[mainCall.args.indexOf("-T") + 1], logcatTime(new Date(windowStartMs - 5000)));
});

test("collect: a failed crash buffer still falls back to the main buffer", async () => {
  const calls = [];
  const exec = makeExec({
    calls,
    crash: fail("logcat: unknown buffer"),
    main: ok("05-03 11:11:11.123  1  1 E AndroidRuntime: x")
  });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.equal(result.status, "ok");
  assert.equal(result.source, "main-buffer");
});

test("collect: missing serial is skipped", async () => {
  const calls = [];
  const exec = makeExec({ calls, devices: "" });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: null,
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.deepEqual(result, { status: "skipped", reason: "no-serial" });
});

test("collect: a requested serial that is not attached is device-offline", async () => {
  const calls = [];
  const exec = makeExec({ calls, devices: "emulator-5554\tdevice" });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "removed-1234",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "device-offline");
});

test("collect: a missing adb binary is adb-not-found", async () => {
  const exec = async () => ({ code: null, stdout: "", stderr: "", error: "spawn adb ENOENT" });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.deepEqual(result, { status: "skipped", reason: "adb-not-found" });
});

test("collect: both buffers failing is command-failed", async () => {
  const calls = [];
  const exec = makeExec({
    calls,
    crash: fail("logcat: read failed"),
    main: fail("logcat: read failed")
  });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "command-failed");
});

test("collect: adb device errors are classified as device-offline", async () => {
  const calls = [];
  const exec = makeExec({
    calls,
    crash: fail("error: device 'emulator-5554' not found"),
    main: fail("error: device 'emulator-5554' not found")
  });
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "device-offline");
});

test("collect: clock probe failures degrade to zero offset with a warning", async () => {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const joined = args.join(" ");
    if (joined === "devices") return ok("List of devices attached\nemulator-5554\tdevice\n");
    if (joined.includes("shell date")) return fail("date: not found");
    if (joined.includes("-b crash")) return ok("05-03 11:11:11.123  1  1 F libc    : Fatal signal 11");
    return ok("");
  };
  const collector = new AdbCrashCollector({ env: { AOS_ADB_PATH: "adb" }, exec });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000,
    windowEndMs: Date.now(),
    targetPackage: null
  });
  assert.equal(result.status, "ok");
  assert.equal(result.clockOffsetMs, 0);
  assert.equal(result.clockWarning, true);
});
