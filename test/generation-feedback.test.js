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
