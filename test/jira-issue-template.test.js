import assert from "node:assert/strict";
import test from "node:test";

import { adfToText } from "../dist/jira/adf.js";
import { buildRegressionIssueDescription, buildRegressionIssueSummary } from "../dist/jira/issue-template.js";

test("buildRegressionIssueSummary: 有无功能段两态", () => {
  const base = {
    runId: "20261014_001",
    caseId: "CASE-7",
    caseName: "登录失败提示",
    platform: "android",
    evidencePaths: []
  };
  assert.equal(
    buildRegressionIssueSummary({ ...base, featureName: "登录流程" }),
    "[回归] 登录流程 · 登录失败提示 失败"
  );
  assert.equal(buildRegressionIssueSummary({ ...base, featureName: null }), "[回归] 登录失败提示 失败");
  assert.equal(buildRegressionIssueSummary({ ...base, featureName: "" }), "[回归] 登录失败提示 失败");
});

test("buildRegressionIssueDescription: 全字段 ADF 形状且可 JSON 序列化", () => {
  const facts = {
    projectName: "AOS",
    runId: "20261014_001",
    taskId: "reg-42",
    featureName: "登录流程",
    platform: "android",
    device: "emulator-5554",
    appVersion: "1.2.3",
    runAt: "2026-10-14T10:30:00Z",
    caseId: "CASE-7",
    caseName: "登录失败提示",
    failureDomain: "app-defect",
    failureConfidence: "high",
    failureReason: "断言不匹配",
    traceId: "trace-abc",
    evidencePaths: ["evidence/step-3-post.png", "evidence/annotated.png"],
    artifactUrl: "https://cdn.example/report.xlsx",
    verdictNote: "确认缺陷"
  };

  const doc = buildRegressionIssueDescription(facts);
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.content));

  const roundTrip = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(roundTrip, doc);

  const text = adfToText(doc);
  assert.match(text, /登录流程 · 登录失败提示 失败/);
  assert.match(text, /项目：AOS/);
  assert.match(text, /运行 ID：20261014_001/);
  assert.match(text, /任务 ID：reg-42/);
  assert.match(text, /用例：CASE-7 · 登录失败提示/);
  assert.match(text, /端：android/);
  assert.match(text, /设备：emulator-5554/);
  assert.match(text, /应用版本：1\.2\.3/);
  assert.match(text, /运行时间：2026-10-14T10:30:00Z/);
  assert.match(text, /失败域：app-defect（置信：high）/);
  assert.match(text, /失败理由：断言不匹配/);
  assert.match(text, /traceId：trace-abc/);
  assert.match(text, /裁决备注：确认缺陷/);
  assert.match(text, /证据路径：evidence\/step-3-post\.png/);
  assert.match(text, /证据路径：evidence\/annotated\.png/);
  assert.match(text, /产物 URL：https:\/\/cdn\.example\/report\.xlsx/);
});

test("buildRegressionIssueDescription: 空字段省略", () => {
  const facts = {
    runId: "r1",
    caseId: "C-1",
    caseName: "空字段用例",
    platform: "ios",
    evidencePaths: []
  };
  const text = adfToText(buildRegressionIssueDescription(facts));
  assert.match(text, /\[回归\] 空字段用例 失败/);
  assert.match(text, /运行 ID：r1/);
  assert.match(text, /用例：C-1 · 空字段用例/);
  assert.match(text, /端：ios/);

  assert.doesNotMatch(text, /项目：/);
  assert.doesNotMatch(text, /任务 ID：/);
  assert.doesNotMatch(text, /设备：/);
  assert.doesNotMatch(text, /应用版本：/);
  assert.doesNotMatch(text, /运行时间：/);
  assert.doesNotMatch(text, /失败域：/);
  assert.doesNotMatch(text, /失败理由：/);
  assert.doesNotMatch(text, /traceId：/);
  assert.doesNotMatch(text, /裁决备注：/);
  assert.doesNotMatch(text, /证据路径：/);
  assert.doesNotMatch(text, /产物 URL：/);
});

test("buildRegressionIssueDescription: 失败域无置信省略置信段", () => {
  const facts = {
    runId: "r1",
    caseId: "C-1",
    caseName: "用例",
    platform: "ios",
    failureDomain: "env",
    failureConfidence: null,
    evidencePaths: []
  };
  const text = adfToText(buildRegressionIssueDescription(facts));
  assert.match(text, /失败域：env/);
  assert.doesNotMatch(text, /置信/);
});
