import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { buildRunManifest, saveRunManifest } from "../dist/figma/run-manifest.js";
import {
  createPanelWebCache,
  handlePanelRequest,
  panelCacheTtlFrom,
  panelWebEnabled
} from "../dist/panel/web.js";
import { baseConfig, makeTempDir } from "./helpers.js";

function makeReadyRepo() {
  const repo = makeTempDir("aos-panel-web-repo-");
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
        scriptProvenance: { asserts: 4, explores: 1 },
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

async function makeHarness() {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const workspace = makeTempDir("aos-panel-web-ws-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  fs.writeFileSync(path.join(projectDir, ".env"), COMPLETE_DOTENV, "utf-8");
  await store.upsertProject({ rootPath: projectDir, name: "demo" });
  return {
    store,
    projectDir,
    deps: { store, env: {}, workspaceRoot: workspace, serviceRepo: repo, buildStale: false }
  };
}

test("panel web: 开关、TTL 解析与 404", async () => {
  const { deps } = await makeHarness();
  const disabled = await handlePanelRequest(new URL("http://x/panel"), {
    ...deps,
    env: { AOS_PANEL_WEB: "0" }
  });
  assert.equal(disabled.status, 404);
  assert.equal(
    (await handlePanelRequest(new URL("http://x/panel.json"), { ...deps, env: { AOS_PANEL_WEB: "0" } })).status,
    404
  );
  assert.equal((await handlePanelRequest(new URL("http://x/other"), deps)).status, 404);

  assert.equal(panelWebEnabled({}), true);
  assert.equal(panelWebEnabled({ AOS_PANEL_WEB: "0" }), false);
  assert.equal(panelCacheTtlFrom({}), 5000);
  assert.equal(panelCacheTtlFrom({ AOS_PANEL_CACHE_MS: "0" }), 0);
  assert.equal(panelCacheTtlFrom({ AOS_PANEL_CACHE_MS: "1500" }), 1500);
});

test("panel web: 总览 JSON 与 HTML", async () => {
  const { deps } = await makeHarness();
  const json = await handlePanelRequest(new URL("http://x/panel.json"), deps);
  assert.equal(json.status, 200);
  assert.match(json.contentType, /application\/json/);
  const payload = JSON.parse(json.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.view, "overview");
  assert.equal(payload.projects.length, 1);
  assert.equal(payload.projects[0].name, "demo");
  assert.equal(payload.projects[0].lamp, "yellow");
  assert.ok(payload.projects[0].lampReasons.some((reason) => reason.includes("存储降级")));

  const html = await handlePanelRequest(new URL("http://x/panel"), deps);
  assert.equal(html.status, 200);
  assert.match(html.contentType, /text\/html/);
  assert.match(html.body, /多项目总览/);
  assert.match(html.body, /lamp-yellow/);
  assert.match(html.body, /存储：内存降级/);
  assert.match(html.body, /demo/);
});

test("panel web: 项目详情（空态→批次→独立运行）与未知项目 404", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const projectUrl = new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}`);

  const empty = JSON.parse((await handlePanelRequest(projectUrl, deps)).body);
  assert.equal(empty.view, "project");
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.emptyState.causes.length, 3);
  assert.equal(empty.integration.llm.usable, true);
  assert.equal(empty.integration.credentials.figma, true);

  const manifest = makeBatch(projectDir, { startedIso: "2026-10-13T09:00:00.000Z", traceId: "trace-1" });
  await store.recordTask({ rootPath: projectDir, traceId: "trace-2", status: "submitted" });

  const detail = JSON.parse((await handlePanelRequest(projectUrl, deps)).body);
  assert.equal(detail.batches.length, 1);
  assert.equal(detail.batches[0].runId, manifest.runId);
  assert.equal(detail.standalones.length, 1);
  assert.equal(detail.standalones[0].traceId, "trace-2");
  assert.equal(detail.standalones[0].outcome, "pending");

  const byName = await handlePanelRequest(new URL("http://x/panel.json?project=demo"), deps);
  assert.equal(byName.status, 200);
  assert.equal(JSON.parse(byName.body).project.name, "demo");

  const projectHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectHtml.body, /磁盘资产/);
  assert.match(projectHtml.body, /对账资产/);

  assert.equal(
    (await handlePanelRequest(new URL("http://x/panel.json?project=nope"), deps)).status,
    404
  );
});

test("panel web: 回归引用区块（复选框/端/基线/内联 JS/无 JS 提示）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const set = await store.recordCaseSet({
    rootPath: projectDir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 2,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /新建回归测试/);
  assert.match(html.body, new RegExp(`value="${set.id}\\|f-1"`), "复选框 value＝caseSetId|featureKey");
  assert.match(html.body, /name="platform" value="ios" checked/);
  assert.match(html.body, /name="platform" value="android" checked/);
  assert.match(html.body, /name="baseline"/);
  assert.match(html.body, /fetch\('\/panel\/api\/tasks'/);
  assert.match(html.body, /需启用 JavaScript 提交/);
});

test("panel web: 批次详情（证据缺失占位/失败域）与非法文件名", async () => {
  const { deps, projectDir } = await makeHarness();
  const manifest = makeBatch(projectDir, {
    startedIso: "2026-10-13T09:00:00.000Z",
    traceId: "trace-1",
    exitCode: 1,
    failureDomain: "app-defect"
  });
  const runsDir = path.join(projectDir, ".artemis", "design", "runs");
  const file = fs.readdirSync(runsDir).find((name) => name.endsWith(".json"));

  const url = new URL(
    `http://x/panel.json?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(file)}`
  );
  const payload = JSON.parse((await handlePanelRequest(url, deps)).body);
  assert.equal(payload.view, "batch");
  assert.equal(payload.read, "ok");
  assert.equal(payload.runId, manifest.runId);
  assert.equal(payload.cases[0].failure.domain, "app-defect");
  assert.deepEqual(payload.cases[0].scriptProvenance, { asserts: 4, explores: 1 });
  assert.deepEqual(payload.failureDomains, { "app-defect": 1 });
  const trace = payload.cases[0].evidence.find((link) => link.kind === "trace");
  assert.equal(trace.status, "missing");

  const htmlUrl = new URL(
    `http://x/panel?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(file)}`
  );
  const htmlBody = (await handlePanelRequest(htmlUrl, deps)).body;
  assert.match(htmlBody, /失败域汇总/);
  assert.match(htmlBody, /已清理/);
  assert.match(htmlBody, /断言 4 \/ 探索 1/);

  const illegal = await handlePanelRequest(
    new URL(`http://x/panel.json?project=demo&batch=${encodeURIComponent("../evil.json")}`),
    deps
  );
  assert.equal(illegal.status, 200);
  assert.equal(JSON.parse(illegal.body).read, "invalid");
});

