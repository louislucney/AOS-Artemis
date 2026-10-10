import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { buildRunReport } from "../dist/figma/run-report.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const CASES = [
  {
    id: "case-1",
    name: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "run case 1"
  },
  {
    id: "case-2",
    name: "我的 → 登录",
    screens: ["我的", "登录"],
    steps: ["点击「登录」（页面应出现「账号」）"],
    preconditions: ["应用已安装且可正常启动", "「登录」需要有效账号可完成登录"],
    expectations: [
      { screen: "登录", hints: ["账号"], provenance: "explicit", confidence: "high", kind: "assert" },
      { screen: "首页", hints: [], provenance: "inferred", confidence: "low", kind: "explore" },
      { screen: "我的", hints: [], provenance: "inferred", confidence: "low", kind: "explore" }
    ],
    taskDesc: "run case 2"
  }
];

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy(), store });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: CASES }));

  const tracesDir = runtime.traceDir("trace-1");
  fs.mkdirSync(tracesDir, { recursive: true });
  fs.writeFileSync(
    path.join(tracesDir, "status.json"),
    JSON.stringify({
      status: "completed",
      notes_dir: "/notes/1",
      stderr_log: "/err/1",
      start_time: 1000,
      end_time: 1002.5
    })
  );
  const failedDir = runtime.traceDir("trace-2");
  fs.mkdirSync(failedDir, { recursive: true });
  fs.writeFileSync(
    path.join(failedDir, "status.json"),
    JSON.stringify({
      status: "failed",
      error: "assert mismatch",
      notes_dir: "/notes/2",
      test_summary: {
        task_status: "failed",
        failed_items: [{ item_text: "登录", evidence: "请先登录后重试" }]
      },
      start_time: 2000,
      end_time: 2003
    })
  );

  await store.recordTask({
    rootPath: dir,
    traceId: "trace-1",
    caseId: "case-1",
    model: "deepseek-chat",
    status: "completed",
    taskDesc: "run case 1",
    finishedAt: "2026-10-02T00:00:10.000Z"
  });
  await store.recordTask({
    rootPath: dir,
    traceId: "trace-2",
    caseId: "case-2",
    model: "deepseek-chat",
    status: "failed",
    taskDesc: "run case 2",
    finishedAt: "2026-10-02T00:00:20.000Z"
  });
  await store.recordTask({
    rootPath: dir,
    traceId: "trace-3",
    caseId: null,
    status: "submitted",
    taskDesc: "ad-hoc task\nsecond line"
  });
  return { dir, runtime, designDir };
}

test("run report: ledger rows get outcome, duration, evidence and failure domain", async () => {
  const { dir, runtime, designDir } = await setup();
  const report = await buildRunReport(runtime, { save: false });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.cases.map((entry) => entry.traceId),
    ["trace-1", "trace-2", "trace-3"]
  );
  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.pending, 1);

  const passed = report.cases[0];
  assert.equal(passed.name, "Home → Checkout");
  assert.equal(passed.outcome, "passed");
  assert.equal(passed.durationMs, 2500);
  assert.equal(passed.evidence.notesDir, "/notes/1");
  assert.equal(passed.evidence.stderrLog, "/err/1");
  assert.ok(passed.evidence.traceDir.startsWith(path.join(designDir, "..")));
  assert.equal(passed.failure, null);

  const failed = report.cases[1];
  assert.equal(failed.name, "我的 → 登录");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.durationMs, 3000);
  assert.equal(failed.failure.domain, "data-environment");
  assert.equal(failed.failure.confidence, "high");
  assert.ok(failed.failure.evidence.some((entry) => entry.startsWith("precondition:")));

  const pending = report.cases[2];
  assert.equal(pending.outcome, "pending");
  assert.equal(pending.name, "ad-hoc task");
  assert.equal(pending.durationMs, null);
  assert.equal(pending.failure, null);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.xlsx")), false);
});

