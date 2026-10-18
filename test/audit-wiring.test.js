import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { fireDueSchedules } from "../dist/runner/schedules.js";
import { registerSuiteRun } from "../dist/tasks/run-registry.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

function caseResult(overrides = {}) {
  return {
    caseId: "case-1",
    name: "Case 1",
    status: "passed",
    traceId: "trace-1",
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

function suiteInput() {
  return {
    report: {
      ok: true,
      testsPath: "/p/tests.json",
      total: 1,
      executed: 1,
      skipped: 0,
      passed: 1,
      failed: 0,
      preflight: null,
      apiErrorCatalog: null,
      cases: [caseResult()]
    },
    trigger: "cli",
    platform: "android",
    device: null,
    caseSetId: "cs-1",
    featureKey: "f-1",
    exitCode: 0,
    startedAtMs: Date.parse("2026-10-14T10:00:00Z"),
    finishedAtMs: Date.parse("2026-10-14T10:05:00Z")
  };
}

async function setupProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { runtime, store };
}

test("audit wiring: suite 批次登记 → suite/run.recorded", async () => {
  const { runtime, store } = await setupProject();
  const id = await registerSuiteRun(runtime, suiteInput());
  assert.ok(id);
  const audit = await store.listAudit(runtime.project.rootDir, { domain: "suite" });
  assert.ok(
    audit.some((event) => event.action === "run.recorded" && event.refs.runId === id),
    "批次登记落审计"
  );
});

test("audit wiring: 定时触发 → schedule/fired（含 refs）", async () => {
  const { runtime, store } = await setupProject();
  const rootPath = runtime.project.rootDir;
  await store.recordCaseSet({
    rootPath,
    source: "pen:a.pen",
    basename: "t",
    features: [
      {
        key: "f-1",
        name: "登录",
        caseCount: 1,
        screens: [],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });
  const schedule = await store.createSchedule({
    rootPath,
    name: "夜间",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 60,
    createdBy: "cli"
  });
  const io = { log: () => {}, errorLog: () => {} };
  const fired = await fireDueSchedules({ store, rootPath, now: () => NOW, io });
  assert.equal(fired, 1);
  const audit = await store.listAudit(rootPath, { domain: "schedule" });
  assert.ok(
    audit.some((event) => event.action === "fired" && event.refs.scheduleId === schedule.id),
    "定时触发落审计"
  );
});

test("audit wiring: best-effort —— 审计写入失败不影响主流程", async () => {
  const { runtime, store } = await setupProject();
  const failingStore = new Proxy(store, {
    get(target, prop) {
      if (prop === "recordAudit") {
        return async () => {
          throw new Error("audit down");
        };
      }
      return Reflect.get(target, prop, target);
    }
  });
  const id = await registerSuiteRun(
    { store: failingStore, project: runtime.project },
    suiteInput()
  );
  assert.ok(id);
  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(runs.length, 1);
});
