import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest, panelActionsEnabled } from "../dist/panel/actions.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function request(overrides = {}) {
  return {
    method: "POST",
    url: new URL("http://localhost/panel/api/tasks"),
    body: {},
    ...overrides
  };
}

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const set = await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
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
  const run = await store.recordSuiteRun({
    rootPath: runtime.project.rootDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: set.id,
      featureKey: "f-1",
      featureName: "登录流程",
      platform: "android",
      device: null,
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 2,
      passed: 0,
      failed: 2,
      flaky: 0,
      quarantined: 0,
      failureDomains: { 用例缺陷: 2 },
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
  const deps = { store, env: {}, workspaceRoot: null };
  return { dir, runtime, store, set, run, deps };
}

test("panel actions: 开关关闭 404 / 非 POST 405 / body 非对象 400", async () => {
  const { deps } = await setup();
  const off = await handlePanelActionRequest(request(), {
    ...deps,
    env: { AOS_PANEL_ACTIONS: "0" }
  });
  assert.equal(off.status, 404);

  const notPost = await handlePanelActionRequest(request({ method: "GET", body: undefined }), deps);
  assert.equal(notPost.status, 405);

  const badBody = await handlePanelActionRequest(request({ body: "not-an-object" }), deps);
  assert.equal(badBody.status, 400);
  const nullBody = await handlePanelActionRequest(request({ body: null }), deps);
  assert.equal(nullBody.status, 400);

  assert.equal(panelActionsEnabled({}), true);
  assert.equal(panelActionsEnabled({ AOS_PANEL_ACTIONS: "0" }), false);
});

test("panel actions: POST tasks 创建成功 / 未知项目 404 / refs 空 400 / 未知份 400 / 非法参数 400", async () => {
  const { runtime, store, set, deps } = await setup();
  const body = (payload) => ({ project: runtime.project.rootDir, ...payload });

  const ok = await handlePanelActionRequest(
    request({
      body: body({ refs: [{ caseSetId: set.id, featureKey: "f-1" }], platforms: ["android"], baseline: "none" })
    }),
    deps
  );
  assert.equal(ok.status, 200);
  const payload = JSON.parse(ok.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.task.baseline, "none");
  assert.deepEqual(payload.task.platforms, ["android"]);
  const tasks = await store.listRegressionTasks(runtime.project.rootDir);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].refs, [{ caseSetId: set.id, featureKey: "f-1" }]);

  const unknownProject = await handlePanelActionRequest(
    request({ body: { project: "nope", refs: [] } }),
    deps
  );
  assert.equal(unknownProject.status, 404);

  const emptyRefs = await handlePanelActionRequest(request({ body: body({ refs: [] }) }), deps);
  assert.equal(emptyRefs.status, 400);

  const unknownRef = await handlePanelActionRequest(
    request({ body: body({ refs: [{ caseSetId: set.id, featureKey: "f-nope" }] }) }),
    deps
  );
  assert.equal(unknownRef.status, 400);

  const badPlatform = await handlePanelActionRequest(
    request({ body: body({ refs: [{ caseSetId: set.id, featureKey: "f-1" }], platforms: ["windows"] }) }),
    deps
  );
  assert.equal(badPlatform.status, 400);

  const badBaseline = await handlePanelActionRequest(
    request({ body: body({ refs: [{ caseSetId: set.id, featureKey: "f-1" }], baseline: "latestt" }) }),
    deps
  );
  assert.equal(badBaseline.status, 400);
});

