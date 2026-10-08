import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  SuiteProxy,
  toPng
} from "./helpers.js";

function caseEntry(index, overrides = {}) {
  return {
    id: `case-${index}`,
    name: `Case ${index}`,
    screens: ["Home"],
    steps: ["点击「Go」，验证进入「Next」（页面应出现「Done」）"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: `run case ${index}`,
    ...overrides
  };
}

async function runCli(runtime, args, extra = {}) {
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(args, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...extra
  });
  return { code, logs, errors };
}

async function setupRun({ cases = [caseEntry(1)], statuses = {}, store, running = true } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const projectStore = store ?? new MemoryStore();
  const proxy = new SuiteProxy({ statuses, running });
  const crashCollector = { collect: async () => ({ status: "skipped", reason: "disabled" }) };
  const { runtime } = await loadTestRuntime(dir, {
    proxy,
    store: projectStore,
    crashCollector
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  if (cases) {
    fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: cases }));
  }
  return { dir, runtime, store: projectStore, proxy };
}

function writeStatus(runtime, traceId, payload) {
  const traceDir = runtime.traceDir(traceId);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, "status.json"), JSON.stringify(payload));
}

test("suite run: all cases pass → exit 0 with preflight and per-case lines", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1), caseEntry(2)],
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  const { code, logs, errors } = await runCli(runtime, ["run"]);
  assert.equal(code, 0);
  assert.equal(logs.filter((line) => line.startsWith("[PASS]")).length, 2);
  assert.ok(logs.some((line) => line.startsWith("预检:")));
  assert.ok(logs.some((line) => line.startsWith("结果: pass 2 / fail 0")));
  assert.deepEqual(errors, []);
});

test("suite run: failure keeps classification and hints at evidence", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1), caseEntry(2)],
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": {
        status: "failed",
        error: "assert mismatch",
        test_summary: {
          task_status: "failed",
          failed_items: [{ item_text: "校验金额", evidence: "expected 42 got 41" }]
        }
      }
    }
  });
  const { code, logs } = await runCli(runtime, ["run"]);
  assert.equal(code, 1);
  assert.ok(logs.some((line) => line.startsWith("[FAIL]") && line.includes("behavior-or-design")));
  assert.ok(logs.some((line) => line.includes("suite evidence trace-2")));
  assert.ok(logs.some((line) => line.startsWith("结果: pass 1 / fail 1")));
});

test("suite run: missing tests.json exits 2; --json prints the report", async () => {
  const missing = await setupRun({ cases: null });
  const failed = await runCli(missing.runtime, ["run"]);
  assert.equal(failed.code, 2);
  assert.ok(failed.errors.some((line) => line.includes("套件未执行")));

  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" } }
  });
  const { code, logs } = await runCli(runtime, ["run", "--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(logs.at(-1));
  assert.equal(payload.ok, true);
  assert.equal(payload.passed, 1);
  assert.match(payload.cases[0].caseId, /^case-/);
});

test("suite evidence: aggregates failed items and degrades explicitly", async () => {
  const { runtime } = await setupRun({ cases: null });
  writeStatus(runtime, "trace-9", {
    status: "failed",
    test_summary: {
      task_status: "failed",
      failed_items: [{ item_text: "登录", evidence: "请先登录后重试" }]
    }
  });
  const { code, logs } = await runCli(runtime, ["evidence", "trace-9", "--no-save"]);
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes("失败项 1:") && line.includes("请先登录后重试")));
  assert.ok(logs.some((line) => line.startsWith("降级:")));

  const idle = await setupRun({ cases: null, running: false });
  const offline = await runCli(idle.runtime, ["evidence", "ghost", "--no-save"]);
  assert.equal(offline.code, 1);
  assert.ok(offline.logs.some((line) => line.includes("ok=false")));

  const usage = await runCli(runtime, ["evidence"]);
  assert.equal(usage.code, 2);
  assert.ok(usage.errors.some((line) => line.includes("用法:")));
});

class ShotProxy {
  constructor({ shots, serial = "emulator-5554" } = {}) {
    this.shots = shots;
    this.serial = serial;
  }

  isRunning() {
    return true;
  }

  async ensureStarted() {}

