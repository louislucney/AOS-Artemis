import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildRunManifest,
  loadLatestRunManifest,
  loadRunManifest,
  newRunId,
  pruneRunManifests,
  runManifestFileNames,
  runManifestMax,
  runManifestsEnabled,
  saveRunManifest,
  testsFingerprint
} from "../dist/figma/run-manifest.js";
import { RETENTION_CATEGORIES } from "../dist/figma/retention.js";
import { baseConfig, makeTempProject } from "./helpers.js";

const STARTED = Date.parse("2026-10-13T08:15:00.000Z");

const BASE_OPTIONS = {
  deviceSerial: null,
  lockedAppPackage: null,
  model: null,
  maxCases: null,
  stopOnFailure: false,
  apiErrors: true,
  failOnApiErrors: false,
  strict: false,
  failOnUncovered: false,
  retry: 0,
  quarantinedCaseIds: []
};

function makeCase(index, overrides = {}) {
  return {
    caseId: `case-${index}`,
    name: `Case ${index}`,
    status: "passed",
    traceId: `trace-${index}`,
    error: null,
    testSummary: null,
    failure: null,
    scriptProvenance: null,
    apiErrors: [],
    apiErrorsDegraded: null,
    evidence: { notesDir: null, stderrLog: null, stdoutLog: null },
    reset: null,
    ...overrides
  };
}

function makeReport(cases, overrides = {}) {
  return {
    ok: true,
    testsPath: "/tmp/project/.artemis/design/tests.json",
    total: cases.length,
    executed: cases.length,
    skipped: 0,
    passed: cases.filter((entry) => entry.status === "passed").length,
    failed: cases.filter((entry) => entry.status !== "passed").length,
    preflight: null,
    apiErrorCatalog: null,
    cases,
    ...overrides
  };
}

function makeManifest(startedIso, reportOverrides = {}, inputOverrides = {}) {
  const startedAtMs = Date.parse(startedIso);
  return buildRunManifest({
    report: makeReport([makeCase(1)], reportOverrides),
    source: "suite-run",
    startedAtMs,
    finishedAtMs: startedAtMs + 1000,
    exitCode: 0,
    coverageIssue: null,
    testsPath: "/x/design/tests.json",
    testsSha256: null,
    testsGeneratedAt: null,
    options: BASE_OPTIONS,
    ...inputOverrides
  });
}

