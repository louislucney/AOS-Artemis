import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { buildGenerationFeedback } from "../dist/figma/generation-feedback.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

const CASES = [
  {
    id: "case-1",
    name: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」，验证进入「Checkout」（页面应出现「Pay now」）"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "run case 1"
  },
  {
    id: "case-2",
    name: "我的 → 登录",
    screens: ["我的", "登录"],
    steps: ["点击「登录」进入登录页（页面应出现「账号」）", "报告当前页面"],
    preconditions: ["应用已安装且可正常启动", "「登录」需要有效账号可完成登录"],
    taskDesc: "run case 2"
  }
];

function failedStatus() {
  return {
    status: "failed",
    error: "assert mismatch",
    test_summary: {
      task_status: "failed",
      failed_items: [{ item_text: "登录", evidence: "请先登录后重试" }]
    }
  };
}

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy(), store });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "tests.json"), JSON.stringify({ flows: CASES }));

  for (const traceId of ["trace-1", "trace-2"]) {
    const traceDir = runtime.traceDir(traceId);
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, "status.json"), JSON.stringify(failedStatus()));
    await store.recordTask({
      rootPath: dir,
      traceId,
      caseId: "case-2",
      model: "deepseek-chat",
      status: "failed",
      taskDesc: "run case 2",
      finishedAt: "2026-10-02T00:00:20.000Z"
    });
  }

  const hotspotDir = path.join(
    designDir,
    "baselines",
    "emulator-5554",
    "case-1",
    "step-2-post"
  );
  fs.mkdirSync(hotspotDir, { recursive: true });
  fs.writeFileSync(
    path.join(hotspotDir, "last-diff.json"),
    JSON.stringify({
      schemaVersion: 1,
      comparedAt: "2026-10-02T00:00:00.000Z",
      regions: [
        { bbox: { x: 1, y: 2, width: 3, height: 4 }, category: "color" },
        { bbox: { x: 5, y: 6, width: 7, height: 8 }, category: "position-size" }
      ]
    })
  );
  return { dir, runtime, designDir };
}

function snapshot(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(path.relative(dir, child));
    }
  };
  walk(dir);
  return files.sort();
}

function verdictCase(caseId, verdict, extra = {}) {
  return {
    caseId,
    name: extra.name ?? `Case ${caseId}`,
    featureKey: extra.featureKey ?? "f-1",
    platform: extra.platform ?? "android",
    status: extra.status ?? "failed",
    traceId: extra.traceId ?? null,
    failureDomain: "用例缺陷",
    failureConfidence: "medium",
    failureReason: "断言未命中",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict,
    verdictBy: verdict === null ? null : "alice",
    verdictAt: verdict === null ? null : "2026-10-14T12:00:00.000Z",
    verdictNote: extra.note ?? null,
    jiraIssueKey: extra.jiraKey ?? null
  };
}

function verdictRun(overrides = {}) {
  return {
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: "cs-1",
    featureKey: "f-1",
    featureName: "登录流程",
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    runner: null,
    status: "failed",
    startedAt: "2026-10-14T10:00:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
    total: 1,
    passed: 0,
    failed: 1,
    flaky: 0,
    quarantined: 0,
    failureDomains: { 用例缺陷: 1 },
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null,
    ...overrides
  };
}

test("generation feedback: aggregates screens, data assumptions and weak assertions", async () => {
  const { runtime } = await setup();
  const feedback = await buildGenerationFeedback(runtime);

  assert.equal(feedback.ok, true);
  assert.deepEqual(feedback.generatedFrom, { tasks: 2, failed: 2, baselines: 1 });

  assert.deepEqual(feedback.issues.screens, [
    { screen: "我的", failures: 2, caseIds: ["case-2"], traceIds: ["trace-1", "trace-2"] },
    { screen: "登录", failures: 2, caseIds: ["case-2"], traceIds: ["trace-1", "trace-2"] }
  ]);
  assert.equal(feedback.issues.assertions.length, 1);
  assert.equal(feedback.issues.assertions[0].text, "登录");
  assert.equal(feedback.issues.assertions[0].failures, 2);
  assert.equal(feedback.issues.data.length, 1);
  assert.equal(feedback.issues.data[0].precondition, "「登录」需要有效账号可完成登录");
  assert.deepEqual(feedback.issues.data[0].traceIds, ["trace-1", "trace-2"]);
  assert.deepEqual(feedback.issues.weakAssertions, [
    { caseId: "case-2", name: "我的 → 登录", stepIndex: 1, step: "报告当前页面" }
  ]);
  assert.deepEqual(feedback.issues.visualHotspots, [
    {
      serial: "emulator-5554",
      caseId: "case-1",
      stepNumber: 2,
      regions: 2,
      categories: ["color", "position-size"],
      dir: feedback.issues.visualHotspots[0].dir
    }
  ]);

  const kinds = feedback.suggestions.map((suggestion) => suggestion.kind).sort();
  assert.deepEqual(kinds, ["assertion", "data", "hint", "hint", "prompt", "prompt"]);
  const dataSuggestion = feedback.suggestions.find((suggestion) => suggestion.kind === "data");
  assert.match(dataSuggestion.message, /有效账号/);
  assert.deepEqual(dataSuggestion.caseIds, ["case-2"]);
  assert.deepEqual(dataSuggestion.traceIds, ["trace-1", "trace-2"]);
  const weakSuggestion = feedback.suggestions.find((suggestion) => suggestion.kind === "assertion");
  assert.deepEqual(weakSuggestion.targets, { caseId: "case-2", stepIndex: 1 });
  const visualSuggestion = feedback.suggestions.find((suggestion) =>
    suggestion.message.includes("基线差异")
  );
  assert.deepEqual(visualSuggestion.targets, { caseId: "case-1", stepIndex: 1 });
});

