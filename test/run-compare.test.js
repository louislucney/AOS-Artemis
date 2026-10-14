import assert from "node:assert/strict";
import test from "node:test";

import { compareRuns, crossPlatformDeltas } from "../dist/tasks/run-compare.js";

function entry(caseId, outcome, name = `Case ${caseId}`) {
  return { caseId, name, outcome };
}

test("compareRuns: 修复/回归/仍通过/仍失败/新增失败/新增通过/消失", () => {
  const baseline = [
    entry("c1", "passed"),
    entry("c2", "failed"),
    entry("c3", "passed"),
    entry("c4", "failed"),
    entry("c8", "passed")
  ];
  const current = [
    entry("c1", "passed"),
    entry("c2", "passed"),
    entry("c3", "failed"),
    entry("c4", "failed"),
    entry("c6", "failed"),
    entry("c7", "passed")
  ];
  const result = compareRuns(baseline, current);
  assert.equal(result.baseline, "compared");
  assert.equal(result.stillPassed, 1);
  assert.equal(result.fixed, 1);
  assert.equal(result.regressed, 1);
  assert.equal(result.stillFailed, 1);
  assert.equal(result.newFailed, 1);
  assert.equal(result.newPassed, 1);
  assert.equal(result.vanished, 1);
  assert.deepEqual(result.regressedCases.map((item) => item.caseId), ["c3"]);
  assert.deepEqual(result.fixedCases.map((item) => item.caseId), ["c2"]);
  assert.deepEqual(result.newFailedCases.map((item) => item.caseId), ["c6"]);
  assert.deepEqual(result.vanishedCases.map((item) => item.caseId), ["c8"]);
});

test("compareRuns: 无基线 → 基准建立（全部按新增计）", () => {
  const result = compareRuns(null, [entry("c1", "passed"), entry("c2", "failed")]);
  assert.equal(result.baseline, "established");
  assert.equal(result.newPassed, 1);
  assert.equal(result.newFailed, 1);
  assert.equal(result.stillPassed, 0);
  assert.equal(result.regressed, 0);
  assert.equal(result.vanished, 0);
});

test("compareRuns: pending 不参与计数", () => {
  const result = compareRuns([entry("c1", "pending")], [entry("c1", "pending"), entry("c2", "passed")]);
  assert.equal(result.stillPassed, 0);
  assert.equal(result.vanished, 0);
  assert.equal(result.newPassed, 1);
  assert.equal(result.fixed, 0);
});

test("crossPlatformDeltas: 仅列出两端结果不同的用例", () => {
  const deltas = crossPlatformDeltas([
    { platform: "ios", cases: [entry("c1", "passed"), entry("c2", "failed")] },
    { platform: "android", cases: [entry("c1", "passed"), entry("c2", "passed")] }
  ]);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].caseId, "c2");
  assert.equal(deltas[0].name, "Case c2");
  assert.deepEqual(deltas[0].results, { ios: "failed", android: "passed" });
});
