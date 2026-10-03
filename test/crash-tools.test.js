import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { aosCrashes } from "../dist/tools/crash.js";
import { logcatTime } from "./fixtures/logcat.mjs";
import { loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function crashText(date, pkg = "com.example.app") {
  return [
    `${logcatTime(date)}  1000  1000 E AndroidRuntime: FATAL EXCEPTION: main`,
    `${logcatTime(date)}  1000  1000 E AndroidRuntime: Process: ${pkg}, PID: 1000`,
    `${logcatTime(date)}  1000  1000 E AndroidRuntime: java.lang.RuntimeException: boom`,
    `${logcatTime(date)}  1000  1000 E AndroidRuntime: \tat ${pkg}.Main.run(Main.kt:1)`
  ].join("\n");
}

function writeTraceStatus(dir, id, status) {
  const traceDir = path.join(dir, ".artemis", "traces", id);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, "status.json"), JSON.stringify(status));
}

class FakeCollector {
  constructor(text, { delayMs = 0 } = {}) {
    this.text = text;
    this.delayMs = delayMs;
    this.calls = [];
    this.active = 0;
    this.maxActive = 0;
  }

  async collect(request) {
    this.calls.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return {
        status: "ok",
        source: "crash-buffer",
        text: this.text,
        clockOffsetMs: 0,
        serial: request.serial ?? "emulator-5554"
      };
    } finally {
      this.active -= 1;
    }
  }
}

function terminalStatus(now, outcome = "failed", overrides = {}) {
  return {
    status: outcome,
    device_serial: "emulator-5554",
    start_time: (now - 60_000) / 1000,
    end_time: now / 1000,
    ...overrides
  };
}

test("aos_crashes: terminal tasks are scanned, listed and deduplicated", async () => {
  const now = Date.now();
  const dir = makeTempProject();
  writeTraceStatus(dir, "t1", terminalStatus(now));
  const collector = new FakeCollector(crashText(new Date(now - 30_000)));
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector
  });

  await runtime.recordTaskSubmission({ traceId: "t1", model: "Flash", taskDesc: "open" });
  const sync = await runtime.syncTaskStatuses();
  assert.equal(sync.updated, 1);
  await runtime.flushCrashScans();
  assert.equal(collector.calls.length, 1);
  assert.equal(collector.calls[0].serial, "emulator-5554");

  const list = parseToolResult(await aosCrashes(runtime, { action: "list" }));
  assert.equal(list.ok, true);
  assert.equal(list.enabled, true);
  assert.equal(list.total, 1);
  assert.equal(list.count, 1);
  assert.ok(list.store.dir.endsWith(path.join(".artemis", "crashes")));

  const summary = list.records[0];
  assert.equal(summary.package, "com.example.app");
  assert.equal(summary.kind, "java");
  assert.equal(summary.occurrences, 1);
  assert.deepEqual(summary.outcomeCounts, { failed: 1 });
  assert.deepEqual(summary.traceIds, ["t1"]);

  const full = parseToolResult(
    await aosCrashes(runtime, { action: "get", signature: summary.id })
  );
  assert.ok(full.record.frames.length >= 1);
  assert.match(full.record.excerpt, /FATAL EXCEPTION/);

  const scan = parseToolResult(await aosCrashes(runtime, { action: "scan", traceId: "t1" }));
  assert.equal(scan.found, 1);
  assert.deepEqual(scan.updatedSignatures, [summary.id]);
  assert.equal(collector.calls.length, 2, "explicit scan forces a re-scan");

  const after = parseToolResult(await aosCrashes(runtime, { action: "list" }));
  assert.equal(after.records[0].occurrences, 2);
});

