import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import {
  buildRunReport,
  buildTaskRunReport,
  updateTestsWorkbookWithResults
} from "../dist/figma/run-report.js";
import { renderTestsWorkbook } from "../dist/figma/test-xlsx.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const TEST_RESULT_HEADERS = [
  "#",
  "用例编号",
  "caseId",
  "用例名称",
  "结果",
  "台账状态",
  "功能",
  "端",
  "设备",
  "耗时(ms)",
  "traceId",
  "失败域",
  "失败原因",
  "API 错误",
  "证据路径",
  "批次",
  "运行时间"
];

const CASES = [
  {
    id: "case-1",
    name: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "run case 1",
    feature: "f-1"
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
  await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });
  return { dir, runtime, designDir, store };
}

test("run report: 摘要包含 designWarnings", async () => {
  const { runtime, designDir } = await setup();
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [],
      edges: [],
      warnings: [
        { code: "flow-graph-empty", message: "流程图为空" },
        { code: "vision-degraded", message: "视觉识别不可用" }
      ]
    })
  );

  const report = await buildRunReport(runtime, { save: false });

  assert.equal(report.designWarnings.available, true);
  assert.equal(report.designWarnings.total, 2);
  assert.deepEqual(report.designWarnings.codes, ["flow-graph-empty", "vision-degraded"]);
  assert.deepEqual(report.designWarnings.byCode, { "flow-graph-empty": 1, "vision-degraded": 1 });
  assert.ok(!Number.isNaN(Date.parse(report.designWarnings.snapshotAt)));
});

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
  assert.equal(sheet.getRow(1).getCell(4).value, "功能");
  assert.equal(sheet.getRow(1).getCell(5).value, "端");
  assert.equal(sheet.getRow(1).getCell(6).value, "结果");
  assert.equal(sheet.getRow(1).getCell(12).value, "脚本来源");
  assert.equal(sheet.getRow(2).getCell(2).value, "Home → Checkout");
  assert.equal(sheet.getRow(2).getCell(4).value, "登录流程");
  assert.equal(sheet.getRow(2).getCell(5).value, "—");
  assert.equal(sheet.getRow(2).getCell(6).value, "passed");
  assert.equal(sheet.getRow(2).getCell(8).value, 2.5);
  assert.equal(sheet.getRow(3).getCell(10).value, "data-environment");
  assert.equal(sheet.getRow(3).getCell(12).value, "断言 1 / 探索 2");
  assert.match(sheet.getRow(3).getCell(14).value, /trace: .*trace-2/);

  const junit = fs.readFileSync(report.saved.junit, "utf-8");
  assert.match(junit, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(junit, /<testsuites tests="3" failures="1" skipped="1">/);
  assert.match(junit, /<testsuite name="aos-run" tests="3" failures="1" skipped="1" time="5\.500">/);
  assert.match(junit, /<testcase name="我的 → 登录" classname="case-2" time="3\.000">/);
  assert.match(junit, /<failure type="data-environment" message="[^"]*数据假设/);
  assert.match(junit, /<skipped message="pending \(submitted\)"\/>/);
});

test("run report: caseId 缺失时按 taskDesc 回填生成用例", async () => {
  const { dir, runtime } = await setup();
  fs.mkdirSync(runtime.traceDir("trace-4"), { recursive: true });
  fs.writeFileSync(
    path.join(runtime.traceDir("trace-4"), "status.json"),
    JSON.stringify({ status: "completed" })
  );
  await runtime.store.recordTask({
    rootPath: dir,
    traceId: "trace-4",
    caseId: null,
    model: "deepseek-chat",
    status: "completed",
    taskDesc: "run case 2",
    finishedAt: "2026-10-02T00:00:40.000Z"
  });
  const report = await buildRunReport(runtime);
  const entry = report.cases.find((item) => item.traceId === "trace-4");
  assert.equal(entry.caseId, "case-2", "taskDesc 命中时回填 caseId");
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
  assert.match(sheet.getRow(rowIndex).getCell(15).value, /AUTH_401\(unhandled ×2\)/);
  assert.match(sheet.getRow(rowIndex).getCell(16).value, /AUTH_401=relogin/);

  assert.match(
    fs.readFileSync(report.saved.junit, "utf-8"),
    /api_error: AUTH_401 verdict=unhandled handler=relogin/
  );
});

function taskRunInput(taskId, featureKey, featureName, cases) {
  return {
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: taskId,
      caseSetId: "cs-1",
      featureKey,
      featureName,
      platform: "android",
      device: "emulator-5554",
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: cases.length,
      passed: cases.filter((entry) => entry.status === "passed").length,
      failed: cases.filter((entry) => entry.status !== "passed").length,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: null
    },
    cases: cases.map((entry) => ({
      caseId: entry.caseId,
      name: entry.name ?? entry.caseId,
      featureKey,
      platform: "android",
      status: entry.status,
      traceId: entry.traceId ?? null,
      failureDomain: entry.failureDomain ?? null,
      failureConfidence: entry.failureConfidence ?? null,
      failureReason: entry.failureReason ?? null,
      durationMs: null,
      quarantined: false,
      flaky: false,
      verdict: null,
      verdictBy: null,
      verdictAt: null,
      verdictNote: null
    }))
  };
}

