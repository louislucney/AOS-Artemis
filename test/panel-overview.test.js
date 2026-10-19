import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { buildRunManifest, saveRunManifest } from "../dist/figma/run-manifest.js";
import {
  artifactUrl,
  buildPanelBatchDetail,
  buildPanelOverview,
  buildPanelProjectDetail,
  buildPanelReviewQueue,
  buildPanelStatsView,
  buildPanelTaskDetail,
  PANEL_BATCH_EMPTY_CAUSES
} from "../dist/panel/overview.js";
import { baseConfig, makeTempDir, makeTempProject } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

/** ready 状态的宿主仓库：.venv/bin/python + stamp 与 uv.lock 哈希一致。 */
function makeReadyRepo() {
  const repo = makeTempDir("aos-panel-repo-");
  const lock = "lock-v1\n";
  fs.writeFileSync(path.join(repo, "uv.lock"), lock, "utf-8");
  fs.mkdirSync(path.join(repo, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".venv", "bin", "python"), "", "utf-8");
  fs.writeFileSync(
    path.join(repo, ".venv", ".aos-deps.json"),
    JSON.stringify({ lockSha256: createHash("sha256").update(lock).digest("hex") }),
    "utf-8"
  );
  return repo;
}

const COMPLETE_DOTENV = [
  "AOS_LLM_MODEL=deepseek-flash",
  "AOS_LLM_BASE_URL=https://api.deepseek.com/v1",
  "AOS_LLM_API_KEY=sk-test",
  "FIGMA_ACCESS_TOKEN=figma-test",
  "JIRA_BASE_URL=https://example.atlassian.net",
  "JIRA_EMAIL=dev@example.com",
  "JIRA_API_TOKEN=jira-test",
  ""
].join("\n");

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

function makeBatch(dir, { startedIso, traceId, exitCode = 0, failureDomain = null, evidence = null }) {
  const report = {
    ok: true,
    testsPath: path.join(dir, ".artemis", "design", "tests.json"),
    total: 1,
    executed: 1,
    skipped: 0,
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode === 0 ? 0 : 1,
    preflight: null,
    apiErrorCatalog: null,
    cases: [
      {
        caseId: "case-x",
        name: "Case X",
        status: exitCode === 0 ? "passed" : "failed",
        traceId,
        error: null,
        testSummary: null,
        failure: failureDomain
          ? { domain: failureDomain, confidence: "high", reason: "崩溃签名匹配", evidence: [] }
          : null,
        scriptProvenance: null,
        apiErrors: [],
        apiErrorsDegraded: null,
        evidence: evidence ?? { notesDir: null, stderrLog: null, stdoutLog: null },
        reset: null
      }
    ]
  };
  const manifest = buildRunManifest({
    report,
    source: "suite-run",
    startedAtMs: Date.parse(startedIso),
    finishedAtMs: Date.parse(startedIso) + 1000,
    exitCode,
    coverageIssue: null,
    testsPath: report.testsPath,
    testsSha256: null,
    testsGeneratedAt: null,
    options: BASE_OPTIONS
  });
  saveRunManifest(path.join(dir, ".artemis"), manifest);
  return manifest;
}

test("panel overview: green 灯（完整接入 + ready 宿主 + postgres 存储）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "green-app" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.ok, true);
  assert.equal(view.store.degraded, false);
  assert.equal(view.host.deps, "ready");
  assert.equal(view.projects.length, 1);
  const row = view.projects[0];
  assert.equal(row.name, "green-app");
  assert.equal(row.registered, true);
  assert.equal(row.diskReachable, true);
  assert.equal(row.lamp, "green");
  assert.deepEqual(row.lampReasons, []);
  assert.deepEqual(row.integration, { ready: 3, total: 3, missing: [] });
  assert.equal(row.latestBatch, null);
});

