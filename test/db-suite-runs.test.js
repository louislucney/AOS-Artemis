import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

const CASES = [
  {
    caseId: "case-aaaa00000001",
    name: "Case 1",
    featureKey: "f-登录-41b473ed",
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
  },
  {
    caseId: "case-aaaa00000002",
    name: "Case 2",
    featureKey: "f-登录-41b473ed",
    platform: "android",
    status: "passed",
    traceId: "trace-2",
    failureDomain: null,
    failureConfidence: null,
    failureReason: null,
    durationMs: null,
    quarantined: false,
    flaky: true,
    verdict: null,
    verdictBy: null,
    verdictAt: null,
    verdictNote: null
  }
];

function runInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    createdAt: "2026-10-14T16:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: "task-1",
      caseSetId: "cs-1",
      featureKey: "f-登录-41b473ed",
      featureName: "登录流程",
      platform: "android",
      device: "emulator-5554",
      appVersion: null,
      status: "completed",
      startedAt: "2026-10-14T16:00:00.000Z",
      finishedAt: "2026-10-14T16:05:00.000Z",
      total: 2,
      passed: 1,
      failed: 1,
      flaky: 1,
      quarantined: 0,
      failureDomains: { 用例缺陷: 1 },
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: { baseline: "compared", fixed: 0, regressed: 1 }
    },
    cases: CASES,
    ...overrides
  };
}

test("regression_tasks: create/get/list/update 往返（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const task = await store.createRegressionTask({
      rootPath: "/w/p1",
      refs: [{ caseSetId: "cs-1", featureKey: "f-登录-41b473ed" }],
      platforms: ["ios", "android"],
      baseline: "latest",
      createdBy: "cli"
    });
    assert.ok(task.id);
    assert.equal(task.status, "pending");
    assert.deepEqual(task.refs, [{ caseSetId: "cs-1", featureKey: "f-登录-41b473ed" }]);
    assert.deepEqual(task.platforms, ["ios", "android"]);
    assert.deepEqual(task.runIds, []);

    const fetched = await store.getRegressionTask("/w/p1", task.id);
    assert.equal(fetched.baseline, "latest");
    assert.equal(fetched.createdBy, "cli");

    assert.equal(await store.updateRegressionTask("/w/p1", task.id, { status: "running" }), true);
    assert.equal(
      await store.updateRegressionTask("/w/p1", task.id, {
        status: "completed",
        runIds: ["run-1", "run-2"]
      }),
      true
    );
    const updated = await store.getRegressionTask("/w/p1", task.id);
    assert.equal(updated.status, "completed");
    assert.deepEqual(updated.runIds, ["run-1", "run-2"]);

    const listed = await store.listRegressionTasks("/w/p1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, task.id);
    assert.equal(await store.getRegressionTask("/w/p1", "missing"), null);
  }
});

test("recordSuiteRun: 往返完整（cases 嵌套、failureDomains、comparison JSON）（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const record = await store.recordSuiteRun(runInput());
    assert.ok(record.id);
    assert.equal(record.trigger, "cli");
    assert.equal(record.regressionTaskId, "task-1");
    assert.equal(record.featureName, "登录流程");
    assert.deepEqual(record.failureDomains, { 用例缺陷: 1 });
    assert.deepEqual(record.comparison, { baseline: "compared", fixed: 0, regressed: 1 });
    assert.equal(record.cases.length, 2);
    const failed = record.cases.find((entry) => entry.caseId === "case-aaaa00000001");
    assert.equal(failed.name, "Case 1");
    assert.equal(failed.failureDomain, "用例缺陷");
    assert.equal(failed.failureConfidence, "medium");
    assert.equal(failed.traceId, "trace-1");
    const flaky = record.cases.find((entry) => entry.caseId === "case-aaaa00000002");
    assert.equal(flaky.flaky, true);
    assert.equal(flaky.quarantined, false);

    const listed = await store.listSuiteRuns("/w/p1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].cases.length, 2);
    assert.equal(listed[0].featureName, "登录流程");
    assert.equal(listed[0].exitCode, 1);
    assert.equal(
      listed[0].cases.find((entry) => entry.caseId === "case-aaaa00000001").name,
      "Case 1"
    );
  }
});