test("panel actions: POST verdicts 批量裁决（重复幂等）/ 全未命中 400 / 非法裁决 400", async () => {
  const { runtime, store, run, deps } = await setup();
  const url = new URL("http://localhost/panel/api/verdicts");
  const body = (payload) => ({ project: runtime.project.rootDir, ...payload });

  const ok = await handlePanelActionRequest(
    request({
      url,
      body: body({
        items: [{ runId: run.id, caseId: "case-1" }],
        verdict: "case-defect",
        note: "期望错"
      })
    }),
    deps
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, updated: 1, missed: 0 });
  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(runs[0].cases[0].verdict, "case-defect");
  assert.equal(runs[0].cases[0].verdictNote, "期望错");
  assert.equal(runs[0].cases[0].verdictBy, "panel");

  const again = await handlePanelActionRequest(
    request({
      url,
      body: body({ items: [{ runId: run.id, caseId: "case-1" }], verdict: "app-defect" })
    }),
    deps
  );
  assert.equal(again.status, 200);
  assert.equal((await store.listSuiteRuns(runtime.project.rootDir))[0].cases[0].verdict, "app-defect");

  const missed = await handlePanelActionRequest(
    request({
      url,
      body: body({ items: [{ runId: "run-nope", caseId: "case-1" }], verdict: "uncertain" })
    }),
    deps
  );
  assert.equal(missed.status, 400);

  const badVerdict = await handlePanelActionRequest(
    request({
      url,
      body: body({ items: [{ runId: run.id, caseId: "case-1" }], verdict: "nope" })
    }),
    deps
  );
  assert.equal(badVerdict.status, 400);
});

test("panel actions: verdicts 部分失败容忍 + 写后清缓存", async () => {
  const { runtime, store, run, deps } = await setup();
  const url = new URL("http://localhost/panel/api/verdicts");
  let cleared = 0;
  const cache = {
    get: () => undefined,
    set: () => {},
    clear: () => {
      cleared += 1;
    }
  };
  const original = store.updateCaseVerdict.bind(store);
  let calls = 0;
  store.updateCaseVerdict = async (input) => {
    calls += 1;
    if (calls === 2) throw new Error("db hiccup");
    return original(input);
  };

  const response = await handlePanelActionRequest(
    request({
      url,
      body: {
        project: runtime.project.rootDir,
        items: [
          { runId: run.id, caseId: "case-1" },
          { runId: run.id, caseId: "case-2" }
        ],
        verdict: "case-defect"
      }
    }),
    { ...deps, cache }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, updated: 1, missed: 0, failed: 1 });
  assert.equal(cleared, 1, "写后清缓存（含部分失败）");
  const runs = await store.listSuiteRuns(runtime.project.rootDir);
  assert.equal(
    runs[0].cases.find((entry) => entry.caseId === "case-1").verdict,
    "case-defect"
  );
  assert.equal(runs[0].cases.find((entry) => entry.caseId === "case-2").verdict, null);
});

test("panel actions: verdicts 全部写入失败 → 500 通用错误（不泄露详情）", async () => {
  const { runtime, store, run, deps } = await setup();
  const url = new URL("http://localhost/panel/api/verdicts");
  store.updateCaseVerdict = async () => {
    throw new Error("relation pg_stat_activity does not exist");
  };
  const response = await handlePanelActionRequest(
    request({
      url,
      body: {
        project: runtime.project.rootDir,
        items: [{ runId: run.id, caseId: "case-1" }],
        verdict: "case-defect"
      }
    }),
    deps
  );
  assert.equal(response.status, 500);
  const payload = JSON.parse(response.body);
  assert.equal(payload.error, "裁决写入失败");
  assert.ok(!response.body.includes("pg_stat_activity"), "不泄露底层错误详情");
});

test("panel actions: platforms 去重", async () => {
  const { runtime, store, set, deps } = await setup();
  const response = await handlePanelActionRequest(
    request({
      body: {
        project: runtime.project.rootDir,
        refs: [{ caseSetId: set.id, featureKey: "f-1" }],
        platforms: ["android", "android"]
      }
    }),
    deps
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.task.platforms, ["android"]);
  assert.deepEqual(
    (await store.listRegressionTasks(runtime.project.rootDir))[0].platforms,
    ["android"]
  );
});
