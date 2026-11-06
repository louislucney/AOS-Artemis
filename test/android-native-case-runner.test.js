import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeCase,
  stripIosExpectation,
  taskDescForTarget
} from "../dist/figma/case-runner.js";

const ANDROID = "10CF6609P900059";
const IOS_SIM = "11111111-1111-1111-1111-111111111111";

function androidCase(overrides = {}) {
  return {
    id: "TC_01",
    name: "Check the UI of the Register page",
    semanticId: null,
    displayId: "TC_01",
    preconditions: [],
    taskDesc: "打开登录页\n【AOS-EXPECT】Register now",
    screens: ["Register"],
    feature: null,
    exploreSteps: [],
    hintScreens: [],
    scriptProvenance: { asserts: 1, explores: 0 },
    ...overrides
  };
}

function runtimeStub(calls, submissions, traceDir) {
  return {
    configDirAbs: traceDir,
    proxy: {
      async callTool(name, args) {
        calls.push({ name, args });
        return {
          content: [{ type: "text", text: JSON.stringify({ trace_id: "trace-native-1" }) }]
        };
      }
    },
    traceDir() {
      return traceDir;
    },
    async traceStatus() {
      return {
        traceId: "trace-native-1",
        status: "completed",
        deviceSerial: ANDROID,
        error: null,
        message: null,
        testSummary: null,
        notesDir: null,
        stderrLog: null,
        stdoutLog: null,
        startTimeMs: 100,
        endTimeMs: 200
      };
    },
    async recordTaskSubmission(entry) {
      submissions.push(entry);
    },
    async syncTaskStatuses() {},
    async flushCrashScans() {}
  };
}

function contextStub(runtime, overrides = {}) {
  return {
    runtime,
    model: null,
    deviceSerial: ANDROID,
    lockedAppPackage: "com.exxonmobil.mobil.gusp.uat",
    appPath: "/tmp/app-under-test.apk",
    quarantined: false,
    failOnApiErrors: false,
    apiCatalog: null,
    resetFn: async () => ({
      ok: true,
      serial: ANDROID,
      adb: { path: null, source: "missing" },
      commands: []
    }),
    iosDeviceWda: null,
    sleep: async () => {},
    now: () => 1_000,
    pollIntervalMs: 1,
    pollTimeoutMs: 2_000,
    collectLogcat: async () => ({ status: "unsupported", reason: "test" }),
    collectIosLogs: async () => ({ status: "unsupported", reason: "test" }),
    ...overrides
  };
}

test("android native: strips iOS expectation block before submission", () => {
  assert.equal(taskDescForTarget("a\n【AOS-EXPECT】b", ANDROID), "a");
  assert.equal(stripIosExpectation("a\n【AOS-EXPECT】b"), "a");
  assert.equal(taskDescForTarget("a\n【AOS-EXPECT】b", IOS_SIM), "a\n【AOS-EXPECT】b");
});

test("android native: executeCase submits mobile_run_task and never touches scripts", async () => {
  const calls = [];
  const submissions = [];
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-native-case-"));
  const runtime = runtimeStub(calls, submissions, traceDir);

  try {
    const outcome = await executeCase(androidCase(), contextStub(runtime));

    assert.equal(outcome.submitted, true);
    assert.equal(outcome.result.status, "passed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "mobile_run_task");
    assert.equal(calls[0].args.task_desc, "打开登录页");
    assert.equal(calls[0].args.device_serial, ANDROID);
    assert.equal(calls[0].args.locked_app_package, "com.exxonmobil.mobil.gusp.uat");
    assert.equal(calls[0].args.app_path, "/tmp/app-under-test.apk");
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].traceId, "trace-native-1");
    assert.equal(submissions[0].caseId, "TC_01");
    assert.equal(calls.some((call) => /script|maestro/i.test(call.name)), false);
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
});
