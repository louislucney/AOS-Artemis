import assert from "node:assert/strict";
import test from "node:test";

import { buildRegressionStats } from "../dist/panel/stats.js";

function caseRecord(overrides = {}) {
  return {
    caseId: "case-1",
    name: "Case 1",
    featureKey: "f-1",
    platform: "android",
    status: "passed",
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
    ...overrides
  };
}

function runRecord(overrides = {}) {
  return {
    id: "run-1",
    projectId: "p",
    createdAt: "2026-10-14T10:00:00.000Z",
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: "cs-1",
    featureKey: "f-1",
    featureName: "登录流程",
    platform: "android",
    device: null,
    appVersion: null,
    runner: null,
    status: "completed",
    startedAt: "2026-10-14T10:00:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
    total: 2,
    passed: 1,
    failed: 1,
    flaky: 0,
    quarantined: 0,
    failureDomains: { 用例缺陷: 1 },
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null,
    cases: [caseRecord(), caseRecord({ caseId: "case-2", name: "Case 2" })],
    ...overrides
  };
}

test("buildRegressionStats: 功能聚合（通过率/趋势/失败域/归因构成）", () => {
  const runs = [
    runRecord({
      id: "r3",
      createdAt: "2026-10-14T12:00:00.000Z",
      passed: 2,
      failed: 0,
      gateResult: "pass",
      failureDomains: {},
      cases: [
        caseRecord({ status: "passed", verdict: "case-defect" }),
        caseRecord({ caseId: "case-2", status: "passed" })
      ]
    }),
    runRecord({ id: "r2", createdAt: "2026-10-14T11:00:00.000Z" }),
    runRecord({
      id: "r1",
      createdAt: "2026-10-14T10:00:00.000Z",
      passed: 2,
      failed: 0,
      gateResult: "pass",
      failureDomains: {},
      cases: [
        caseRecord({ status: "passed" }),
        caseRecord({ caseId: "case-2", status: "passed" })
      ]
    })
  ];
  const stats = buildRegressionStats(runs);
  assert.equal(stats.features.length, 1);
  const feature = stats.features[0];
  assert.equal(feature.featureKey, "f-1");
  assert.equal(feature.featureName, "登录流程");
  assert.equal(feature.runs, 3);
  assert.equal(feature.total, 6);
  assert.equal(feature.passed, 5);
  assert.equal(feature.failed, 1);
  assert.ok(Math.abs(feature.passRate - 5 / 6) < 1e-9);
  assert.deepEqual(feature.trend, ["pass", "fail", "pass"]);
  assert.deepEqual(feature.failureDomains, { 用例缺陷: 1 });
  assert.deepEqual(feature.verdicts, { "case-defect": 1 });
  assert.deepEqual(stats.verdictTotals, { "case-defect": 1 });
});

test("buildRegressionStats: 最不稳用例（连败/flaky/最近状态与裁决）", () => {
  const runs = [
    runRecord({
      id: "r3",
      createdAt: "2026-10-14T12:00:00.000Z",
      cases: [
        caseRecord({ status: "failed", failureDomain: "环境", flaky: true }),
        caseRecord({ caseId: "case-2", status: "passed" })
      ]
    }),
    runRecord({
      id: "r2",
      createdAt: "2026-10-14T11:00:00.000Z",
      cases: [
        caseRecord({ status: "failed", failureDomain: "环境", verdict: "execution-deviation" }),
        caseRecord({ caseId: "case-2", status: "passed" })
      ]
    }),
    runRecord({
      id: "r1",
      createdAt: "2026-10-14T10:00:00.000Z",
      cases: [
        caseRecord({ status: "passed" }),
        caseRecord({ caseId: "case-2", status: "passed" })
      ]
    })
  ];
  const stats = buildRegressionStats(runs);
  const unstable = stats.unstableCases.find((entry) => entry.caseId === "case-1");
  assert.equal(unstable.caseSetId, "cs-1");
  assert.equal(unstable.runs, 3);
  assert.equal(unstable.failed, 2);
  assert.equal(unstable.consecutiveFailures, 2);
  assert.equal(unstable.flaky, 1);
  assert.equal(unstable.lastStatus, "failed");
  assert.equal(unstable.lastFailureDomain, "环境");
  assert.equal(unstable.verdict, "execution-deviation");
  assert.equal(stats.unstableCases[0].caseId, "case-1", "失败多的排前");
});

test("buildRegressionStats: case 级按（caseSetId＋caseId）分组——跨份同 id 不混", () => {
  const runs = [
    runRecord({
      id: "rB",
      createdAt: "2026-10-14T12:00:00.000Z",
      caseSetId: "cs-B",
      cases: [caseRecord({ status: "failed" })]
    }),
    runRecord({
      id: "rA",
      createdAt: "2026-10-14T10:00:00.000Z",
      caseSetId: "cs-A",
      cases: [caseRecord({ status: "passed" })]
    })
  ];
  const stats = buildRegressionStats(runs);
  const entries = stats.unstableCases.filter((entry) => entry.caseId === "case-1");
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.caseSetId).sort(),
    ["cs-A", "cs-B"]
  );
  assert.equal(entries.find((entry) => entry.caseSetId === "cs-B").consecutiveFailures, 1);
  assert.equal(entries.find((entry) => entry.caseSetId === "cs-A").consecutiveFailures, 0);
});

test("buildRegressionStats: 跨端差异仅同份内（同 caseId 不同 platform）", () => {
  const runs = [
    runRecord({
      id: "r-ios",
      createdAt: "2026-10-14T12:00:00.000Z",
      platform: "ios",
      cases: [caseRecord({ platform: "ios", status: "failed" })]
    }),
    runRecord({
      id: "r-android",
      createdAt: "2026-10-14T11:00:00.000Z",
      platform: "android",
      cases: [caseRecord({ platform: "android", status: "passed" })]
    }),
    runRecord({
      id: "r-other",
      createdAt: "2026-10-14T10:00:00.000Z",
      caseSetId: "cs-2",
      platform: "android",
      cases: [caseRecord({ platform: "android", status: "failed" })]
    })
  ];
  const stats = buildRegressionStats(runs);
  assert.equal(stats.crossPlatform.length, 1);
  assert.equal(stats.crossPlatform[0].caseId, "case-1");
  assert.deepEqual(stats.crossPlatform[0].results, { ios: "failed", android: "passed" });
});

test("buildRegressionStats: 空输入与无份运行不崩（跳过 featureKey=null）", () => {
  const empty = buildRegressionStats([]);
  assert.deepEqual(empty, {
    features: [],
    unstableCases: [],
    verdictTotals: {},
    crossPlatform: []
  });
  const skipped = buildRegressionStats([
    runRecord({ caseSetId: null, featureKey: null, featureName: null })
  ]);
  assert.equal(skipped.features.length, 0);
  assert.equal(skipped.unstableCases.length, 0);
});
