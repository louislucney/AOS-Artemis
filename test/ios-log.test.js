import assert from "node:assert/strict";
import test from "node:test";

import { IosLogCollector, formatLogShowTime } from "../dist/device/ios-log.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";

function fakeExec(result) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { calls, exec };
}

test("formatLogShowTime：本地时间 YYYY-MM-DD HH:mm:ss", () => {
  const ms = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(formatLogShowTime(ms), "2026-01-02 03:04:05");
});

test("IosLogCollector：按进程谓词与时间窗采集，超限放弃并降级", async () => {
  const { calls, exec } = fakeExec({ code: 0, stdout: "a\nb\n", stderr: "" });
  const collector = new IosLogCollector({ exec, platform: "darwin", timeoutMs: 1000, maxLines: 2 });
  const result = await collector.collect({
    serial: UDID,
    windowStartMs: 1000,
    windowEndMs: 2000,
    processName: "My App"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.text, "a\nb");
  const args = calls[0].args;
  assert.deepEqual(args.slice(0, 6), ["simctl", "spawn", UDID, "log", "show", "--style"]);
  assert.equal(args[args.indexOf("--predicate") + 1], 'process == "My App"');
  assert.ok(args[args.indexOf("--start") + 1].startsWith("19"));

  const over = new IosLogCollector({
    exec: fakeExec({ code: 0, stdout: "a\nb\nc\n", stderr: "" }).exec,
    platform: "darwin",
    maxLines: 2
  });
  const overResult = await over.collect({
    serial: UDID,
    windowStartMs: 1000,
    windowEndMs: 2000,
    processName: "My App"
  });
  assert.equal(overResult.status, "skipped");
  assert.equal(overResult.reason, "log-over-limit");
});

test("IosLogCollector：无进程名/非 macOS/空日志/失败均显式降级", async () => {
  const { exec } = fakeExec({ code: 0, stdout: "", stderr: "" });
  const collector = new IosLogCollector({ exec, platform: "darwin" });
  assert.equal(
    (await collector.collect({ serial: UDID, windowStartMs: 1, windowEndMs: 2 })).reason,
    "no-process"
  );
  assert.equal(
    (await collector.collect({ serial: UDID, windowStartMs: 1, windowEndMs: 2, processName: "X" })).reason,
    "log-empty"
  );
  const linux = new IosLogCollector({ exec, platform: "linux" });
  assert.equal(
    (await linux.collect({ serial: UDID, windowStartMs: 1, windowEndMs: 2, processName: "X" })).reason,
    "ios-unsupported"
  );
  const failing = new IosLogCollector({
    exec: fakeExec({ code: 1, stdout: "", stderr: "boom" }).exec,
    platform: "darwin"
  });
  assert.equal(
    (await failing.collect({ serial: UDID, windowStartMs: 1, windowEndMs: 2, processName: "X" })).reason,
    "log-show-failed"
  );
});
