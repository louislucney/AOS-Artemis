import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { JiraApiError } from "../dist/jira/client.js";
import { handlePanelActionRequest, panelActionsEnabled } from "../dist/panel/actions.js";
import { createRunCaseIssues } from "../dist/panel/issues.js";
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

// ---------------------------------------------------------------------------
// POST /panel/api/issues — 一键建单
// ---------------------------------------------------------------------------

function fakeRuntime(overrides = {}) {
  const resolverValues = {
    JIRA_ISSUE_PROJECT: "AOS",
    JIRA_ISSUE_TYPE: "Bug",
    JIRA_ISSUE_LABELS: "",
    ...(overrides.resolverValues ?? {})
  };
  const rootDir = overrides.rootDir ?? "/issues-proj";
  return {
    project: {
      rootDir,
      resolver: {
        getValue: (name) => ({ value: resolverValues[name] ?? null, source: null })
      }
    },
    traceDir: (traceId) => `${rootDir}/.artemis/traces/${traceId}`,
    jiraConfig:
      overrides.jiraConfig ??
      (() => ({ configured: false, siteUrl: null, email: null, apiToken: null, missing: [] }))
  };
}

async function issueStore(rootPath = "/issues-proj") {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "issues" });
  return store;
}

async function recordIssueRun(store, rootPath, { cases } = {}) {
  return await store.recordSuiteRun({
    rootPath,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: null,
      featureName: "登录流程",
      platform: "android",
      device: "emulator-5554",
      appVersion: "1.2.3",
      status: "failed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 1,
      passed: 0,
      failed: 1,
      flaky: 0,
      quarantined: 0,
      failureDomains: { 应用缺陷: 1 },
      gateResult: "fail",
      exitCode: 1,
      manifestPath: null,
      comparison: null
    },
    cases:
      cases ?? [
        {
          caseId: "case-1",
          name: "Case 1",
          featureKey: null,
          platform: "android",
          status: "failed",
          traceId: "trace-1",
          failureDomain: "应用缺陷",
          failureConfidence: "high",
          failureReason: "崩溃",
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

function fakeClientFor({ siteUrl = "https://acme.atlassian.net", createIssue } = {}) {
  const calls = [];
  const clientFor = () => ({
    siteUrl,
    client: {
      createIssue: async (fields) => {
        calls.push(fields);
        if (createIssue) return await createIssue(fields, calls.length);
        return { id: "10001", key: "AOS-1" };
      }
    }
  });
  return { clientFor, calls };
}

const noopEvidence = async () => ({ ok: true });

test("panel issues: 成功建单（模板字段/证据 key-trace/回写/响应）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);
  const { clientFor, calls } = fakeClientFor();
  const evidenceCalls = [];
  const postEvidence = async (runtime, args) => {
    evidenceCalls.push(args);
    return { ok: true, issue: args.key };
  };

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, 1);
  assert.equal(outcome.existing, 0);
  assert.equal(outcome.skipped, 0);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.results[0].status, "created");
  assert.equal(outcome.results[0].key, "AOS-1");
  assert.equal(outcome.results[0].url, "https://acme.atlassian.net/browse/AOS-1");
  assert.equal(outcome.results[0].evidence, "posted");

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].project, { key: "AOS" });
  assert.deepEqual(calls[0].issuetype, { name: "Bug" });
  assert.equal(calls[0].summary, "[回归] 登录流程 · Case 1 失败");
  assert.ok(calls[0].description, "含 ADF 描述");
  assert.deepEqual(calls[0].labels, []);

  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0].key, "AOS-1");
  assert.equal(evidenceCalls[0].traceId, "trace-1");
  assert.equal(evidenceCalls[0].platform, "android");
  assert.equal(evidenceCalls[0].deviceSerial, "emulator-5554");
  assert.equal(evidenceCalls[0].dryRun, false);

  const stored = await store.getSuiteRun(rootPath, run.id);
  assert.equal(stored.cases.find((c) => c.caseId === "case-1").jiraIssueKey, "AOS-1");
});