test("buildRunManifest：字段映射、汇总、gate 与 failureDomains", () => {
  const report = makeReport(
    [
      makeCase(1, { scriptProvenance: { asserts: 3, explores: 0 } }),
      makeCase(2, {
        status: "failed",
        failure: {
          domain: "app-defect",
          confidence: "high",
          reason: "崩溃签名匹配",
          evidence: ["crash-1"]
        },
        quarantined: true
      }),
      makeCase(3, {
        status: "failed",
        error: "轮询超时",
        retry: { attempts: 1, finalStatus: "passed", finalTraceId: "trace-3b", flaky: true }
      })
    ],
    {
      preflight: {
        cases: 3,
        weakCases: [{}, {}],
        coverage: {
          available: true,
          designScreens: [],
          screens: [],
          uncoveredScreens: ["A"],
          uncoveredEdges: [],
          explore: { uncoveredScreens: ["B"], uncoveredEdges: ["C"] }
        },
        generation: { truncated: true, entryFallback: false },
        artifacts: { testsFile: "t", excelFile: "x", excelPresent: true, excelStale: false },
        dataPolicy: { missing: [{ id: "c", name: "n" }] }
      },
      apiErrorCatalog: { file: "err.json", rules: 3, errors: ["bad-rule"] }
    }
  );
  const options = {
    ...BASE_OPTIONS,
    deviceSerial: "SIM-1",
    strict: true,
    failOnUncovered: true,
    retry: 1,
    quarantinedCaseIds: ["case-2"]
  };
  const manifest = buildRunManifest({
    report,
    source: "suite-run",
    startedAtMs: STARTED,
    finishedAtMs: STARTED + 61_000,
    exitCode: 1,
    coverageIssue: "流程未完整覆盖",
    testsPath: "/tmp/project/.artemis/design/tests.json",
    testsSha256: "abc",
    testsGeneratedAt: "2026-10-13T08:00:00.000Z",
    options
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taxonomyVersion, 1);
  assert.match(manifest.runId, /^run-20261013T081500-[0-9a-f]{6}$/);
  assert.equal(manifest.startedAt, new Date(STARTED).toISOString());
  assert.equal(manifest.finishedAt, new Date(STARTED + 61_000).toISOString());
  assert.equal(manifest.ok, true);
  assert.equal(manifest.error, null);
  assert.deepEqual(manifest.tests, {
    path: "/tmp/project/.artemis/design/tests.json",
    sha256: "abc",
    generatedAt: "2026-10-13T08:00:00.000Z"
  });
  assert.deepEqual(manifest.options, options);
  assert.deepEqual(manifest.preflight, {
    cases: 3,
    weakCases: 2,
    coverage: {
      available: true,
      uncoveredScreens: 1,
      uncoveredEdges: 0,
      exploreUncoveredScreens: 1,
      exploreUncoveredEdges: 1
    },
    artifacts: { excelPresent: true, excelStale: false },
    dataPolicyMissing: 1,
    generation: { truncated: true, entryFallback: false }
  });
  assert.deepEqual(manifest.apiErrorCatalog, {
    file: "err.json",
    rules: 3,
    errors: ["bad-rule"]
  });
  assert.notEqual(manifest.apiErrorCatalog.errors, report.apiErrorCatalog.errors, "数组为拷贝");
  assert.deepEqual(manifest.summary, {
    total: 3,
    executed: 3,
    skipped: 0,
    passed: 1,
    failed: 2,
    flaky: 1,
    quarantinedFailed: 1
  });
  assert.deepEqual(manifest.gate, {
    result: "fail",
    exitCode: 1,
    reasons: ["preflight-gate", "failed:1"]
  });
  assert.deepEqual(manifest.failureDomains, { "app-defect": 1, unclassified: 1 });

  assert.equal(manifest.cases.length, 3);
  assert.deepEqual(manifest.cases[1].failure, {
    domain: "app-defect",
    confidence: "high",
    reason: "崩溃签名匹配"
  });
  assert.equal(manifest.cases[1].quarantined, true);
  assert.deepEqual(manifest.cases[2].retry, {
    attempts: 1,
    finalStatus: "passed",
    finalTraceId: "trace-3b",
    flaky: true
  });
  assert.equal(manifest.cases[2].error, "轮询超时");
  assert.equal("testSummary" in manifest.cases[0], false);
  assert.equal("reset" in manifest.cases[0], false);
});

test("run manifest: designWarnings 快照写入，历史批次不随 flows 变化", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const summary = {
    available: true,
    total: 2,
    byCode: { "flow-graph-empty": 1, "vision-degraded": 1 },
    codes: ["flow-graph-empty", "vision-degraded"],
    snapshotAt: "2026-10-13T08:00:00.000Z",
    stale: false
  };
  const preflight = {
    cases: 1,
    weakCases: [],
    coverage: {
      available: false,
      designScreens: [],
      screens: [],
      uncoveredScreens: [],
      uncoveredEdges: [],
      explore: { uncoveredScreens: [], uncoveredEdges: [] }
    },
    generation: null,
    artifacts: { testsFile: "t.json", excelFile: "t.xlsx", excelPresent: true, excelStale: false },
    dataPolicy: { missing: [] },
    designWarnings: [
      { code: "flow-graph-empty", message: "流程图为空" },
      { code: "vision-degraded", message: "视觉识别不可用" }
    ],
    designWarningSummary: summary,
    designWarningsSource: "tests",
    designWarningsSnapshotAt: summary.snapshotAt,
    designWarningsStale: false
  };
  const manifest = makeManifest("2026-10-13T08:15:00.000Z", { preflight });

  assert.deepEqual(manifest.designWarnings, summary);
  assert.notEqual(manifest.designWarnings, summary, "摘要为拷贝，不与报告共享引用");

  const file = saveRunManifest(dir, manifest);
  fs.mkdirSync(path.join(dir, "design"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "design", "flows.json"),
    JSON.stringify({ warnings: [{ code: "later-warning", message: "后续变化" }] }),
    "utf-8"
  );

  const read = loadRunManifest(dir, path.basename(file));
  assert.equal(read.kind, "ok");
  assert.deepEqual(read.manifest.designWarnings, summary);

  assert.equal(makeManifest("2026-10-13T08:16:00.000Z").designWarnings, null);
});