test("panel overview: LLM 缺失只影响集成轴（执行灯不再变红）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig() });
  await store.upsertProject({ rootPath: dir, name: "no-llm" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  const row = view.projects[0];
  assert.equal(row.lamp, "green", "LLM 是可选集成，不染执行灯");
  assert.deepEqual(row.lampReasons, []);
  assert.ok(row.integration.missing.includes("LLM"), "集成轴标注缺 LLM");
  assert.equal(row.integration.total, 3);
  assert.equal(row.integration.ready, row.integration.total - row.integration.missing.length);
});

test("panel overview: yellow 灯（执行轴）与 gray 灯（磁盘不可达，短路判定）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const partial = makeTempProject({
    config: baseConfig(),
    dotenv: "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_API_KEY=sk-test\n"
  });
  await store.upsertProject({ rootPath: partial, name: "partial" });
  const gone = path.join(makeTempDir("aos-panel-gone-"), "gone");
  await store.upsertProject({ rootPath: gone, name: "gone-app" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  const partialRow = view.projects.find((row) => row.name === "partial");
  assert.equal(partialRow.lamp, "green", "Figma/Jira 未配置不染执行灯");
  assert.deepEqual(partialRow.lampReasons, []);
  assert.ok(partialRow.integration.missing.includes("Figma"));
  assert.ok(partialRow.integration.missing.includes("Jira"));

  const goneRow = view.projects.find((row) => row.name === "gone-app");
  assert.equal(goneRow.registered, true);
  assert.equal(goneRow.diskReachable, false);
  assert.equal(goneRow.lamp, "gray");
  assert.ok(goneRow.lampReasons[0].includes("磁盘不可达"));
});

test("panel overview: 工作区目录并入项目集合（未注册行）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const workspace = makeTempDir("aos-panel-ws-");
  const sub = path.join(workspace, "ws-app");
  fs.mkdirSync(sub, { recursive: true });

  const view = await buildPanelOverview({
    store,
    serviceRepo: repo,
    buildStale: false,
    env: {},
    workspaceRoot: workspace
  });
  assert.equal(view.workspaceRoot, workspace);
  const row = view.projects.find((project) => project.rootPath === sub);
  assert.ok(row);
  assert.equal(row.registered, false);
  assert.equal(row.diskReachable, true);
});

test("panel overview: 会话内存标注（黄灯）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "mem-app" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.store.degraded, true);
  const row = view.projects[0];
  assert.equal(row.lamp, "yellow");
  assert.ok(row.lampReasons.some((reason) => reason.includes("会话内存")));
});

test("panel detail: 批次清单权威 + 独立运行过滤 + outcome 映射", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "batch-app" });
  const older = makeBatch(dir, {
    startedIso: "2026-10-13T08:00:00.000Z",
    traceId: "trace-0",
    exitCode: 1,
    failureDomain: "app-defect"
  });
  const newer = makeBatch(dir, { startedIso: "2026-10-13T09:00:00.000Z", traceId: "trace-1" });
  await store.recordTask({ rootPath: dir, traceId: "trace-1", status: "completed", model: "deepseek-flash" });
  await store.recordTask({ rootPath: dir, traceId: "trace-2", status: "submitted" });
  await store.recordTask({ rootPath: dir, traceId: "trace-3", status: "failed" });

  const deps = { store, serviceRepo: repo, buildStale: false, env: {} };
  const detail = await buildPanelProjectDetail(deps, dir);
  assert.ok(detail);
  assert.equal(detail.project.latestBatch.runId, newer.runId);
  assert.equal(detail.batches.length, 2);
  assert.equal(detail.batches[0].runId, newer.runId);
  assert.equal(detail.batches[0].gate, "pass");
  assert.equal(detail.batches[1].runId, older.runId);
  assert.equal(detail.batches[1].gate, "fail");
  assert.deepEqual(detail.batches[1].failureDomains, { "app-defect": 1 });
  assert.equal(detail.emptyState, null);

  const traceIds = detail.standalones.map((row) => row.traceId).sort();
  assert.deepEqual(traceIds, ["trace-2", "trace-3"], "批次覆盖的 trace-1 被过滤");
  assert.equal(detail.standalones.find((row) => row.traceId === "trace-2").outcome, "pending");
  assert.equal(detail.standalones.find((row) => row.traceId === "trace-3").outcome, "failed");

  const limited = await buildPanelProjectDetail(deps, dir, { batchLimit: 1 });
  assert.equal(limited.batches.length, 1);
  assert.equal(limited.batches[0].runId, newer.runId);
});

