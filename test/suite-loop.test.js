import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSuiteLoopReport,
  deriveLoopActions,
  renderSuiteLoopMarkdown
} from "../dist/figma/suite-loop.js";

function checkInput({ issue = null, weak = 0, uncoveredScreens = [], uncoveredEdges = [], drift = [] } = {}) {
  return {
    testsPath: "/p/.artemis/design/tests.json",
    preflight: {
      cases: 2,
      weakCases: Array.from({ length: weak }, (_, index) => ({
        id: `c${index}`,
        name: `c${index}`,
        weakSteps: []
      })),
      coverage: {
        available: true,
        designScreens: ["Home"],
        screens: ["Home"],
        uncoveredScreens,
        uncoveredEdges
      },
      generation: null
    },
    issue,
    routeDrift: drift
  };
}

function runInput() {
  return {
    ok: true,
    testsPath: "tests.json",
    total: 2,
    executed: 2,
    skipped: 0,
    passed: 1,
    failed: 1,
    preflight: null,
    apiErrorCatalog: null,
    cases: [
      {
        caseId: "c1",
        name: "c1",
        status: "passed",
        traceId: "t1",
        error: null,
        testSummary: null,
        failure: null,
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
        reset: null
      },
      {
        caseId: "c2",
        name: "c2",
        status: "failed",
        traceId: "t2",
        error: "boom",
        testSummary: null,
        failure: { domain: "应用缺陷", confidence: "low", reason: "x" },
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
        reset: null,
        retry: { attempts: 1, finalStatus: "passed", finalTraceId: "t3", flaky: true }
      }
    ]
  };
}

function feedbackInput() {
  return {
    ok: true,
    generatedFrom: { tasks: 2, failed: 1, baselines: 0 },
    issues: {
      screens: [{ screen: "Home", failures: 2, caseIds: ["c2"], traceIds: ["t2"] }],
      assertions: [],
      data: [{ precondition: "有账号", failures: 1, caseIds: ["c2"], traceIds: ["t2"] }],
      weakAssertions: [],
      visualHotspots: [],
      apiErrors: [{ code: "AUTH_401", handler: null, expect: null, occurrences: 1, caseIds: ["c2"], traceIds: ["t2"] }]
    },
    suggestions: [
      { kind: "data", message: "补数据前置", targets: {}, caseIds: ["c2"], traceIds: ["t2"] }
    ]
  };
}

function calibrationInput() {
  return {
    generatedAt: "2026-10-08T00:00:00.000Z",
    xcSource: "fixture",
    matched: 2,
    mcpMiss: 1,
    mcpFalseAlarm: 0,
    agreedPass: 1,
    agreedFail: 0,
    missRate: 1,
    falseAlarmRate: null,
    cases: [],
    unmatchedXcTests: []
  };
}

test("deriveLoopActions: deterministic next actions from every loop gap", () => {
  const actions = deriveLoopActions({
    generatedAt: "2026-10-08T00:00:00.000Z",
    check: checkInput({ issue: "流程未完整覆盖：未覆盖屏幕 1", weak: 1, drift: ["ObservedOnly"] }),
    run: runInput(),
    feedback: feedbackInput(),
    calibration: calibrationInput()
  });
  const joined = actions.join("\n");
  assert.match(joined, /流程未完整覆盖/);
  assert.match(joined, /弱断言 1 条/);
  assert.match(joined, /路线漂移 1 处.*ObservedOnly/);
  assert.match(joined, /首跑失败 1 例/);
  assert.match(joined, /flaky 1 例/);
  assert.match(joined, /未处理 API 错误 1 类/);
  assert.match(joined, /数据类失败 1 组/);
  assert.match(joined, /失败热点屏幕 top1：Home/);
  assert.match(joined, /MCP 漏报 1 例/);

  const clean = deriveLoopActions({
    generatedAt: "2026-10-08T00:00:00.000Z",
    check: checkInput(),
    run: null,
    feedback: null,
    calibration: null
  });
  assert.deepEqual(clean, ["闭环无阻塞：覆盖完整、无失败/漂移/校准缺口（可进入下一轮设计变更）"]);
});

test("buildSuiteLoopReport: aggregates steps, flake and failure domains", () => {
  const report = buildSuiteLoopReport({
    generatedAt: "2026-10-08T00:00:00.000Z",
    check: checkInput(),
    run: runInput(),
    feedback: feedbackInput(),
    calibration: calibrationInput()
  });
  assert.equal(report.steps.check.cases, 2);
  assert.equal(report.steps.run.flaky, 1);
  assert.deepEqual(report.steps.run.failureDomains, { 应用缺陷: 1 });
  assert.equal(report.steps.feedback.suggestions, 1);
  assert.equal(report.steps.calibration.mcpMiss, 1);
  assert.equal(report.topSuggestions.length, 1);
});

test("buildSuiteLoopReport: feedback error is reported, not hidden", () => {
  const report = buildSuiteLoopReport({
    generatedAt: "2026-10-08T00:00:00.000Z",
    check: null,
    run: null,
    feedback: null,
    feedbackError: "无法读取运行台账",
    calibration: null
  });
  assert.equal(report.steps.feedback.error, "无法读取运行台账");
  assert.match(report.nextActions.join("\n"), /无法读取 tests.json/);
});

test("renderSuiteLoopMarkdown: steps, actions and top suggestions", () => {
  const markdown = renderSuiteLoopMarkdown(
    buildSuiteLoopReport({
      generatedAt: "2026-10-08T00:00:00.000Z",
      check: checkInput(),
      run: runInput(),
      feedback: feedbackInput(),
      calibration: calibrationInput()
    })
  );
  assert.match(markdown, /# 测试闭环报告/);
  assert.match(markdown, /pass 1 \/ fail 1/);
  assert.match(markdown, /flaky 1/);
  assert.match(markdown, /## 下一步动作/);
  assert.match(markdown, /MCP 漏报 1（100\.0%）/);
  assert.match(markdown, /## 生成改进建议/);
  assert.match(markdown, /\[data\] 补数据前置/);
});
