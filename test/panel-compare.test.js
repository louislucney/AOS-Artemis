import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { buildPanelCompare, selectCompareRows } from "../dist/panel/compare.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { baseConfig, makeTempDir, makeTempProject } from "./helpers.js";

function makeReadyRepo() {
  const repo = makeTempDir("aos-panel-compare-repo-");
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

function mkCase(overrides = {}) {
  return {
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
  };
}

function mkRun(overrides = {}) {
  return {
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
  };
}

async function makeHarness() {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "compare-app" });
  return { store, repo, dir };
}

test("panel compare: 聚合（窗口稀释 40→lineage 15；latestBatch/trend/flaky/domains）", async () => {
  const { store, repo, dir } = await makeHarness();
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

  const lineageDomains = (i) => {
    if (i < 5) return { a: 2, b: 1 };
    if (i < 10) return { c: 3 };
    return { a: 1, b: 3 };
  };

  for (let i = 0; i < 25; i += 1) {
    const minute = String(i).padStart(2, "0");
    await store.recordSuiteRun({
      rootPath: dir,
      createdAt: `2026-10-14T00:${minute}:00.000Z`,
      run: mkRun({
        caseSetId: null,
        featureKey: null,
        featureName: null,
        finishedAt: `2026-10-14T00:${minute}:05.000Z`
      }),
      cases: []
    });
  }
  for (let i = 0; i < 15; i += 1) {
    const minute = String(25 + i).padStart(2, "0");
    const newest = i === 14;
    await store.recordSuiteRun({
      rootPath: dir,
      createdAt: `2026-10-14T00:${minute}:00.000Z`,
      run: mkRun({
        caseSetId: set.id,
        featureKey: "f-1",
        featureName: "登录流程",
        finishedAt: `2026-10-14T00:${minute}:05.000Z`,
        flaky: 1,
        failureDomains: lineageDomains(i),
        gateResult: newest ? "fail" : "pass",
        total: newest ? 4 : 2,
        passed: newest ? 1 : 2,
        failed: newest ? 3 : 0
      }),
      cases: []
    });
  }

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.ok, true);
  assert.equal(view.store.degraded, true);
  assert.deepEqual(view.window, { runs: 20 });
  assert.equal(view.truncated, false);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.projects.length, 1);

  const row = view.projects[0];
  assert.equal(row.name, "compare-app");
  assert.equal(row.error, null);
  // 40 条中 25 条 adhoc → 窗口只剩 15 条 lineage（如实短窗）
  assert.equal(row.latestBatch.at, "2026-10-14T00:39:05.000Z");
  assert.equal(row.latestBatch.gate, "fail");
  assert.equal(row.latestBatch.passRate, 0.25);
  assert.equal(row.trend.length, 10, "趋势 ≤10");
  assert.equal(row.trend[0].at, "2026-10-14T00:30:05.000Z", "时间升序（旧→新）");
  assert.equal(row.trend[9].at, "2026-10-14T00:39:05.000Z");
  assert.equal(row.trend[0].passRate, 1);
  assert.equal(row.trend[9].passRate, 0.25);
  assert.equal(row.flaky, 15);
  assert.deepEqual(row.domains, [
    { domain: "b", count: 20 },
    { domain: "a", count: 15 },
    { domain: "c", count: 15 }
  ]);
  assert.equal(row.pendingVerdicts, 0);
  assert.equal(row.unissuedAppDefects, 0);
});

test("panel compare: pendingVerdicts 与 unissuedAppDefects（最新裁决去重且 jiraKey null）", async () => {
  const { store, repo, dir } = await makeHarness();
  const set = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [{ key: "f-1", name: "登录流程", caseCount: 2, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }]
  });

  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T09:00:00.000Z",
    run: mkRun({ caseSetId: set.id, featureKey: "f-1", featureName: "登录流程" }),
    cases: [
      mkCase({
        caseId: "case-x",
        name: "Case X",
        featureKey: "f-1",
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T09:30:00.000Z"
      })
    ]
  });
  const newer = await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: set.id, featureKey: "f-1", featureName: "登录流程" }),
    cases: [
      mkCase({ caseId: "case-x", name: "Case X", featureKey: "f-1", verdict: null }),
      mkCase({
        caseId: "case-y",
        name: "Case Y",
        featureKey: "f-1",
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T10:30:00.000Z"
      })
    ]
  });
  await store.setCaseIssueKey({ rootPath: dir, runId: newer.id, caseId: "case-y", jiraKey: "REGR-1" });

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  const row = view.projects[0];
  assert.equal(row.pendingVerdicts, 1, "case-x 最新一次未裁决 → 计入；已裁决不计");
  assert.equal(row.unissuedAppDefects, 1, "case-x（旧 app-defect 且 jiraKey null）计入；case-y 已建单不计");
});