test("panel detail: 无批次时给原因清单（不做断言式归因）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "empty-app" });

  const detail = await buildPanelProjectDetail({ store, serviceRepo: repo, buildStale: false, env: {} }, dir);
  assert.ok(detail);
  assert.deepEqual(detail.batches, []);
  assert.deepEqual(detail.emptyState.causes, [...PANEL_BATCH_EMPTY_CAUSES]);
});

test("panel detail: 回归引用聚合（两份同 key → 两条；最近通过率）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "regression-app" });
  const oldSet = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    createdAt: "2026-10-10T09:00:00.000Z",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: "/x/old.json",
        mdPath: "/x/old.md",
        xlsxPath: "/x/old.xlsx"
      }
    ]
  });
  const newSet = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    createdAt: "2026-10-14T15:30:00.000Z",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 2,
        screens: ["Home"],
        jsonPath: "/x/new.json",
        mdPath: "/x/new.md",
        xlsxPath: "/x/new.xlsx"
      }
    ]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T16:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: newSet.id,
      featureKey: "f-1",
      featureName: "登录流程",
      platform: "android",
      device: null,
      appVersion: null,
      status: "completed",
      startedAt: "2026-10-14T16:00:00.000Z",
      finishedAt: "2026-10-14T16:05:00.000Z",
      total: 2,
      passed: 1,
      failed: 1,
      flaky: 0,
      quarantined: 0,
      failureDomains: { 用例缺陷: 1 },
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: null
    },
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: "f-1",
        platform: "android",
        status: "passed",
        traceId: null,
        failureDomain: null,
        failureConfidence: null,
        failureReason: null,
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      },
      {
        caseId: "case-2",
        name: "Case 2",
        featureKey: "f-1",
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "x",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      }
    ]
  });

  const detail = await buildPanelProjectDetail({ store, serviceRepo: repo, buildStale: false, env: {} }, dir);
  assert.ok(detail);
  assert.equal(detail.regressionRefs.length, 2);
  const newer = detail.regressionRefs.find((ref) => ref.caseSetId === newSet.id);
  const older = detail.regressionRefs.find((ref) => ref.caseSetId === oldSet.id);
  assert.equal(newer.caseCount, 2);
  assert.equal(newer.lastPassRate, 0.5);
  assert.equal(older.lastPassRate, null);
  assert.equal(detail.regressionRefs[0].caseSetId, newSet.id, "新→旧");
});

test("panel batch detail: ok 读取 + 证据链存在性校验（缺失→占位）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "evidence-app" });
  const manifest = makeBatch(dir, {
    startedIso: "2026-10-13T09:00:00.000Z",
    traceId: "trace-1",
    evidence: { notesDir: null, stderrLog: "/nonexistent/stderr.log", stdoutLog: null }
  });
  fs.mkdirSync(path.join(dir, ".artemis", "traces", "trace-1"), { recursive: true });

  const runsDir = path.join(dir, ".artemis", "design", "runs");
  const file = fs.readdirSync(runsDir).find((name) => name.endsWith(".json"));
  const detail = await buildPanelBatchDetail({ store, serviceRepo: repo, buildStale: false, env: {} }, dir, file);
  assert.equal(detail.read, "ok");
  assert.equal(detail.runId, manifest.runId);
  assert.equal(detail.gate.result, "pass");
  assert.equal(detail.taxonomyVersion, 1);

  const entry = detail.cases[0];
  assert.equal(entry.evidence.find((link) => link.kind === "trace").status, "present");
  assert.equal(entry.evidence.find((link) => link.kind === "stderr").status, "missing");
  assert.equal(entry.evidence.some((link) => link.kind === "stdout"), false, "null 路径不生成占位行");
});

