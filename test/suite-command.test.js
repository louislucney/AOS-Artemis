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