test("panel issues: 路由成功 → 200 + 清缓存（existing 离线）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath, {
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: "trace-1",
        failureDomain: "应用缺陷",
        failureConfidence: "high",
        failureReason: "崩溃",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: "app-defect",
        verdictBy: "panel",
        verdictAt: null,
        verdictNote: null,
        jiraIssueKey: "AOS-42"
      }
    ]
  });
  let cleared = 0;
  const cache = {
    get: () => undefined,
    set: () => {},
    clear: () => {
      cleared += 1;
    }
  };
  const deps = {
    store,
    env: {},
    workspaceRoot: null,
    runtimeFor: async () =>
      fakeRuntime({
        jiraConfig: () => ({
          configured: true,
          siteUrl: "https://acme.atlassian.net",
          email: "a@b.c",
          apiToken: "tok",
          missing: []
        })
      })
  };
  const response = await handlePanelActionRequest(
    request({
      url: new URL("http://localhost/panel/api/issues"),
      body: { project: rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
    }),
    { ...deps, cache }
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.existing, 1);
  assert.equal(payload.results[0].status, "existing");
  assert.equal(payload.results[0].url, "https://acme.atlassian.net/browse/AOS-42");
  assert.equal(cleared, 1, "写后清缓存（existing 亦清）");
});

test("panel issues: existing 幂等（不调 createIssue）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath, {
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: "trace-1",
        failureDomain: "应用缺陷",
        failureConfidence: "high",
        failureReason: "崩溃",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null,
        jiraIssueKey: "AOS-9"
      }
    ]
  });
  const { clientFor, calls } = fakeClientFor();
  let evidenceCalls = 0;
  const postEvidence = async () => {
    evidenceCalls += 1;
    return { ok: true };
  };

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.existing, 1);
  assert.equal(outcome.created, 0);
  assert.equal(outcome.results[0].status, "existing");
  assert.equal(outcome.results[0].key, "AOS-9");
  assert.equal(outcome.results[0].url, "https://acme.atlassian.net/browse/AOS-9");
  assert.equal(calls.length, 0, "existing 不触发 createIssue");
  assert.equal(evidenceCalls, 0, "existing 不触发证据");
});

test("panel issues: skipped 三态（未知/通过/裁决冲突）不触 Jira", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath, {
    cases: [
      {
        caseId: "case-pass",
        name: "Pass",
        featureKey: null,
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
        caseId: "case-defect",
        name: "Defect",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: null,
        failureReason: null,
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: "case-defect",
        verdictBy: "panel",
        verdictAt: null,
        verdictNote: null
      }
    ]
  });
  const { clientFor, calls } = fakeClientFor();
  let evidenceCalls = 0;
  const postEvidence = async () => {
    evidenceCalls += 1;
    return { ok: true };
  };

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence },
    {
      rootPath,
      items: [
        { runId: "run-nope", caseId: "case-1" },
        { runId: run.id, caseId: "case-pass" },
        { runId: run.id, caseId: "case-defect" }
      ]
    }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.skipped, 3);
  assert.equal(outcome.created, 0);
  assert.deepEqual(outcome.results.map((r) => r.status), ["skipped", "skipped", "skipped"]);
  assert.equal(outcome.results[0].reason, "未知运行或用例");
  assert.equal(outcome.results[1].reason, "用例已通过，无需建单");
  assert.equal(outcome.results[2].reason, "裁决为 case-defect，与建单不符");
  assert.equal(calls.length, 0, "skipped 不触 createIssue");
  assert.equal(evidenceCalls, 0, "skipped 不触证据");
});

test("panel issues: dryRun 预览（不触 createIssue；证据以 dryRun:true）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);
  const { clientFor, calls } = fakeClientFor();
  const evidenceCalls = [];
  const postEvidence = async (runtime, args) => {
    evidenceCalls.push(args);
    return { ok: true, dryRun: true, attachments: ["traces/trace-1/screenshot.png"] };
  };

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }], dryRun: true }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, 0);
  assert.equal(outcome.results[0].status, "preview");
  assert.equal(outcome.results[0].summary, "[回归] 登录流程 · Case 1 失败");
  assert.deepEqual(outcome.results[0].attachments, ["traces/trace-1/screenshot.png"]);
  assert.equal(calls.length, 0, "dryRun 不触 createIssue");
  assert.equal(evidenceCalls.length, 1);
  assert.equal(evidenceCalls[0].key, "");
  assert.equal(evidenceCalls[0].dryRun, true);
  const stored = await store.getSuiteRun(rootPath, run.id);
  assert.equal(stored.cases.find((c) => c.caseId === "case-1").jiraIssueKey, null, "dryRun 不回写");
});

test("panel issues: 未配置 Jira / runtimeFor 缺失 → ok:false 指引", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);

  const unconfigured = await createRunCaseIssues(
    {
      store,
      runtimeFor: async () =>
        fakeRuntime({
          jiraConfig: () => ({
            configured: false,
            siteUrl: null,
            email: null,
            apiToken: null,
            missing: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"]
          })
        }),
      clientFor: () => null,
      postEvidence: noopEvidence
    },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );
  assert.equal(unconfigured.ok, false);
  assert.ok(unconfigured.error.includes("JIRA_BASE_URL"), "错误含缺失项");
  assert.ok(Array.isArray(unconfigured.hints) && unconfigured.hints.length > 0);

  const noRuntime = await createRunCaseIssues(
    { store, runtimeFor: async () => null },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );
  assert.equal(noRuntime.ok, false);
  assert.equal(noRuntime.error, "项目运行时不可用（仅限 workspace 内项目、HTTP 模式）");
});

