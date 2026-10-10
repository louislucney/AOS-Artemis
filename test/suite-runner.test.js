import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { buildRunReport } from "../dist/figma/run-report.js";
import { runGeneratedTests } from "../dist/figma/suite-runner.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

function caseEntry(index, overrides = {}) {
  return {
    id: `case-${index}`,
    name: `Case ${index}`,
    screens: ["Home", "Next"],
    steps: ["点击「Go」，验证进入「Next」（页面应出现「Done」）"],
    preconditions: ["应用已安装且可正常启动", "开始前应用停留在「Home」页"],
    taskDesc: `run case ${index}`,
    ...overrides
  };
}

async function setup({ cases = [caseEntry(1)], statuses = {}, runError = null, reset } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const proxy = new SuiteProxy({ statuses, runError });
  const crashCollector = { collect: async () => ({ status: "skipped", reason: "disabled" }) };
  const { runtime } = await loadTestRuntime(dir, { proxy, store, crashCollector });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: cases }));

  const resetCalls = [];
  const resetFn = async (request) => {
    resetCalls.push(request);
    return reset
      ? reset(request)
      : {
          ok: true,
          serial: request.serial ?? null,
          adb: { path: "/opt/adb", source: "env" },
          commands: []
        };
  };
  const run = (overrides = {}) =>
    runGeneratedTests(runtime, {
      reset: resetFn,
      sleep: async () => {},
      pollIntervalMs: 0,
      ...overrides
    });
  return { dir, runtime, store, proxy, resetCalls, run };
}

test("suite runner: runs all cases, resets per case and writes the ledger", async () => {
  const { dir, store, resetCalls, run } = await setup({
    cases: [caseEntry(1), caseEntry(2)],
    statuses: {
      "trace-1": { status: "completed", notes_dir: "/notes/1", stderr_log: "/err/1" },
      "trace-2": { status: "completed" }
    }
  });

  const report = await run({ lockedAppPackage: "com.example.app" });
  assert.equal(report.ok, true);
  assert.equal(report.total, 2);
  assert.equal(report.executed, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.cases[0].evidence.notesDir, "/notes/1");
  assert.equal(report.cases[0].evidence.stderrLog, "/err/1");
  assert.equal(report.cases[0].failure, null);
  assert.equal(resetCalls.length, 2);
  assert.equal(resetCalls[0].packageName, "com.example.app");

  const tasks = await store.listTasks(dir, 10);
  assert.equal(tasks.length, 2);
  assert.deepEqual(
    tasks.map((task) => task.caseId).sort(),
    ["case-1", "case-2"]
  );
  assert.ok(tasks.every((task) => task.status === "completed"));
  assert.ok(tasks.every((task) => task.finishedAt));
});

test("suite runner: keeps going after a failing case and keeps failure evidence", async () => {
  const { run } = await setup({
    cases: [caseEntry(1), caseEntry(2), caseEntry(3)],
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": {
        status: "failed",
        error: "assert mismatch",
        test_summary: {
          task_status: "failed",
          failed_items: [{ item_text: "checkout", kind: "assert", evidence: "text mismatch" }]
        }
      },
      "trace-3": { status: "completed" }
    }
  });

  const report = await run();
  assert.equal(report.executed, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.cases[1].status, "failed");
  assert.equal(report.cases[1].error, "assert mismatch");
  assert.equal(report.cases[1].testSummary.failedItems.length, 1);
  assert.equal(report.cases[1].failure.domain, "behavior-or-design");
  assert.equal(report.cases[1].failure.confidence, "high");
  assert.equal(report.cases[2].status, "passed");
  assert.equal(report.cases[2].failure, null);
});

test("suite runner: exploration-only failures classify as design-inference with script provenance", async () => {
  const exploreCase = caseEntry(1, {
    preconditions: [],
    expectations: [
      { screen: "门市", hints: [], provenance: "inferred", confidence: "low", kind: "explore" }
    ]
  });
  const { run } = await setup({
    cases: [exploreCase],
    statuses: {
      "trace-1": {
        status: "failed",
        error: "assert mismatch",
        test_summary: {
          task_status: "failed",
          failed_items: [{ item_text: "未到达门市", kind: "assert", evidence: "no target screen" }]
        }
      }
    }
  });

  const report = await run();
  assert.equal(report.cases[0].status, "failed");
  assert.equal(report.cases[0].failure.domain, "design-inference");
  assert.equal(report.cases[0].failure.confidence, "high");
  assert.deepEqual(report.cases[0].scriptProvenance, { asserts: 0, explores: 1 });
});

test("suite runner: stopOnFailure breaks the run and reports skipped", async () => {
  const { run } = await setup({
    cases: [caseEntry(1), caseEntry(2), caseEntry(3)],
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "failed", error: "boom" }
    }
  });

  const report = await run({ stopOnFailure: true });
  assert.equal(report.executed, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.cases.length, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
});

