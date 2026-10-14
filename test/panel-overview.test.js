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
  buildPanelBatchDetail,
  buildPanelOverview,
  buildPanelProjectDetail,
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
  assert.equal(row.latestBatch, null);
});

test("panel overview: red 灯（无可用 LLM）", async () => {
  const store = await makePgStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig() });
  await store.upsertProject({ rootPath: dir, name: "no-llm" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  const row = view.projects[0];
  assert.equal(row.lamp, "red");
  assert.ok(row.lampReasons[0].includes("setup_required"));
});

test("panel overview: yellow 灯（凭证缺）与 gray 灯（磁盘不可达，短路判定）", async () => {
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
  assert.equal(partialRow.lamp, "yellow");
  assert.ok(partialRow.lampReasons.some((reason) => reason.includes("Figma token 未配置")));
  assert.ok(partialRow.lampReasons.some((reason) => reason.includes("Jira 未配置")));

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

test("panel overview: 内存存储降级标注（黄灯）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "mem-app" });

  const view = await buildPanelOverview({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.store.degraded, true);
  const row = view.projects[0];
  assert.equal(row.lamp, "yellow");
  assert.ok(row.lampReasons.some((reason) => reason.includes("存储降级")));
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