  async listTools() {
    return [];
  }

  async callTool(name, args) {
    if (name === "mobile_inspect_trace" && args.action === "view_step_screenshots") {
      const entry = this.shots[args.step_number];
      if (!entry) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "no screenshot" }) }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              device_serial: this.serial,
              step_number: args.step_number,
              before_screenshot: entry.pre ?? null,
              after_screenshot: entry.post ?? null
            })
          }
        ]
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  }

  status() {
    return { running: true, pid: 1, restarts: 0, lastError: null, stderrTail: [], fingerprint: null };
  }

  async markForRestart() {}

  async dispose() {}

  disposeSync() {}
}

test("suite baseline: save/compare lifecycle with --fail-on gating", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const shotPath = path.join(dir, "step-post.png");
  const page = (withSquare) => {
    const image = createImage(390, 844);
    if (withSquare) fillRect(image, 40, 80, 120, 60, [30, 64, 175, 255]);
    return toPng(image);
  };
  fs.writeFileSync(shotPath, page(true));
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new ShotProxy({ shots: { 2: { post: shotPath } } })
  });

  const saved = await runCli(runtime, ["baseline", "save", "--case", "case-1", "--step", "2", "--trace", "trace-1"]);
  assert.equal(saved.code, 0);
  assert.ok(saved.logs.some((line) => line.startsWith("已保存基线")));

  const same = await runCli(runtime, [
    "baseline",
    "compare",
    "--case",
    "case-1",
    "--step",
    "2",
    "--trace",
    "trace-1",
    "--fail-on",
    "any"
  ]);
  assert.equal(same.code, 0);
  assert.ok(same.logs.some((line) => line.includes("新出现 0")));

  fs.writeFileSync(shotPath, page(false));
  const regressed = await runCli(runtime, [
    "baseline",
    "compare",
    "--case",
    "case-1",
    "--step",
    "2",
    "--trace",
    "trace-1",
    "--fail-on",
    "any"
  ]);
  assert.equal(regressed.code, 2);
  assert.ok(regressed.logs.some((line) => /新出现 [1-9]/.test(line)));

  const invalid = await runCli(runtime, ["baseline", "save", "--case", "case-1"]);
  assert.equal(invalid.code, 2);
});

test("suite report/feedback: ledger-derived artifacts and suggestions", async () => {
  const store = new MemoryStore();
  const { dir, runtime } = await setupRun({
    cases: [
      caseEntry(1),
      caseEntry(2, {
        name: "我的 → 登录",
        screens: ["我的", "登录"],
        preconditions: ["应用已安装且可正常启动", "「登录」需要有效账号可完成登录"]
      })
    ],
    store
  });
  writeStatus(runtime, "trace-1", { status: "completed" });
  writeStatus(runtime, "trace-2", {
    status: "failed",
    test_summary: {
      task_status: "failed",
      failed_items: [{ item_text: "登录", evidence: "请先登录后重试" }]
    }
  });
  for (const [traceId, caseId] of [
    ["trace-1", "case-1"],
    ["trace-2", "case-2"]
  ]) {
    await store.recordTask({
      rootPath: dir,
      traceId,
      caseId,
      status: traceId === "trace-1" ? "completed" : "failed",
      taskDesc: `run ${caseId}`,
      finishedAt: "2026-10-02T00:00:20.000Z"
    });
  }

  const report = await runCli(runtime, ["report", "--no-sync", "--stamp", "cli", "--json"]);
  assert.equal(report.code, 0);
  const reportPayload = JSON.parse(report.logs.at(-1));
  assert.equal(reportPayload.total, 2);
  assert.equal(reportPayload.passed, 1);
  assert.equal(reportPayload.failed, 1);
  assert.ok(fs.existsSync(reportPayload.saved.xlsx));
  assert.ok(fs.existsSync(reportPayload.saved.junit));
  assert.match(fs.readFileSync(reportPayload.saved.junit, "utf-8"), /<testsuites tests="2"/);

  const feedback = await runCli(runtime, ["feedback", "--min-failures", "1", "--json"]);
  assert.equal(feedback.code, 0);
  const feedbackPayload = JSON.parse(feedback.logs.at(-1));
  assert.ok(feedbackPayload.suggestions.some((suggestion) => suggestion.kind === "data"));
  assert.ok(feedbackPayload.suggestions.every((suggestion) => Array.isArray(suggestion.traceIds)));
});