test("panel batch detail: newer/invalid/missing 与非法文件名", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "reads-app" });
  const runsDir = path.join(dir, ".artemis", "design", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, "run-20260101T000000-aaaaaa.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId: "run-x",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:10.000Z",
      ok: true,
      summary: { total: 3, passed: 2, failed: 1 }
    }),
    "utf-8"
  );
  fs.writeFileSync(path.join(runsDir, "run-20260101T000000-bbbbbb.json"), "{oops", "utf-8");

  const deps = { store, serviceRepo: repo, buildStale: false, env: {} };
  const newer = await buildPanelBatchDetail(deps, dir, "run-20260101T000000-aaaaaa.json");
  assert.equal(newer.read, "newer");
  assert.equal(newer.runId, "run-x");
  assert.equal(newer.summary.passed, 2);
  assert.ok(newer.note.includes("版本"));

  const invalid = await buildPanelBatchDetail(deps, dir, "run-20260101T000000-bbbbbb.json");
  assert.equal(invalid.read, "invalid");

  const missing = await buildPanelBatchDetail(deps, dir, "run-20260101T000000-cccccc.json");
  assert.equal(missing.read, "missing");

  const illegal = await buildPanelBatchDetail(deps, dir, "../evil.json");
  assert.equal(illegal.read, "invalid");
  assert.ok(illegal.note.includes("非法"));

  const unknown = await buildPanelBatchDetail(deps, "/nope/unknown", "run-20260101T000000-aaaaaa.json");
  assert.equal(unknown, null);
});

test("panel detail: 批次趋势与磁盘资产聚合", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "trend-app" });
  const older = makeBatch(dir, {
    startedIso: "2026-10-13T08:00:00.000Z",
    traceId: "trace-0",
    exitCode: 1,
    failureDomain: "app-defect"
  });
  const newer = makeBatch(dir, { startedIso: "2026-10-13T09:00:00.000Z", traceId: "trace-1" });

  const oldFile = path.join(dir, ".artemis", "design", "reports", "run-old.json");
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "x".repeat(10));
  const oldSeconds = (Date.now() - 120 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldFile, oldSeconds, oldSeconds);

  const detail = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    dir
  );
  assert.ok(detail.trend);
  assert.equal(detail.trend.points.length, 2);
  assert.equal(detail.trend.points[0].runId, older.runId, "时间升序（旧→新）");
  assert.equal(detail.trend.points[0].gate, "fail");
  assert.equal(detail.trend.points[1].runId, newer.runId);
  assert.equal(detail.trend.points[1].gate, "pass");
  assert.deepEqual(detail.trend.domainTotals, { "app-defect": 1 });
  assert.equal(detail.trend.recentPassRate, 1);

  assert.ok(detail.diskAssets);
  assert.equal(detail.diskAssets.crashes.total, 0);
  assert.equal(detail.diskAssets.baselines.count, 0);
  assert.equal(detail.diskAssets.retention.overdue.count, 1);
  assert.deepEqual(detail.diskAssets.warnings, []);
});

test("panel detail: 无批次时 trend 为 null", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "no-trend" });
  const detail = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    dir
  );
  assert.equal(detail.trend, null);
  assert.ok(detail.diskAssets);
});

test("panel detail: 磁盘不可达降级为仅台账（standalones = 全部台账行）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const gone = path.join(makeTempDir("aos-panel-gone-"), "gone");
  await store.upsertProject({ rootPath: gone, name: "gone-app" });
  await store.recordTask({ rootPath: gone, traceId: "trace-g1", status: "completed" });

  const deps = { store, serviceRepo: repo, buildStale: false, env: {} };
  const detail = await buildPanelProjectDetail(deps, gone);
  assert.ok(detail);
  assert.equal(detail.integration, null);
  assert.equal(detail.diskAssets, null);
  assert.equal(detail.trend, null);
  assert.deepEqual(detail.batches, []);
  assert.equal(detail.standalones.length, 1);
  assert.equal(detail.standalones[0].outcome, "passed");
  assert.ok(detail.warnings.some((warning) => warning.includes("磁盘不可达")));

  const unknown = await buildPanelProjectDetail(deps, path.join(makeTempDir("aos-panel-unknown-"), "nope"));
  assert.equal(unknown, null);
});

