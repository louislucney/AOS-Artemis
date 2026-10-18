import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { exportProjectData } from "../dist/export/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sampleRun(overrides = {}) {
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
    status: "failed",
    startedAt: "2026-10-18T00:00:00.000Z",
    finishedAt: "2026-10-18T00:01:00.000Z",
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

function sampleCase(overrides = {}) {
  return {
    caseId: "c1",
    name: "登录",
    featureKey: "f",
    platform: "android",
    status: "failed",
    traceId: null,
    failureDomain: "应用缺陷",
    failureConfidence: "high",
    failureReason: "crash",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict: null,
    verdictBy: null,
    verdictAt: null,
    verdictNote: null,
    jiraIssueKey: null,
    ...overrides
  };
}

async function seedStore(store, root) {
  await store.upsertProject({ rootPath: root, name: "p" });
  await store.recordSuiteRun({
    rootPath: root,
    run: sampleRun(),
    cases: [sampleCase({ verdict: "app-defect", verdictBy: "qa", verdictAt: "2026-10-18T01:00:00.000Z", jiraIssueKey: "AOS-1" })]
  });
  await store.recordAudit(root, {
    domain: "suite",
    action: "run.recorded",
    result: "ok",
    summary: "批次登记",
    at: "2026-10-18T01:00:00.000Z"
  });
  await store.recordCaseSet({
    rootPath: root,
    source: "figma:x",
    basename: "cs",
    features: [
      { key: "f", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  await store.recordTask({ rootPath: root, traceId: "t1", status: "submitted" });
}

test("exportProjectData: results 三件（runs/verdicts/issues）＋limit/since", async () => {
  const store = new MemoryStore();
  const root = "/w/p1";
  await seedStore(store, root);

  const result = await exportProjectData(root, store, { what: "results" });
  assert.equal(result.format, "json");
  assert.deepEqual(result.counts, { runs: 1, verdicts: 1, issues: 1 });
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.verdicts[0].verdict, "app-defect");
  assert.equal(parsed.issues[0].issueKey, "AOS-1");

  const sinceFuture = await exportProjectData(root, store, { what: "results", since: "2030-01-01T00:00:00Z" });
  assert.equal(sinceFuture.counts.runs, 0);

  const csv = await exportProjectData(root, store, { what: "results", format: "csv" });
  assert.match(csv.filename, /\.csv$/);
  assert.match(csv.content.split("\n")[0], /runId/);
  assert.equal(csv.content.trim().split("\n").length, 2);
});

test("exportProjectData: process（含审计）与 data（用例集/任务/索引）", async () => {
  const store = new MemoryStore();
  const root = "/w/p1";
  await seedStore(store, root);

  const process = await exportProjectData(root, store, { what: "process" });
  assert.equal(process.counts.audit, 1);
  assert.equal(process.counts.tasks, 0);
  assert.deepEqual(process.counts.schedules, 0 ?? 0);
  assert.equal(process.counts.runners, 0);

  const data = await exportProjectData(root, store, { what: "data" });
  assert.equal(data.counts.caseSets, 1);
  assert.equal(data.counts.tasks, 1);
  assert.ok(typeof data.counts.artifacts === "number");

  const csv = await exportProjectData(root, store, { what: "process", format: "csv" });
  assert.match(csv.content.split("\n")[0], /action/);
});

test("exportProjectData: 文件台账项目 process 导出非空（审计落盘）", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-export-"));
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  try {
    const store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "p" });
    await store.recordAudit(root, {
      domain: "panel",
      action: "action.tasks",
      result: "ok",
      summary: "面板动作"
    });
    const process = await exportProjectData(root, store, { what: "process" });
    assert.equal(process.counts.audit, 1);
    await store.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("export CLI: --out 落文件 exit 0；非法 --what exit 2", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-export-cli-"));
  const root = join(home, "proj");
  await mkdir(root, { recursive: true });
  const out = join(home, "out.json");
  try {
    const env = {
      ...process.env,
      MOBILE_TESTING_DATABASE_URL: "",
      AOS_LEDGER_DIR: home,
      AOS_PROJECT_DIR: root
    };
    const ok = spawnSync(
      process.execPath,
      [join(repoRoot, "dist", "cli.js"), "export", "--project", root, "--what", "results", "--out", out],
      { env, encoding: "utf8" }
    );
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(await readFile(out, "utf8"));
    assert.equal(parsed.what, "results");

    const bad = spawnSync(
      process.execPath,
      [join(repoRoot, "dist", "cli.js"), "export", "--project", root, "--what", "nope"],
      { env, encoding: "utf8" }
    );
    assert.equal(bad.status, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