test("generation feedback: read-only and deterministic for the same ledger", async () => {
  const { dir, runtime } = await setup();
  const before = snapshot(dir);
  const first = await buildGenerationFeedback(runtime);
  const second = await buildGenerationFeedback(runtime);
  const after = snapshot(dir);

  assert.deepEqual(first.issues, second.issues);
  assert.deepEqual(first.suggestions, second.suggestions);
  assert.deepEqual(after, before);
});

test("generation feedback: minFailures filters repeated issues only", async () => {
  const { runtime } = await setup();
  const strict = await buildGenerationFeedback(runtime, { minFailures: 3 });
  assert.equal(strict.issues.screens.length, 0);
  assert.equal(strict.issues.data.length, 0);
  assert.equal(strict.issues.assertions.length, 0);
  assert.ok(strict.issues.weakAssertions.length > 0);
  assert.ok(strict.suggestions.every((suggestion) => suggestion.kind !== "prompt"));
});

test("generation feedback: unhandled API errors become traceable suggestions", async () => {
  const { runtime } = await setup();
  for (const traceId of ["trace-1", "trace-2"]) {
    fs.writeFileSync(
      path.join(runtime.traceDir(traceId), "api-errors.json"),
      JSON.stringify({
        traceId,
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
            count: 1,
            firstAt: "10-02 04:11:42.319",
            sample: "HTTP 401 Unauthorized"
          }
        ]
      })
    );
  }
  const feedback = await buildGenerationFeedback(runtime);
  assert.equal(feedback.issues.apiErrors.length, 1);
  assert.equal(feedback.issues.apiErrors[0].occurrences, 2);
  assert.deepEqual(feedback.issues.apiErrors[0].traceIds, ["trace-1", "trace-2"]);
  const suggestion = feedback.suggestions.find((entry) => entry.kind === "api");
  assert.ok(suggestion, "api suggestion exists");
  assert.match(suggestion.message, /AUTH_401/);
});

test("generation feedback: 案例问题裁决 → kind: verdict 建议（按功能分组、带 caseIds）", async () => {
  const { dir, runtime } = await setup();
  await runtime.store.upsertProject({ rootPath: dir, name: "p" });
  const mkCase = (caseId, verdict, traceId) => ({
    caseId,
    name: `Case ${caseId}`,
    featureKey: "f-1",
    platform: "android",
    status: "failed",
    traceId,
    failureDomain: "用例缺陷",
    failureConfidence: "medium",
    failureReason: "断言未命中",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict,
    verdictBy: verdict === null ? null : "alice",
    verdictAt: verdict === null ? null : "2026-10-14T12:00:00.000Z",
    verdictNote: null
  });
  const mkRun = (overrides = {}) => ({
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: "cs-1",
    featureKey: "f-1",
    featureName: "登录流程",
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    runner: null,
    status: "failed",
    startedAt: "2026-10-14T10:00:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
    total: 2,
    passed: 0,
    failed: 2,
    flaky: 0,
    quarantined: 0,
    failureDomains: { 用例缺陷: 2 },
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null,
    ...overrides
  });
  await runtime.store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: mkRun(),
    cases: [
      mkCase("case-1", "case-defect", "trace-v1"),
      mkCase("case-2", "app-defect", "trace-v2")
    ]
  });
  await runtime.store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:06:00.000Z",
    run: mkRun({ caseSetId: "cs-2", featureKey: "f-2", featureName: "下单流程" }),
    cases: [mkCase("case-9", "case-defect", null)]
  });
  await runtime.store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:07:00.000Z",
    run: mkRun({ caseSetId: null, featureKey: null, featureName: null }),
    cases: [mkCase("case-standalone", "case-defect", null)]
  });

  const feedback = await buildGenerationFeedback(runtime);
  assert.equal(feedback.ok, true);
  const verdictSuggestions = feedback.suggestions.filter((entry) => entry.kind === "verdict");
  assert.equal(verdictSuggestions.length, 2, "按功能分组各一条");
  const login = verdictSuggestions.find((entry) => entry.message.includes("登录流程"));
  assert.ok(login, "登录流程建议");
  assert.ok(login.message.includes("1 条用例被判案例问题"));
  assert.deepEqual(login.caseIds, ["case-1"]);
  assert.deepEqual(login.traceIds, ["trace-v1"]);
  const order = verdictSuggestions.find((entry) => entry.message.includes("下单流程"));
  assert.ok(order, "下单流程建议");
  assert.deepEqual(order.caseIds, ["case-9"]);
  assert.deepEqual(order.traceIds, []);
  assert.equal(
    verdictSuggestions.some((entry) => entry.message.includes("case-standalone")),
    false,
    "无份运行不进建议（仅份血统）"
  );
});

