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
