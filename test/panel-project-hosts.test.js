import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { handleArtifactRequest } from "../dist/panel/artifact-route.js";
import { handlePanelRequest, resolveProjectKey } from "../dist/panel/web.js";

const ROOT_PATH = "/Users/louis/app";

function makeDeps() {
  const store = new MemoryStore();
  return {
    store,
    deps: {
      store,
      env: {},
      workspaceRoot: null,
      storeForHost: (hostId) => store.scopeHost(hostId)
    }
  };
}

async function seedSuiteRun(store, rootPath, caseName) {
  await store.upsertProject({ rootPath, name: "app" });
  return store.recordSuiteRun({
    rootPath,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: null,
      featureName: null,
      platform: "android",
      device: null,
      appVersion: null,
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
      manifestPath: null,
      comparison: null
    },
    cases: [
      {
        caseId: `case-${caseName}`,
        name: caseName,
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: null,
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
}

test("面板按 host+path 打开远端项目，不受同路径本机项目影响", async () => {
  const { store, deps } = makeDeps();
  await seedSuiteRun(store.scopeHost("h-a"), ROOT_PATH, "run-a");
  await seedSuiteRun(store.scopeHost("h-b"), ROOT_PATH, "run-b");

  const resolved = await resolveProjectKey(deps, ROOT_PATH, "h-b");
  assert.equal(resolved.hostId, "h-b");
  assert.equal(resolved.rootPath, ROOT_PATH);

  const html = String(
    (
      await handlePanelRequest(
        new URL(`http://x/panel?host=h-b&project=${encodeURIComponent(ROOT_PATH)}&view=review`),
        deps
      )
    ).body
  );
  assert.match(html, /run-b/);
  assert.doesNotMatch(html, /run-a/);
});

test("无 host 且同路径跨主机 → 409 候选列表（不取其一）", async () => {
  const { store, deps } = makeDeps();
  await seedSuiteRun(store.scopeHost("h-a"), ROOT_PATH, "run-a");
  await seedSuiteRun(store.scopeHost("h-b"), ROOT_PATH, "run-b");

  const res = await handlePanelRequest(
    new URL(`http://x/panel.json?project=${encodeURIComponent(ROOT_PATH)}`),
    deps
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.match(body.error, /跨主机重复/);
  assert.deepEqual(
    new Set(body.candidates.map((candidate) => candidate.hostId)),
    new Set(["h-a", "h-b"])
  );
});

test("动作层带 host 命中远端项目（裁决写回 h-b 不串 h-a）", async () => {
  const { store, deps } = makeDeps();
  const hA = store.scopeHost("h-a");
  const hB = store.scopeHost("h-b");
  const runA = await seedSuiteRun(hA, ROOT_PATH, "run-a");
  const runB = await seedSuiteRun(hB, ROOT_PATH, "run-b");

  const res = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/verdicts?host=h-b"),
      body: {
        project: ROOT_PATH,
        verdict: "case-defect",
        items: [{ runId: runB.id, caseId: `case-run-b` }]
      }
    },
    deps
  );
  assert.equal(res.status, 200);

  assert.equal((await hB.getSuiteRun(ROOT_PATH, runB.id)).cases[0].verdict, "case-defect");
  assert.equal((await hA.getSuiteRun(ROOT_PATH, runA.id)).cases[0].verdict, null);
});

test("同路径两主机产生互异的带 host 链接（切换器/总览）", async () => {
  const { store, deps } = makeDeps();
  await seedSuiteRun(store.scopeHost("h-a"), ROOT_PATH, "run-a");
  await seedSuiteRun(store.scopeHost("h-b"), ROOT_PATH, "run-b");

  const html = String((await handlePanelRequest(new URL("http://x/panel"), deps)).body);
  const enc = encodeURIComponent(ROOT_PATH);
  assert.match(html, new RegExp(`${enc}&amp;host=h-a`));
  assert.match(html, new RegExp(`${enc}&amp;host=h-b`));
});

test("动作层无 host 且同路径跨主机 → 409（非 500）", async () => {
  const { store, deps } = makeDeps();
  await seedSuiteRun(store.scopeHost("h-a"), ROOT_PATH, "run-a");
  await seedSuiteRun(store.scopeHost("h-b"), ROOT_PATH, "run-b");

  const res = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/verdicts"),
      body: {
        project: ROOT_PATH,
        verdict: "case-defect",
        items: [{ runId: "x", caseId: "y" }]
      }
    },
    deps
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.match(body.error, /跨主机重复/);
  assert.deepEqual(
    new Set(body.candidates.map((candidate) => candidate.hostId)),
    new Set(["h-a", "h-b"])
  );
});

test("产物路由无 host 且同路径跨主机 → 409（非 500）", async () => {
  const { store, deps } = makeDeps();
  await seedSuiteRun(store.scopeHost("h-a"), ROOT_PATH, "run-a");
  await seedSuiteRun(store.scopeHost("h-b"), ROOT_PATH, "run-b");

  const res = await handleArtifactRequest(
    new URL(`http://x/panel/artifact?project=${encodeURIComponent(ROOT_PATH)}&path=foo.txt`),
    deps
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.match(body.error, /跨主机重复/);
  assert.deepEqual(
    new Set(body.candidates.map((candidate) => candidate.hostId)),
    new Set(["h-a", "h-b"])
  );

  const scoped = await handleArtifactRequest(
    new URL(
      `http://x/panel/artifact?project=${encodeURIComponent(ROOT_PATH)}&host=h-b&path=foo.txt`
    ),
    deps
  );
  assert.notEqual(scoped.status, 409, "带 host 时不再歧义");
});