test("panel compare: 任务计数按状态 / runner 在线 TTL 与设备数 / schedules enabled/lastFiredAt", async () => {
  const { store, repo, dir } = await makeHarness();

  const taskStatuses = ["pending", "pending", "claimed", "running", "failed", "completed", "partial"];
  for (const status of taskStatuses) {
    const task = await store.createRegressionTask({
      rootPath: dir,
      refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
      platforms: ["android"],
      baseline: "latest",
      createdBy: "cli"
    });
    await store.updateRegressionTask(dir, task.id, { status });
  }

  const runner1 = await store.upsertRunner({
    rootPath: dir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [
      { serial: "a1", name: "", platform: "android", kind: "emulator", state: "device" },
      { serial: "a2", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  });
  await store.upsertRunner({
    rootPath: dir,
    name: "r-2",
    hostname: "mac-2",
    platforms: ["ios"],
    devices: [{ serial: "i1", name: "", platform: "ios", kind: "simulator", state: "booted" }],
    tools: { adb: false, idb: true, simctl: true, ideviceId: false, appium: false }
  });

  const scheduleA = await store.createSchedule({
    rootPath: dir,
    name: "夜间回归",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 720,
    createdBy: "cli"
  });
  const scheduleB = await store.createSchedule({
    rootPath: dir,
    name: "午间回归",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 60,
    createdBy: "cli"
  });
  await store.claimScheduleWindow({
    rootPath: dir,
    scheduleId: scheduleA.id,
    firedAt: "2026-10-14T02:00:00.000Z",
    cutoff: "2026-10-14T01:00:00.000Z"
  });
  await store.updateSchedule(dir, scheduleB.id, { enabled: false });

  const seenMs = Date.parse(runner1.lastSeenAt);
  const deps = (nowMs) => ({
    store,
    serviceRepo: repo,
    buildStale: false,
    env: {},
    now: () => nowMs
  });

  const online = await buildPanelCompare(deps(seenMs + 10_000));
  const row = online.projects[0];
  assert.deepEqual(row.taskBacklog, { pending: 2, claimed: 1, running: 1, failed: 1 });
  assert.equal(row.runners.online, 2);
  assert.equal(row.runners.devices, 3, "在线 runner 设备数之和");
  assert.equal(row.schedules.enabled, 1);
  assert.equal(row.schedules.lastFiredAt, "2026-10-14T02:00:00.000Z");

  const offline = await buildPanelCompare(deps(seenMs + 120_000));
  assert.equal(offline.projects[0].runners.online, 0, "TTL 过期 → 离线");
  assert.equal(offline.projects[0].runners.devices, 0);
});

test("panel compare: 排序（无批次→门禁 fail→通过率升 null 后置→名称）含磁盘不可达", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();

  // 磁盘不可达但有台账 → 无批次（rank 0）
  const gone = path.join(makeTempDir("aos-panel-gone-"), "gone");
  await store.upsertProject({ rootPath: gone, name: "no-batch" });

  const passHigh = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const passLow = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const fail = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: passHigh, name: "pass-high" });
  await store.upsertProject({ rootPath: passLow, name: "pass-low" });
  await store.upsertProject({ rootPath: fail, name: "fail" });

  const set = (p) =>
    store.recordCaseSet({
      rootPath: p,
      source: "pen:a.pen",
      basename: "tests",
      features: [{ key: "f-1", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }]
    });

  const sHigh = await set(passHigh);
  const sLow = await set(passLow);
  const sFail = await set(fail);

  await store.recordSuiteRun({
    rootPath: passHigh,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sHigh.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 10, passed: 9, failed: 1 }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: passLow,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sLow.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 10, passed: 5, failed: 5 }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: fail,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sFail.id, featureKey: "f-1", featureName: "登录流程", gateResult: "fail", total: 10, passed: 0, failed: 10 }),
    cases: []
  });

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.deepEqual(
    view.projects.map((row) => row.name),
    ["no-batch", "fail", "pass-low", "pass-high"],
    "无批次(rank0) → fail(rank1) → pass 按通过率升 → 名称"
  );
});

