import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileStore, resolveLedgerHome } from "../dist/db/file.js";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-ledger-"));
}

async function fixtureProject(home, name = "proj") {
  const root = join(home, name);
  await mkdir(root, { recursive: true });
  return root;
}

function sampleRun() {
  return {
    trigger: "manual",
    regressionTaskId: null,
    caseSetId: null,
    featureKey: null,
    featureName: null,
    platform: "android",
    device: null,
    appVersion: null,
    runner: null,
    status: "passed",
    startedAt: "2026-10-18T00:00:00.000Z",
    finishedAt: "2026-10-18T00:01:00.000Z",
    total: 1,
    passed: 1,
    failed: 0,
    flaky: 0,
    quarantined: 0,
    failureDomains: {},
    gateResult: "pass",
    exitCode: 0,
    manifestPath: null,
    comparison: null
  };
}

function sampleCase(caseId) {
  return {
    caseId,
    name: `用例 ${caseId}`,
    featureKey: "f",
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
    verdictNote: null,
    jiraIssueKey: null
  };
}

test("FileStore: restart round-trip across collections", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);

  let store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: root, name: "demo" });
  await store.upsertLlm(root, {
    name: "llm",
    model: "m1",
    baseUrl: "https://x/v1",
    apiKey: "sec",
    makeActive: true
  });
  await store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });
  await store.recordCaseSet({
    rootPath: root,
    source: "figma",
    basename: "cs1",
    features: [
      { key: "f", name: "功能", caseCount: 2, screens: [], jsonPath: "a.json", mdPath: "a.md", xlsxPath: "a.xlsx" }
    ]
  });
  const run = await store.recordSuiteRun({ rootPath: root, run: sampleRun(), cases: [sampleCase("c1")] });
  await store.updateCaseVerdict({ rootPath: root, runId: run.id, caseId: "c1", verdict: "app-defect" });
  await store.upsertRunner({
    rootPath: root,
    name: "runner-1",
    hostname: "h1",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  });
  await store.createSchedule({
    rootPath: root,
    name: "夜间",
    featureKeys: ["f"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 60
  });
  await store.close();

  store = await FileStore.create({ homeDir: home });
  assert.equal((await store.getProjectByPath(root))?.name, "demo");
  assert.equal((await store.listLlms(root)).length, 1);
  assert.equal((await store.listLlms(root))[0].isActive, true);
  assert.equal((await store.listTasks(root)).length, 1);
  assert.equal((await store.listCaseSets(root)).length, 1);
  const runs = await store.listSuiteRuns(root, {});
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cases[0].verdict, "app-defect");
  assert.equal((await store.listRunners(root)).length, 1);
  assert.equal((await store.listSchedules(root)).length, 1);
  assert.notEqual(await store.getEarliestRegistrationCreatedAt(root), null);
});

test("FileStore: cross-writer survival (merge-on-write)", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);

  const a = await FileStore.create({ homeDir: home });
  await a.upsertProject({ rootPath: root, name: "p" });
  await a.recordTask({ rootPath: root, traceId: "x", status: "submitted" });

  const b = await FileStore.create({ homeDir: home });
  await b.recordTask({ rootPath: root, traceId: "y", status: "submitted" });

  await a.recordTask({ rootPath: root, traceId: "z", status: "submitted" });

  const c = await FileStore.create({ homeDir: home });
  const tasks = await c.listTasks(root, 10);
  assert.deepEqual(tasks.map((task) => task.traceId).sort(), ["x", "y", "z"]);
});

test("FileStore: corruption tolerance, tmp cleanup, always-parseable state", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);
  const ledgerDir = join(root, ".artemis", "ledger");
  await mkdir(ledgerDir, { recursive: true });
  await writeFile(join(ledgerDir, "state.json"), "{ not json", "utf8");
  await writeFile(join(ledgerDir, "state.json.tmp-stale"), "partial", "utf8");

  const store = await FileStore.create({ homeDir: home });
  assert.deepEqual(await store.listTasks(root), []);

  await store.upsertProject({ rootPath: root, name: "p" });
  await store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });

  const names = await readdir(ledgerDir);
  assert.equal(names.some((name) => name.includes(".tmp-")), false);
  const raw = await readFile(join(ledgerDir, "state.json"), "utf8");
  assert.ok(JSON.parse(raw).state);

  const reloaded = await FileStore.create({ homeDir: home });
  assert.equal((await reloaded.listTasks(root)).length, 1);
});

test("FileStore: multi-project isolation + registry survives restart", async () => {
  const home = await tempHome();
  const rootA = await fixtureProject(home, "a");
  const rootB = await fixtureProject(home, "b");

  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: rootA, name: "alpha" });
  await store.upsertProject({ rootPath: rootB, name: "beta" });
  await store.recordTask({ rootPath: rootA, traceId: "only-a", status: "submitted" });

  const reloaded = await FileStore.create({ homeDir: home });
  const projects = await reloaded.listProjects();
  assert.deepEqual(projects.map((project) => project.name).sort(), ["alpha", "beta"]);
  assert.deepEqual((await reloaded.listTasks(rootB)).map((task) => task.traceId), []);
  assert.equal((await reloaded.listTasks(rootA)).length, 1);
});