test("buildRunManifest：未执行批次与全通过批次的口径", () => {
  const notExecuted = buildRunManifest({
    report: makeReport([], { ok: false, error: "无法读取用例文件" }),
    source: "suite-run",
    startedAtMs: STARTED,
    finishedAtMs: STARTED + 10,
    exitCode: 2,
    coverageIssue: null,
    testsPath: "/x/design/tests.json",
    testsSha256: null,
    testsGeneratedAt: null,
    options: BASE_OPTIONS
  });
  assert.deepEqual(notExecuted.gate, {
    result: "fail",
    exitCode: 2,
    reasons: ["suite-not-executed"]
  });
  assert.equal(notExecuted.error, "无法读取用例文件");

  const passing = makeManifest("2026-10-13T08:20:00.000Z");
  assert.deepEqual(passing.gate, { result: "pass", exitCode: 0, reasons: [] });
  assert.deepEqual(passing.failureDomains, {});
});

test("buildRunManifest：registration 可得即写；缺省不写空对象", () => {
  const registration = {
    regressionTaskId: "task-1",
    caseSetId: "cs-1",
    featureKey: "checkout",
    featureName: "结算",
    platform: "ios",
    appVersion: null,
    runner: "host-1",
    caseSetJsonPath: "/x/design/case-sets/checkout.json",
    testsPath: "/x/design/tests.json"
  };
  const withRegistration = makeManifest("2026-10-13T08:40:00.000Z", {}, { registration });
  assert.deepEqual(withRegistration.registration, registration);
  assert.equal(withRegistration.schemaVersion, 1);

  const without = makeManifest("2026-10-13T08:41:00.000Z");
  assert.equal("registration" in without, false);
  assert.equal(without.schemaVersion, 1);
});

test("save/load roundtrip：含/不含 registration 均可读取；schemaVersion 判别不回归", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const registration = {
    regressionTaskId: null,
    caseSetId: null,
    featureKey: null,
    featureName: null,
    platform: "android",
    appVersion: null,
    runner: "host-2",
    caseSetJsonPath: null,
    testsPath: "/tmp/project/.artemis/design/tests.json"
  };
  const withFile = saveRunManifest(dir, makeManifest("2026-10-13T08:50:00.000Z", {}, { registration }));
  const withoutFile = saveRunManifest(dir, makeManifest("2026-10-13T08:51:00.000Z"));

  const readWith = loadRunManifest(dir, path.basename(withFile));
  assert.equal(readWith.kind, "ok");
  assert.equal(readWith.manifest.schemaVersion, 1);
  assert.deepEqual(readWith.manifest.registration, registration);

  const readWithout = loadRunManifest(dir, path.basename(withoutFile));
  assert.equal(readWithout.kind, "ok");
  assert.equal(readWithout.manifest.schemaVersion, 1);
  assert.equal("registration" in readWithout.manifest, false);
});

test("save/list/load：原子落盘、倒序列表与 latest", () => {
  const dir = makeTempProject({ config: baseConfig() });
  saveRunManifest(dir, makeManifest("2026-10-13T08:00:00.000Z"));
  saveRunManifest(dir, makeManifest("2026-10-13T10:00:00.000Z"));
  saveRunManifest(dir, makeManifest("2026-10-13T09:00:00.000Z"));

  const names = runManifestFileNames(dir);
  assert.equal(names.length, 3);
  assert.deepEqual([...names], [...names].sort().reverse(), "字典序倒序 = 时间倒序");
  assert.ok(names[0].startsWith("run-20261013T100000-"));
  assert.equal(fs.existsSync(path.join(dir, "design", "runs", names[0])), true);

  const latest = loadLatestRunManifest(dir);
  assert.equal(latest.kind, "ok");
  assert.equal(latest.manifest.startedAt, "2026-10-13T10:00:00.000Z");
  const middle = loadRunManifest(dir, names[1]);
  assert.equal(middle.kind, "ok");
  assert.equal(middle.manifest.startedAt, "2026-10-13T09:00:00.000Z");
});

test("saveRunManifest：撞名换后缀重试（独占创建）", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const manifest = makeManifest("2026-10-13T08:30:00.000Z");
  const first = saveRunManifest(dir, manifest, { randomSuffix: () => "aaaaaa" });
  const second = saveRunManifest(dir, manifest, { randomSuffix: () => "bbbbbb" });
  assert.notEqual(second, first);
  assert.ok(second.endsWith(`run-20261013T083000-bbbbbb.json`));
  assert.equal(runManifestFileNames(dir).length, 2);
  assert.equal(loadRunManifest(dir, path.basename(second)).kind, "ok");
});

