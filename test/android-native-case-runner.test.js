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

const sqlite = await import("node:sqlite").catch(() => null);
const sqliteSkip = sqlite ? false : "node:sqlite unavailable (Node < 22.5)";

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
    project: { rootDir: traceDir },
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
    async recordTaskResult(entry) {
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

test(
  "android native: 终端后用 data_engine.db OCR 计算脚本断言并落盘",
  { skip: sqliteSkip },
  async () => {
    const calls = [];
    const submissions = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-native-adh-"));
    const traceDir = path.join(root, "trace-native-1");
    fs.mkdirSync(traceDir, { recursive: true });
    const db = new sqlite.DatabaseSync(path.join(root, "data_engine.db"));
    db.exec(`CREATE TABLE steps (
      step_id TEXT PRIMARY KEY,
      session_id TEXT,
      step_number INTEGER,
      pre_image_name TEXT,
      post_image_name TEXT,
      action_taken TEXT
    )`);
    db.exec(`CREATE TABLE images (image_name TEXT PRIMARY KEY, ocr_result TEXT)`);
    db.prepare(
      "INSERT INTO steps (step_id, session_id, step_number, pre_image_name, post_image_name, action_taken) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", "trace-native-1", 1, "img1", "img2", JSON.stringify({ action: "tap" }));
    db.prepare("INSERT INTO images (image_name, ocr_result) VALUES (?, ?)").run(
      "img1",
      JSON.stringify([{ text: "首頁" }])
    );
    db.prepare("INSERT INTO images (image_name, ocr_result) VALUES (?, ?)").run(
      "img2",
      JSON.stringify([{ text: "我的" }])
    );
    db.close();
    const runtime = runtimeStub(calls, submissions, traceDir);
    const plan =
      '【AOS-EXPECT】{"start":{"screen":"首頁","hints":["首頁"]},"steps":[{"index":1,"screen":"首頁","hints":["我的"]},{"index":2,"screen":"設定","hints":["設定"]}]}';

    try {
      const outcome = await executeCase(
        androidCase({ taskDesc: `打开首页\n${plan}` }),
        contextStub(runtime)
      );
      assert.equal(outcome.result.status, "passed");
      assert.equal(outcome.result.testSummary.adherence.checkable, 2);
      assert.equal(outcome.result.testSummary.adherence.satisfied, 1);
      assert.equal(outcome.result.testSummary.adherence.unresolved, 1);
      const artifact = JSON.parse(
        fs.readFileSync(path.join(traceDir, "android-adherence.json"), "utf8")
      );
      assert.equal(artifact.start.status, "matched");
      assert.equal(artifact.adherence.unresolved[0].screen, "設定");
      assert.equal(calls[0].args.task_desc, "打开首页");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test("android native: engine=native executes structured runner without Artemis", async () => {
  const calls = [];
  const submissions = [];
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-native-structured-"));
  const runtime = runtimeStub(calls, submissions, traceDir);
  const device = {
    serial: ANDROID,
    platform: "android",
    capabilities: { back: "keyevent" },
    async size() {
      return { width: 1080, height: 2400 };
    },
    async nodes() {
      return [
        {
          id: "com.example:id/search",
          label: "搜索",
          value: "",
          type: "android.widget.EditText",
          rect: { x: 20, y: 100, width: 300, height: 60 }
        }
      ];
    },
    async tap() {},
    async inputText() {},
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };

  try {
    const outcome = await executeCase(
      androidCase({
        engine: "native",
        actions: [
          {
            stepIndex: 0,
            action: "tap",
            target: { kind: "resource-id", value: "com.example:id/search" },
            expect: { hints: ["搜索"] }
          }
        ]
      }),
      contextStub(runtime, { androidDevice: device })
    );
    assert.equal(outcome.submitted, true);
    assert.equal(outcome.result.status, "passed", JSON.stringify(outcome.result));
    assert.equal(outcome.result.engine, "native-android");
    assert.equal(calls.length, 0, "must not submit mobile_run_task");
    assert.ok(fs.existsSync(path.join(traceDir, "native-android.json")));
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
});