test("panel web: 深探注入（默认纯读；ios=1 显式探测）", async () => {
  const { deps } = await makeHarness();
  const requests = [];
  const deep = {
    build: async (rootPath, options) => {
      requests.push({ rootPath, options });
      return {
        activeProfile: "x",
        llmEntries: 1,
        setupRequired: false,
        store: { kind: "memory", degraded: true, note: null, lastError: null },
        usage: { enabled: true },
        modelRefresh: { ttlHours: 12, autoRepair: true },
        artemis: {
          repo: "r",
          configDir: "c",
          python: { path: null, found: false, hint: null },
          child: { running: false, pid: null, restarts: 0, lastError: null }
        },
        figma: {
          bridge: { status: "not_started", port: null, message: "" },
          token: { present: false, source: null }
        },
        jira: { configured: false, siteUrl: null, missing: ["JIRA_BASE_URL"] },
        logs: { file: null, childFile: null },
        build: { stale: false, startedAt: "2026-10-14T00:00:00.000Z" },
        iosProbe: options.iosProbe
          ? {
              appium: { found: false, path: null, version: null },
              xcuitest: { installed: false, version: null },
              guidance: [],
              error: null,
              probedAt: "2026-10-14T00:00:00.000Z"
            }
          : null
      };
    }
  };
  const withDeep = { ...deps, deep };

  const json = await handlePanelRequest(new URL("http://x/panel.json?project=demo"), withDeep);
  const payload = JSON.parse(json.body);
  assert.equal(payload.deep.activeProfile, "x");
  assert.equal(payload.deep.iosProbe, null);
  assert.equal(requests[0].options.iosProbe, false, "默认不触发 iOS 探测");

  const iosJson = await handlePanelRequest(new URL("http://x/panel.json?project=demo&ios=1"), withDeep);
  const iosPayload = JSON.parse(iosJson.body);
  assert.equal(requests[1].options.iosProbe, true);
  assert.equal(iosPayload.deep.iosProbe.appium.found, false);

  const html = await handlePanelRequest(new URL("http://x/panel?project=demo"), withDeep);
  assert.match(html.body, /深探信息/);
  assert.match(html.body, /iOS 环境检测/);
});