test("generation feedback: 无裁决 → 无 verdict 建议；store 抛错不阻断既有建议", async () => {
  const { runtime } = await setup();
  const baseline = await buildGenerationFeedback(runtime);
  assert.ok(baseline.suggestions.length > 0, "既有建议仍在");
  assert.equal(
    baseline.suggestions.filter((entry) => entry.kind === "verdict").length,
    0,
    "无裁决 → 无 verdict 建议"
  );

  runtime.store.listSuiteRuns = async () => {
    throw new Error("store down");
  };
  const degraded = await buildGenerationFeedback(runtime);
  assert.equal(degraded.ok, true);
  assert.ok(degraded.suggestions.length > 0, "store 不可用不阻断既有建议");
  assert.equal(degraded.suggestions.filter((entry) => entry.kind === "verdict").length, 0);
});

test("generation feedback: exits 形状（三清单、jiraKey 透传）；store 抛错 → exits 省略且 ok true", async () => {
  const { dir, runtime } = await setup();
  await runtime.store.upsertProject({ rootPath: dir, name: "p" });
  await runtime.store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: verdictRun(),
    cases: [
      verdictCase("case-1", "case-defect", { note: "按钮文案不符", jiraKey: "AOS-1" }),
      verdictCase("case-2", "execution-deviation", { traceId: "trace-x" }),
      verdictCase("case-3", "app-defect", { jiraKey: "AOS-3" })
    ]
  });

  const feedback = await buildGenerationFeedback(runtime);
  assert.equal(feedback.ok, true);
  const exits = feedback.exits;
  assert.ok(exits, "exits 存在");
  assert.deepEqual(Object.keys(exits).sort(), ["appDefects", "caseDefects", "environment"]);
  assert.equal(exits.caseDefects.length, 1);
  assert.deepEqual(
    {
      caseId: exits.caseDefects[0].caseId,
      jiraKey: exits.caseDefects[0].jiraKey,
      note: exits.caseDefects[0].note
    },
    { caseId: "case-1", jiraKey: "AOS-1", note: "按钮文案不符" }
  );
  assert.deepEqual(exits.appDefects.map((entry) => entry.jiraKey), ["AOS-3"]);
  assert.equal(exits.environment.length, 1);
  assert.equal(exits.environment[0].count, 1);
  assert.equal(exits.environment[0].device, "emulator-5554");

  runtime.store.listSuiteRuns = async () => {
    throw new Error("store down");
  };
  const degraded = await buildGenerationFeedback(runtime);
  assert.equal(degraded.ok, true);
  assert.equal("exits" in degraded, false, "store 不可读 → exits 省略而非 null");
});

test("generation feedback: verdict 建议含用例名与备注摘要（截断 40 字）；无备注不产生空括号", async () => {
  const { dir, runtime } = await setup();
  await runtime.store.upsertProject({ rootPath: dir, name: "p" });
  const longNote = "长".repeat(45);
  await runtime.store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: verdictRun(),
    cases: [
      verdictCase("case-1", "case-defect", { name: "登录成功", note: "按钮文案不符" }),
      verdictCase("case-2", "case-defect", { name: "退出登录", note: longNote }),
      verdictCase("case-3", "case-defect", { name: "无备注", note: null })
    ]
  });

  const feedback = await buildGenerationFeedback(runtime);
  const verdicts = feedback.suggestions.filter((entry) => entry.kind === "verdict");
  assert.equal(verdicts.length, 1);
  assert.equal(
    verdicts[0].message,
    `功能「登录流程」有 3 条用例被判案例问题（case-1「登录成功」（按钮文案不符）；case-2「退出登录」（${"长".repeat(
      40
    )}…）；case-3「无备注」），建议下一轮重新生成该功能用例。`
  );
  assert.equal(verdicts[0].message.includes("（）"), false, "无备注不产生空括号");
  assert.deepEqual(verdicts[0].caseIds, ["case-1", "case-2", "case-3"]);
});
