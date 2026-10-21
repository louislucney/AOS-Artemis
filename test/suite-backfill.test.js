import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { runBackfill } from "../dist/tasks/backfill.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

async function makeRuntime(store, dir) {
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({ running: false }),
    store
  });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return runtime;
}

function runCase(caseId, overrides = {}) {
  return {
    caseId,
    name: `Case ${caseId}`,
    status: "passed",
    traceId: `trace-${caseId}`,
    error: null,
    failure: null,
    quarantined: false,
    retry: null,
    ...overrides
  };
}

function manifestRecord({ runId, startedAt, finishedAt, exitCode = 0, registration, deviceSerial = null, cases = [] }) {
  return {
    schemaVersion: 1,
    runId,
    source: "suite-run",
    ...(registration ? { registration } : {}),
    taxonomyVersion: 1,
    startedAt,
    finishedAt,
    ok: exitCode === 0,
    error: null,
    tests: { path: "/x/design/tests.json", sha256: null, generatedAt: null },
    options: {
      deviceSerial,
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
    },
    preflight: null,
    apiErrorCatalog: null,
    summary: {
      total: cases.length,
      executed: cases.length,
      skipped: 0,
      passed: cases.filter((entry) => entry.status === "passed").length,
      failed: cases.filter((entry) => entry.status !== "passed").length,
      flaky: cases.filter((entry) => entry.retry?.flaky === true).length,
      quarantinedFailed: cases.filter((entry) => entry.quarantined === true && entry.status !== "passed").length
    },
    gate: { result: exitCode === 0 ? "pass" : "fail", exitCode, reasons: [] },
    failureDomains: {},
    cases
  };
}