test("panel web: 进程内缓存 TTL（TTL 内命中、过期重算）", async () => {
  let t = Date.parse("2026-10-13T00:00:00.000Z");
  const cache = createPanelWebCache(5000, () => t);
  const { deps } = await makeHarness();
  const depsWithCache = { ...deps, now: () => t, cache };
  const url = new URL("http://x/panel.json");

  const first = JSON.parse((await handlePanelRequest(url, depsWithCache)).body);
  t += 4000;
  const second = JSON.parse((await handlePanelRequest(url, depsWithCache)).body);
  assert.equal(second.generatedAt, first.generatedAt, "TTL 内命中缓存");
  t += 2000;
  const third = JSON.parse((await handlePanelRequest(url, depsWithCache)).body);
  assert.notEqual(third.generatedAt, first.generatedAt, "TTL 过期后重算");
});

test("panel web: 任务视图（状态/子运行/指引）与未知 task 404", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const set = await store.recordCaseSet({
    rootPath: projectDir,
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
    rootPath: projectDir,
    refs: [{ caseSetId: set.id, featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.updateRegressionTask(projectDir, task.id, { status: "partial", runIds: ["r1"] });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: task.id,
      caseSetId: set.id,
      featureKey: "f-1",
      featureName: "登录流程",
      platform: "android",
      device: "emulator-5554",
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
      manifestPath: "/m/android.json",
      comparison: { baseline: "compared", fixed: 0, regressed: 1, newFailed: 0, vanished: 0 }
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
      }
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${encodeURIComponent(task.id)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /回归任务/);
  assert.match(html.body, /partial/);
  assert.match(html.body, /登录流程/);
  assert.match(html.body, /emulator-5554/);
  assert.match(html.body, new RegExp(`suite run --task ${task.id}`));

  const json = JSON.parse(
    (
      await handlePanelRequest(
        new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}&task=${encodeURIComponent(task.id)}`),
        deps
      )
    ).body
  );
  assert.equal(json.view, "task");
  assert.equal(json.task.id, task.id);

  const missing = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=task-nope`),
    deps
  );
  assert.equal(missing.status, 404);

  const priority = JSON.parse(
    (
      await handlePanelRequest(
        new URL(
          `http://x/panel.json?project=${encodeURIComponent(projectDir)}&task=${encodeURIComponent(task.id)}&view=stats`
        ),
        deps
      )
    ).body
  );
  assert.equal(priority.view, "task", "视图优先级：task > view");

  const unknownView = JSON.parse(
    (
      await handlePanelRequest(
        new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}&view=foo`),
        deps
      )
    ).body
  );
  assert.equal(unknownView.view, "project", "未知 view 静默回项目页");
});

test("panel web: review HTML（radio 四选项、批量复选框、fetch、证据两态、指引）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  fs.mkdirSync(path.join(projectDir, ".artemis", "traces", "trace-1"), { recursive: true });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: null,
      featureName: null,
      platform: "android",
      device: "emulator-5554",
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
        featureKey: null,
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
        caseId: "case-2",
        name: "Case 2",
        featureKey: null,
        platform: "android",
        status: "failed",
        traceId: "trace-gone",
        failureDomain: "环境",
        failureConfidence: "low",
        failureReason: "设备离线",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: null,
        verdictBy: null,
        verdictAt: null,
        verdictNote: null
      },
      {
        caseId: "case-3",
        name: "Case 3",
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
      }
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=review`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /归因队列/);
  assert.match(html.body, /value="case-defect"/);
  assert.match(html.body, /value="execution-deviation"/);
  assert.match(html.body, /value="app-defect"/);
  assert.match(html.body, /value="uncertain"/);
  assert.match(html.body, /name="item" value="[^"]+\|case-1"/);
  assert.match(html.body, /fetch\('\/panel\/api\/verdicts'/);
  assert.match(html.body, /trace-1<\/code>/, "存在证据目录 → 直接展示路径");
  assert.match(
    html.body,
    /trace-gone<\/code> <span class="muted">\[已清理\]<\/span>/,
    "缺失证据目录 → [已清理] 标注"
  );
  assert.match(html.body, /suite run --tests/);
  assert.match(html.body, /quarantine\.json/);
  assert.match(html.body, /裁决仅存档/, "无份运行裁决口径提示");
  assert.doesNotMatch(html.body, /case-3/, "已通过用例不进队列");

  const projectHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectHtml.body, /view=review/, "项目页有归因队列入口");
});

test("panel web: stats HTML（功能表/最不稳用例/跨端/三清单/指引）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const set = await store.recordCaseSet({
    rootPath: projectDir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 2,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: set.id,
      featureKey: "f-1",
      featureName: "登录流程",
      platform: "android",
      device: "emulator-5554",
      appVersion: null,
      status: "failed",
      startedAt: "2026-10-14T10:00:00.000Z",
      finishedAt: "2026-10-14T10:05:00.000Z",
      total: 3,
      passed: 1,
      failed: 2,
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
        status: "failed",
        traceId: null,
        failureDomain: "用例缺陷",
        failureConfidence: "medium",
        failureReason: "断言未命中",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: "case-defect",
        verdictBy: "alice",
        verdictAt: "2026-10-14T12:00:00.000Z",
        verdictNote: "期望值写错"
      },
      {
        caseId: "case-2",
        name: "Case 2",
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
        caseId: "case-3",
        name: "Case 3",
        featureKey: "f-1",
        platform: "android",
        status: "failed",
        traceId: null,
        failureDomain: "应用缺陷",
        failureConfidence: "high",
        failureReason: "崩溃",
        durationMs: null,
        quarantined: false,
        flaky: false,
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T12:30:00.000Z",
        verdictNote: null
      }
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /回归统计/);
  assert.match(html.body, /登录流程/);
  assert.match(html.body, /33%/);
  assert.match(html.body, /案例问题/);
  assert.match(html.body, /执行偏差/);
  assert.match(html.body, /应用缺陷/);
  assert.match(html.body, /figma_generate_tests/);
  assert.match(html.body, /jira issue create/);
  assert.match(html.body, /case-1/);

  const projectHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectHtml.body, /view=stats/, "项目页有统计入口");
});

