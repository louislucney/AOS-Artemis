import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runGeneratedTests, suiteResetFor } from "../dist/figma/suite-runner.js";
import { loadReconciliation } from "../dist/figma/reconciliation.js";
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
  fs.writeFileSync(
    path.join(runtime.configDirAbs, "design", "error-codes.json"),
    JSON.stringify({ version: 1, codes: { AUTH_401: { match: "HTTP\\s*401" } } })
  );
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "completed",
    device_serial: UDID,
    message: "done",
    start_time: 1000,
    end_time: 1010
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
    apiErrors: true,
    iosLogCollector: async () => ({
      status: "skipped",
      reason: "ios-log-unsupported",
      text: "",
      serial: UDID
    })
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

test("suite runner: iOS 复位异常 reason 归 iOS 侧（launch-failed → environment）", async () => {
  __resetIosTasks();
  const { dir, runtime } = await setupIos();
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "failed",
    device_serial: UDID,
    error: "任务失败"
  });
  const report = await runGeneratedTests(runtime, {
    deviceSerial: UDID,
    lockedAppPackage: "com.apple.Preferences",
    reset: async () => {
      throw new Error("idb boom");
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    apiErrors: false
  });
  assert.equal(report.cases[0].reset.reason, "launch-failed");
  assert.equal(report.cases[0].failure.domain, "environment");
  assert.match(report.cases[0].failure.reason, /launch-failed/);
});

test("suite runner: iOS trace 仅执行器记账（platform 字段优先，不重复）", async () => {
  __resetIosTasks();
  const { dir, runtime } = await setupIos();
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "completed",
    platform: "ios",
    device_serial: UDID
  });
  const report = await runGeneratedTests(runtime, {
    deviceSerial: UDID,
    sleep: async () => {},
    pollIntervalMs: 0,
    apiErrors: false
  });
  assert.equal(report.passed, 1);
  assert.equal((await runtime.taskList(10)).length, 0);
});

test("suite runner: ios- 前缀 fallback 同样跳过套件记账", async () => {
  __resetIosTasks();
  const dir = makeTempProject({ config: baseConfig() });
  const traceId = "ios-12345678-1234-4123-8123-123456789012";
  const proxy = new SuiteProxy({ statuses: { [traceId]: { status: "completed", device_serial: UDID } } });
  proxy.callTool = async function (name, args) {
    if (name === "mobile_run_task") {
      return { content: [{ type: "text", text: JSON.stringify({ trace_id: traceId }) }] };
    }
    return SuiteProxy.prototype.callTool.call(this, name, args);
  };
  const { runtime } = await loadTestRuntime(dir, { proxy });
  runtime.proxy = proxy;
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: [caseEntry(1)] }));
  const report = await runGeneratedTests(runtime, {
    deviceSerial: UDID,
    sleep: async () => {},
    pollIntervalMs: 0,
    apiErrors: false
  });
  assert.equal(report.passed, 1);
  assert.equal((await runtime.taskList(10)).length, 0);
});

test("suite runner: iOS 探索命中写入对账资产（same trace 幂等）", async () => {
  __resetIosTasks();
  const { dir, runtime } = await setupIos();
  fs.writeFileSync(
    path.join(runtime.configDirAbs, "design", "tests.json"),
    JSON.stringify({
      flows: [
        {
          id: "case-1",
          name: "Case 1",
          screens: ["首頁", "選擇門市", "店員推薦"],
          steps: ["探索到达「選擇門市」（来源未确认）：自行尝试触发通往该页的交互"],
          preconditions: [],
          taskDesc: "run ios case 1",
          expectations: [
            { index: 1, screen: "選擇門市", hints: [], provenance: "inferred", confidence: "low", kind: "explore" },
            { index: 2, screen: "店員推薦", hints: [], provenance: "inferred", confidence: "low", kind: "explore" },
            { index: 3, screen: "確認頁", hints: ["訂單成立"], provenance: "explicit", confidence: "high", kind: "assert" }
          ]
        }
      ]
    })
  );
  writeStatus(dir, "trace-1", {
    trace_id: "trace-1",
    status: "completed",
    device_serial: UDID,
    message: "done"
  });
  fs.writeFileSync(
    path.join(runtime.configDirAbs, "design", "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "確認頁",
          suggestedRoute: "/confirm",
          childNames: [],
          textHints: [
            {
              text: "訂單成立",
              textClass: "runtime-text",
              nodeId: "node-confirm",
              bounds: { x: 20, y: 100, width: 200, height: 30 }
            }
          ],
          bounds: { x: 0, y: 0, width: 390, height: 844 }
        }
      ],
      edges: [],
      entryScreens: [],
      unresolvedDestinations: []
    })
  );
  fs.writeFileSync(
    path.join(runtime.traceDir("trace-1"), "run.json"),
    JSON.stringify({
      platform: "ios",
      status: "completed",
      steps: [{ step: 1, scriptHits: [1] }, { step: 2, screen: "確認頁 | 訂單成立 | 其他文案" }]
    })
  );

  const runOptions = {
    deviceSerial: UDID,
    reset: async (request) => ({
      ok: true,
      serial: request.serial ?? null,
      adb: { path: null, source: "missing" },
      commands: []
    }),
    sleep: async () => {},
    pollIntervalMs: 0,
    apiErrors: false
  };
  const report = await runGeneratedTests(runtime, runOptions);
  assert.equal(report.passed, 1);

  const asset = loadReconciliation(runtime.configDirAbs);
  assert.equal(asset.edges.length, 2);
  const upgraded = asset.edges.find((entry) => entry.to === "選擇門市");
  assert.equal(upgraded.from, "首頁");
  assert.equal(upgraded.status, "upgraded");
  assert.equal(upgraded.provenance, "runtime-observed");
  assert.deepEqual(upgraded.traces, ["trace-1"]);
  const pending = asset.edges.find((entry) => entry.to === "店員推薦");
  assert.equal(pending.from, "選擇門市");
  assert.equal(pending.status, "pending", "un-reached exploration is registered as a reconciliation gap");
  assert.equal(pending.hits, 0);

  const screenMap = JSON.parse(
    fs.readFileSync(path.join(runtime.configDirAbs, "design", "screen-map.json"), "utf-8")
  );
  assert.equal(screenMap.elements.length, 1, "observed labels produce element-level mappings");
  assert.equal(screenMap.elements[0].screen, "確認頁");
  assert.equal(screenMap.elements[0].text, "訂單成立");
  assert.match(screenMap.elements[0].identifier, /^element_[0-9a-f]{8}$/);
  assert.equal(screenMap.elements[0].hits, 1);
  assert.equal(screenMap.elements[0].designNodeId, "node-confirm", "design node identity is anchored");
  assert.ok(
    Math.abs(screenMap.elements[0].bounds.x - 20 / 390) < 1e-9,
    "bounds are normalized within the design screen"
  );
});
