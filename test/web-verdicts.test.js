import assert from "node:assert/strict";
import test from "node:test";

import { classifyExpectedResult } from "../dist/web/assertions.js";
import { aggregateResultGate, resolveResultStatus } from "../dist/web/results.js";
import { assertionGate, deriveCaseVerdicts, selectSourceCases } from "../dist/web/verdicts.js";

const HIGH_EXPECTED = "1. 页面显示“登录成功”";

function sourceCase(caseId, options = {}) {
  return {
    caseId,
    name: options.name ?? caseId,
    steps: options.steps ?? ["打开登录页"],
    expected: options.expected === undefined ? HIGH_EXPECTED : options.expected,
    preconditions: [],
    module: options.module ?? null,
    priority: null,
    testData: null,
    testId: null,
    rowNumber: options.rowNumber ?? 2
  };
}

function docFor(caseId, expected = HIGH_EXPECTED, steps = ["打开登录页"]) {
  return classifyExpectedResult({ expected, steps, caseId });
}

function assertionsFor(cases) {
  return new Map(cases.map((entry) => [entry.caseId, docFor(entry.caseId, entry.expected, entry.steps)]));
}

function passCase(caseId, extra = {}) {
  return { caseId, name: caseId, status: "PASS", durationMs: 100, ...extra };
}

function derive(overrides = {}) {
  return deriveCaseVerdicts({
    payloadCases: overrides.payloadCases ?? [],
    sourceCases: overrides.sourceCases ?? null,
    assertions: overrides.assertions ?? null,
    caseFilter: overrides.caseFilter ?? { modules: [], caseIds: [] },
    suppressPerCaseResult: overrides.suppressPerCaseResult ?? false
  });
}

