import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCase } from "../dist/figma/case-runner.js";

const IOS_UDID = "00008101-000359440C69001E";

function proxyCase() {
  return {
    id: "TC_ABORT",
    name: "abort trace",
    semanticId: null,
    displayId: "TC_ABORT",
    preconditions: [],
    taskDesc: "run abort case",
    screens: ["Home"],
    feature: null,
    exploreSteps: [],
    hintScreens: [],
    scriptProvenance: { asserts: 1, explores: 0 }
  };
}

test("iOS proxy: 取消后把仍为 running 的 trace 落成 cancelled", async () => {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-abort-trace-"));
  const traceId = "ios-abort-1";
  const calls = [];
  const runtime = {
    configDirAbs: traceDir,
    project: { rootDir: traceDir },
    store: {},
    proxy: {
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "mobile_run_task") {
          return { content: [{ type: "text", text: JSON.stringify({ trace_id: traceId }) }] };
        }
        return { content: [] };
      }
    },
    traceDir() {
      return traceDir;
    },
    async traceStatus() {
      return {
        traceId,
        status: "running",
        deviceSerial: IOS_UDID,
        error: null,
        message: "running",
        testSummary: null,
        notesDir: null,
        stderrLog: null,
        stdoutLog: null,
        startTimeMs: 1000,
        endTimeMs: null
      };
    },
    async recordTaskSubmission() {},
    async recordTaskResult() {},
    async syncTaskStatuses() {},
    async flushCrashScans() {}
  };
  const context = {
    runtime,
    model: null,
    deviceSerial: IOS_UDID,
    lockedAppPackage: "com.exxonmobil.mobil.gusp.beta",
    quarantined: false,
    failOnApiErrors: false,
    apiCatalog: null,
    resetFn: async () => ({
      ok: true,
      serial: IOS_UDID,
      adb: { path: null, source: "missing" },
      commands: []
    }),
    iosDeviceWda: null,
    sleep: async () => {},
    now: () => 1_000,
    pollIntervalMs: 1,
    pollTimeoutMs: 2_000,
    shouldAbort: () => true,
    collectLogcat: async () => ({ status: "unsupported", reason: "test" }),
    collectIosLogs: async () => ({ status: "unsupported", reason: "test" })
  };
  fs.writeFileSync(
    path.join(traceDir, "status.json"),
    JSON.stringify({
      trace_id: traceId,
      platform: "ios",
      device_serial: IOS_UDID,
      status: "running",
      start_time: 1,
      end_time: null
    })
  );
  fs.writeFileSync(
    path.join(traceDir, "run.json"),
    JSON.stringify({
      schema_version: 1,
      trace_id: traceId,
      platform: "ios",
      status: "running",
      steps: [
        { step: 1, action: "tap", outcome: "ok" },
        { step: 2, action: "text", outcome: "参数错误" }
      ]
    })
  );
  try {
    const outcome = await executeCase(proxyCase(), context);
    assert.equal(outcome.submitted, true);
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.traceId, traceId);
    assert.equal(
      calls.some((call) => call.name === "mobile_manage_task" && call.args.action === "stop"),
      true,
      "取消时必须向 Artemis 发送 stop"
    );
    const status = JSON.parse(fs.readFileSync(path.join(traceDir, "status.json"), "utf8"));
    assert.equal(status.status, "cancelled");
    assert.match(status.error, /任务已取消/);
    assert.equal(typeof status.end_time, "number");
    const evidence = JSON.parse(
      fs.readFileSync(path.join(traceDir, "execution-evidence.json"), "utf8")
    );
    assert.equal(evidence.stepsAvailable, true);
    assert.deepEqual(evidence.steps, [
      { index: 1, action: "tap", status: "passed" },
      { index: 2, action: "text", status: "failed" }
    ]);
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
});