test("loadRunManifest：判别式读取（missing/invalid/newer 安全映射）", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const runsDir = path.join(dir, "design", "runs");
  fs.mkdirSync(runsDir, { recursive: true });

  assert.equal(loadRunManifest(dir, "run-20260101T000000-deadbe.json").kind, "missing");

  fs.writeFileSync(path.join(runsDir, "run-20260101T000000-aaaaaa.json"), "{oops", "utf-8");
  assert.equal(loadRunManifest(dir, "run-20260101T000000-aaaaaa.json").kind, "invalid");

  fs.writeFileSync(
    path.join(runsDir, "run-20260101T000000-cccccc.json"),
    JSON.stringify({ runId: "run-x" }),
    "utf-8"
  );
  const noVersion = loadRunManifest(dir, "run-20260101T000000-cccccc.json");
  assert.equal(noVersion.kind, "invalid");

  fs.writeFileSync(
    path.join(runsDir, "run-20260101T000000-dddddd.json"),
    JSON.stringify({ schemaVersion: "1", runId: "run-x" }),
    "utf-8"
  );
  assert.equal(loadRunManifest(dir, "run-20260101T000000-dddddd.json").kind, "invalid");

  fs.writeFileSync(
    path.join(runsDir, "run-20260101T000000-bbbbbb.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "run-x",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: 42,
      ok: true,
      summary: { total: "3", passed: 2, failed: 1, extra: 9 },
      cases: []
    }),
    "utf-8"
  );
  const newer = loadRunManifest(dir, "run-20260101T000000-bbbbbb.json");
  assert.equal(newer.kind, "newer");
  assert.equal(newer.version, 2);
  assert.deepEqual(newer.base, {
    runId: "run-x",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    ok: true,
    summary: { total: null, passed: 2, failed: 1 }
  });
});

test("pruneRunManifests：保留最新 N 件；max ≤ 0 不裁剪", () => {
  const dir = makeTempProject({ config: baseConfig() });
  for (const iso of [
    "2026-10-13T08:00:00.000Z",
    "2026-10-13T09:00:00.000Z",
    "2026-10-13T10:00:00.000Z",
    "2026-10-13T11:00:00.000Z"
  ]) {
    saveRunManifest(dir, makeManifest(iso));
  }
  assert.equal(pruneRunManifests(dir, 2), 2);
  const names = runManifestFileNames(dir);
  assert.equal(names.length, 2);
  assert.ok(names[0].startsWith("run-20261013T110000-"));
  assert.ok(names[1].startsWith("run-20261013T100000-"));
  assert.equal(pruneRunManifests(dir, 0), 0);
  assert.equal(runManifestFileNames(dir).length, 2);
});

test("env 开关与 runId 格式", () => {
  assert.equal(runManifestsEnabled({}), true);
  assert.equal(runManifestsEnabled({ AOS_SUITE_RUNS: "0" }), false);
  assert.equal(runManifestsEnabled({ AOS_SUITE_RUNS: "1" }), true);

  assert.equal(runManifestMax({}), 200);
  assert.equal(runManifestMax({ AOS_SUITE_RUNS_MAX: "5" }), 5);
  assert.equal(runManifestMax({ AOS_SUITE_RUNS_MAX: " 12 " }), 12);
  assert.equal(runManifestMax({ AOS_SUITE_RUNS_MAX: "0" }), 200);
  assert.equal(runManifestMax({ AOS_SUITE_RUNS_MAX: "abc" }), 200);

  assert.equal(
    newRunId(Date.parse("2026-10-13T08:15:00.000Z"), "abc123"),
    "run-20261013T081500-abc123"
  );
});

test("retention 分类包含批次清单 runs", () => {
  const runs = RETENTION_CATEGORIES.find((category) => category.id === "runs");
  assert.deepEqual(runs?.segments, [".artemis", "design", "runs"]);
});

test("testsFingerprint：sha256 + mtime；缺失文件降级 null", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const file = path.join(dir, "tests.json");
  const content = JSON.stringify({ flows: [] });
  fs.writeFileSync(file, content, "utf-8");
  const fingerprint = testsFingerprint(file);
  assert.equal(fingerprint.sha256, createHash("sha256").update(content).digest("hex"));
  assert.ok(fingerprint.generatedAt !== null && !Number.isNaN(Date.parse(fingerprint.generatedAt)));
  assert.deepEqual(testsFingerprint(path.join(dir, "missing.json")), {
    sha256: null,
    generatedAt: null
  });
});