test("task report: 逐例来自 suite_runs、单功能命名、功能/端列", async () => {
  const { runtime, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath: runtime.project.rootDir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    ...taskRunInput(task.id, "f-1", "登录流程", [
      { caseId: "case-1", name: "Home → Checkout", status: "passed", traceId: "trace-1" },
      {
        caseId: "case-2",
        name: "我的 → 登录",
        status: "failed",
        traceId: "trace-2",
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中"
      }
    ])
  });

  const report = await buildTaskRunReport(runtime, { taskId: task.id, stamp: "20261014-100500" });
  assert.equal(report.ok, true);
  assert.equal(report.total, 2);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.cases[0].feature, "登录流程");
  assert.equal(report.cases[0].platform, "android");
  assert.equal(report.cases[1].failure.domain, "用例缺陷");
  assert.equal(
    report.saved.xlsx,
    path.join(runtime.configDirAbs, "design", "reports", "20261014-100500_登录流程_回归.xlsx")
  );
  assert.equal(
    report.saved.junit,
    path.join(runtime.configDirAbs, "design", "reports", "20261014-100500_登录流程_回归.xml")
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(report.saved.xlsx));
  const sheet = workbook.getWorksheet("运行报告");
  assert.equal(sheet.getRow(1).getCell(4).value, "功能");
  assert.equal(sheet.getRow(2).getCell(4).value, "登录流程");
  assert.equal(sheet.getRow(2).getCell(5).value, "android");
});

test("task report: 多功能 → 多功能N项 命名", async () => {
  const { runtime, store } = await setup();
  const task = await store.createRegressionTask({
    rootPath: runtime.project.rootDir,
    refs: [
      { caseSetId: "cs-1", featureKey: "f-1" },
      { caseSetId: "cs-2", featureKey: "f-2" }
    ],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    ...taskRunInput(task.id, "f-1", "登录流程", [{ caseId: "case-1", status: "passed" }])
  });
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    ...taskRunInput(task.id, "f-2", "下单流程", [{ caseId: "case-3", status: "passed" }]),
    createdAt: "2026-10-14T10:06:00.000Z"
  });

  const report = await buildTaskRunReport(runtime, { taskId: task.id, stamp: "20261014-101000" });
  assert.equal(
    report.saved.xlsx,
    path.join(runtime.configDirAbs, "design", "reports", "20261014-101000_多功能2项_回归.xlsx")
  );
  assert.ok(fs.existsSync(report.saved.xlsx));
});

