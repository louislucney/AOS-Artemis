import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { loadGeneratedCases } from "../dist/figma/design-store.js";
import {
  baselineFor,
  buildSuiteRunInput,
  platformOf,
  registerSuiteRun,
  resolveRunRefs
} from "../dist/tasks/run-registry.js";
import { baseConfig, loadTestRuntime, makeTempProject, seedCaseSets } from "./helpers.js";

function caseResult(overrides = {}) {
  return {
    caseId: "case-1",
    name: "Case 1",
    status: "failed",
    traceId: "trace-1",
    error: null,
    testSummary: null,
    failure: { domain: "用例缺陷", confidence: "medium", reason: "断言未命中" },
    scriptProvenance: null,
    apiErrors: [],
    apiErrorsDegraded: null,
    evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
    reset: null,
    ...overrides
  };
}

function makeReport(overrides = {}) {
  return {
    ok: true,
    testsPath: "/p/tests.json",
    total: 2,
    executed: 2,
    skipped: 0,
    passed: 1,
    failed: 1,
    preflight: null,
    apiErrorCatalog: null,
    cases: [
      caseResult(),
      caseResult({
        caseId: "case-2",
        name: "Case 2",
        status: "passed",
        traceId: "trace-2",
        failure: null,
        retry: { attempts: 1, finalStatus: "passed", finalTraceId: "trace-2", flaky: true }
      })
    ],
    ...overrides
  };
}

async function setupProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { dir, runtime, store };
}

test("buildSuiteRunInput: 逐例映射（name、failure 域/置信/理由、quarantined、flaky、traceId）", () => {
  const built = buildSuiteRunInput({
    report: makeReport({
      cases: [caseResult({ quarantined: true }), ...makeReport().cases.slice(1)]
    }),
    trigger: "cli",
    platform: "android",
    device: "emulator-5554",
    exitCode: 1,
    startedAtMs: Date.parse("2026-10-14T16:00:00.000Z"),
    finishedAtMs: Date.parse("2026-10-14T16:05:00.000Z")
  });
  assert.equal(built.run.status, "failed");
  assert.equal(built.run.failureDomains["用例缺陷"], 1);
  assert.equal(built.run.quarantined, 1);
  assert.equal(built.run.flaky, 1);
  assert.equal(built.run.startedAt, "2026-10-14T16:00:00.000Z");
  const failed = built.cases[0];
  assert.equal(failed.name, "Case 1");
  assert.equal(failed.failureDomain, "用例缺陷");
  assert.equal(failed.failureConfidence, "medium");
  assert.equal(failed.failureReason, "断言未命中");
  assert.equal(failed.quarantined, true);
  assert.equal(built.cases[1].flaky, true);
  assert.equal(built.cases[1].traceId, "trace-2");
});

test("platformOf: iOS UDID → ios；adb serial → android；null → unknown", () => {
  assert.equal(platformOf("4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"), "ios");
  assert.equal(platformOf("00008101-000A1B2C3D4E001E"), "ios");
  assert.equal(platformOf("emulator-5554"), "android");
  assert.equal(platformOf(null), "unknown");
});

test("resolveRunRefs: jsonPath 精确匹配命中/未命中 null", async () => {
  const { runtime, store } = await setupProject();
  await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-登录-41b473ed",
        name: "登录流程",
        caseCount: 1,
        screens: ["登录"],
        jsonPath: "/x/case-sets/20261014T153000_登录.json",
        mdPath: "/x/case-sets/20261014T153000_登录.md",
        xlsxPath: "/x/case-sets/20261014T153000_登录.xlsx"
      }
    ]
  });
  const sets = await store.listCaseSets(runtime.project.rootDir);
  const hit = await resolveRunRefs(runtime, "/x/case-sets/20261014T153000_登录.json");
  assert.deepEqual(hit, {
    caseSetId: sets[0].id,
    featureKey: "f-登录-41b473ed",
    featureName: "登录流程"
  });
  assert.equal(await resolveRunRefs(runtime, "/x/other.json"), null);
});

