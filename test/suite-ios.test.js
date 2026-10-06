import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runGeneratedTests, suiteResetFor } from "../dist/figma/suite-runner.js";
import { resetApp } from "../dist/device/reset.js";
import { resetIosApp } from "../dist/device/ios-reset.js";
import { __resetIosTasks } from "../dist/ios/task-runner.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";

function caseEntry(index) {
  return {
    id: `case-${index}`,
    name: `Case ${index}`,
    screens: ["Home"],
    steps: ["观察页面"],
    preconditions: [],
    taskDesc: `run ios case ${index}`
  };
}

function writeStatus(dir, traceId, payload) {
  const traceDir = path.join(dir, ".artemis", "traces", traceId);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, "status.json"), JSON.stringify(payload));
}

async function setupIos({ statuses = {} } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new SuiteProxy({ statuses });
  const crashCollector = { collect: async () => ({ status: "skipped", reason: "disabled" }) };
  const { runtime } = await loadTestRuntime(dir, { proxy, crashCollector });
  // Bypass the iOS wrapper so this test exercises the suite runner, not the runner.
  runtime.proxy = proxy;
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: [caseEntry(1)] }));
  return { dir, runtime, proxy };
}

test("suiteResetFor: iOS 设备 UDID 用 iOS 复位，其余用 adb", () => {
  assert.equal(suiteResetFor(UDID), resetIosApp);
  assert.equal(suiteResetFor("00008110-001A2C681E22801E"), resetIosApp);
  assert.equal(suiteResetFor("emulator-5554"), resetApp);
  assert.equal(suiteResetFor(null), resetApp);
});

test("suite runner: iOS UDID 任务跑通用例并标记 logcat 降级", async () => {
  __resetIosTasks();
  const { dir, proxy, runtime } = await setupIos();
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "completed",
    device_serial: UDID,
    message: "done"
  });
  const resetCalls = [];
  const report = await runGeneratedTests(runtime, {
    deviceSerial: UDID,
    lockedAppPackage: "com.apple.Preferences",
    reset: async (request) => {
      resetCalls.push(request);
      return { ok: true, serial: request.serial ?? null, adb: { path: null, source: "missing" }, commands: [] };
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    apiErrors: true
  });
  assert.equal(report.ok, true);
  assert.equal(report.passed, 1, JSON.stringify(report.cases));
  assert.equal(report.cases[0].traceId, "trace-1");
  assert.equal(report.cases[0].apiErrorsDegraded, "ios-log-unsupported");
  assert.equal(resetCalls[0].serial, UDID);
  assert.equal(
    proxy.calls.some((call) => call.name === "mobile_run_task" && call.args.device_serial === UDID),
    true
  );
});

test("suite runner: iOS 失败任务（test_summary）走分类", async () => {
  __resetIosTasks();
  const { dir, runtime } = await setupIos();
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "failed",
    device_serial: UDID,
    error: "未找到按钮",
    test_summary: {
      task_status: "failed",
      passed: 0,
      failed: 1,
      failed_items: [{ item_text: "未找到按钮", evidence: "未找到按钮" }]
    }
  });
  const report = await runGeneratedTests(runtime, {
    deviceSerial: UDID,
    sleep: async () => {},
    pollIntervalMs: 0
  });
  assert.equal(report.failed, 1);
  const failure = report.cases[0].failure;
  assert.ok(failure, "failure classification present");
  assert.equal(typeof failure.domain, "string");
  assert.equal(report.cases[0].testSummary.failed, 1);
});