test("suite runner: no device surfaces an explicit error and records failed rows", async () => {
  const { dir, store, run } = await setup({
    cases: [caseEntry(1), caseEntry(2)],
    runError: "device not found"
  });

  const report = await run();
  assert.equal(report.ok, false);
  assert.match(report.error, /device not found/);
  assert.equal(report.executed, 2);
  assert.ok(report.cases.every((entry) => entry.status === "submit-error"));
  assert.ok(report.cases.every((entry) => entry.failure.domain === "environment"));
  assert.ok(report.cases.every((entry) => entry.failure.confidence === "high"));

  const tasks = await store.listTasks(dir, 10);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.status === "failed"));
  assert.ok(tasks.every((task) => task.caseId));
});

test("suite runner: degraded reset does not block and stays visible", async () => {
  const { run } = await setup({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" } },
    reset: (request) => ({
      ok: false,
      reason: "device-offline",
      message: "device offline",
      serial: request.serial ?? null,
      adb: { path: "adb", source: "path" },
      commands: []
    })
  });

  const report = await run({ lockedAppPackage: "com.example.app" });
  assert.equal(report.passed, 1);
  assert.equal(report.cases[0].reset.reason, "device-offline");
});

test("suite runner: poll timeout marks the case as timeout", async () => {
  const { run } = await setup({ cases: [caseEntry(1)], statuses: {} });
  let clock = 0;
  const report = await run({
    pollTimeoutMs: 100,
    pollIntervalMs: 10,
    now: () => (clock += 50)
  });

  assert.equal(report.cases[0].status, "timeout");
  assert.match(report.cases[0].error, /超时/);
  assert.equal(report.cases[0].failure.domain, "case-defect");
  assert.equal(report.cases[0].failure.confidence, "medium");
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.ok, true);
});

test("suite runner: linked crash records classify the failure as app defect", async () => {
  const { runtime, run } = await setup({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "failed", error: "process crashed" } }
  });
  const record = {
    id: "crash-deadbeef",
    kind: "java",
    package: "com.example.app",
    attribution: "process-line",
    exceptionClass: "java.lang.IllegalStateException",
    message: "boom",
    rootCauseClass: "java.lang.IllegalStateException",
    topFrame: "com.example.app.Main.onCreate(Main.java:1)",
    signatureBasis: "sig",
    source: "crash-buffer",
    deviceSerial: null,
    occurredAt: null,
    capturedAt: "2026-10-02T00:00:00.000Z",
    occurrences: 1,
    outcomeCounts: { failed: 1 },
    firstSeenAt: "2026-10-02T00:00:00.000Z",
    lastSeenAt: "2026-10-02T00:00:00.000Z",
    traceIds: ["trace-1"]
  };
  fs.mkdirSync(runtime.crashStore.dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(runtime.crashStore.dirPath, "index.json"),
    JSON.stringify({ version: 1, records: [record] })
  );

  const report = await run();
  assert.equal(report.cases[0].failure.domain, "app-defect");
  assert.equal(report.cases[0].failure.confidence, "high");
  assert.deepEqual(report.cases[0].failure.evidence, ["crash-deadbeef"]);
});

function writeErrorCodes(runtime, codes) {
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "error-codes.json"), JSON.stringify({ version: 1, codes }));
}

test("suite runner: unhandled API errors classify as api-error and persist an artifact", async () => {
  const { runtime, run } = await setup({
    cases: [caseEntry(1), caseEntry(2)],
    statuses: {
      "trace-1": {
        status: "completed",
        device_serial: "emulator-5554",
        start_time: 1700000000,
        end_time: 1700000010
      },
      "trace-2": {
        status: "failed",
        error: "assert mismatch",
        device_serial: "emulator-5554",
        start_time: 1700000020,
        end_time: 1700000032,
        test_summary: {
          task_status: "failed",
          failed_items: [{ item_text: "校验金额", evidence: "expected 42 got 41" }]
        }
      }
    }
  });
  writeErrorCodes(runtime, {
    AUTH_401: { match: "HTTP\\s*401", handler: "relogin", expect: "跳转登录页", handledPattern: "AuthInterceptor" }
  });
  const collected = [];
  const report = await run({
    logcatCollector: async (request) => {
      collected.push(request);
      return {
        status: "ok",
        serial: "emulator-5554",
        clockWarning: false,
        text:
          request.windowStartMs === 1700000020 * 1000
            ? "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized"
            : "10-02 04:11:40.000  1000  1000 I OkHttp: 200 OK"
      };
    }
  });

  assert.equal(collected.length, 2, "each terminal case collects its own window");
  const failed = report.cases[1];
  assert.equal(failed.failure.domain, "api-error");
  assert.deepEqual(failed.apiErrors.map((entry) => [entry.code, entry.verdict]), [["AUTH_401", "unhandled"]]);
  assert.equal(failed.apiErrorsDegraded, null);
  assert.equal(report.cases[0].status, "passed");
  assert.deepEqual(report.cases[0].apiErrors, []);
  assert.equal(report.apiErrorCatalog.rules, 1);

  const artifact = JSON.parse(
    fs.readFileSync(path.join(runtime.traceDir("trace-2"), "api-errors.json"), "utf-8")
  );
  assert.equal(artifact.errors[0].code, "AUTH_401");
  assert.equal(artifact.degraded, null);
});