test("panel detail: buildPanelTaskDetail（引用解析/子运行/对比/跨端；未知 task → null）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "task-app" });
  const set = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });
  const task = await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: set.id, featureKey: "f-1" }],
    platforms: ["ios", "android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.updateRegressionTask(dir, task.id, { status: "completed", runIds: ["r1", "r2"] });

  const caseEntry = (platform, status) => ({
    caseId: "case-1",
    name: "Case 1",
    featureKey: "f-1",
    platform,
    status,
    traceId: null,
    failureDomain: status === "passed" ? null : "用例缺陷",
    failureConfidence: status === "passed" ? null : "medium",
    failureReason: status === "passed" ? null : "断言未命中",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict: null,
    verdictBy: null,
    verdictAt: null,
    verdictNote: null
  });
  const runBase = (platform, status) => ({
    trigger: "cli",
    regressionTaskId: task.id,
    caseSetId: set.id,
    featureKey: "f-1",
    featureName: "登录流程",
    platform,
    device: platform === "ios" ? "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B" : "emulator-5554",
    appVersion: null,
    status,
    startedAt: "2026-10-14T10:00:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
    total: 1,
    passed: status === "completed" ? 1 : 0,
    failed: status === "completed" ? 0 : 1,
    flaky: 0,
    quarantined: 0,
    failureDomains: status === "completed" ? {} : { 用例缺陷: 1 },
    gateResult: status === "completed" ? "pass" : "fail",
    exitCode: status === "completed" ? 0 : 1,
    manifestPath: `/m/${platform}.json`,
    comparison: { baseline: "compared", fixed: 0, regressed: 1, newFailed: 0, vanished: 0 }
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: runBase("ios", "failed"),
    cases: [caseEntry("ios", "failed")]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:06:00.000Z",
    run: runBase("android", "completed"),
    cases: [caseEntry("android", "passed")]
  });

  const deps = { store, serviceRepo: repo, buildStale: false, env: {} };
  const detail = await buildPanelTaskDetail(deps, dir, task.id);
  assert.ok(detail);
  assert.equal(detail.task.status, "completed");
  assert.deepEqual(detail.task.runIds, ["r1", "r2"]);
  assert.equal(detail.refs.length, 1);
  assert.equal(detail.refs[0].featureName, "登录流程");
  assert.equal(detail.refs[0].caseCount, 1);
  assert.equal(detail.runs.length, 2);
  const ios = detail.runs.find((run) => run.platform === "ios");
  assert.equal(ios.status, "failed");
  assert.equal(ios.comparison.regressed, 1);
  assert.equal(ios.manifestPath, "/m/ios.json");
  assert.equal(detail.crossPlatform.length, 1);
  assert.deepEqual(detail.crossPlatform[0].results, { ios: "failed", android: "passed" });

  const projectDetail = await buildPanelProjectDetail(deps, dir);
  assert.equal(projectDetail.tasks.length, 1);
  assert.equal(projectDetail.tasks[0].id, task.id);
  assert.equal(projectDetail.tasks[0].runIds, 2);

  assert.equal(await buildPanelTaskDetail(deps, dir, "task-nope"), null);
});

