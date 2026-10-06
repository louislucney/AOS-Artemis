import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectIosCrashes, parseIps } from "../dist/crash/ios.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const HEADER = JSON.stringify({
  app_name: "Preferences",
  timestamp: "2026-10-06T04:20:00.000Z",
  is_simulated: true
});
const BODY = JSON.stringify({
  exception: { type: "EXC_CRASH", signal: "SIGABRT" },
  termination: { namespace: "SIGNAL", reason: "Namespace SIGNAL, Code 6" },
  threads: [{ frames: [{ symbol: "main" }, { symbol: "start" }] }]
});
const IPS = `${HEADER}\n${BODY}\n`;

test("parseIps: 解析头/体为 ParsedCrash", () => {
  const record = parseIps(IPS);
  assert.ok(record);
  assert.equal(record.kind, "ios");
  assert.equal(record.package, "Preferences");
  assert.equal(record.attribution, "ips-header");
  assert.equal(record.exceptionClass, "EXC_CRASH");
  assert.match(record.message, /SIGNAL/);
  assert.equal(record.topFrame, "main");
  assert.deepEqual(record.frames, ["main", "start"]);
  assert.equal(record.occurredAt, "2026-10-06T04:20:00.000Z");
  assert.match(record.signature, /preferences\|exc_crash\|main/);
  assert.equal(parseIps("not json"), null);
});

test("collectIosCrashes: 时间窗与进程过滤", () => {
  const base = Date.parse("2026-10-06T04:20:00.000Z");
  const files = ["in-window.ips", "old.ips", "other-app.ips"];
  const result = collectIosCrashes(
    { startMs: base - 1000, endMs: base + 1000, processName: "Preferences" },
    {
      reportsDir: "/fake/reports",
      listDir: () => files,
      mtimeMs: (file) =>
        ({
          "/fake/reports/in-window.ips": base,
          "/fake/reports/old.ips": base - 600_000,
          "/fake/reports/other-app.ips": base
        })[file] ?? 0,
      readFile: (file) => {
        if (file.endsWith("other-app.ips")) {
          return `${JSON.stringify({ app_name: "Maps", timestamp: new Date(base).toISOString() })}\n${BODY}\n`;
        }
        return IPS;
      }
    }
  );
  assert.equal(result.skipped, null);
  assert.equal(result.scanned, 2);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].package, "Preferences");
});

test("collectIosCrashes: 目录缺失显式降级", () => {
  const result = collectIosCrashes(
    { startMs: null, endMs: null },
    {
      reportsDir: "/missing",
      listDir: () => {
        throw new Error("ENOENT");
      }
    }
  );
  assert.equal(result.skipped, "reports-dir-missing");
});

test("runtime.captureIosCrashes: 入索引并关联 traceId", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  const record = parseIps(IPS);
  const scan = await runtime.captureIosCrashes(
    { traceId: "ios-trace-1", udid: "UDID-1", processName: "Preferences", startMs: 0, endMs: 1 },
    { collect: () => ({ records: [record], scanned: 1, skipped: null }) }
  );
  assert.equal(scan.status, "captured");
  assert.equal(scan.source, "diagnostic-reports");
  const list = runtime.crashStore.list({ limit: 10 });
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].kind, "ios");
  assert.deepEqual(list.records[0].traceIds, ["ios-trace-1"]);
  assert.equal(list.records[0].deviceSerial, "UDID-1");

  const empty = await runtime.captureIosCrashes(
    { traceId: "ios-trace-2", udid: "UDID-1", processName: null, startMs: 0, endMs: 1 },
    { collect: () => ({ records: [], scanned: 0, skipped: null }) }
  );
  assert.equal(empty.status, "empty");
});

test("scanTraceForCrashes: ios- trace 路由 iOS 采集 + 有界重试", async () => {
  const now = Date.now();
  const dir = makeTempProject({ config: baseConfig() });
  const traceDir = path.join(dir, ".artemis", "traces", "ios-scan-1");
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(
    path.join(traceDir, "status.json"),
    JSON.stringify({
      trace_id: "ios-scan-1",
      status: "failed",
      platform: "ios",
      device_serial: "UDID-1",
      start_time: (now - 60_000) / 1000,
      end_time: now / 1000
    })
  );
  const record = parseIps(IPS);
  const calls = [];
  let attempt = 0;
  const iosCollector = (options) => {
    calls.push(options);
    attempt += 1;
    return attempt >= 2
      ? { records: [record], scanned: 1, skipped: null }
      : { records: [], scanned: 0, skipped: null };
  };
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    iosCrashCollector: iosCollector,
    iosCrashRetry: { attempts: 3, delayMs: 1, sleep: async () => {} }
  });
  await runtime.recordTaskSubmission({
    traceId: "ios-scan-1",
    lockedAppPackage: "com.example.MyApp",
    status: "submitted"
  });
  const report = await runtime.scanTraceForCrashes({ traceId: "ios-scan-1" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].processName, "MyApp");
  assert.equal(report.results[0].status, "captured");
  assert.equal(report.results[0].source, "diagnostic-reports");
  const list = runtime.crashStore.list({ limit: 10 });
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].kind, "ios");
  assert.equal(list.records[0].traceIds[0], "ios-scan-1");
});

test("syncTaskStatuses: iOS 终态自动补扫（走 iOS 采集与重试路径）", async () => {
  const now = Date.now();
  const dir = makeTempProject({ config: baseConfig() });
  const traceDir = path.join(dir, ".artemis", "traces", "ios-sync-1");
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(
    path.join(traceDir, "status.json"),
    JSON.stringify({
      trace_id: "ios-sync-1",
      status: "failed",
      platform: "ios",
      device_serial: "UDID-1",
      start_time: (now - 60_000) / 1000,
      end_time: now / 1000
    })
  );
  const record = parseIps(IPS);
  const calls = [];
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    iosCrashCollector: (options) => {
      calls.push(options);
      return { records: [record], scanned: 1, skipped: null };
    },
    iosCrashRetry: { attempts: 2, delayMs: 1, sleep: async () => {} }
  });
  await runtime.recordTaskSubmission({ traceId: "ios-sync-1", status: "submitted", taskDesc: "T" });
  const sync = await runtime.syncTaskStatuses();
  assert.equal(sync.updated, 1);
  await runtime.flushCrashScans();
  assert.ok(calls.length >= 1);
  const list = runtime.crashStore.list({ limit: 10 });
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].kind, "ios");
});