test("panel compare: D8 直测——磁盘不可达但有台账血统运行 → latestBatch 按台账且 rank 1", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();

  const noBatch = path.join(makeTempDir("aos-panel-d8-"), "no-batch");
  await store.upsertProject({ rootPath: noBatch, name: "no-batch" });

  const ledgerOnly = path.join(makeTempDir("aos-panel-d8-"), "ledger-only");
  await store.upsertProject({ rootPath: ledgerOnly, name: "ledger-only" });
  const ledgerSet = await store.recordCaseSet({
    rootPath: ledgerOnly,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      { key: "f-1", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
    ]
  });
  await store.recordSuiteRun({
    rootPath: ledgerOnly,
    createdAt: "2026-10-14T09:00:00.000Z",
    run: mkRun({
      caseSetId: ledgerSet.id,
      featureKey: "f-1",
      featureName: "登录流程",
      gateResult: "fail",
      total: 10,
      passed: 4,
      failed: 6
    }),
    cases: []
  });

  const passHigh = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const passLow = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: passHigh, name: "pass-high" });
  await store.upsertProject({ rootPath: passLow, name: "pass-low" });

  const set = (p) =>
    store.recordCaseSet({
      rootPath: p,
      source: "pen:a.pen",
      basename: "tests",
      features: [
        { key: "f-1", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
      ]
    });
  const sHigh = await set(passHigh);
  const sLow = await set(passLow);
  await store.recordSuiteRun({
    rootPath: passHigh,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sHigh.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 10, passed: 9, failed: 1 }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: passLow,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sLow.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 10, passed: 5, failed: 5 }),
    cases: []
  });

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });

  const row = view.projects.find((entry) => entry.name === "ledger-only");
  assert.ok(row, "磁盘不可达但有台账 → 行存在");
  assert.equal(row.error, null);
  assert.notEqual(row.latestBatch, null, "台账运行 → 最近批次非空（非无批次 rank 0）");
  assert.equal(row.latestBatch.gate, "fail");
  assert.equal(row.latestBatch.passRate, 0.4);
  assert.equal(row.latestBatch.at, "2026-10-14T09:05:00.000Z");
  assert.equal(row.trend.length, 1);

  assert.deepEqual(
    view.projects.map((entry) => entry.name),
    ["no-batch", "ledger-only", "pass-low", "pass-high"],
    "无批次(rank0) → 台账 fail(rank1) → pass 按通过率升"
  );
  assert.equal(
    view.projects.findIndex((entry) => entry.name === "ledger-only"),
    1,
    "位于 rank 1（fail 组），非无批次 rank 0"
  );
});