test("updateTestsWorkbookWithResults: 独立执行结果 sheet，幂等且不动计划", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const testsXlsx = path.join(dir, "tests.xlsx");
  const workbookCases = CASES.map((entry, index) => ({
    ...entry,
    displayId: `TC_00000${index + 1}`,
    continuation: false,
    startScreen: entry.screens[0],
    prelude: [],
    expectations: entry.expectations ?? []
  }));
  fs.writeFileSync(
    testsXlsx,
    await renderTestsWorkbook(workbookCases, {
      source: "test",
      generatedAt: "2026-10-26T00:00:00Z",
      counts: { cases: 2, screens: 2, edges: 2 }
    })
  );
  const report = {
    ok: true,
    generatedAt: "2026-10-26T00:00:00Z",
    total: 2,
    passed: 1,
    failed: 1,
    pending: 0,
    cases: [
      {
        caseId: "case-1",
        name: "Home → Checkout",
        traceId: "trace-1",
        outcome: "passed",
        ledgerStatus: "completed",
        durationMs: 1200,
        model: null,
        feature: "f-1",
        platform: "android",
        runId: "run-1",
        device: "emulator-5554",
        startedAt: "2026-10-26T00:00:00Z",
        appVersion: "1.0",
        failure: null,
        scriptProvenance: null,
        failedItems: [],
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: {
          traceDir: "/tmp/trace-1",
          notesDir: null,
          stderrLog: null,
          stdoutLog: null
        }
      },
      {
        caseId: "case-2",
        name: "我的 → 登录",
        traceId: "trace-2",
        outcome: "failed",
        ledgerStatus: "failed",
        durationMs: 3400,
        model: null,
        feature: "f-1",
        platform: "ios",
        runId: "run-1",
        device: "iPhone",
        startedAt: "2026-10-26T00:00:01Z",
        appVersion: "1.0",
        failure: { domain: "app-defect", confidence: "high", reason: "崩溃", evidence: [] },
        scriptProvenance: null,
        failedItems: [],
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: {
          traceDir: "/tmp/trace-2",
          notesDir: null,
          stderrLog: null,
          stdoutLog: null
        }
      }
    ],
    traceability: null,
    designWarnings: null
  };
  const historyRun = (runId, platform, finishedAt, cases) => {
    const passed = cases.filter((entry) => entry.status === "passed").length;
    return {
      id: `run-${runId}`,
      projectId: null,
      createdAt: finishedAt,
      runId,
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: "f-1",
      featureName: "登录",
      platform,
      device: platform === "ios" ? "iPhone" : "emulator-5554",
      appVersion: "1.0",
      runner: null,
      status: "completed",
      startedAt: finishedAt,
      finishedAt,
      total: cases.length,
      passed,
      failed: cases.length - passed,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "pass",
      exitCode: 0,
      manifestPath: null,
      comparison: null,
      apiReview: null,
      cases: cases.map((entry) => ({
        caseId: entry.caseId,
        name: entry.name,
        featureKey: "f-1",
        platform,
        status: entry.status,
        traceId: null,
        failureDomain: null,
        failureConfidence: null,
        failureReason: null,
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null,
        jiraIssueKey: null
      }))
    };
  };
  const runs = [
    historyRun("run-ios", "ios", "2026-10-26T03:10:00Z", [
      { caseId: "case-1", name: "Home → Checkout", status: "failed" },
      { caseId: "case-2", name: "我的 → 登录", status: "passed" }
    ]),
    historyRun("run-android-new", "android", "2026-10-26T03:00:00Z", [
      { caseId: "case-1", name: "Home → Checkout", status: "passed" },
      { caseId: "case-2", name: "我的 → 登录", status: "failed" }
    ]),
    historyRun("run-android-old", "android", "2026-10-26T02:00:00Z", [
      { caseId: "case-1", name: "Home → Checkout", status: "failed" },
      { caseId: "case-2", name: "我的 → 登录", status: "passed" }
    ])
  ];
  const first = await updateTestsWorkbookWithResults(testsXlsx, report, { runs });
  assert.deepEqual(first, { path: testsXlsx, rows: 2, historyRows: 2 });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(testsXlsx);
  assert.ok(workbook.getWorksheet("测试用例"), "计划 sheet 保留");
  const sheet = workbook.getWorksheet("执行结果");
  assert.ok(sheet);
  assert.deepEqual(sheet.getRow(1).values.slice(1), TEST_RESULT_HEADERS);
  assert.equal(sheet.getRow(2).getCell(2).value, "TC_000001");
  assert.equal(sheet.getRow(2).getCell(5).value, "passed");
  assert.equal(sheet.getRow(2).getCell(9).value, "emulator-5554");
  assert.equal(sheet.getRow(2).getCell(16).value, "run-1");
  assert.equal(sheet.getRow(3).getCell(2).value, "TC_000002");
  assert.equal(sheet.getRow(3).getCell(12).value, "app-defect");
  assert.equal(sheet.getRow(3).getCell(13).value, "崩溃");

  const cross = workbook.getWorksheet("跨端对比");
  assert.ok(cross, "跨端对比 sheet");
  assert.deepEqual(cross.getRow(1).values.slice(1), [
    "#",
    "用例编号",
    "caseId",
    "用例名称",
    "功能",
    "Android",
    "iOS",
    "变化",
    "最近批次",
    "最近时间"
  ]);
  assert.equal(cross.getRow(2).getCell(1).value, 1);
  assert.equal(cross.getRow(2).getCell(2).value, "TC_000001");
  assert.equal(cross.getRow(2).getCell(6).value, "passed");
  assert.equal(cross.getRow(2).getCell(7).value, "failed");
  assert.equal(cross.getRow(2).getCell(8).value, "Android:修复；iOS:新增");
  assert.equal(cross.getRow(2).getCell(9).value, "run-ios");
  assert.equal(cross.getRow(3).getCell(6).value, "failed");
  assert.equal(cross.getRow(3).getCell(7).value, "passed");
  assert.equal(cross.getRow(3).getCell(8).value, "Android:回归；iOS:新增");

  await updateTestsWorkbookWithResults(testsXlsx, report, { runs });
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.readFile(testsXlsx);
  assert.equal(
    reread.worksheets.filter((entry) => entry.name === "执行结果").length,
    1,
    "重复回填替换而非追加"
  );
  assert.equal(reread.getWorksheet("执行结果").rowCount, 3);
  assert.equal(
    reread.worksheets.filter((entry) => entry.name === "跨端对比").length,
    1,
    "跨端对比也幂等"
  );
  assert.equal(reread.getWorksheet("跨端对比").rowCount, 3);

  await assert.rejects(
    updateTestsWorkbookWithResults(path.join(dir, "missing.xlsx"), report),
    /未找到 tests.xlsx/
  );
});
