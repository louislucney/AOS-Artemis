import assert from "node:assert/strict";
import test from "node:test";

import { buildCalibration, parseXcResultTests } from "../dist/figma/calibration.js";

test("parseXcResultTests: nested xcresulttool testNodes and simplified tests[]", () => {
  const nested = {
    testNodes: [
      {
        nodeType: "Test Plan",
        name: "MOPItemDetailUITests",
        result: "Failed",
        children: [
          {
            nodeType: "Test Suite",
            name: "MOPItemDetailFlowUITests",
            result: "Failed",
            children: [
              { nodeType: "Test Case", name: "test01_case-aaaaaaaaaaaa()", result: "Passed" },
              { nodeType: "Test Case", name: "test02_case-bbbbbbbbbbbb()", result: "Failed" },
              { nodeType: "Test Case", name: "test03_case-cccccccccccc()", result: "Skipped" }
            ]
          }
        ]
      }
    ]
  };
  assert.deepEqual(parseXcResultTests(nested), [
    { name: "test01_case-aaaaaaaaaaaa()", status: "passed" },
    { name: "test02_case-bbbbbbbbbbbb()", status: "failed" },
    { name: "test03_case-cccccccccccc()", status: "skipped" }
  ]);

  const simple = { tests: [{ name: "test_a", status: "Passed" }, { name: "test_b", result: "failure" }] };
  assert.deepEqual(parseXcResultTests(simple), [
    { name: "test_a", status: "passed" },
    { name: "test_b", status: "failed" }
  ]);
  assert.deepEqual(parseXcResultTests("garbage"), []);
});

test("buildCalibration: miss, false alarm, single-sided and unmatched", () => {
  const report = buildCalibration({
    cases: [
      { id: "case-aaaa", name: "A" },
      { id: "case-bbbb", name: "B" },
      { id: "case-cccc", name: "C" },
      { id: "case-dddd", name: "D" }
    ],
    mcpOutcomes: new Map([
      ["case-aaaa", "passed"],
      ["case-bbbb", "failed"],
      ["case-cccc", "passed"]
    ]),
    xcTests: [
      { name: "testA_case-aaaa()", status: "passed" },
      { name: "testB_case-bbbb()", status: "passed" },
      { name: "testC_case-cccc()", status: "failed" },
      { name: "testUnmatched()", status: "failed" }
    ],
    generatedAt: "2026-10-08T00:00:00.000Z",
    xcSource: "fixture"
  });

  const verdict = new Map(report.cases.map((entry) => [entry.caseId, entry.verdict]));
  assert.equal(verdict.get("case-aaaa"), "agreed-pass");
  assert.equal(verdict.get("case-bbbb"), "mcp-false-alarm");
  assert.equal(verdict.get("case-cccc"), "mcp-miss");
  assert.equal(verdict.get("case-dddd"), "untested");
  assert.equal(report.matched, 3);
  assert.equal(report.mcpMiss, 1);
  assert.equal(report.mcpFalseAlarm, 1);
  assert.equal(report.missRate, 1);
  assert.equal(report.falseAlarmRate, 0.5);
  assert.deepEqual(report.unmatchedXcTests, ["testUnmatched()"]);
});

test("buildCalibration: rates are null without observed ground truth", () => {
  const report = buildCalibration({
    cases: [{ id: "case-aaaa", name: "A" }],
    mcpOutcomes: new Map(),
    xcTests: [],
    generatedAt: "2026-10-08T00:00:00.000Z",
    xcSource: "fixture"
  });
  assert.equal(report.missRate, null);
  assert.equal(report.falseAlarmRate, null);
  assert.equal(report.cases[0].verdict, "untested");
});