test("aos_crashes: locked app package filters out other apps' crashes", async () => {
  const now = Date.now();
  const dir = makeTempProject();
  writeTraceStatus(dir, "t2", terminalStatus(now));
  const collector = new FakeCollector(crashText(new Date(now - 30_000), "com.example.app"));
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector
  });

  await runtime.recordTaskSubmission({
    traceId: "t2",
    model: "Flash",
    taskDesc: "open",
    lockedAppPackage: "com.other"
  });
  await runtime.syncTaskStatuses();
  await runtime.flushCrashScans();

  const list = parseToolResult(await aosCrashes(runtime, { action: "list" }));
  assert.equal(list.total, 0);

  const scan = parseToolResult(await aosCrashes(runtime, { action: "scan", traceId: "t2" }));
  assert.equal(scan.found, 0);
  assert.equal(scan.results[0].status, "empty");
});

test("aos_crashes: matching locked package captures the crash", async () => {
  const now = Date.now();
  const dir = makeTempProject();
  writeTraceStatus(dir, "t3", terminalStatus(now, "completed"));
  const collector = new FakeCollector(crashText(new Date(now - 30_000), "com.example.app"));
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector
  });

  await runtime.recordTaskSubmission({
    traceId: "t3",
    model: "Flash",
    taskDesc: "open",
    lockedAppPackage: "com.example.app"
  });
  await runtime.syncTaskStatuses();
  await runtime.flushCrashScans();

  const list = parseToolResult(await aosCrashes(runtime, { action: "list" }));
  assert.equal(list.total, 1);
  assert.deepEqual(list.records[0].outcomeCounts, { completed: 1 });
});

test("aos_crashes: sync-triggered scans are serialized", async () => {
  const now = Date.now();
  const dir = makeTempProject();
  writeTraceStatus(dir, "s1", terminalStatus(now));
  writeTraceStatus(dir, "s2", terminalStatus(now));
  const collector = new FakeCollector(crashText(new Date(now - 30_000)), { delayMs: 15 });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector
  });

  await runtime.recordTaskSubmission({ traceId: "s1", model: "Flash", taskDesc: "a" });
  await runtime.recordTaskSubmission({ traceId: "s2", model: "Flash", taskDesc: "b" });
  await runtime.syncTaskStatuses();
  await runtime.flushCrashScans();

  assert.equal(collector.calls.length, 2);
  assert.equal(collector.maxActive, 1, "scans must not overlap");
});

test("aos_crashes: capture can be disabled with AOS_CRASH_CAPTURE=0", async () => {
  const now = Date.now();
  const dir = makeTempProject();
  writeTraceStatus(dir, "d1", terminalStatus(now));
  const collector = new FakeCollector(crashText(new Date(now - 30_000)));
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector,
    baseEnv: { AOS_CRASH_CAPTURE: "0" }
  });

  await runtime.recordTaskSubmission({ traceId: "d1", model: "Flash", taskDesc: "a" });
  await runtime.syncTaskStatuses();
  await runtime.flushCrashScans();

  assert.equal(collector.calls.length, 0);
  const list = parseToolResult(await aosCrashes(runtime, { action: "list" }));
  assert.equal(list.enabled, false);
  assert.equal(list.total, 0);
});

test("aos_crashes: a trace without a window is skipped as no-window", async () => {
  const dir = makeTempProject();
  const collector = new FakeCollector("");
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: collector
  });

  const scan = parseToolResult(
    await aosCrashes(runtime, { action: "scan", traceId: "ghost-trace" })
  );
  assert.equal(scan.results[0].status, "skipped");
  assert.equal(scan.results[0].reason, "no-window");
  assert.equal(collector.calls.length, 0);
});

test("aos_crashes: list validates since and get validates signature", async () => {
  const dir = makeTempProject();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    crashCollector: new FakeCollector("")
  });

  const badSince = await aosCrashes(runtime, { action: "list", since: "not-a-date" });
  assert.equal(badSince.isError, true);

  const missing = await aosCrashes(runtime, { action: "get", signature: "nope" });
  assert.equal(missing.isError, true);

  const noSignature = await aosCrashes(runtime, { action: "get" });
  assert.equal(noSignature.isError, true);
});