test("panel web: 项目页 runner 区块（在线灯/设备 chips/工具徽标）+ 有 runner 挂 refresh", async () => {
  const { deps, projectDir, store } = await makeHarness();
  await store.upsertRunner({
    rootPath: projectDir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    artifactBaseUrl: "http://mac-1:8770"
  });
  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /执行机（runner）/);
  assert.match(html.body, /lamp-green/);
  assert.match(html.body, /emulator-5554/);
  assert.match(html.body, /adb ✓/);
  assert.match(html.body, /appium ✗/);
  assert.match(html.body, /http:\/\/mac-1:8770/);
  assert.match(html.body, /http-equiv="refresh" content="30"/);

  const clean = await makeHarness();
  const cleanHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(clean.projectDir)}`),
    clean.deps
  );
  assert.match(cleanHtml.body, /暂无 runner 心跳/);
  assert.doesNotMatch(cleanHtml.body, /http-equiv="refresh"/, "无 runner 不挂刷新");
});

test("panel web: 任务页 已领取/在线标记/刷新/无端覆盖提示", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const taskInput = (platforms) => ({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms,
    baseline: "latest",
    createdBy: "cli"
  });
  const claimedTask = await store.createRegressionTask(taskInput(["android"]));
  const runner = await store.upsertRunner({
    rootPath: projectDir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  });
  await store.claimRegressionTask({
    rootPath: projectDir,
    runnerId: runner.id,
    platforms: ["android"]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${claimedTask.id}`),
    deps
  );
  assert.match(html.body, /已领取/);
  assert.match(html.body, /「r-1」（在线）/);
  assert.match(html.body, /http-equiv="refresh" content="10"/);
  assert.match(html.body, /在线 runner 会自动领取执行/);
  assert.doesNotMatch(html.body, /无在线 runner 完整覆盖/);

  const pendingTask = await store.createRegressionTask(taskInput(["ios"]));
  const pendingHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pendingTask.id}`),
    deps
  );
  assert.match(pendingHtml.body, /无在线 runner 完整覆盖/, "pending 且无端覆盖 → 提示");

  await store.updateRegressionTask(projectDir, claimedTask.id, { status: "completed" });
  const doneHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${claimedTask.id}`),
    deps
  );
  assert.match(doneHtml.body, /已完成/);
  assert.doesNotMatch(doneHtml.body, /http-equiv="refresh"/, "终态不刷新");
});