test("suite help and unknown subcommands", async () => {
  const { runtime } = await setupRun({ cases: null });
  const help = await runCli(runtime, ["help"]);
  assert.equal(help.code, 0);
  assert.ok(help.logs.some((line) => line.includes("aos-mcp suite")));

  const unknown = await runCli(runtime, ["nope"]);
  assert.equal(unknown.code, 2);
  assert.ok(unknown.errors.some((line) => line.includes('未知 suite 子命令 "nope"')));
});

function writeErrorCodes(runtime, codes) {
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "error-codes.json"), JSON.stringify({ version: 1, codes }));
}

test("suite api-errors: injected collector matches the registry and persists the artifact", async () => {
  const { runtime } = await setupRun({ cases: null });
  writeErrorCodes(runtime, {
    AUTH_401: {
      match: "HTTP\\s*401",
      handler: "relogin",
      expect: "跳转登录页",
      handledPattern: "AuthInterceptor"
    }
  });
  writeStatus(runtime, "trace-9", {
    status: "failed",
    device_serial: "emulator-5554",
    start_time: 1000,
    end_time: 1010
  });
  const requests = [];
  const collector = async (request) => {
    requests.push(request);
    return {
      status: "ok",
      serial: "emulator-5554",
      clockWarning: false,
      text: "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized"
    };
  };

  const first = await runCli(runtime, ["api-errors", "trace-9"], { logcatCollector: collector });
  assert.equal(first.code, 0);
  assert.equal(requests[0].serial, "emulator-5554");
  assert.equal(requests[0].windowStartMs, 1000 * 1000);
  assert.ok(first.logs.some((line) => line.includes("AUTH_401 unhandled ×1 handler=relogin")));
  const artifactPath = path.join(runtime.traceDir("trace-9"), "api-errors.json");
  assert.ok(fs.existsSync(artifactPath));
  assert.equal(JSON.parse(fs.readFileSync(artifactPath, "utf-8")).errors[0].code, "AUTH_401");

  const noRegistry = await setupRun({ cases: null });
  const missing = await runCli(noRegistry.runtime, ["api-errors", "trace-9"], {});
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("注册表")));

  const noStatus = await runCli(runtime, ["api-errors", "ghost"], { logcatCollector: collector });
  assert.equal(noStatus.code, 1);
  assert.ok(noStatus.errors.some((line) => line.includes("时间窗")));
});

test("suite run: --fail-on api-error blocks and prints the API note", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: {
      "trace-1": {
        status: "completed",
        device_serial: "emulator-5554",
        start_time: 1000,
        end_time: 1010
      }
    }
  });
  writeErrorCodes(runtime, {
    AUTH_401: {
      match: "HTTP\\s*401",
      handler: "relogin",
      handledPattern: "AuthInterceptor"
    }
  });
  const collector = async () => ({
    status: "ok",
    serial: "emulator-5554",
    clockWarning: false,
    text: "10-02 04:11:42.319  1000  1000 E Api: HTTP 401 Unauthorized"
  });

  const report = await runCli(runtime, ["run", "--fail-on", "api-error"], {
    logcatCollector: collector
  });
  assert.equal(report.code, 1);
  assert.ok(report.logs.some((line) => line.includes("API 错误 AUTH_401(unhandled)")));
  assert.ok(report.logs.some((line) => line.includes("失败域 api-error")));
});

test("suite api-errors: iOS UDID 走 simctl 采集并标注 source", async () => {
  const { runtime } = await setupRun({ cases: null });
  writeErrorCodes(runtime, {
    AUTH_401: {
      match: "HTTP\\s*401",
      handler: "relogin"
    }
  });
  writeStatus(runtime, "ios-1234", {
    status: "failed",
    platform: "ios",
    device_serial: "65584900-E161-4125-8928-587499DD6457",
    start_time: 1000,
    end_time: 1010
  });
  const requests = [];
  const iosCollector = async (request) => {
    requests.push(request);
    return { status: "ok", serial: request.serial, text: "HTTP 401 Unauthorized" };
  };
  const result = await runCli(runtime, ["api-errors", "ios-1234", "--app", "com.example.MyApp"], {
    iosLogCollector: iosCollector
  });
  assert.equal(result.code, 0);
  assert.equal(requests[0].processName, "MyApp");
  const artifact = JSON.parse(
    fs.readFileSync(path.join(runtime.traceDir("ios-1234"), "api-errors.json"), "utf-8")
  );
  assert.equal(artifact.source, "simctl-log");
  assert.equal(artifact.errors[0].code, "AUTH_401");
});