test("panel detail: 归因队列聚合（未裁决在前、初判字段、已裁决展示）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "review-app" });

  const mkCase = (overrides) => ({
    caseId: "case-1",
    name: "Case 1",
    featureKey: null,
    platform: "android",
    status: "failed",
    traceId: null,
    failureDomain: null,
    failureConfidence: null,
    failureReason: null,
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict: null,
    verdictBy: null,
    verdictAt: null,
    verdictNote: null,
    ...overrides
  });
  const mkRun = (overrides) => ({
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: null,
    featureKey: null,
    featureName: null,
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    status: "failed",
    startedAt: "2026-10-14T09:00:00.000Z",
    finishedAt: "2026-10-14T09:05:00.000Z",
    total: 1,
    passed: 0,
    failed: 1,
    flaky: 0,
    quarantined: 0,
    failureDomains: {},
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null,
    ...overrides
  });

  const older = await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T09:00:00.000Z",
    run: mkRun({}),
    cases: [
      mkCase({
        traceId: "trace-1",
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中"
      })
    ]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({}),
    cases: [
      mkCase({ caseId: "case-2", name: "Case 2", status: "passed" }),
      mkCase({
        caseId: "case-3",
        name: "Case 3",
        verdict: "case-defect",
        verdictBy: "alice",
        verdictAt: "2026-10-14T11:00:00.000Z",
        verdictNote: "期望值写错"
      })
    ]
  });

  const { items, warnings } = await buildPanelReviewQueue(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    dir
  );
  assert.deepEqual(warnings, []);
  assert.equal(items.length, 2, "已通过用例不进队列");
  assert.equal(items[0].caseId, "case-1", "未裁决在前（即使运行更旧）");
  assert.equal(items[0].runId, older.id);
  assert.equal(items[0].name, "Case 1");
  assert.equal(items[0].platform, "android");
  assert.equal(items[0].device, "emulator-5554");
  assert.equal(items[0].status, "failed");
  assert.equal(items[0].failureDomain, "用例缺陷");
  assert.equal(items[0].failureConfidence, "medium");
  assert.equal(items[0].failureReason, "断言未命中");
  assert.equal(items[0].verdict, null);
  assert.equal(items[0].evidencePath, path.join(dir, ".artemis", "traces", "trace-1"));
  assert.equal(items[1].caseId, "case-3");
  assert.equal(items[1].verdict, "case-defect");
  assert.equal(items[1].verdictBy, "alice");
  assert.equal(items[1].verdictNote, "期望值写错");
  assert.equal(items[1].evidencePath, null, "无 traceId → 无证据路径");
});

test("panel detail: buildPanelStatsView（三清单取最新裁决；指引非空；空数据不崩）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "stats-app" });
  const set = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 3,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });

  const mkCase = (caseId, status, verdict) => ({
    caseId,
    name: `Case ${caseId}`,
    featureKey: "f-1",
    platform: "android",
    status,
    traceId: null,
    failureDomain: status === "passed" ? null : "用例缺陷",
    failureConfidence: status === "passed" ? null : "medium",
    failureReason: status === "passed" ? null : "断言未命中",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict,
    verdictBy: verdict === null ? null : "alice",
    verdictAt: verdict === null ? null : "2026-10-14T12:00:00.000Z",
    verdictNote: null
  });
  const mkRun = (overrides) => ({
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: set.id,
    featureKey: "f-1",
    featureName: "登录流程",
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    status: "failed",
    startedAt: "2026-10-14T09:00:00.000Z",
    finishedAt: "2026-10-14T09:05:00.000Z",
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

  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T09:00:00.000Z",
    run: mkRun({}),
    cases: [
      mkCase("case-1", "failed", "case-defect"),
      mkCase("case-2", "failed", "execution-deviation")
    ]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T09:30:00.000Z",
    run: mkRun({ caseSetId: null, featureKey: null, featureName: null }),
    cases: [mkCase("case-standalone", "failed", "case-defect")]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({}),
    cases: [
      mkCase("case-1", "failed", "app-defect"),
      mkCase("case-3", "failed", "case-defect")
    ]
  });

  const view = await buildPanelStatsView(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    dir
  );
  assert.deepEqual(view.warnings, []);
  assert.equal(view.stats.features.length, 1);
  assert.equal(view.stats.features[0].runs, 2);
  assert.equal(view.improvement.caseDefects.length, 1);
  assert.equal(view.improvement.caseDefects[0].caseId, "case-3");
  assert.equal(view.improvement.caseDefects[0].featureName, "登录流程");
  assert.equal(view.improvement.environment.length, 1);
  assert.equal(view.improvement.environment[0].device, "emulator-5554");
  assert.equal(view.improvement.environment[0].platform, "android");
  assert.equal(view.improvement.environment[0].count, 1);
  assert.deepEqual(view.improvement.environment[0].features, ["登录流程"]);
  assert.equal(view.improvement.appDefects.length, 1);
  assert.equal(view.improvement.appDefects[0].caseId, "case-1", "同（份,用例）取最新裁决");
  assert.equal(
    view.improvement.caseDefects.some((entry) => entry.caseId === "case-standalone"),
    false,
    "无份运行不进改进出口（与统计主体口径一致）"
  );
  assert.ok(view.guidance.length >= 3);
  assert.ok(view.guidance.some((line) => line.includes("figma_generate_tests")));
  assert.ok(view.guidance.some((line) => line.includes("jira issue create")));

  const emptyDir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: emptyDir, name: "stats-empty" });
  const empty = await buildPanelStatsView(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    emptyDir
  );
  assert.deepEqual(empty.stats.features, []);
  assert.deepEqual(empty.improvement.caseDefects, []);
  assert.deepEqual(empty.improvement.environment, []);
  assert.deepEqual(empty.improvement.appDefects, []);
  assert.ok(Array.isArray(empty.guidance));
});