function writeManifest(runtime, { fileName, ...rest }) {
  const dir = path.join(runtime.configDirAbs, "design", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(
    file,
    JSON.stringify(manifestRecord({ ...rest, runId: fileName.replace(/\.json$/, "") }), null, 2) + "\n",
    "utf-8"
  );
  return file;
}

function archiveFlow(id, screens) {
  return { id, name: `Case ${id}`, screens, feature: "f", taskDesc: "run", steps: [], expectations: [] };
}

function writeArchive(runtime, { stem, source = "pen:a.pen", featureKey, featureName, featureScreens = [], flows = [], withMd = false, withXlsx = false }) {
  const dir = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${stem}.json`);
  const mdPath = path.join(dir, `${stem}.md`);
  const xlsxPath = path.join(dir, `${stem}.xlsx`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        source,
        features: [{ key: featureKey, name: featureName, screens: featureScreens, caseIds: flows.map((entry) => entry.id) }],
        flows,
        counts: { flows: flows.length, screens: 3, edges: 5 }
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );
  if (withMd) fs.writeFileSync(mdPath, "# markdown\n", "utf-8");
  if (withXlsx) fs.writeFileSync(xlsxPath, "fake-xlsx", "utf-8");
  return { jsonPath, mdPath, xlsxPath };
}

function minimalRun(overrides = {}) {
  return {
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: null,
    featureKey: null,
    featureName: null,
    platform: "android",
    device: null,
    appVersion: null,
    runner: null,
    status: "completed",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    quarantined: 0,
    failureDomains: {},
    gateResult: "pass",
    exitCode: 0,
    manifestPath: null,
    comparison: null,
    ...overrides
  };
}

async function runCli(runtime, args, extra = {}) {
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(args, {
    buildRuntime: extra.buildRuntime ?? (async () => ({ runtime, dispose: async () => {} })),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...extra.deps
  });
  return { code, logs, errors };
}

test("backfill runs: 登记 2 份、跳过已登记、坏 JSON invalid；登记行字段/平台分类/缺维度 null/createdAt=finishedAt", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);

  const aPath = writeManifest(runtime, {
    fileName: "run-20261014T150000-aaaaaa.json",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    deviceSerial: "emulator-5554",
    registration: {
      regressionTaskId: "task-1",
      caseSetId: "cs-a",
      featureKey: "f-a",
      featureName: "功能A",
      runner: "host-x"
    },
    cases: [
      runCase("case-1"),
      runCase("case-2", {
        status: "failed",
        failure: { domain: "app-defect", confidence: "high", reason: "boom" },
        retry: { attempts: 1, finalStatus: "passed", finalTraceId: "trace-2b", flaky: true }
      })
    ]
  });

  const bPath = writeManifest(runtime, {
    fileName: "run-20261014T160000-bbbbbb.json",
    startedAt: "2026-10-14T15:59:00.000Z",
    finishedAt: "2026-10-14T16:00:00.000Z",
    cases: [runCase("case-3")]
  });

  const cPath = writeManifest(runtime, {
    fileName: "run-20261014T170000-cccccc.json",
    startedAt: "2026-10-14T16:59:00.000Z",
    finishedAt: "2026-10-14T17:00:00.000Z",
    cases: [runCase("case-4")]
  });
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: minimalRun({ manifestPath: cPath }),
    cases: []
  });

  fs.writeFileSync(path.join(runtime.configDirAbs, "design", "runs", "run-20261014T180000-dddddd.json"), "{oops", "utf-8");

  const report = await runBackfill(runtime);
  assert.equal(report.scanned.runs, 4);
  assert.equal(report.registered.runs, 2);
  assert.equal(report.skipped, 1);
  assert.equal(report.invalid, 1);
  assert.equal(report.beforeSince, 0);

  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  const a = runs.find((entry) => entry.manifestPath === aPath);
  assert.ok(a, "A 登记");
  assert.equal(a.trigger, "cli");
  assert.equal(a.platform, "android");
  assert.equal(a.device, "emulator-5554");
  assert.equal(a.regressionTaskId, "task-1");
  assert.equal(a.caseSetId, "cs-a");
  assert.equal(a.featureKey, "f-a");
  assert.equal(a.featureName, "功能A");
  assert.equal(a.runner, "host-x");
  assert.equal(a.appVersion, null);
  assert.equal(a.createdAt, "2026-10-14T15:00:00.000Z");
  assert.equal(a.status, "completed");
  assert.equal(a.gateResult, "pass");
  assert.equal(a.total, 2);
  assert.equal(a.passed, 1);
  assert.equal(a.failed, 1);
  assert.equal(a.flaky, 1);
  assert.equal(a.quarantined, 0);
  assert.equal(a.cases.length, 2);
  const flakyCase = a.cases.find((entry) => entry.caseId === "case-2");
  assert.equal(flakyCase.flaky, true);
  assert.equal(flakyCase.failureDomain, "app-defect");
  assert.equal(flakyCase.traceId, "trace-case-2");

  const b = runs.find((entry) => entry.manifestPath === bPath);
  assert.ok(b, "B 登记");
  assert.equal(b.platform, "unknown");
  assert.equal(b.caseSetId, null);
  assert.equal(b.featureKey, null);
  assert.equal(b.featureName, null);
  assert.equal(b.regressionTaskId, null);
  assert.equal(b.runner, null);
  assert.equal(b.appVersion, null);
  assert.equal(b.cases[0].featureKey, null);
});

test("backfill 冲突: 直插同名 manifest_path → 23505 归 skipped（不双行）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = await makePgStore();
  const runtime = await makeRuntime(store, dir);

  const xPath = writeManifest(runtime, {
    fileName: "run-20261014T150000-aaaaaa.json",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    cases: [runCase("case-1")]
  });
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T15:00:00.000Z",
    run: minimalRun({ manifestPath: xPath }),
    cases: []
  });
  // 模拟并发窗口：应用层查重漏掉，但 DB 唯一索引命中 23505
  store.listRegisteredManifestPaths = async () => [];

  const report = await runBackfill(runtime);
  assert.equal(report.registered.runs, 0);
  assert.equal(report.skipped, 1);
  assert.equal(report.invalid, 0);

  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(runs.filter((entry) => entry.manifestPath === xPath).length, 1, "不双行");
});

test("backfill since: 空库无下界＋warning；最早登记晚于远古 manifest → beforeSince；显式 since 覆盖", async () => {
  {
    const dir = makeTempProject({ config: baseConfig() });
    const store = new MemoryStore();
    const runtime = await makeRuntime(store, dir);
    writeManifest(runtime, {
      fileName: "run-20261014T150000-aaaaaa.json",
      startedAt: "2026-10-14T14:59:00.000Z",
      finishedAt: "2026-10-14T15:00:00.000Z",
      cases: [runCase("case-1")]
    });
    const report = await runBackfill(runtime);
    assert.equal(report.beforeSince, 0);
    assert.equal(report.registered.runs, 1);
    assert.ok(report.warnings.some((warning) => warning.includes("无下界")), "空库告警");
  }

  {
    const dir = makeTempProject({ config: baseConfig() });
    const store = new MemoryStore();
    const runtime = await makeRuntime(store, dir);
    await store.recordSuiteRun({
      rootPath: runtime.project.rootDir,
      createdAt: "2026-10-14T10:00:00.000Z",
      run: minimalRun(),
      cases: []
    });
    const ancient = writeManifest(runtime, {
      fileName: "run-20260101T000000-ancient.json",
      startedAt: "2025-12-31T23:59:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      cases: [runCase("case-a")]
    });
    const recent = writeManifest(runtime, {
      fileName: "run-20261015T150000-recent.json",
      startedAt: "2026-10-15T14:59:00.000Z",
      finishedAt: "2026-10-15T15:00:00.000Z",
      cases: [runCase("case-b")]
    });
    const report = await runBackfill(runtime);
    assert.equal(report.beforeSince, 1);
    assert.equal(report.registered.runs, 1);
    const runs = await store.listSuiteRuns(runtime.project.rootDir);
    assert.equal(runs.some((entry) => entry.manifestPath === ancient), false);
    assert.equal(runs.some((entry) => entry.manifestPath === recent), true);
  }

  {
    const dir = makeTempProject({ config: baseConfig() });
    const store = new MemoryStore();
    const runtime = await makeRuntime(store, dir);
    await store.recordSuiteRun({
      rootPath: runtime.project.rootDir,
      createdAt: "2026-10-14T10:00:00.000Z",
      run: minimalRun(),
      cases: []
    });
    const ancient = writeManifest(runtime, {
      fileName: "run-20260101T000000-ancient.json",
      startedAt: "2025-12-31T23:59:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      cases: [runCase("case-a")]
    });
    const report = await runBackfill(runtime, { since: "2025-01-01T00:00:00.000Z" });
    assert.equal(report.beforeSince, 0);
    assert.equal(report.registered.runs, 1);
    const runs = await store.listSuiteRuns(runtime.project.rootDir);
    assert.equal(runs.some((entry) => entry.manifestPath === ancient), true);
  }
});

test("backfill since 归一化: 带时区 --since 与内部 UTC 时间戳字符串比较正确", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);
  const before = writeManifest(runtime, {
    fileName: "run-20251231T150000-before.json",
    startedAt: "2025-12-31T14:59:00.000Z",
    finishedAt: "2025-12-31T15:00:00.000Z",
    cases: [runCase("case-before")]
  });
  const after = writeManifest(runtime, {
    fileName: "run-20251231T170000-after.json",
    startedAt: "2025-12-31T16:59:00.000Z",
    finishedAt: "2025-12-31T17:00:00.000Z",
    cases: [runCase("case-after")]
  });
  const report = await runBackfill(runtime, { since: "2026-01-01T00:00:00+08:00" });
  assert.equal(report.beforeSince, 1);
  assert.equal(report.registered.runs, 1);
  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(runs.some((entry) => entry.manifestPath === before), false);
  assert.equal(runs.some((entry) => entry.manifestPath === after), true);
});

test("backfill 畸形 manifest（缺 summary/gate/cases）→ invalid＋友好 warning", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);
  const runsDir = path.join(runtime.configDirAbs, "design", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(
    path.join(runsDir, "run-20261014T150000-malformed.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: "run-20261014T150000-malformed",
      startedAt: "2026-10-14T14:59:00.000Z",
      finishedAt: "2026-10-14T15:00:00.000Z"
    }),
    "utf-8"
  );
  const report = await runBackfill(runtime);
  assert.equal(report.invalid, 1);
  assert.equal(report.registered.runs, 0);
  assert.ok(report.warnings.some((warning) => warning.includes("清单缺 summary/gate/cases")), "友好 warning");
});

test("backfill 路径桥: 先 sets 后 runs，重映射新 id 且 feature 自归档恢复；匹配不到原值保留", async () => {  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);

  const archive = writeArchive(runtime, {
    stem: "20261014T150000_结算",
    featureKey: "f-结算-new",
    featureName: "结算流程",
    flows: [archiveFlow("case-结算-1", ["结算页", "确认页"])]
  });

  const m1 = writeManifest(runtime, {
    fileName: "run-20261014T160000-aaaaaa.json",
    startedAt: "2026-10-14T15:59:00.000Z",
    finishedAt: "2026-10-14T16:00:00.000Z",
    registration: {
      caseSetId: "cs-old",
      featureKey: "f-old",
      featureName: "旧值",
      caseSetJsonPath: archive.jsonPath
    },
    cases: [runCase("case-1")]
  });

  const m2 = writeManifest(runtime, {
    fileName: "run-20261014T170000-bbbbbb.json",
    startedAt: "2026-10-14T16:59:00.000Z",
    finishedAt: "2026-10-14T17:00:00.000Z",
    registration: {
      caseSetId: "cs-old2",
      featureKey: "f-old2",
      featureName: "旧值2",
      caseSetJsonPath: "/nonexistent.json"
    },
    cases: [runCase("case-2")]
  });

  const report = await runBackfill(runtime);
  assert.equal(report.scanned.caseSets, 1);
  assert.equal(report.registered.caseSets, 1);
  assert.equal(report.registered.runs, 2);

  const sets = await store.listCaseSets(runtime.project.rootDir);
  assert.equal(sets.length, 1);
  const newId = sets[0].id;

  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  const r1 = runs.find((entry) => entry.manifestPath === m1);
  assert.equal(r1.caseSetId, newId);
  assert.equal(r1.featureKey, "f-结算-new");
  assert.equal(r1.featureName, "结算流程");
  assert.equal(r1.cases[0].featureKey, "f-结算-new");

  const r2 = runs.find((entry) => entry.manifestPath === m2);
  assert.equal(r2.caseSetId, "cs-old2");
  assert.equal(r2.featureKey, "f-old2");
  assert.equal(r2.featureName, "旧值2");
});

test("backfill case-sets: 登记 1 归档（缺 xlsx 告警仍登记）、跳过已登记、坏 JSON invalid；字段口径", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);

  const a = writeArchive(runtime, {
    stem: "20261014_150000_登录",
    source: "pen:login.pen",
    featureKey: "f-登录",
    featureName: "登录流程",
    flows: [archiveFlow("case-1", ["Home", "Login"]), archiveFlow("case-2", ["Login", "Home"])],
    withMd: true
  });

  const b = writeArchive(runtime, {
    stem: "20261014T160000_下单",
    source: "pen:order.pen",
    featureKey: "f-下单",
    featureName: "下单流程",
    flows: [archiveFlow("case-3", ["Cart"])],
    withMd: true,
    withXlsx: true
  });
  await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:order.pen",
    basename: "tests",
    createdAt: "2026-10-14T10:00:00.000Z",
    features: [
      {
        key: "f-下单",
        name: "下单流程",
        caseCount: 1,
        screens: ["Cart"],
        jsonPath: b.jsonPath,
        mdPath: b.mdPath,
        xlsxPath: b.xlsxPath
      }
    ]
  });

  const caseSetsDirPath = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.writeFileSync(path.join(caseSetsDirPath, "20261014T170000_坏.json"), "{oops", "utf-8");

  const report = await runBackfill(runtime);
  assert.equal(report.scanned.caseSets, 3);
  assert.equal(report.registered.caseSets, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.invalid, 1);
  assert.ok(report.warnings.some((warning) => warning.includes("xlsx")), "缺 xlsx 告警");

  const sets = await store.listCaseSets(runtime.project.rootDir);
  const aSet = sets.find((entry) => entry.features.some((feature) => feature.jsonPath === a.jsonPath));
  assert.ok(aSet, "A 登记");
  assert.equal(aSet.basename, "20261014_150000_登录");
  assert.equal(aSet.designName, null);
  assert.equal(aSet.source, "pen:login.pen");
  assert.equal(aSet.fingerprint, createHash("sha256").update(fs.readFileSync(a.jsonPath)).digest("hex"));
  assert.equal(aSet.createdAt, "2026-10-14T15:00:00.000Z");
  assert.equal(aSet.features.length, 1);
  assert.equal(aSet.features[0].key, "f-登录");
  assert.equal(aSet.features[0].name, "登录流程");
  assert.equal(aSet.features[0].caseCount, 2);
  assert.deepEqual(aSet.features[0].screens, ["Home", "Login"]);
  assert.equal(aSet.features[0].mdPath, a.mdPath);
  assert.equal(aSet.features[0].xlsxPath, a.xlsxPath);
});

test("backfill: 归档 features[0].screens 优先于 flows 并集（屏集不被用例覆盖放大）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);

  const archive = writeArchive(runtime, {
    stem: "20261019T100137_到店自取",
    featureKey: "f-到店自取",
    featureName: "到店自取",
    featureScreens: ["Cart", "Pay"],
    flows: [archiveFlow("case-1", ["Cart", "Pay", "Extra"])],
    withMd: true
  });

  const report = await runBackfill(runtime);
  assert.equal(report.registered.caseSets, 1);
  const sets = await store.listCaseSets(runtime.project.rootDir);
  const rebuilt = sets.find((entry) => entry.features.some((feature) => feature.jsonPath === archive.jsonPath));
  assert.ok(rebuilt, "归档登记");
  assert.deepEqual(rebuilt.features[0].screens, ["Cart", "Pay"]);
  assert.equal(rebuilt.features[0].caseCount, 1);
});

test("backfill 幂等: 第二次全 skip；dry-run 不写库且 wouldRegister=将登记数", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);

  writeManifest(runtime, {
    fileName: "run-20261014T150000-aaaaaa.json",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    cases: [runCase("case-1")]
  });
  writeArchive(runtime, {
    stem: "20261014T150000_登录",
    featureKey: "f-登录",
    featureName: "登录流程",
    flows: [archiveFlow("case-1", ["Home"])]
  });

  const first = await runBackfill(runtime);
  assert.equal(first.scanned.runs, 1);
  assert.equal(first.scanned.caseSets, 1);
  assert.equal(first.registered.runs, 1);
  assert.equal(first.registered.caseSets, 1);

  const second = await runBackfill(runtime);
  assert.equal(second.registered.runs, 0);
  assert.equal(second.registered.caseSets, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.scanned.runs, 1);
  assert.equal(second.scanned.caseSets, 1);

  const dir2 = makeTempProject({ config: baseConfig() });
  const store2 = new MemoryStore();
  const runtime2 = await makeRuntime(store2, dir2);
  writeManifest(runtime2, {
    fileName: "run-20261014T150000-aaaaaa.json",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    cases: [runCase("case-1")]
  });
  writeArchive(runtime2, {
    stem: "20261014T150000_登录",
    featureKey: "f-登录",
    featureName: "登录流程",
    flows: [archiveFlow("case-1", ["Home"])]
  });

  const beforeRuns = (await store2.listSuiteRuns(runtime2.project.rootDir)).length;
  const beforeSets = (await store2.listCaseSets(runtime2.project.rootDir)).length;
  const dry = await runBackfill(runtime2, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.registered.runs, 0);
  assert.equal(dry.registered.caseSets, 0);
  assert.equal(dry.wouldRegister.runs, 1);
  assert.equal(dry.wouldRegister.caseSets, 1);
  assert.equal(dry.scanned.runs, 1);
  assert.equal(dry.scanned.caseSets, 1);
  assert.equal((await store2.listSuiteRuns(runtime2.project.rootDir)).length, beforeRuns);
  assert.equal((await store2.listCaseSets(runtime2.project.rootDir)).length, beforeSets);
});

test("命令层: usage 列出 backfill；内存 store → exit 2（持久台账守卫）；--json 形状", async () => {
  const helpLogs = [];
  await runSuiteCommand(["help"], {
    buildRuntime: async () => {
      throw new Error("unused");
    },
    log: (line) => helpLogs.push(line),
    errorLog: () => {}
  });
  assert.ok(helpLogs.join("\n").includes("suite backfill"), "usage 列出 backfill");

  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);
  const mem = await runCli(runtime, ["backfill"]);
  assert.equal(mem.code, 2);
  assert.ok(mem.errors.some((line) => line.includes("会话内存")), "持久台账守卫提示");

  const dir2 = makeTempProject({ config: baseConfig() });
  const store2 = await makePgStore();
  const runtime2 = await makeRuntime(store2, dir2);
  writeManifest(runtime2, {
    fileName: "run-20261014T150000-aaaaaa.json",
    startedAt: "2026-10-14T14:59:00.000Z",
    finishedAt: "2026-10-14T15:00:00.000Z",
    cases: [runCase("case-1")]
  });
  const json = await runCli(runtime2, ["backfill", "--json"]);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.logs.join("\n"));
  assert.equal(report.scanned.runs, 1);
  assert.equal(report.registered.runs, 1);
  assert.equal(report.dryRun, false);
  assert.equal("beforeSince" in report, true);
  assert.equal("wouldRegister" in report, true);
});

test("命令层: --since 非法 → exit 2 不进入扫描", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = await makePgStore();
  const runtime = await makeRuntime(store, dir);
  const res = await runCli(runtime, ["backfill", "--since", "abc"]);
  assert.equal(res.code, 2);
  assert.ok(res.errors.some((line) => line.includes("--since 非法")), "非法 since 提示");
});

test("命令层: --since 与 --project 生效", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = await makePgStore();
  const runtime = await makeRuntime(store, dir);
  await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: minimalRun(),
    cases: []
  });
  writeManifest(runtime, {
    fileName: "run-20260101T000000-ancient.json",
    startedAt: "2025-12-31T23:59:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    cases: [runCase("case-a")]
  });

  let projectArg = null;
  const logs = [];
  const code = await runSuiteCommand(
    ["backfill", "--since", "2025-01-01T00:00:00.000Z", "--project", dir, "--json"],
    {
      buildRuntime: async (projectDir) => {
        projectArg = projectDir;
        return { runtime, dispose: async () => {} };
      },
      log: (line) => logs.push(line),
      errorLog: () => {}
    }
  );
  assert.equal(code, 0);
  assert.equal(projectArg, dir, "--project 透传");
  const report = JSON.parse(logs.join("\n"));
  assert.equal(report.beforeSince, 0, "--since 覆盖默认下界");
  assert.equal(report.registered.runs, 1, "远古 manifest 被登记");
});

test("suite backfill: 从导入归档重建登记（top-level source + features）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const runtime = await makeRuntime(store, dir);
  const file = path.join(dir, "qa.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例名", "步骤", "预期"]);
  sheet.addRow(["登录", "点击登录", "进入首页"]);
  await workbook.xlsx.writeFile(file);
  const imported = await importTestDocument(runtime, { excelPath: file });
  assert.equal(imported.ok, true, JSON.stringify(imported));

  const fresh = new MemoryStore();
  const runtime2 = await makeRuntime(fresh, dir);
  const report = await runBackfill(runtime2);
  assert.equal(report.registered.caseSets, 1, JSON.stringify(report));
  const sets = await fresh.listCaseSets(runtime2.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].source, imported.sourceId);
  assert.equal(sets[0].features[0].caseCount, 1);
  assert.equal(sets[0].features[0].key, imported.sets[0].featureKey);
});