test("suite run --fail-on-uncovered: exits 2 on uncovered flow, 0 when fully covered", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  const writeFlows = (payload) =>
    fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(payload), "utf-8");

  writeFlows({
    screens: [
      { id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "2", name: "Orphan", suggestedRoute: "/orphan", childNames: [], textHints: [] }
    ],
    edges: []
  });
  const gated = await runCli(runtime, ["run", "--fail-on-uncovered"]);
  assert.equal(gated.code, 2);
  assert.ok(gated.errors.some((line) => line.includes("流程未完整覆盖")));
  assert.ok(gated.logs.some((line) => line.startsWith("[PASS]")));

  writeFlows({
    screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
    edges: [{ from: { name: "Home" }, to: { name: "Home" } }]
  });
  const clean = await runCli(runtime, ["run", "--fail-on-uncovered"]);
  assert.equal(clean.code, 0);
  assert.deepEqual(clean.errors, []);
});

test("suite run --fail-on-uncovered: custom tests path is validated; missing flows.json fails closed", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "completed" } }
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  const qaDir = path.join(runtime.project.rootDir, "qa");
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(
    path.join(qaDir, "tests.json"),
    JSON.stringify({ flows: [caseEntry(1)] }),
    "utf-8"
  );

  const missingFlows = await runCli(runtime, ["run", "--tests", "qa/tests.json", "--fail-on-uncovered"]);
  assert.equal(missingFlows.code, 2);
  assert.ok(missingFlows.errors.some((line) => line.includes("缺 flows.json")));

  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
      edges: []
    }),
    "utf-8"
  );
  const okRun = await runCli(runtime, ["run", "--tests", "qa/tests.json", "--fail-on-uncovered"]);
  assert.equal(okRun.code, 0);
  assert.ok(okRun.logs.some((line) => line.startsWith("预检:")));
  assert.deepEqual(okRun.errors, []);
});

test("suite run --fail-on-uncovered: execution failure is reported before coverage issue", async () => {
  const { runtime } = await setupRun({ cases: null });
  const result = await runCli(runtime, ["run", "--fail-on-uncovered"]);
  assert.equal(result.code, 2);
  const executionIndex = result.errors.findIndex((line) => line.includes("套件未执行"));
  const coverageIndex = result.errors.findIndex((line) => line.includes("流程覆盖校验不可用"));
  assert.ok(executionIndex >= 0, "execution failure line present");
  assert.ok(coverageIndex >= 0, "coverage issue line present");
  assert.ok(executionIndex < coverageIndex, "execution failure comes first");
});

test("suite check: static coverage without device (0 complete, 2 uncovered/missing flows)", async () => {
  const { runtime, proxy } = await setupRun({ cases: [caseEntry(1)], statuses: {} });
  const designDir = path.join(runtime.configDirAbs, "design");
  const writeFlows = (payload) =>
    fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(payload), "utf-8");

  writeFlows({
    screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
    edges: []
  });
  const complete = await runCli(runtime, ["check"]);
  assert.equal(complete.code, 0);
  assert.ok(complete.logs.some((line) => line.includes("结论: 完整")));

  const jsonRun = await runCli(runtime, ["check", "--json"]);
  assert.equal(jsonRun.code, 0);
  assert.equal(JSON.parse(jsonRun.logs[0]).ok, true);
  assert.equal(proxy.calls.length, 0, "check never touches the device proxy");

  writeFlows({
    screens: [
      { id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "2", name: "Orphan", suggestedRoute: "/orphan", childNames: [], textHints: [] }
    ],
    edges: []
  });
  const incomplete = await runCli(runtime, ["check"]);
  assert.equal(incomplete.code, 2);
  assert.ok(incomplete.errors.some((line) => line.includes("流程未完整覆盖")));

  fs.rmSync(path.join(designDir, "flows.json"));
  const missing = await runCli(runtime, ["check"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("缺 flows.json")));
});