test("FileStore: usage + audit retention and audit survives restart", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);
  const env = { ...process.env, AOS_AUDIT_MAX_EVENTS: "3" };

  const store = await FileStore.create({ homeDir: home, env });
  await store.upsertProject({ rootPath: root, name: "p" });
  for (let i = 0; i < 8; i += 1) {
    await store.recordUsageEvent(
      root,
      { tool: "aos_status", family: "native", ok: true, durationMs: i },
      { maxEvents: 5 }
    );
  }
  for (let i = 0; i < 5; i += 1) {
    await store.recordAudit(root, {
      domain: "panel",
      action: `action.${i}`,
      result: "ok",
      summary: `s${i}`,
      at: `2026-10-18T0${i}:00:00.000Z`
    });
  }

  const reloaded = await FileStore.create({ homeDir: home, env });
  assert.equal((await reloaded.listUsageEvents(root)).length, 5);
  const audit = await reloaded.listAudit(root);
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((event) => event.action), ["action.4", "action.3", "action.2"]);
});

test("FileStore: journal records write ops only", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);

  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: root, name: "p" });
  await store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });
  await store.listTasks(root);

  const lines = (await readFile(join(root, ".artemis", "ledger", "journal.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((entry) => entry.op), ["upsertProject", "recordTask"]);
});

test("FileStore: credentials stripped from state.json", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);

  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: root, name: "p" });
  await store.upsertLlm(root, {
    name: "llm",
    model: "m",
    baseUrl: "https://x/v1",
    apiKey: "super-secret-key",
    makeActive: true
  });
  await store.setFigmaToken(root, "figma-secret-token");

  const raw = await readFile(join(root, ".artemis", "ledger", "state.json"), "utf8");
  assert.equal(raw.includes("super-secret-key"), false);
  assert.equal(raw.includes("figma-secret-token"), false);

  const reloaded = await FileStore.create({ homeDir: home });
  assert.equal((await reloaded.listLlms(root))[0].apiKey, null);
  assert.equal((await reloaded.getProjectByPath(root))?.figmaToken, null);
});

test("FileStore: unwritable home fails create", { skip: process.platform === "win32" }, async () => {
  const home = await tempHome();
  await chmod(home, 0o555);
  try {
    await assert.rejects(() => FileStore.create({ homeDir: home }));
  } finally {
    await chmod(home, 0o755);
    await rm(home, { recursive: true, force: true });
  }
});

test("FileStore: 同记录更新不被陈旧写者回滚（磁盘胜合并）", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);

  const a = await FileStore.create({ homeDir: home });
  await a.upsertProject({ rootPath: root, name: "p" });
  await a.recordTask({ rootPath: root, traceId: "x", status: "submitted" });

  const b = await FileStore.create({ homeDir: home });
  await b.listTasks(root, 10);

  await a.markTaskFinished(root, "x", "completed");
  await b.recordTask({ rootPath: root, traceId: "y", status: "submitted" });

  const c = await FileStore.create({ homeDir: home });
  const tasks = await c.listTasks(root, 10);
  const x = tasks.find((task) => task.traceId === "x");
  assert.equal(x.status, "completed", "陈旧写者不得回滚已落盘的更新");
  assert.ok(tasks.some((task) => task.traceId === "y"));
});

test("FileStore: usage 裁剪重写不丢并发写者事件，且原子（无 tmp 残留）", async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);
  const policy = { maxEvents: 3 };

  const a = await FileStore.create({ homeDir: home });
  await a.upsertProject({ rootPath: root, name: "p" });
  for (const id of ["e1", "e2", "e3"]) {
    await a.recordUsageEvent(
      root,
      { tool: `t-${id}`, family: "native", ok: true, durationMs: 1, at: `2026-10-18T00:00:0${id.slice(1)}.000Z` },
      policy
    );
  }

  const b = await FileStore.create({ homeDir: home });
  await b.listUsageEvents(root, { limit: 10 });

  await a.recordUsageEvent(
    root,
    { tool: "t-e4", family: "native", ok: true, durationMs: 1, at: "2026-10-18T00:00:04.000Z" },
    policy
  );
  await b.recordUsageEvent(
    root,
    { tool: "t-e5", family: "native", ok: true, durationMs: 1, at: "2026-10-18T00:00:05.000Z" },
    policy
  );

  const c = await FileStore.create({ homeDir: home });
  const events = await c.listUsageEvents(root, { limit: 10 });
  assert.deepEqual(events.map((event) => event.tool), ["t-e5", "t-e4", "t-e3"]);

  const names = await readdir(join(root, ".artemis", "ledger"));
  assert.equal(names.some((name) => name.includes(".tmp-")), false, "原子重写无 tmp 残留");
});

test("FileStore: 写失败计数经 writeErrors 暴露（如实信号）", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = await tempHome();
  const root = await fixtureProject(home);
  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: root, name: "p" });

  const ledgerDir = join(root, ".artemis", "ledger");
  await chmod(ledgerDir, 0o555);
  try {
    await store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });
    const health = store.writeErrors();
    assert.ok(health.count >= 1, "写失败被计数");
    assert.ok(typeof health.lastError === "string" && health.lastError.length > 0);
  } finally {
    await chmod(ledgerDir, 0o755);
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveLedgerHome: explicit env, project root, home fallback (never cwd)", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "aos-home-"));
  const custom = join(scratch, "custom-ledger");
  assert.equal(resolveLedgerHome({ AOS_LEDGER_DIR: custom }, scratch), custom);
  assert.equal(resolveLedgerHome({}, scratch), join(homedir(), ".aos", "ledger"));

  await writeFile(join(scratch, "aos.config.jsonc"), "{}", "utf8");
  await mkdir(join(scratch, "sub"), { recursive: true });
  assert.equal(resolveLedgerHome({}, join(scratch, "sub")), join(scratch, ".artemis", "ledger"));

  await rm(scratch, { recursive: true, force: true });
});