test("panel compare: 行级降级（store 抛错 → 该行 error，其余行正常）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const good = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const bad = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: good, name: "good" });
  await store.upsertProject({ rootPath: bad, name: "bad" });

  const throwingStore = new Proxy(store, {
    get(target, prop) {
      if (prop === "listSuiteRuns") {
        return async (rootPath, query) => {
          if (rootPath === bad) throw new Error("store boom");
          return target.listSuiteRuns(rootPath, query);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const view = await buildPanelCompare({ store: throwingStore, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.projects.length, 2);
  const goodRow = view.projects.find((row) => row.name === "good");
  const badRow = view.projects.find((row) => row.name === "bad");
  assert.equal(goodRow.error, null);
  assert.equal(goodRow.latestBatch, null);
  assert.equal(badRow.error, "store boom");
  assert.equal(badRow.latestBatch, null);
  assert.deepEqual(badRow.trend, []);
  assert.deepEqual(badRow.taskBacklog, { pending: 0, claimed: 0, running: 0, failed: 0 });
});

test("panel compare: selectCompareRows 纯 helper（合成 60 行 → 关注序前 50 + truncated）", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({ name: `n${i}`, latestBatch: null });
  }
  for (let i = 0; i < 10; i += 1) {
    rows.push({ name: `f${i}`, latestBatch: { gate: "fail", passRate: (i + 1) / 10 } });
  }
  for (let i = 0; i < 40; i += 1) {
    rows.push({ name: `p${String(i).padStart(2, "0")}`, latestBatch: { gate: "pass", passRate: i / 100 } });
  }

  const { rows: selected, truncated } = selectCompareRows(rows, 50);
  assert.equal(truncated, true);
  assert.equal(selected.length, 50);
  assert.deepEqual(selected.slice(0, 10).map((r) => r.name), rows.slice(0, 10).map((r) => r.name), "rank0 无批次在前");
  assert.ok(selected.slice(10, 20).every((r) => r.latestBatch.gate === "fail"), "rank1 fail 次之");
  assert.ok(selected.slice(20, 50).every((r) => r.latestBatch.gate === "pass"), "rank2 pass 最后");
  const failRates = selected.slice(10, 20).map((r) => r.latestBatch.passRate);
  assert.deepEqual(failRates, [...failRates].sort((a, b) => a - b), "fail 组内通过率升序");
  const passRates = selected.slice(20, 50).map((r) => r.latestBatch.passRate);
  assert.deepEqual(passRates, [...passRates].sort((a, b) => a - b), "pass 组内通过率升序");
});

test("panel compare: selectCompareRows 空集 → 空数组且不截断", () => {
  const { rows, truncated } = selectCompareRows([], 50);
  assert.deepEqual(rows, []);
  assert.equal(truncated, false);
});

test("panel compare: 空项目集 → 空 projects", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.ok, true);
  assert.deepEqual(view.projects, []);
  assert.equal(view.truncated, false);
});

test("panel compare: 路由/JSON（view=compare 无 project → compare；带 project 回退项目页）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const dir = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dir, name: "compare-app" });
  const deps = { store, env: {}, serviceRepo: repo, buildStale: false };

  const json = await handlePanelRequest(new URL("http://x/panel.json?view=compare"), deps);
  assert.equal(json.status, 200);
  const payload = JSON.parse(json.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.view, "compare");
  assert.deepEqual(payload.window, { runs: 20 });
  assert.ok(Array.isArray(payload.projects));
  assert.equal(payload.projects[0].name, "compare-app");

  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.match(html.contentType, /text\/html/);
  assert.match(html.body, /对比/);
  assert.match(html.body, /<table/);

  const projectUrl = new URL(`http://x/panel.json?project=${encodeURIComponent(dir)}&view=compare`);
  const projectPayload = JSON.parse((await handlePanelRequest(projectUrl, deps)).body);
  assert.equal(projectPayload.view, "project", "带 project 参数 + view=compare → 回退项目页");
});

test("panel compare: 功能对齐（两项目同源同名→groups=1/entries=2/指标正确）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const dirA = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const dirB = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: dirA, name: "align-a" });
  await store.upsertProject({ rootPath: dirB, name: "align-b" });

  const setA = await store.recordCaseSet({
    rootPath: dirA,
    source: `${dirA}/.artemis/design/flows.json`,
    basename: "tests",
    features: [
      { key: "f-a", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
    ]
  });
  const setB = await store.recordCaseSet({
    rootPath: dirB,
    source: `${dirB}/.artemis/design/flows.json`,
    basename: "tests",
    features: [
      { key: "f-b", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
    ]
  });

  await store.recordSuiteRun({
    rootPath: dirA,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({
      caseSetId: setA.id,
      featureKey: "f-a",
      featureName: "登录流程",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 8,
      passed: 4,
      failed: 4,
      flaky: 1
    }),
    cases: [
      mkCase({ caseId: "c1", featureKey: "f-a", status: "failed", verdict: null }),
      mkCase({ caseId: "c2", featureKey: "f-a", status: "error", verdict: null })
    ]
  });
  await store.recordSuiteRun({
    rootPath: dirB,
    createdAt: "2026-10-14T11:00:00.000Z",
    run: mkRun({
      caseSetId: setB.id,
      featureKey: "f-b",
      featureName: "登录流程",
      finishedAt: "2026-10-14T11:05:00.000Z",
      total: 4,
      passed: 2,
      failed: 2,
      flaky: 0
    }),
    cases: []
  });

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.featureAlignment.unmatched, 0);
  assert.equal(view.featureAlignment.groups.length, 1);
  const group = view.featureAlignment.groups[0];
  assert.equal(group.displayName, "登录流程");
  assert.equal(group.sourceLabel, `${dirA}/.artemis/design/flows.json`);
  assert.equal(group.entries.length, 2);
  const entryA = group.entries.find((entry) => entry.project === "align-a");
  const entryB = group.entries.find((entry) => entry.project === "align-b");
  assert.equal(entryA.passRate, 0.5);
  assert.equal(entryA.runs, 1);
  assert.equal(entryA.flaky, 1);
  assert.equal(entryA.pendingVerdicts, 2);
  assert.equal(entryA.latestAt, "2026-10-14T10:05:00.000Z");
  assert.equal(entryB.passRate, 0.5);
  assert.equal(entryB.runs, 1);
  assert.equal(entryB.flaky, 0);
  assert.equal(entryB.pendingVerdicts, 0);
  assert.equal(entryB.latestAt, "2026-10-14T11:05:00.000Z");
});