test("listSuiteRuns: 过滤（taskId/caseSetId/featureKey/platform）与新→旧、limit（pg-mem）", async () => {
  const store = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
  const base = runInput({ rootPath: "/w/p2" });
  await store.recordSuiteRun({
    ...base,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: { ...base.run, regressionTaskId: "task-a" }
  });
  await store.recordSuiteRun({
    ...base,
    createdAt: "2026-10-14T12:00:00.000Z",
    run: { ...base.run, regressionTaskId: "task-a", platform: "ios" }
  });
  await store.recordSuiteRun({
    ...base,
    createdAt: "2026-10-14T14:00:00.000Z",
    run: { ...base.run, regressionTaskId: "task-b" }
  });

  const all = await store.listSuiteRuns("/w/p2");
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((entry) => entry.regressionTaskId),
    ["task-b", "task-a", "task-a"]
  );
  const byTask = await store.listSuiteRuns("/w/p2", { taskId: "task-a" });
  assert.equal(byTask.length, 2);
  const byPlatform = await store.listSuiteRuns("/w/p2", { taskId: "task-a", platform: "ios" });
  assert.equal(byPlatform.length, 1);
  const byFeature = await store.listSuiteRuns("/w/p2", {
    caseSetId: "cs-1",
    featureKey: "f-登录-41b473ed"
  });
  assert.equal(byFeature.length, 3);
  const limited = await store.listSuiteRuns("/w/p2", { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal((await store.listSuiteRuns("/w/unknown")).length, 0);
});

test("recordSuiteRun: 事务协议——失败时 BEGIN→ROLLBACK→release，不 COMMIT", async () => {
  const calls = [];
  let caseInserts = 0;
  const client = {
    async query(text) {
      calls.push(text);
      if (text.startsWith("INSERT INTO suite_run_cases")) {
        caseInserts += 1;
        if (caseInserts > 1) throw new Error("boom");
      }
      return { rows: [] };
    },
    release() {
      calls.push("release");
    }
  };
  const pool = {
    async query(text) {
      calls.push(`pool:${text}`);
      return { rows: [] };
    },
    async connect() {
      return client;
    }
  };
  const store = new PostgresStore(pool);

  await assert.rejects(store.recordSuiteRun(runInput()), /boom/);
  assert.ok(calls.includes("BEGIN"), "BEGIN issued");
  assert.ok(calls.includes("ROLLBACK"), "ROLLBACK issued");
  assert.ok(!calls.includes("COMMIT"), "no COMMIT on failure");
  assert.equal(calls.at(-1), "release");
});

test("updateCaseVerdict: 往返 + 重复覆盖更新 verdictAt（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const record = await store.recordSuiteRun(runInput());
    const updated = await store.updateCaseVerdict({
      rootPath: "/w/p1",
      runId: record.id,
      caseId: "case-aaaa00000001",
      verdict: "case-defect",
      verdictBy: "alice",
      verdictNote: "期望值写错"
    });
    assert.equal(updated, true);
    const runs = await store.listSuiteRuns("/w/p1");
    const entry = runs[0].cases.find((item) => item.caseId === "case-aaaa00000001");
    assert.equal(entry.verdict, "case-defect");
    assert.equal(entry.verdictBy, "alice");
    assert.equal(entry.verdictNote, "期望值写错");
    assert.ok(entry.verdictAt);

    const firstAt = entry.verdictAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await store.updateCaseVerdict({
      rootPath: "/w/p1",
      runId: record.id,
      caseId: "case-aaaa00000001",
      verdict: "execution-deviation"
    });
    assert.equal(again, true);
    const reread = (await store.listSuiteRuns("/w/p1"))[0].cases.find(
      (item) => item.caseId === "case-aaaa00000001"
    );
    assert.equal(reread.verdict, "execution-deviation");
    assert.equal(reread.verdictBy, null);
    assert.notEqual(reread.verdictAt, firstAt, "重复裁决更新 verdictAt");
  }
});

test("updateCaseVerdict: 未知 run/case/项目 → false（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const record = await store.recordSuiteRun(runInput());
    assert.equal(
      await store.updateCaseVerdict({
        rootPath: "/w/p1",
        runId: "run-nope",
        caseId: "case-aaaa00000001",
        verdict: "uncertain"
      }),
      false
    );
    assert.equal(
      await store.updateCaseVerdict({
        rootPath: "/w/p1",
        runId: record.id,
        caseId: "case-nope",
        verdict: "uncertain"
      }),
      false
    );
    assert.equal(
      await store.updateCaseVerdict({
        rootPath: "/w/unknown",
        runId: record.id,
        caseId: "case-aaaa00000001",
        verdict: "uncertain"
      }),
      false
    );
  }
});

test("suite_runs: runner 字段往返（显式值 / 缺省 null；memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const input = runInput();
    const withRunner = await store.recordSuiteRun({
      ...input,
      run: { ...input.run, runner: "runner-a" }
    });
    const withoutRunner = await store.recordSuiteRun(input);
    const runs = await store.listSuiteRuns("/w/p1");
    assert.equal(runs.find((entry) => entry.id === withRunner.id).runner, "runner-a");
    assert.equal(runs.find((entry) => entry.id === withoutRunner.id).runner, null);
  }
});

test("suite_runs: 存量库迁移——旧表缺 runner 列时 init 补列", async () => {
  // noAstCoverageCheck：旧表已存在时 pg-mem 会因未读取的 AST 约束直接报错，这里只关注迁移结果
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    `CREATE TABLE suite_runs (
       id TEXT PRIMARY KEY,
       project_id TEXT,
       created_at TEXT NOT NULL,
       trigger TEXT NOT NULL,
       regression_task_id TEXT,
       case_set_id TEXT,
       feature_key TEXT,
       feature_name TEXT,
       platform TEXT NOT NULL,
       device TEXT,
       app_version TEXT,
       status TEXT NOT NULL,
       started_at TEXT NOT NULL,
       finished_at TEXT NOT NULL,
       total INTEGER NOT NULL,
       passed INTEGER NOT NULL,
       failed INTEGER NOT NULL,
       flaky INTEGER NOT NULL,
       quarantined INTEGER NOT NULL,
       failure_domains TEXT NOT NULL DEFAULT '{}',
       gate_result TEXT,
       exit_code INTEGER NOT NULL,
       manifest_path TEXT,
       comparison TEXT
     )`
  );
  const store = new PostgresStore(pool);
  await store.init();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const input = runInput();
  const record = await store.recordSuiteRun({
    ...input,
    run: { ...input.run, runner: "legacy-fix" }
  });
  const runs = await store.listSuiteRuns("/w/p1");
  assert.equal(runs.find((entry) => entry.id === record.id).runner, "legacy-fix");
});

test("updateCaseVerdict: 跨项目 runId → false 且不误写（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
    const record = await store.recordSuiteRun(runInput());
    assert.equal(
      await store.updateCaseVerdict({
        rootPath: "/w/p2",
        runId: record.id,
        caseId: "case-aaaa00000001",
        verdict: "case-defect"
      }),
      false
    );
    const runs = await store.listSuiteRuns("/w/p1");
    const entry = runs[0].cases.find((item) => item.caseId === "case-aaaa00000001");
    assert.equal(entry.verdict, null, "跨项目裁决不生效");
  }
});
