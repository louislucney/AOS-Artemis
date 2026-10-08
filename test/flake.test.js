import assert from "node:assert/strict";
import test from "node:test";

import { buildFlakeReport, renderFlakeMarkdown } from "../dist/figma/flake.js";

function caseResult(caseId, status) {
  return {
    caseId,
    name: caseId,
    status,
    traceId: `t-${caseId}-${status}`,
    error: null,
    testSummary: null,
    failure: null,
    apiErrors: [],
    apiErrorsDegraded: null,
    evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
    reset: null
  };
}

test("buildFlakeReport: flake detection, flips, pass rate and dispersion", () => {
  const rounds = [
    [caseResult("c1", "passed"), caseResult("c2", "failed"), caseResult("c3", "passed")],
    [caseResult("c1", "passed"), caseResult("c2", "failed"), caseResult("c3", "passed")],
    [caseResult("c1", "failed"), caseResult("c2", "failed"), caseResult("c3", "passed")]
  ];
  const report = buildFlakeReport({
    generatedAt: "2026-10-08T00:00:00.000Z",
    caseIds: ["c1", "c2", "c3", "c4"],
    caseNames: new Map([["c3", "稳定用例"]]),
    rounds
  });

  const byId = new Map(report.cases.map((entry) => [entry.caseId, entry]));
  assert.deepEqual(byId.get("c1").statuses, ["passed", "passed", "failed"]);
  assert.equal(byId.get("c1").passRate, 2 / 3);
  assert.equal(byId.get("c1").flips, 1);
  assert.equal(byId.get("c1").verdict, "flaky");
  assert.equal(byId.get("c2").verdict, "stable-fail");
  assert.equal(byId.get("c3").verdict, "stable-pass");
  assert.equal(byId.get("c3").name, "稳定用例");
  assert.equal(byId.get("c4").verdict, "untested");
  assert.deepEqual(byId.get("c4").statuses, ["missing", "missing", "missing"]);

  assert.deepEqual(
    report.rounds.map((round) => `${round.round}:${round.passed}/${round.executed}`),
    ["1:2/3", "2:2/3", "3:1/3"]
  );
  assert.deepEqual(
    {
      flaky: report.summary.flakyCases,
      pass: report.summary.stablePass,
      fail: report.summary.stableFail,
      untested: report.summary.untestedCases
    },
    { flaky: 1, pass: 1, fail: 1, untested: 1 }
  );
  assert.ok(Math.abs(report.summary.meanPassRate - 5 / 9) < 1e-9);
  assert.ok(Math.abs(report.summary.stddevPassRate - 0.4157) < 0.01);
});

test("buildFlakeReport: no measured cases leaves dispersion null", () => {
  const report = buildFlakeReport({
    generatedAt: "2026-10-08T00:00:00.000Z",
    caseIds: ["c1"],
    rounds: [[caseResult("other", "passed")]]
  });
  assert.equal(report.summary.meanPassRate, null);
  assert.equal(report.summary.stddevPassRate, null);
  assert.equal(report.cases[0].verdict, "untested");
});

test("renderFlakeMarkdown: matrix, verdicts and summary", () => {
  const markdown = renderFlakeMarkdown(
    buildFlakeReport({
      generatedAt: "2026-10-08T00:00:00.000Z",
      caseIds: ["c1"],
      rounds: [[caseResult("c1", "passed")], [caseResult("c1", "failed")]]
    })
  );
  assert.match(markdown, /# Flake 采样报告/);
  assert.match(markdown, /\| R1 \| R2 \|/);
  assert.match(markdown, /passed \| failed/);
  assert.match(markdown, /flaky 1/);
});