test("panel compare: 功能对齐（单项目→unmatched=1 且无组）", async () => {
  const { store, repo, dir } = await makeHarness();
  const set = await store.recordCaseSet({
    rootPath: dir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      { key: "f-1", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
    ]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: set.id, featureKey: "f-1", featureName: "登录流程" }),
    cases: []
  });

  const view = await buildPanelCompare({ store, serviceRepo: repo, buildStale: false, env: {} });
  assert.deepEqual(view.featureAlignment.groups, []);
  assert.equal(view.featureAlignment.unmatched, 1);
});

test("panel compare: 功能对齐（listCaseSets 抛错→该项目不进组且项目级行照常）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const good = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  const bad = makeTempProject({ config: baseConfig(), dotenv: COMPLETE_DOTENV });
  await store.upsertProject({ rootPath: good, name: "good" });
  await store.upsertProject({ rootPath: bad, name: "bad" });

  const set = (p) =>
    store.recordCaseSet({
      rootPath: p,
      source: "figma:SHARED",
      basename: "tests",
      features: [
        { key: "f-1", name: "登录流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
      ]
    });
  const sGood = await set(good);
  const sBad = await set(bad);

  await store.recordSuiteRun({
    rootPath: good,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sGood.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 4, passed: 4, failed: 0 }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: bad,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: mkRun({ caseSetId: sBad.id, featureKey: "f-1", featureName: "登录流程", gateResult: "pass", total: 4, passed: 4, failed: 0 }),
    cases: []
  });

  const throwingStore = new Proxy(store, {
    get(target, prop) {
      if (prop === "listCaseSets") {
        return async (rootPath) => {
          if (rootPath === bad) throw new Error("sets boom");
          return target.listCaseSets(rootPath);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const view = await buildPanelCompare({ store: throwingStore, serviceRepo: repo, buildStale: false, env: {} });
  assert.equal(view.projects.length, 2);
  const badRow = view.projects.find((row) => row.name === "bad");
  assert.equal(badRow.error, null, "listCaseSets 失败不置行级 error");
  assert.notEqual(badRow.latestBatch, null, "项目级批次照常聚合");
  assert.equal(view.featureAlignment.groups.length, 0, "bad 不进组 → 仅 good 单项目无组");
  assert.equal(view.featureAlignment.unmatched, 1);
});

test("panel compare: JSON 含 featureAlignment（加性字段不破坏既有字段）", async () => {
  const { store, repo, dir } = await makeHarness();
  const json = await handlePanelRequest(new URL("http://x/panel.json?view=compare"), {
    store,
    env: {},
    serviceRepo: repo,
    buildStale: false
  });
  const payload = JSON.parse(json.body);
  assert.equal(payload.view, "compare");
  assert.deepEqual(payload.window, { runs: 20 }, "既有 window 字段不变");
  assert.ok(Array.isArray(payload.projects), "既有 projects 字段不变");
  assert.ok(payload.featureAlignment, "featureAlignment 存在");
  assert.deepEqual(Object.keys(payload.featureAlignment).sort(), ["groups", "unmatched"]);
  assert.ok(Array.isArray(payload.featureAlignment.groups));
  assert.equal(typeof payload.featureAlignment.unmatched, "number");
});