test("suite check: route drift warning (test screens absent from design, non-blocking)", async () => {
  const { runtime } = await setupRun({ cases: [caseEntry(1, { screens: ["Home", "ObservedOnly"] })] });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
      edges: []
    }),
    "utf-8"
  );
  const result = await runCli(runtime, ["check"]);
  assert.equal(result.code, 0);
  assert.ok(result.logs.some((line) => line.includes("路线漂移") && line.includes("ObservedOnly")));
});

test("suite calibrate: aligns xcresult report with the ledger and reports miss rate", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1), caseEntry(2)],
    statuses: {
      "trace-1": { status: "completed" },
      "trace-2": { status: "failed", error: "boom" }
    }
  });
  const run = await runCli(runtime, ["run"]);
  assert.equal(run.code, 1);

  const reportPath = path.join(runtime.project.rootDir, "qa", "xc.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      tests: [
        { name: "testFlow_case-1()", status: "Passed" },
        { name: "testFlow2_case-2()", status: "Passed" }
      ]
    }),
    "utf-8"
  );

  const result = await runCli(runtime, ["calibrate", "--report", "qa/xc.json", "--json", "--no-save"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.agreedPass, 1);
  assert.equal(payload.mcpFalseAlarm, 1);
  assert.equal(payload.missRate, null);
  assert.equal(payload.falseAlarmRate, 0.5);
});

test("suite calibrate: injected xcresult reader and --fail-on-miss gating", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" } }
  });
  const run = await runCli(runtime, ["run"]);
  assert.equal(run.code, 0);

  const result = await runCli(
    runtime,
    ["calibrate", "--xcresult", "/tmp/fake.xcresult", "--json", "--no-save", "--fail-on-miss"],
    { xcresultReader: async () => ({ tests: [{ name: "test_case-1()", status: "Failed" }] }) }
  );
  assert.equal(result.code, 2);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.mcpMiss, 1);
  assert.equal(payload.missRate, 1);
});

test("suite report: traceability matrix joins design, cases, traces and evidence", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1, { screens: ["Home", "Checkout"] })],
    statuses: { "trace-1": { status: "completed" } }
  });
  await runCli(runtime, ["run"]);
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        { id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
        { id: "2", name: "Checkout", suggestedRoute: "/c", childNames: [], textHints: [] },
        { id: "3", name: "Orphan", suggestedRoute: "/o", childNames: [], textHints: [] }
      ],
      edges: [{ from: { name: "Home" }, to: { name: "Checkout" } }]
    }),
    "utf-8"
  );

  const result = await runCli(runtime, ["report", "--json", "--no-save"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.deepEqual(payload.traceability.uncoveredScreens, ["Orphan"]);
  const home = payload.traceability.screens.find((entry) => entry.screen === "Home");
  assert.deepEqual(home.caseIds, ["case-1"]);
  assert.deepEqual(home.traceIds, ["trace-1"]);
});

test("suite run --retry: reruns failures for diagnosis; first-run result still gates", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: {
      "trace-1": { status: "failed", error: "transient" },
      "trace-2": { status: "completed" }
    }
  });
  const result = await runCli(runtime, ["run", "--retry", "1"]);
  assert.equal(result.code, 1, "first-run failure still gates");
  assert.ok(
    result.logs.some((line) => line.includes("重试 1 次") && line.includes("flaky，不计首跑")),
    "retry annotation is honest in text output"
  );
});

test("suite run --retry: retry annotation is machine-readable and counters stay first-run", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: {
      "trace-1": { status: "failed", error: "transient" },
      "trace-2": { status: "completed" }
    }
  });
  const result = await runCli(runtime, ["run", "--retry", "1", "--json"]);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.failed, 1, "counters reflect first run");
  assert.equal(payload.passed, 0);
  assert.deepEqual(payload.cases[0].retry, {
    attempts: 1,
    finalStatus: "passed",
    finalTraceId: "trace-2",
    flaky: true
  });
});