test("registerSuiteRun: 落库并返回 id；store 抛错 → null 不抛", async () => {
  const { runtime, store } = await setupProject();
  const input = {
    report: makeReport(),
    trigger: "cli",
    platform: "android",
    device: "emulator-5554",
    exitCode: 1,
    startedAtMs: Date.now(),
    finishedAtMs: Date.now()
  };
  const id = await registerSuiteRun(runtime, input);
  assert.ok(id);
  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cases.length, 2);
  assert.equal(runs[0].runner, os.hostname(), "登记填执行机 hostname");

  runtime.store.recordSuiteRun = async () => {
    throw new Error("down");
  };
  const failedId = await registerSuiteRun(runtime, input);
  assert.equal(failedId, null);
});

test("baselineFor: 同 ref 最近一条、排除 excludeRunId；无 → null", async () => {
  const { runtime, store } = await setupProject();
  const input = (started, report = makeReport()) => ({
    report,
    trigger: "cli",
    platform: "android",
    device: "emulator-5554",
    caseSetId: "cs-1",
    featureKey: "f-1",
    exitCode: 1,
    startedAtMs: Date.parse(started),
    finishedAtMs: Date.parse(started) + 60000
  });
  await registerSuiteRun(runtime, input("2026-10-14T10:00:00Z"));
  await registerSuiteRun(
    runtime,
    input(
      "2026-10-14T12:00:00Z",
      makeReport({
        cases: [
          caseResult(),
          caseResult({
            caseId: "case-2",
            name: "Case 2",
            status: "failed",
            traceId: "trace-2",
            failure: { domain: "环境", confidence: "high", reason: "设备离线" }
          })
        ]
      })
    )
  );
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { caseSetId: "cs-1" });
  assert.equal(runs.length, 2);
  const newest = runs[0];

  const baseline = await baselineFor(runtime, {
    caseSetId: "cs-1",
    featureKey: "f-1",
    platform: "android"
  });
  assert.equal(baseline.length, 2);
  assert.equal(baseline.find((entry) => entry.caseId === "case-2").outcome, "failed");
  assert.equal(baseline.find((entry) => entry.caseId === "case-1").outcome, "failed");

  const excluded = await baselineFor(
    runtime,
    { caseSetId: "cs-1", featureKey: "f-1", platform: "android" },
    newest.id
  );
  assert.equal(excluded.find((entry) => entry.caseId === "case-2").outcome, "passed");

  const missing = await baselineFor(runtime, {
    caseSetId: "cs-x",
    featureKey: "f-1",
    platform: "android"
  });
  assert.equal(missing, null);
});

test("loadGeneratedCases: 读取用例的 feature 标签", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "tests.json"),
    JSON.stringify({
      flows: [
        {
          id: "case-1",
          name: "Case 1",
          screens: ["登录"],
          steps: ["点击"],
          taskDesc: "t",
          feature: "f-登录-41b473ed"
        },
        { id: "case-2", name: "Case 2", screens: ["首页"], steps: ["点击"], taskDesc: "t" }
      ]
    })
  );
  const { runtime } = await loadTestRuntime(dir, {});
  const cases = loadGeneratedCases(runtime.configDirAbs);
  assert.equal(cases[0].feature, "f-登录-41b473ed");
  assert.equal(cases[1].feature, null);
});

test("resolveRunRefs: >50 份仍归因窗口外既有份", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  const { targetJsonPath } = await seedCaseSets(
    store,
    runtime.project.rootDir,
    path.join(runtime.configDirAbs, "design")
  );
  const ref = await resolveRunRefs(runtime, targetJsonPath);
  assert.ok(ref, "应能归因窗口外的既有份");
  assert.equal(ref.featureKey, "f-old");
});
