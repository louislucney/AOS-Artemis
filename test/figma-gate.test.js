import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactGateIssue,
  coverageGateIssue,
  dataPolicyGateIssue,
  isImportedTestsFile
} from "../dist/figma/gate.js";

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

test("artifactGateIssue: 仅三件套（缺 xlsx / 过期 / 健康）", () => {
  const missing = artifactGateIssue(
    preflightFixture({
      artifacts: {
        testsFile: "/project/.artemis/design/tests.json",
        excelFile: "/project/.artemis/design/tests.xlsx",
        excelPresent: false,
        excelStale: false
      }
    })
  );
  assert.ok(missing !== null && missing.includes("缺少配套 tests.xlsx"));

  const stale = artifactGateIssue(
    preflightFixture({
      artifacts: {
        testsFile: "/project/.artemis/design/tests.json",
        excelFile: "/project/.artemis/design/tests.xlsx",
        excelPresent: true,
        excelStale: true
      }
    })
  );
  assert.equal(stale, "tests.xlsx 早于 tests.json（疑似手改或未重新生成；请重新运行 figma_generate_tests）");

  assert.equal(artifactGateIssue(preflightFixture()), null);
  assert.equal(artifactGateIssue(null), null);
});

test("dataPolicyGateIssue: 仅真实数据约束", () => {
  const missing = dataPolicyGateIssue(
    preflightFixture({
      dataPolicy: { missing: [{ id: "case-1", name: "Case 1" }] }
    })
  );
  assert.ok(missing !== null && missing.includes("用例缺少真实数据约束【真实数据】"));
  assert.equal(dataPolicyGateIssue(preflightFixture()), null);
  assert.equal(dataPolicyGateIssue(null), null);
});

test("isImportedTestsFile: meta.source 前缀 imported:", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-gate-"));
  try {
    const write = (name, payload) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload));
      return file;
    };
    assert.equal(
      isImportedTestsFile(write("a.json", { meta: { source: "imported:qa.xlsx@abcd1234" }, flows: [] })),
      true
    );
    assert.equal(isImportedTestsFile(write("b.json", { meta: { source: "figma:abc" }, flows: [] })), false);
    assert.equal(isImportedTestsFile(write("c.json", { flows: [] })), false);
    assert.equal(isImportedTestsFile(path.join(dir, "missing.json")), false);
    assert.equal(isImportedTestsFile(write("d.json", "not json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