test("suite runner: failOnApiErrors turns handled-only passes red, default does not", async () => {
  const build = async () =>
    setup({
      cases: [caseEntry(1)],
      statuses: {
        "trace-1": {
          status: "completed",
          device_serial: "emulator-5554",
          start_time: 1700000000,
          end_time: 1700000010
        }
      }
    });
  const collector = async () => ({
    status: "ok",
    serial: "emulator-5554",
    clockWarning: false,
    text: "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized"
  });

  const first = await build();
  writeErrorCodes(first.runtime, {
    AUTH_401: { match: "HTTP\\s*401", handler: "relogin", handledPattern: "AuthInterceptor" }
  });
  const evidenceOnly = await first.run({ logcatCollector: collector });
  assert.equal(evidenceOnly.passed, 1, "unhandled API errors are evidence by default");
  assert.equal(evidenceOnly.cases[0].apiErrors[0].verdict, "unhandled");

  const second = await build();
  writeErrorCodes(second.runtime, {
    AUTH_401: { match: "HTTP\\s*401", handler: "relogin", handledPattern: "AuthInterceptor" }
  });
  const blocked = await second.run({ logcatCollector: collector, failOnApiErrors: true });
  assert.equal(blocked.passed, 0);
  assert.equal(blocked.cases[0].status, "failed");
  assert.match(blocked.cases[0].error, /未处理的 API 错误/);
  assert.equal(blocked.cases[0].failure.domain, "api-error");
});

test("suite runner: handled API errors stay evidence; missing registry degrades without collecting", async () => {
  const handled = await setup({
    cases: [caseEntry(1)],
    statuses: {
      "trace-1": {
        status: "completed",
        device_serial: "emulator-5554",
        start_time: 1700000000,
        end_time: 1700000010
      }
    }
  });
  writeErrorCodes(handled.runtime, {
    AUTH_401: { match: "HTTP\\s*401", handler: "relogin", handledPattern: "AuthInterceptor" }
  });
  const report = await handled.run({
    logcatCollector: async () => ({
      status: "ok",
      serial: "emulator-5554",
      clockWarning: false,
      text: "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized\n10-02 04:11:42.320  1000  1000 I AuthInterceptor: redirect to login"
    })
  });
  assert.equal(report.cases[0].status, "passed");
  assert.equal(report.cases[0].apiErrors[0].verdict, "handled");

  const noRegistry = await setup({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed", start_time: 1700000000, end_time: 1700000010 } }
  });
  let calls = 0;
  const degraded = await noRegistry.run({
    logcatCollector: async () => {
      calls += 1;
      return { status: "ok", serial: null, text: "", clockWarning: false };
    }
  });
  assert.equal(calls, 0);
  assert.equal(degraded.cases[0].apiErrorsDegraded, "registry-missing");
  assert.equal(degraded.apiErrorCatalog.rules, 0);
});

test("suite runner -> report: logcat API errors reach the exported report", async () => {
  const { runtime, run } = await setup({
    cases: [caseEntry(1)],
    statuses: {
      "trace-1": {
        status: "failed",
        error: "assert mismatch",
        device_serial: "emulator-5554",
        start_time: 1700000000,
        end_time: 1700000010,
        test_summary: {
          task_status: "failed",
          failed_items: [{ item_text: "登录", evidence: "请先登录后重试" }]
        }
      }
    }
  });
  writeErrorCodes(runtime, {
    AUTH_401: { match: "HTTP\\s*401", handler: "relogin", handledPattern: "AuthInterceptor" }
  });
  const report = await run({
    logcatCollector: async () => ({
      status: "ok",
      serial: "emulator-5554",
      clockWarning: false,
      text: "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized"
    })
  });
  assert.equal(report.cases[0].failure.domain, "api-error");

  const exported = await buildRunReport(runtime, { save: true, stamp: "e2e" });
  const exportedCase = exported.cases[0];
  assert.equal(exportedCase.failure.domain, "api-error");
  assert.equal(exportedCase.apiErrors[0].code, "AUTH_401");
  assert.match(fs.readFileSync(exported.saved.junit, "utf-8"), /api_error: AUTH_401/);
});
