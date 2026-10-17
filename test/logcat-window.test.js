import assert from "node:assert/strict";
import test from "node:test";

import { AdbLogcatCollector, formatLogcatTime } from "../dist/device/logcat.js";

function makeExec({
  devices = "emulator-5554\tdevice",
  deviceNowMs = Date.now(),
  clockError = null,
  logText = "10-02 04:11:42.319  1000  1000 E Api: HTTP 401",
  logResult = { code: 0, stdout: "", stderr: "" },
  execError = null
} = {}) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (execError) return { code: null, stdout: "", stderr: "", error: execError };
    const joined = args.join(" ");
    if (joined === "devices") {
      return { code: 0, stdout: `List of devices attached\n${devices}\n`, stderr: "" };
    }
    if (joined.includes("shell date")) {
      if (clockError) return { code: 1, stdout: "", stderr: clockError };
      return { code: 0, stdout: `${Math.floor(deviceNowMs / 1000)}\n`, stderr: "" };
    }
    if (joined.includes("logcat")) {
      return { ...logResult, stdout: logResult.stdout || logText };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("logcat collector: pulls the window with -T and returns the text", async () => {
  const deviceNow = 1_700_000_000_000;
  const { exec, calls } = makeExec({ deviceNowMs: deviceNow });
  const collector = new AdbLogcatCollector({ exec, env: {}, now: () => deviceNow, platform: "darwin" });
  const result = await collector.collect({ serial: "emulator-5554", windowStartMs: deviceNow - 60_000 });

  assert.equal(result.status, "ok");
  assert.equal(result.serial, "emulator-5554");
  assert.match(result.text, /HTTP 401/);
  const logcatCall = calls.find((call) => call.args.join(" ").includes("logcat"));
  assert.ok(logcatCall, "logcat was invoked");
  const since = logcatCall.args[logcatCall.args.indexOf("-T") + 1];
  assert.equal(since, formatLogcatTime(deviceNow - 65_000));
});

test("logcat collector: 项目 env（ADB_SERVER_SOCKET）透传到每个 adb 子进程", async () => {
  const deviceNow = 1_700_000_000_000;
  const { exec, calls } = makeExec({ deviceNowMs: deviceNow });
  const env = { ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037" };
  const collector = new AdbLogcatCollector({
    exec,
    env,
    now: () => deviceNow,
    platform: "darwin"
  });
  const result = await collector.collect({
    serial: "emulator-5554",
    windowStartMs: deviceNow - 60_000
  });

  assert.equal(result.status, "ok");
  assert.ok(calls.length >= 3, "devices / shell date / logcat");
  for (const call of calls) {
    assert.equal(
      call.options.env.ADB_SERVER_SOCKET,
      "tcp:10.0.0.5:5037",
      `${call.args.join(" ")} 未收到项目 env`
    );
  }
});

test("logcat collector: auto-selects a single device, rejects ambiguity and unknown serial", async () => {
  const single = makeExec({ devices: "emulator-5554\tdevice" });
  const ok = await new AdbLogcatCollector({ exec: single.exec, env: {}, platform: "darwin" }).collect({
    windowStartMs: Date.now() - 1000
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.serial, "emulator-5554");

  const many = makeExec({ devices: "a\tdevice\nb\tdevice" });
  const ambiguous = await new AdbLogcatCollector({ exec: many.exec, env: {}, platform: "darwin" }).collect({
    windowStartMs: Date.now() - 1000
  });
  assert.equal(ambiguous.status, "skipped");
  assert.equal(ambiguous.reason, "no-serial");

  const unknown = await new AdbLogcatCollector({ exec: many.exec, env: {}, platform: "darwin" }).collect({
    serial: "ghost",
    windowStartMs: Date.now() - 1000
  });
  assert.equal(unknown.status, "skipped");
  assert.equal(unknown.reason, "device-offline");
});

test("logcat collector: degraded branches are structured, never thrown", async () => {
  const enoent = makeExec({ execError: "spawn adb ENOENT" });
  const missing = await new AdbLogcatCollector({ exec: enoent.exec, env: {}, platform: "darwin" }).collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000
  });
  assert.equal(missing.status, "skipped");
  assert.equal(missing.reason, "adb-not-found");

  const offline = makeExec({
    logResult: { code: 1, stdout: "", stderr: "device offline" }
  });
  const failed = await new AdbLogcatCollector({ exec: offline.exec, env: {}, platform: "darwin" }).collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000
  });
  assert.equal(failed.status, "skipped");
  assert.equal(failed.reason, "device-offline");

  const empty = makeExec({ logResult: { code: 0, stdout: "  ", stderr: "" } });
  const blank = await new AdbLogcatCollector({ exec: empty.exec, env: {}, platform: "darwin" }).collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000
  });
  assert.equal(blank.status, "skipped");
  assert.equal(blank.reason, "log-empty");

  const noClock = makeExec({ clockError: "boom" });
  const warned = await new AdbLogcatCollector({ exec: noClock.exec, env: {}, platform: "darwin" }).collect({
    serial: "emulator-5554",
    windowStartMs: Date.now() - 1000
  });
  assert.equal(warned.status, "ok");
  assert.equal(warned.clockWarning, true);
});