test("suite loop --skip-run: static closed-loop report without device (0 complete, 2 uncovered)", async () => {
  const { runtime } = await setupRun({ cases: [caseEntry(1)] });
  const designDir = path.join(runtime.configDirAbs, "design");
  const writeFlows = (payload) =>
    fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(payload), "utf-8");
  writeFlows({
    screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
    edges: []
  });

  const result = await runCli(runtime, ["loop", "--skip-run", "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.steps.check.issue, null);
  assert.equal(payload.steps.run, null);
  assert.ok(payload.nextActions.length >= 1);
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));
  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /测试闭环报告/);

  writeFlows({
    screens: [
      { id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "2", name: "Orphan", suggestedRoute: "/orphan", childNames: [], textHints: [] }
    ],
    edges: []
  });
  const incomplete = await runCli(runtime, ["loop", "--skip-run", "--no-save"]);
  assert.equal(incomplete.code, 2);
  assert.ok(incomplete.logs.some((line) => line.includes("未通过")));
});

test("suite loop: runs the loop with execution, feedback and calibration merge", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" } }
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [{ id: "1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }],
      edges: []
    }),
    "utf-8"
  );
  const calPath = path.join(runtime.project.rootDir, "qa", "cal.json");
  fs.mkdirSync(path.dirname(calPath), { recursive: true });
  fs.writeFileSync(
    calPath,
    JSON.stringify({
      generatedAt: "2026-10-08T00:00:00.000Z",
      xcSource: "fixture",
      matched: 1,
      mcpMiss: 1,
      mcpFalseAlarm: 0,
      agreedPass: 0,
      agreedFail: 0,
      missRate: 1,
      falseAlarmRate: null,
      cases: [],
      unmatchedXcTests: []
    }),
    "utf-8"
  );

  const result = await runCli(runtime, [
    "loop",
    "--calibration",
    "qa/cal.json",
    "--json",
    "--no-save"
  ]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.steps.run.passed, 1);
  assert.equal(payload.steps.feedback.suggestions, 0);
  assert.equal(payload.steps.calibration.mcpMiss, 1);
  assert.ok(payload.nextActions.some((line) => line.includes("MCP 漏报 1 例")));
});

test("suite calibrate: JUnit XML report (Android instrumentation) aligns by case_id", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" } }
  });
  const run = await runCli(runtime, ["run"]);
  assert.equal(run.code, 0);

  const xmlPath = path.join(runtime.project.rootDir, "qa", "android-results.xml");
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  fs.writeFileSync(
    xmlPath,
    '<testsuites><testsuite name="suite"><testcase classname="C" name="test_case-1()" time="0.1"/></testsuite></testsuites>',
    "utf-8"
  );

  const result = await runCli(runtime, ["calibrate", "--report", "qa/android-results.xml", "--json", "--no-save"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.agreedPass, 1);
  assert.equal(payload.matched, 1);
});

test("suite flake: repeated sampling detects a flaky case and saves the report", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "failed", error: "boom" } }
  });
  const result = await runCli(runtime, ["flake", "--cases", "case-1", "--runs", "2", "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.logs[0]);
  assert.equal(payload.runs, 2);
  assert.deepEqual(payload.cases[0].statuses, ["passed", "failed"]);
  assert.equal(payload.cases[0].flaky, true);
  assert.equal(payload.summary.flakyCases, 1);
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));
});

test("suite flake: --fail-on-flaky gates; missing/absent case ids are rejected", async () => {
  const { runtime } = await setupRun({
    cases: [caseEntry(1)],
    statuses: { "trace-1": { status: "completed" }, "trace-2": { status: "failed" } }
  });
  const flaky = await runCli(runtime, ["flake", "--cases", "case-1", "--runs", "2", "--fail-on-flaky", "--no-save"]);
  assert.equal(flaky.code, 2);

  const missing = await runCli(runtime, ["flake", "--cases", "case-nope", "--runs", "1"]);
  assert.equal(missing.code, 2);
  assert.ok(missing.errors.some((line) => line.includes("用例不存在")));

  const noCases = await runCli(runtime, ["flake"]);
  assert.equal(noCases.code, 2);
});
