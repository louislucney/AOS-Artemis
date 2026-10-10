import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  IosDeviceLogTail,
  IosLogCollector,
  filterDeviceLogLines,
  formatLogShowTime,
  parseDeviceLogTime
} from "../dist/device/ios-log.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";
const DEVICE_UDID = "00008101-000359440C69001E";

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

test("parseDeviceLogTime/filterDeviceLogLines：真机行解析与实时尾采样窗口过滤", () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
  assert.equal(
    parseDeviceLogTime("Oct  8 11:59:30.684 iPhone MyApp[123] <Notice>: hello", now),
    new Date(2026, 9, 8, 11, 59, 30, 684).getTime()
  );
  assert.equal(parseDeviceLogTime("garbage line", now), null);
  const janRef = new Date(2027, 0, 2, 0, 0, 0).getTime();
  assert.equal(
    parseDeviceLogTime("Dec 31 23:59:59.000 iPhone App[1] x", janRef),
    new Date(2026, 11, 31, 23, 59, 59, 0).getTime(),
    "跨年回退到上一年"
  );

  const windowStart = new Date(2026, 9, 8, 11, 55, 0).getTime();
  const windowEnd = new Date(2026, 9, 8, 11, 58, 0).getTime();
  const filtered = filterDeviceLogLines(
    [
      "Oct  8 11:50:00.000 iPhone MyApp[1] <Notice>: old",
      "Oct  8 11:57:00.000 iPhone MyApp[1] <Notice>: in-window",
      "Oct  8 12:00:10.000 iPhone MyApp[1] <Notice>: tail-after-window",
      "Oct  8 11:57:01.000 iPhone OtherApp[2] <Notice>: other process"
    ],
    { windowStartMs: windowStart, windowEndMs: windowEnd, processName: "MyApp", nowMs: now }
  );
  assert.deepEqual(filtered.lines, [
    "Oct  8 11:57:00.000 iPhone MyApp[1] <Notice>: in-window",
    "Oct  8 12:00:10.000 iPhone MyApp[1] <Notice>: tail-after-window"
  ]);
  assert.equal(filtered.approximateEnd, true, "捕获在窗口结束后，尾部行近似保留");
  assert.equal(filtered.windowElapsed, false);

  const elapsed = filterDeviceLogLines(["Oct  8 09:00:00.000 iPhone MyApp[1] <Notice>: old"], {
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    processName: "MyApp",
    nowMs: now
  });
  assert.deepEqual(elapsed.lines, []);
  assert.equal(elapsed.windowElapsed, true);
});

test("IosLogCollector：真机走 idevicesyslog 尾采样（超时=正常停止，clockWarning 标注）", async () => {
  const now = Date.now();
  const stamp = (offsetSeconds) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const d = new Date(now + offsetSeconds * 1000);
    const pad2 = (value) => String(value).padStart(2, "0");
    return `${months[d.getMonth()]} ${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  };
  const { calls, exec } = fakeExec({
    code: null,
    stdout: `${stamp(-30)} iPhone MyApp[1] <Notice>: old\n${stamp(-2)} iPhone MyApp[1] <Notice>: fresh\n`,
    stderr: "",
    error: "timeout"
  });
  const collector = new IosLogCollector({
    exec,
    platform: "darwin",
    timeoutMs: 1000,
    env: { AOS_IDEVICESYSLOG_PATH: "/opt/bin/idevicesyslog" }
  });
  const result = await collector.collect({
    serial: DEVICE_UDID,
    windowStartMs: now - 20_000,
    windowEndMs: now - 10_000,
    processName: "MyApp"
  });
  assert.equal(result.status, "ok");
  assert.match(result.text, /fresh/);
  assert.equal(result.clockWarning, true);
  assert.equal(calls[0].cmd, "/opt/bin/idevicesyslog");
  assert.deepEqual(calls[0].args, ["-u", DEVICE_UDID]);
});

test("IosLogCollector：真机工具缺失显式降级（ios-log-tool-missing）", async () => {
  const { exec } = fakeExec({ code: null, stdout: "", stderr: "", error: "spawn idevicesyslog ENOENT" });
  const collector = new IosLogCollector({ exec, platform: "darwin" });
  const result = await collector.collect({
    serial: DEVICE_UDID,
    windowStartMs: 1,
    windowEndMs: 2,
    processName: "MyApp"
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "ios-log-tool-missing");
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.killed = null;
  child.kill = (signal) => {
    child.killed = signal;
  };
  return child;
}

test("IosDeviceLogTail：环形缓冲上限、ANSI 清理与 stop 回收", () => {
  const child = fakeChild();
  const tail = new IosDeviceLogTail({ serial: DEVICE_UDID, maxLines: 3, spawnFn: () => child });
  assert.equal(tail.start(), true);
  child.stdout.emit("data", "\u001b[31mline-1\u001b[0m\nline-2\n");
  child.stdout.emit("data", "line-3\nline-4\n");
  assert.deepEqual(tail.snapshot(), ["line-2", "line-3", "line-4"]);
  tail.stop();
  assert.equal(child.killed, "SIGTERM");
  assert.deepEqual(tail.snapshot(), ["line-2", "line-3", "line-4"]);
});

test("IosDeviceLogTail：spawn 抛错返回 false 且不阻塞", () => {
  const tail = new IosDeviceLogTail({
    serial: DEVICE_UDID,
    spawnFn: () => {
      throw new Error("ENOENT");
    }
  });
  assert.equal(tail.start(), false);
  assert.deepEqual(tail.snapshot(), []);
});