test("run report: writes xlsx result sheet and JUnit XML without touching tests.xlsx", async () => {
  const { runtime, designDir } = await setup();
  const report = await buildRunReport(runtime, { stamp: "20261002-000000" });

  assert.equal(report.ok, true);
  assert.equal(report.saved.xlsx, path.join(designDir, "reports", "run-20261002-000000.xlsx"));
  assert.equal(report.saved.junit, path.join(designDir, "reports", "run-20261002-000000.xml"));
  assert.ok(fs.existsSync(report.saved.xlsx));
  assert.ok(fs.existsSync(report.saved.junit));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(report.saved.xlsx));
  const sheet = workbook.getWorksheet("运行报告");
  assert.ok(sheet);
  assert.equal(sheet.getRow(1).getCell(1).value, "#");
  assert.equal(sheet.getRow(1).getCell(4).value, "结果");
  assert.equal(sheet.getRow(1).getCell(10).value, "脚本来源");
  assert.equal(sheet.getRow(2).getCell(2).value, "Home → Checkout");
  assert.equal(sheet.getRow(2).getCell(4).value, "passed");
  assert.equal(sheet.getRow(2).getCell(6).value, 2.5);
  assert.equal(sheet.getRow(3).getCell(8).value, "data-environment");
  assert.equal(sheet.getRow(3).getCell(10).value, "断言 1 / 探索 2");
  assert.match(sheet.getRow(3).getCell(12).value, /trace: .*trace-2/);

  const junit = fs.readFileSync(report.saved.junit, "utf-8");
  assert.match(junit, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(junit, /<testsuites tests="3" failures="1" skipped="1">/);
  assert.match(junit, /<testsuite name="aos-run" tests="3" failures="1" skipped="1" time="5\.500">/);
  assert.match(junit, /<testcase name="我的 → 登录" classname="case-2" time="3\.000">/);
  assert.match(junit, /<failure type="data-environment" message="[^"]*数据假设/);
  assert.match(junit, /<skipped message="pending \(submitted\)"\/>/);
});

test("run report: caseIds filter and save:false leave no artifacts", async () => {
  const { runtime, designDir } = await setup();
  const filtered = await buildRunReport(runtime, { caseIds: ["case-2"] });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.cases[0].traceId, "trace-2");
  assert.equal(fs.existsSync(filtered.saved.xlsx), true);
  assert.equal(fs.existsSync(filtered.saved.junit), true);

  const reportsDir = path.join(designDir, "reports");
  fs.rmSync(reportsDir, { recursive: true, force: true });
  const dry = await buildRunReport(runtime, { save: false });
  assert.equal(dry.saved, undefined);
  assert.equal(fs.existsSync(reportsDir), false);
});

test("run report: API error artifact feeds xlsx columns and JUnit failure content", async () => {
  const { runtime } = await setup();
  fs.writeFileSync(
    path.join(runtime.traceDir("trace-2"), "api-errors.json"),
    JSON.stringify({
      traceId: "trace-2",
      serial: "emulator-5554",
      window: { startMs: 1, endMs: 2 },
      source: "logcat",
      degraded: null,
      errors: [
        {
          code: "AUTH_401",
          handler: "relogin",
          expect: "跳转登录页",
          handled: false,
          verdict: "unhandled",
          count: 2,
          firstAt: "10-02 04:11:42.319",
          sample: "HTTP 401 Unauthorized"
        }
      ]
    })
  );

  const report = await buildRunReport(runtime, { save: true, stamp: "api" });
  const failed = report.cases.find((entry) => entry.traceId === "trace-2");
  assert.equal(failed.failure.domain, "api-error");
  assert.equal(failed.apiErrors[0].code, "AUTH_401");
  assert.equal(failed.apiErrorsDegraded, null);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(report.saved.xlsx));
  const sheet = workbook.getWorksheet("运行报告");
  const rowIndex = report.cases.findIndex((entry) => entry.traceId === "trace-2") + 2;
  assert.match(sheet.getRow(rowIndex).getCell(13).value, /AUTH_401\(unhandled ×2\)/);
  assert.match(sheet.getRow(rowIndex).getCell(14).value, /AUTH_401=relogin/);

  assert.match(
    fs.readFileSync(report.saved.junit, "utf-8"),
    /api_error: AUTH_401 verdict=unhandled handler=relogin/
  );
});