test("panel detail: runners 聚合（在线按 TTL；含设备/工具；无 runner → []）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "runner-app" });
  const runner = await store.upsertRunner({
    rootPath: dir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    artifactBaseUrl: "http://mac-1:8770"
  });
  const seenMs = Date.parse(runner.lastSeenAt);

  const online = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {}, now: () => seenMs + 10_000 },
    dir
  );
  assert.equal(online.runners.length, 1);
  assert.equal(online.runners[0].id, runner.id);
  assert.equal(online.runners[0].online, true);
  assert.equal(online.runners[0].name, "r-1");
  assert.equal(online.runners[0].devices[0].serial, "emulator-5554");
  assert.deepEqual(online.runners[0].tools, {
    adb: true,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false
  });
  assert.equal(online.runners[0].artifactBaseUrl, "http://mac-1:8770");

  const offline = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {}, now: () => seenMs + 120_000 },
    dir
  );
  assert.equal(offline.runners[0].online, false, "TTL 过期 → 离线");

  const emptyDir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: emptyDir, name: "empty-app" });
  const empty = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    emptyDir
  );
  assert.deepEqual(empty.runners, []);
});

test("panel detail: 任务详情 runner 匹配（claimedBy=runner id；未领取 → null）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "task-runner-app" });
  const taskInput = {
    rootPath: dir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  };
  const task = await store.createRegressionTask(taskInput);
  const runner = await store.upsertRunner({
    rootPath: dir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  });
  await store.claimRegressionTask({ rootPath: dir, runnerId: runner.id, platforms: ["android"] });
  const deps = {
    store,
    serviceRepo: repo,
    buildStale: false,
    env: {},
    now: () => Date.parse(runner.lastSeenAt) + 5_000
  };

  const detail = await buildPanelTaskDetail(deps, dir, task.id);
  assert.ok(detail);
  assert.equal(detail.task.claimedBy, runner.id);
  assert.equal(detail.runner.id, runner.id);
  assert.equal(detail.runner.online, true);
  assert.equal(detail.runners.length, 1);

  const second = await store.createRegressionTask(taskInput);
  const pending = await buildPanelTaskDetail(deps, dir, second.id);
  assert.equal(pending.runner, null, "未领取 → null");
});

test("artifactUrl: 相对 .artemis 分段编码；越界/无基址/null → null", () => {
  assert.equal(
    artifactUrl("http://mac:8770", "/proj", "/proj/.artemis/design/runs/a b.json"),
    "http://mac:8770/artifact/design/runs/a%20b.json"
  );
  assert.equal(
    artifactUrl("http://mac:8770/", "/proj", "/proj/.artemis/design/中文/1.png"),
    `http://mac:8770/artifact/design/${encodeURIComponent("中文")}/1.png`
  );
  assert.equal(artifactUrl("http://mac:8770", "/proj", "/proj/.artemis"), "http://mac:8770/artifact/");
  assert.equal(artifactUrl("http://mac:8770", "/proj", "/proj/secret.txt"), null, "越界拒绝");
  assert.equal(
    artifactUrl("http://mac:8770", "/proj", "/proj/.artemis-old/x"),
    null,
    "前缀近似但越界"
  );
  assert.equal(artifactUrl(null, "/proj", "/proj/.artemis/x"), null, "无基址");
  assert.equal(artifactUrl("http://mac:8770", "/proj", null), null);
});