test("verdicts：PASS + 高置信断言文档 + assertionCount>0 → PASS", () => {
  const source = [sourceCase("TC-1")];
  const result = derive({
    payloadCases: [passCase("TC-1", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].status, "PASS");
  assert.equal(result.cases[0].failureReason, undefined);
  assert.equal(result.unverified, 0);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.warnings, []);
});

test("verdicts：PASS + 仅人工断言 → UNVERIFIED manual-or-ambiguous", () => {
  const source = [sourceCase("TC-1", { expected: "1. 后台排序结果正确" })];
  const result = derive({
    payloadCases: [passCase("TC-1", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases[0].status, "UNVERIFIED");
  assert.equal(result.reasons[0].reason, "manual-or-ambiguous");
  assert.match(result.cases[0].failureReason, /^未验证：/);
});

test("verdicts：PASS + 空预期 → UNVERIFIED no-executable-assertion", () => {
  const source = [sourceCase("TC-1", { expected: "" })];
  const result = derive({
    payloadCases: [passCase("TC-1", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases[0].status, "UNVERIFIED");
  assert.equal(result.reasons[0].reason, "no-executable-assertion");
  assert.match(result.cases[0].failureReason, /^未验证：/);
});

test("verdicts：PASS + 高置信文档但 assertionCount 为 0/缺失 → UNVERIFIED", () => {
  const source = [sourceCase("TC-1")];
  for (const assertionCount of [0, undefined]) {
    const result = derive({
      payloadCases: [passCase("TC-1", assertionCount === undefined ? {} : { assertionCount })],
      sourceCases: source,
      assertions: assertionsFor(source)
    });
    assert.equal(result.cases[0].status, "UNVERIFIED", String(assertionCount));
    assert.equal(result.reasons[0].reason, "assertion-proof-missing");
    assert.equal(result.unverified, 1);
  }
});

test("verdicts：仅软 text 断言 → UNVERIFIED soft-assertion-only", () => {
  const source = [
    sourceCase("TC-1", { expected: "1. 彈窗關閉", steps: ["點擊關閉"] })
  ];
  const result = derive({
    payloadCases: [passCase("TC-1", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases[0].status, "UNVERIFIED");
  assert.equal(result.reasons[0].reason, "soft-assertion-only");
  assert.match(result.cases[0].failureReason, /^未验证：.*软断言/);

  const soft = classifyExpectedResult({
    expected: "1. 彈窗關閉",
    steps: ["點擊關閉"],
    caseId: "TC-SOFT"
  });
  assert.equal(soft.confidence, "medium");
  assert.deepEqual(assertionGate(soft, 1), {
    status: "UNVERIFIED",
    reason: "soft-assertion-only"
  });
});

test("verdicts：PASS 但原件没有该用例 → UNVERIFIED case-not-in-source", () => {
  const source = [sourceCase("TC-1")];
  const result = derive({
    payloadCases: [passCase("TC-9", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases[0].status, "UNVERIFIED");
  assert.equal(result.reasons[0].reason, "case-not-in-source");
});

test("verdicts：FAIL/ERROR/SKIP 原样保留，不因缺断言证据改写", () => {
  const source = [sourceCase("TC-1"), sourceCase("TC-2"), sourceCase("TC-3")];
  const result = derive({
    payloadCases: [
      { caseId: "TC-1", name: "TC-1", status: "FAIL", durationMs: 1 },
      { caseId: "TC-2", name: "TC-2", status: "ERROR", durationMs: 1 },
      { caseId: "TC-3", name: "TC-3", status: "SKIP", durationMs: 0 }
    ],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.deepEqual(
    result.cases.map((entry) => entry.status),
    ["FAIL", "ERROR", "SKIP"]
  );
  assert.equal(result.unverified, 0);
  assert.equal(result.missing, 0);
});

test("verdicts：范围内缺失用例补 synthetic SKIP（未执行），追加在 payload 之后", () => {
  const source = [sourceCase("TC-1"), sourceCase("TC-2")];
  const result = derive({
    payloadCases: [passCase("TC-1", { assertionCount: 1 })],
    sourceCases: source,
    assertions: assertionsFor(source)
  });
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases[0].status, "PASS");
  const synthetic = result.cases[1];
  assert.equal(synthetic.caseId, "TC-2");
  assert.equal(synthetic.status, "SKIP");
  assert.equal(synthetic.failureReason, "未执行");
  assert.equal(synthetic.synthetic, true);
  assert.equal(synthetic.durationMs, 0);
  assert.equal(result.missing, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("verdict-missing-result")));
  assert.ok(result.reasons.some((entry) => entry.caseId === "TC-2" && entry.reason === "未执行"));
});

test("verdicts：过滤只影响选中范围与告警，缺失仍覆盖全部原件用例", () => {
  const source = [
    sourceCase("TC-1", { module: "登录" }),
    sourceCase("TC-2", { module: "设置" })
  ];
  const byCase = derive({
    sourceCases: source,
    assertions: assertionsFor(source),
    caseFilter: { modules: [], caseIds: [" TC-2 "] }
  });
  assert.deepEqual(
    byCase.cases.map((entry) => [entry.caseId, entry.status]),
    [
      ["TC-1", "SKIP"],
      ["TC-2", "SKIP"]
    ],
    "未选中的 TC-1 也要写 SKIP"
  );
  assert.ok(
    byCase.warnings.some((warning) =>
      warning.includes("verdict-partial-scope: 过滤条件仅选中 1/2 个用例，其余 1 个写 SKIP")
    ),
    byCase.warnings.join("；")
  );

  const byModule = derive({
    sourceCases: source,
    assertions: assertionsFor(source),
    caseFilter: { modules: [" 登录 "], caseIds: [] }
  });
  assert.deepEqual(byModule.cases.map((entry) => entry.caseId), ["TC-1", "TC-2"]);
  assert.ok(byModule.warnings.some((warning) => warning.includes("verdict-partial-scope")));

  const all = derive({ sourceCases: source, assertions: assertionsFor(source) });
  assert.deepEqual(all.cases.map((entry) => entry.caseId), ["TC-1", "TC-2"]);
  assert.ok(!all.warnings.some((warning) => warning.includes("verdict-partial-scope")));

  assert.deepEqual(
    selectSourceCases(source, { modules: [], caseIds: [] }).map((entry) => entry.caseId),
    ["TC-1", "TC-2"]
  );
});

test("verdicts：任务级抑制下 PASS 与缺失用例都写 ERROR（不留 PASS）", () => {
  const source = [sourceCase("TC-1"), sourceCase("TC-2")];
  const result = derive({
    payloadCases: [passCase("TC-1")],
    sourceCases: source,
    assertions: assertionsFor(source),
    suppressPerCaseResult: true
  });
  assert.deepEqual(
    result.cases.map((entry) => [entry.caseId, entry.status, entry.failureReason]),
    [
      ["TC-1", "ERROR", "任务级错误，未采纳逐例 PASS"],
      ["TC-2", "ERROR", "任务级错误，未执行"]
    ]
  );
  assert.equal(result.cases[1].synthetic, true);
  assert.equal(result.unverified, 0);
  assert.equal(result.missing, 1);
  assert.ok(result.warnings.some((warning) => warning.includes("verdict-missing-result")));
});

test("verdicts：原件不可解析时 PASS fail-closed 降级 UNVERIFIED，不补 SKIP", () => {
  const result = derive({
    payloadCases: [
      passCase("TC-1"),
      { caseId: "TC-2", name: "TC-2", status: "FAIL", durationMs: 1 }
    ],
    sourceCases: null
  });
  assert.deepEqual(
    result.cases.map((entry) => [entry.caseId, entry.status, entry.failureReason]),
    [
      ["TC-1", "UNVERIFIED", "未验证：原件不可解析，无法生成断言"],
      ["TC-2", "FAIL", undefined]
    ]
  );
  assert.equal(result.unverified, 1);
  assert.equal(result.missing, 0);
  assert.equal(result.reasons[0].reason, "source-unreadable");
  assert.ok(result.warnings.some((warning) => warning.includes("verdict-unverified")));
  assert.ok(result.warnings.some((warning) => warning.includes("verdict-source-unreadable")));
});

test("verdicts：原件不可解析且任务级抑制时 PASS 同样写 ERROR", () => {
  const result = derive({
    payloadCases: [passCase("TC-1")],
    sourceCases: null,
    suppressPerCaseResult: true
  });
  assert.equal(result.cases[0].status, "ERROR");
  assert.equal(result.cases[0].failureReason, "任务级错误，未采纳逐例 PASS");
  assert.equal(result.unverified, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("verdict-source-unreadable")));
});

test("verdicts：assertionGate 直接覆盖文档缺失/人工歧义/证据缺失", () => {
  assert.equal(assertionGate(undefined, 1).reason, "assertion-doc-missing");
  const high = docFor("TC-1");
  assert.equal(assertionGate(high, 2).status, "PASS");
  assert.equal(assertionGate(high, 0).reason, "assertion-proof-missing");
  assert.equal(assertionGate(high, undefined).reason, "assertion-proof-missing");

  const manual = classifyExpectedResult({
    expected: "1. 后台数据排序结果正确",
    steps: ["打开列表"],
    caseId: "TC-1"
  });
  assert.equal(assertionGate(manual, 1).reason, "manual-or-ambiguous");

  const ambiguous = classifyExpectedResult({
    expected: ["页面显示“登录成功”", "页面显示“登录成功”"].join("\n"),
    steps: ["打开登录页"],
    caseId: "TC-1"
  });
  assert.equal(assertionGate(ambiguous, 1).reason, "manual-or-ambiguous");

  const emptySteps = classifyExpectedResult({
    expected: "页面显示“登录成功”",
    steps: [],
    caseId: "TC-1"
  });
  assert.equal(emptySteps.steps.length, 0);
  assert.equal(emptySteps.ambiguous.length, 1);
  assert.equal(assertionGate(emptySteps, 1).reason, "manual-or-ambiguous");
});

test("verdicts：UNVERIFIED 使 gate 为 partial，passed 不计入", () => {
  const gate = aggregateResultGate([
    { caseId: "TC-1", name: "a", status: "PASS" },
    { caseId: "TC-2", name: "b", status: "PASS" },
    { caseId: "TC-3", name: "c", status: "UNVERIFIED" }
  ]);
  assert.deepEqual(gate, {
    result: "partial",
    total: 3,
    passed: 2,
    failed: 0,
    errors: 0,
    skipped: 0,
    unverified: 1
  });
  const skipped = aggregateResultGate([
    { caseId: "TC-1", name: "a", status: "PASS" },
    { caseId: "TC-2", name: "b", status: "SKIP" }
  ]);
  assert.equal(skipped.result, "partial");
  assert.equal(skipped.unverified, undefined);
  assert.equal(aggregateResultGate([{ caseId: "TC-1", name: "a", status: "PASS" }]).result, "passed");
});

test("resolveResultStatus：上报 partial 优先于聚合 passed（取较坏状态）", () => {
  assert.equal(resolveResultStatus("partial", "passed"), "partial");
  assert.equal(resolveResultStatus("passed", "partial"), "partial");
  assert.equal(resolveResultStatus("partial", "failed"), "failed");
  assert.equal(resolveResultStatus("error", "passed"), "error");
  assert.equal(resolveResultStatus("passed", "passed"), "passed");
});