test("panel issues: projectKey/issueType/labels 缺省解析（逗号拆分去重）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);
  const { clientFor, calls } = fakeClientFor();
  const runtime = fakeRuntime({
    resolverValues: {
      JIRA_ISSUE_PROJECT: "AOS",
      JIRA_ISSUE_TYPE: "Task",
      JIRA_ISSUE_LABELS: " login , pay , , login "
    }
  });

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => runtime, clientFor, postEvidence: noopEvidence },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, 1);
  assert.deepEqual(calls[0].project, { key: "AOS" });
  assert.deepEqual(calls[0].issuetype, { name: "Task" });
  assert.deepEqual(calls[0].labels, ["login", "pay"]);
});

test("panel issues: 部分失败容忍（第 1 条 create 抛错、第 2 条成功）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath, {
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: "trace-1",
        failureDomain: "应用缺陷",
        failureConfidence: "high",
        failureReason: "崩溃",
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
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: "trace-2",
        failureDomain: "应用缺陷",
        failureConfidence: "high",
        failureReason: "崩溃",
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
  const calls = [];
  const clientFor = () => ({
    siteUrl: "https://acme.atlassian.net",
    client: {
      createIssue: async (fields) => {
        calls.push(fields);
        if (calls.length === 1) throw new Error("jira hiccup");
        return { id: "10002", key: "AOS-2" };
      }
    }
  });

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence: noopEvidence },
    {
      rootPath,
      items: [
        { runId: run.id, caseId: "case-1" },
        { runId: run.id, caseId: "case-2" }
      ]
    }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, 1);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[0].status, "error");
  assert.equal(outcome.results[0].reason, "Jira 建单失败");
  assert.equal(outcome.results[1].status, "created");
  assert.equal(outcome.results[1].key, "AOS-2");
  const stored = await store.getSuiteRun(rootPath, run.id);
  assert.equal(stored.cases.find((c) => c.caseId === "case-2").jiraIssueKey, "AOS-2");
  assert.equal(stored.cases.find((c) => c.caseId === "case-1").jiraIssueKey, null);
});

test("panel issues: createIssue 抛 JiraApiError → reason 通用短语（不泄露 body 与 Jira API 原文）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);
  const clientFor = () => ({
    siteUrl: "https://acme.atlassian.net",
    client: {
      createIssue: async () => {
        throw new JiraApiError(500, "UNIQUE_MARKER_SECRET_BODY_42", null);
      }
    }
  });

  const outcome = await createRunCaseIssues(
    { store, runtimeFor: async () => fakeRuntime(), clientFor, postEvidence: noopEvidence },
    { rootPath, items: [{ runId: run.id, caseId: "case-1" }] }
  );

  assert.equal(outcome.ok, true);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.results[0].status, "error");
  assert.equal(outcome.results[0].reason, "Jira 建单失败");
  assert.ok(!outcome.results[0].reason.includes("UNIQUE_MARKER_SECRET_BODY_42"), "不泄露 Jira body");
  assert.ok(!outcome.results[0].reason.includes("Jira API"), "不泄露底层原文");
});

test("panel issues: 路由校验（items 超 20 → 400；labels 非字符串 → 400）", async () => {
  const rootPath = "/issues-proj";
  const store = await issueStore(rootPath);
  const run = await recordIssueRun(store, rootPath);
  const deps = {
    store,
    env: {},
    workspaceRoot: null,
    runtimeFor: async () => fakeRuntime()
  };
  const url = new URL("http://localhost/panel/api/issues");
  const body = (payload) => ({ project: rootPath, ...payload });

  const tooMany = await handlePanelActionRequest(
    request({
      url,
      body: body({ items: Array.from({ length: 21 }, () => ({ runId: run.id, caseId: "case-1" })) })
    }),
    deps
  );
  assert.equal(tooMany.status, 400);
  assert.ok(JSON.parse(tooMany.body).error.includes("超过上限"));

  const badLabels = await handlePanelActionRequest(
    request({ url, body: body({ items: [{ runId: run.id, caseId: "case-1" }], labels: 123 }) }),
    deps
  );
  assert.equal(badLabels.status, 400);

  const emptyItems = await handlePanelActionRequest(
    request({ url, body: body({ items: [] }) }),
    deps
  );
  assert.equal(emptyItems.status, 400);
});