test("panel detail: 产物链接（manifestUrl/jsonUrl/xlsxUrl/evidenceUrl；无 runner → null）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "artifact-app" });
  const caseSetsDir = path.join(dir, ".artemis", "design", "case-sets");
  const set = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: path.join(caseSetsDir, "20261014T153000_登录.json"),
        mdPath: path.join(caseSetsDir, "20261014T153000_登录.md"),
        xlsxPath: path.join(caseSetsDir, "20261014T153000_登录.xlsx")
      }
    ]
  });
  const task = await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: set.id, featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: task.id,
      caseSetId: set.id,
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
      manifestPath: path.join(dir, ".artemis", "design", "runs", "run-1.json"),
      comparison: null
    },
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: "f-1",
        platform: "android",
        status: "failed",
        traceId: "trace-1",
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      }
    ]
  });

  const deps = { store, serviceRepo: repo, buildStale: false, env: {} };
  const bare = await buildPanelTaskDetail(deps, dir, task.id);
  assert.equal(bare.refs[0].jsonUrl, null, "无 runner → 无链接");
  assert.ok(bare.refs[0].xlsxPath.endsWith("_登录.xlsx"));
  assert.equal(bare.runs[0].artifacts.manifestUrl, null);
  const bareQueue = await buildPanelReviewQueue(deps, dir);
  assert.equal(bareQueue.items[0].evidenceUrl, null);

  const runner = await store.upsertRunner({
    rootPath: dir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    artifactBaseUrl: "http://mac-1:8770"
  });
  await store.claimRegressionTask({ rootPath: dir, runnerId: runner.id, platforms: ["android"] });

  const detail = await buildPanelTaskDetail(deps, dir, task.id);
  assert.equal(detail.runner.name, "r-1");
  assert.equal(
    detail.runs[0].artifacts.manifestUrl,
    "http://mac-1:8770/artifact/design/runs/run-1.json"
  );
  assert.equal(
    detail.refs[0].jsonUrl,
    `http://mac-1:8770/artifact/design/case-sets/${encodeURIComponent("20261014T153000_登录.json")}`
  );
  assert.equal(
    detail.refs[0].xlsxUrl,
    `http://mac-1:8770/artifact/design/case-sets/${encodeURIComponent("20261014T153000_登录.xlsx")}`
  );
  const queue = await buildPanelReviewQueue(deps, dir);
  assert.equal(queue.items[0].evidenceUrl, "http://mac-1:8770/artifact/traces/trace-1");
});

test("panel detail: schedules 聚合 + lastTask 匹配（schedule:<name>）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "schedule-app" });
  const schedule = await store.createSchedule({
    rootPath: dir,
    name: "夜间回归",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 720,
    createdBy: "cli"
  });
  await store.claimScheduleWindow({
    rootPath: dir,
    scheduleId: schedule.id,
    firedAt: "2026-10-14T02:00:00.000Z",
    cutoff: "2026-10-14T01:00:00.000Z"
  });
  const created = await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "schedule:夜间回归"
  });
  await store.updateRegressionTask(dir, created.id, { status: "completed" });
  await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });

  const detail = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    dir
  );
  assert.equal(detail.schedules.length, 1);
  const view = detail.schedules[0];
  assert.equal(view.name, "夜间回归");
  assert.deepEqual(view.featureKeys, ["f-1"]);
  assert.equal(view.everyMinutes, 720);
  assert.equal(view.enabled, true);
  assert.equal(view.lastFiredAt, "2026-10-14T02:00:00.000Z");
  assert.equal(view.lastTaskId, created.id, "匹配 schedule:<name> 任务");
  assert.equal(view.lastTaskStatus, "completed");

  const emptyDir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: emptyDir, name: "empty-sched" });
  const empty = await buildPanelProjectDetail(
    { store, serviceRepo: repo, buildStale: false, env: {} },
    emptyDir
  );
  assert.deepEqual(empty.schedules, []);
});
