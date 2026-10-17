import assert from "node:assert/strict";
import test from "node:test";

import { coverageGateIssue } from "../dist/figma/gate.js";

function preflightFixture(overrides = {}) {
  return {
    cases: 1,
    weakCases: [],
    coverage: {
      available: true,
      designScreens: ["Home"],
      screens: ["Home"],
      uncoveredScreens: [],
      uncoveredEdges: [],
      explore: { uncoveredScreens: [], uncoveredEdges: [] }
    },
    generation: null,
    artifacts: {
      testsFile: "/project/.artemis/design/tests.json",
      excelFile: "/project/.artemis/design/tests.xlsx",
      excelPresent: true,
      excelStale: false
    },
    dataPolicy: { missing: [] },
    ...overrides
  };
}

test("coverageGateIssue: 缺 tests.xlsx 命中三件套硬门禁", () => {
  const issue = coverageGateIssue(
    preflightFixture({
      artifacts: {
        testsFile: "/project/.artemis/design/tests.json",
        excelFile: "/project/.artemis/design/tests.xlsx",
        excelPresent: false,
        excelStale: false
      }
    })
  );
  assert.ok(issue !== null);
  assert.ok(issue.includes("缺少配套 tests.xlsx"));
});

test("coverageGateIssue: 预检数据缺失时 fail-closed", () => {
  const issue = coverageGateIssue(null);
  assert.equal(issue, "流程覆盖校验不可用：预检数据缺失（tests.json 不可读）");
  assert.ok(issue.includes("预检数据缺失"));
});

test("coverageGateIssue: strict 弱断言路径保留原判", () => {
  const fixture = preflightFixture({
    weakCases: [
      { id: "case-1", name: "Case 1", weakSteps: [{ index: 0, reason: "缺少可验证断言（目的地屏无文本提示）" }] }
    ]
  });
  assert.equal(coverageGateIssue(fixture), null, "默认不因弱断言拦截");
  assert.equal(coverageGateIssue(fixture, {}), null);
  const strict = coverageGateIssue(fixture, { strict: true });
  assert.equal(strict, "--strict 门禁未通过：弱断言 1 条（explore 步骤已豁免）");
});

test("coverageGateIssue: 完整报告通过时返回 null", () => {
  assert.equal(coverageGateIssue(preflightFixture()), null);
});
