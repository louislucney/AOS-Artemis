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
  panelWebEnabled,
  trendPassRateSvg
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

function makeBatch(
  dir,
  {
    startedIso,
    traceId,
    exitCode = 0,
    failureDomain = null,
    evidence = null,
    designWarningSummary = null,
    ui = null,
    uiSummary = null
  }
) {
  const report = {
    ok: true,
    testsPath: path.join(dir, ".artemis", "design", "tests.json"),
    total: 1,
    executed: 1,
    skipped: 0,
    passed: exitCode === 0 ? 1 : 0,
    failed: exitCode === 0 ? 0 : 1,
    ...(uiSummary === null ? {} : { ui: uiSummary }),
    preflight:
      designWarningSummary === null
        ? null
        : {
            cases: 1,
            weakCases: [],
            coverage: {
              available: true,
              uncoveredScreens: [],
              uncoveredEdges: [],
              explore: { uncoveredScreens: [], uncoveredEdges: [] }
            },
            artifacts: { excelPresent: true, excelStale: false },
            dataPolicy: { missing: [] },
            generation: null,
            designWarningSummary
          },
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
        ...(ui === null ? {} : { ui }),
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
  assert.ok(payload.projects[0].lampReasons.some((reason) => reason.includes("会话内存")));
  assert.equal(payload.projects[0].designWarnings, null);

  const html = await handlePanelRequest(new URL("http://x/panel"), deps);
  assert.equal(html.status, 200);
  assert.match(html.contentType, /text\/html/);
  assert.match(html.body, /多项目总览/);
  assert.match(html.body, /lamp-yellow/);
  assert.match(html.body, /存储：会话内存/);
  assert.match(html.body, /demo/);
  assert.match(html.body, /<time datetime="/, "最后活跃相对化（title 绝对）");
  assert.match(html.body, /生成时间 刚刚/, "总览生成时间相对化（文本通道）");
  assert.match(html.body, /c-table/, "CSDC 表格");
  assert.match(html.body, /c-badge/, "CSDC 徽章");
  assert.match(html.body, /进入最近活跃项目：demo →/, "首访直达最近活跃项目");
  assert.match(html.body, /class="c-project-link"[^>]*>demo<span class="c-project-arrow"/, "项目名即进入动作");
  assert.match(html.body, /c-table--fixed/, "总览表格固定列宽");
  assert.match(html.body, /<col style="width:20%">/, "项目列宽按信息优先级分配");
  assert.match(html.body, /进入任一项目后显示项目级版块/, "无项目上下文时导航给说明而非死项");
  assert.match(html.body, /id="aos-resume"/, "继续上次位点");
  assert.match(html.body, /aos-auto-entered/, "单项目自动进入（每会话一次守卫）");
  assert.match(
    html.body,
    /设计源警告：不可用（缺 tests\.json \/ flows\.json 快照）/,
    "无设计警告快照的项目行显式未知（不静默）"
  );
});

test("panel web: 项目详情（空态→批次→单次运行）与未知项目 404", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const projectUrl = new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}`);

  const empty = JSON.parse((await handlePanelRequest(projectUrl, deps)).body);
  assert.equal(empty.view, "project");
  assert.deepEqual(empty.batches, []);
  assert.equal(empty.emptyState.causes.length, 3);
  assert.equal(empty.integration.llm.usable, true);
  assert.equal(empty.integration.credentials.figma, true);

  const emptyHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(emptyHtml.body, /id="onboarding"/, "空项目三步卡");
  assert.match(emptyHtml.body, /生成或导入第一份用例/, "② 步文案");
  assert.match(emptyHtml.body, /先去生成\/导入用例 →/, "主 CTA 随状态切换（无份）");
  assert.match(emptyHtml.body, /详细状态（批次 \/ 任务 \/ 执行机 \/ 计划）/, "空区块收敛到详细状态");
  assert.match(emptyHtml.body, /去用例库/, "下发块引导先去用例库");

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
  assert.match(projectHtml.body, /磁盘文件/);
  assert.match(projectHtml.body, /对账信息/);
  assert.match(projectHtml.body, /在跑什么/, "一屏三问");
  assert.ok(!projectHtml.body.includes("c-store-chip"), "顶栏不再有存储状态胶囊");
  assert.ok(!projectHtml.body.includes("最近写入"), "顶栏不再有最近写入");
  assert.match(projectHtml.body, /会话内存|文件台账/, "可持久行仍显示持久层");
  assert.match(projectHtml.body, /&(amp;)?section=dispatch/, "下发入口");
  assert.match(
    projectHtml.body,
    /href="\/panel\?project=[^"]+&amp;section=dispatch"/,
    "主 CTA 携带项目上下文（不再回总站览）"
  );

  assert.equal(
    (await handlePanelRequest(new URL("http://x/panel.json?project=nope"), deps)).status,
    404
  );
});

test("panel web: 新建任务统一走顶部「下一步」卡（无重复空栏）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  await store.recordCaseSet({
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
  assert.match(html.body, /新建任务/);
  assert.match(html.body, /新建任务走下发向导/);
  assert.match(
    html.body,
    /href="\/panel\?project=[^"]+&amp;section=dispatch"/,
    "CTA 携带项目上下文直达向导"
  );
  assert.match(html.body, /当前有 1 份可引用的用例集/);
  assert.doesNotMatch(html.body, /<section id="regression"/, "不再渲染重复的空栏");
  assert.doesNotMatch(html.body, /<h2>新建任务<\/h2>/, "不再出现无内容的黄色标题条");
  assert.doesNotMatch(html.body, /id="regression-form"/, "内嵌表单已移除（派发唯一真相＝向导）");
  assert.doesNotMatch(html.body, /fetch\('\/panel\/api\/tasks'/);
  assert.match(html.body, /<fieldset class="c-fieldset"><legend>端<\/legend>/, "计划表单端组有 legend");
  assert.match(html.body, /aosInlineConfirm\(b,'确认删除该计划？'/, "计划删除走站内确认");
  assert.doesNotMatch(html.body, /[^a-zA-Z_.]confirm\(/, "项目页无原生 confirm 残留");
  assert.match(html.body, /<fieldset class="c-fieldset"><legend>功能（可多选）<\/legend>/, "计划功能复选组（替代多选下拉）");
  assert.match(html.body, /<input type="checkbox" name="featureKeys" value="f-1"[^>]*> 登录流程（2 例）/, "复选含功能名与条数");
  assert.match(html.body, /f\.getAll\('featureKeys'\)/, "提交收集多选值");
  assert.doesNotMatch(html.body, /id="onboarding"/, "有引用份时不显示入门卡");
  assert.match(html.body, /运行：[\s\S]{0,260}?存储：[\s\S]{0,120}?接入：/, "项目页三轴并列（运行／存储／接入）");
  assert.doesNotMatch(html.body, /项目状态：/, "H1 不再夹灯状态（状态进徽章行）");
  assert.match(html.body, /<details class="c-details">/, "环境自查与明细折叠");
  assert.match(html.body, /<summary>环境自查与明细/);
  assert.match(html.body, /aria-current="page"[^>]*>项目</, "项目页高亮「项目」导航");
});

test("panel web: 内联 JS 按首个 | 切分（裁决 items indexOf+slice 形状，无 split）", async () => {
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
  assert.ok(set.id.length > 0);
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
        caseId: "case-1",
        name: "Case 1",
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

  const reviewHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=review`),
    deps
  );
  assert.match(reviewHtml.body, /name="item" value="[^"]+\|case-1"/, "裁决表单 value 仍为 runId|caseId");
  assert.match(reviewHtml.body, /aria-label="选择用例 case-1（Case 1）"/, "行选择含用例上下文可访问名");
  assert.match(reviewHtml.body, /<fieldset class="c-fieldset"><legend>裁决/, "裁决组 fieldset/legend");
  assert.match(reviewHtml.body, /id="verdict-count"/, "批量已选计数");
  assert.match(reviewHtml.body, /data-bulk="all"/, "全选按钮");
  assert.match(reviewHtml.body, /data-bulk="none"/, "清空按钮");
  assert.match(
    reviewHtml.body,
    /map\(function\(el\)\{var idx=el\.value\.indexOf\('\|'\);return \{runId:el\.value\.slice\(0,idx\),caseId:el\.value\.slice\(idx\+1\)\};\}\)/,
    "裁决表单 items 以首个 | 切分（indexOf+slice）"
  );
  assert.match(
    reviewHtml.body,
    /aosBindBulk\('#verdict-form','item','verdict-count'\);/,
    "裁决批量按钮绑定在本页脚本（不再依赖项目页）"
  );
  assert.match(
    reviewHtml.body,
    /parts=\['裁决已提交 '\+payload\.updated\+' 条'\]/,
    "裁决部分失败如实播报（更新/跳过/失败计数）"
  );

  assert.doesNotMatch(reviewHtml.body, /\.value\.split\('\|'\)/, "裁决表单不得残留 split('|')");
});

test("panel web: 页面内联脚本可解析（项目/裁决/任务页，防语法回归）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const task = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs-parse", featureKey: "f-parse" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  for (const suffix of ["", "&view=review", `&task=${task.id}`]) {
    const html = await handlePanelRequest(
      new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}${suffix}`),
      deps
    );
    assert.equal(html.status, 200);
    if (suffix === "") {
      assert.doesNotMatch(html.body, /待领取：待领取/, "活动行不重复状态词");
      assert.match(html.body, /待领取：<a[^>]*><code>/, "活动行链接只显示任务短 id");
      assert.doesNotMatch(html.body, /<caption>最近运行<\/caption>/, "表题不与 h2 重复");
      assert.doesNotMatch(html.body, /<caption>执行机<\/caption>/, "表题不与 h2 重复");
    }
    if (suffix.startsWith("&task=")) {
      assert.doesNotMatch(html.body, /<caption>跨端差异<\/caption>/, "表题不与 h2 重复");
    }
    const label = suffix === "" ? "项目页" : suffix === "&view=review" ? "裁决页" : "任务页";
    const scripts = [...html.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(scripts.length >= 1, `页面含内联脚本（${label}）`);
    for (const code of scripts) {
      assert.doesNotThrow(() => new Function(code), `脚本可解析（${label}）`);
    }
  }
  const overviewHtml = await handlePanelRequest(new URL("http://x/panel"), deps);
  assert.equal(overviewHtml.status, 200);
  const overviewScripts = [...overviewHtml.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]
  );
  assert.ok(overviewScripts.length >= 1, "总览页含内联脚本");
  for (const code of overviewScripts) {
    assert.doesNotThrow(() => new Function(code), "脚本可解析（总览页）");
  }
});

test("panel web: 批次详情（证据缺失占位/失败域）与非法文件名", async () => {
  const { deps, projectDir } = await makeHarness();
  const manifest = makeBatch(projectDir, {
    startedIso: "2026-10-13T09:00:00.000Z",
    traceId: "trace-1",
    exitCode: 1,
    failureDomain: "app-defect",
    ui: { status: "failed", reason: "像素差异" },
    uiSummary: { passed: 0, failed: 1, unverified: 0, notApplicable: 0 }
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
  assert.equal(payload.cases[0].ui.status, "failed");
  assert.deepEqual(payload.ui, { passed: 0, failed: 1, unverified: 0, notApplicable: 0 });
  assert.deepEqual(payload.cases[0].scriptProvenance, { asserts: 4, explores: 1 });
  assert.deepEqual(payload.failureDomains, { "app-defect": 1 });
  const trace = payload.cases[0].evidence.find((link) => link.kind === "trace");
  assert.equal(trace.status, "missing");

  const htmlUrl = new URL(
    `http://x/panel?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(file)}`
  );
  const htmlBody = (await handlePanelRequest(htmlUrl, deps)).body;
  assert.match(htmlBody, /结果概览/);
  assert.doesNotMatch(htmlBody, /归纳分类/, "批次摘要标题直白");
  assert.match(htmlBody, /<th scope="col">UI<\/th>/, "批次用例结果含 UI 列");
  assert.match(htmlBody, /UI 失败 1/, "批次摘要回显 UI 失败计数");
  assert.match(htmlBody, /失败域汇总/);
  assert.match(htmlBody, /已清理/);
  assert.match(htmlBody, /断言 4 \/ 探索 1/);

  fs.mkdirSync(path.join(projectDir, ".artemis", "traces", "trace-1"), { recursive: true });
  const htmlPresent = (await handlePanelRequest(htmlUrl, deps)).body;
  assert.match(htmlPresent, /panel\/artifact\?project=/, "证据路径渲染为可点链接");
  assert.match(htmlPresent, /&amp;path=/, "链接指向产物只读服务");
  assert.doesNotMatch(htmlPresent, /\[已清理\]/, "trace 存量后不再标注已清理");

  const illegal = await handlePanelRequest(
    new URL(`http://x/panel.json?project=demo&batch=${encodeURIComponent("../evil.json")}`),
    deps
  );
  assert.equal(illegal.status, 200);
  assert.equal(JSON.parse(illegal.body).read, "invalid");
});

test("panel web: 设计源警告（项目级快照与批次冻结摘要）", async () => {
  const { deps, projectDir } = await makeHarness();
  const designDirAbs = path.join(projectDir, ".artemis", "design");
  fs.mkdirSync(designDirAbs, { recursive: true });
  fs.writeFileSync(
    path.join(designDirAbs, "tests.json"),
    JSON.stringify({
      designWarnings: [
        { code: "pen-no-interactions", message: "未检测到原型交互" },
        { code: "screenshot-missing", message: "屏幕截图缺失" }
      ]
    }),
    "utf-8"
  );

  const projectJson = JSON.parse(
    (await handlePanelRequest(new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}`), deps)).body
  );
  assert.equal(projectJson.diskAssets.designWarnings.total, 2);
  assert.deepEqual(projectJson.diskAssets.designWarnings.codes, [
    "pen-no-interactions",
    "screenshot-missing"
  ]);
  assert.equal(projectJson.project.designWarnings.total, 2);

  const projectHtml = (
    await handlePanelRequest(new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`), deps)
  ).body;
  assert.match(projectHtml, /设计源警告 2 条（pen-no-interactions、screenshot-missing）/);

  const summary = {
    available: true,
    total: 2,
    byCode: { "pen-no-interactions": 1, "screenshot-missing": 1 },
    codes: ["pen-no-interactions", "screenshot-missing"],
    snapshotAt: "2026-10-13T08:00:00.000Z",
    stale: false
  };
  makeBatch(projectDir, {
    startedIso: "2026-10-13T09:00:00.000Z",
    traceId: "trace-warn",
    designWarningSummary: summary
  });
  makeBatch(projectDir, { startedIso: "2026-10-13T10:00:00.000Z", traceId: "trace-plain" });
  const files = fs
    .readdirSync(path.join(designDirAbs, "runs"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.equal(files.length, 2);

  const batchJson = JSON.parse(
    (await handlePanelRequest(
      new URL(
        `http://x/panel.json?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(files[0])}`
      ),
      deps
    )).body
  );
  assert.deepEqual(batchJson.designWarnings, summary);

  const batchHtml = (
    await handlePanelRequest(
      new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(files[0])}`),
      deps
    )
  ).body;
  assert.match(batchHtml, /设计源警告 2 条（pen-no-interactions、screenshot-missing）/);

  const plainJson = JSON.parse(
    (await handlePanelRequest(
      new URL(
        `http://x/panel.json?project=${encodeURIComponent(projectDir)}&batch=${encodeURIComponent(files[1])}`
      ),
      deps
    )).body
  );
  assert.equal(plainJson.designWarnings, null, "无摘要 → null，不折算成 0 条");
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
  assert.match(html.body, /运行时细节/);
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

test("panel web: 任务视图（状态/设备运行/指引）与未知 task 404", async () => {
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
  makeBatch(projectDir, {
    startedIso: "2026-10-14T10:00:00.000Z",
    traceId: "trace-task",
    exitCode: 1,
    ui: { status: "failed", reason: "像素差异" },
    uiSummary: { passed: 0, failed: 1, unverified: 0, notApplicable: 0 }
  });
  const manifestPath = path.join(
    projectDir,
    ".artemis",
    "design",
    "runs",
    fs.readdirSync(path.join(projectDir, ".artemis", "design", "runs")).find((name) => name.endsWith(".json"))
  );
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
      manifestPath,
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
  const taskJson = JSON.parse(
    (
      await handlePanelRequest(
        new URL(
          `http://x/panel.json?project=${encodeURIComponent(projectDir)}&task=${encodeURIComponent(task.id)}`
        ),
        deps
      )
    ).body
  );
  assert.deepEqual(taskJson.runs[0].ui, { passed: 0, failed: 1, unverified: 0, notApplicable: 0 });
  assert.match(html.body, /<th scope="col">UI<\/th>/, "设备运行表含 UI 列");
  assert.match(html.body, /UI 失败 1/, "设备运行回显 UI 失败计数");
  assert.match(html.body, /<h1>任务 <code>/);
  assert.match(html.body, /partial/);
  assert.match(html.body, /登录流程/);
  assert.match(html.body, /emulator-5554/);
  assert.match(html.body, new RegExp(`suite run --task ${task.id}`));
  assert.match(html.body, /c-badge-warning/, "状态语义徽章");
  assert.match(html.body, />重新派发</, "非运行态可重新派发");
  assert.doesNotMatch(html.body, />停止执行</, "非运行态无停止动作");

  const pending = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: set.id, featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  const pendingHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}`),
    deps
  );
  assert.match(pendingHtml.body, /等待执行机领取/, "pending 无释放动作（等待领取）");
  assert.match(pendingHtml.body, /panel\/api\/tasks\/stop/, "动作脚本覆盖三入口");
  assert.doesNotMatch(pendingHtml.body, />释放回队列</, "pending 不渲染释放按钮");
  assert.match(pendingHtml.body, /data-task-action="cancel"/, "pending 可取消");
  assert.match(pendingHtml.body, /id="task-cancel-note"/, "取消备注输入");
  assert.match(
    pendingHtml.body,
    /note:action==='cancel'&&noteEl\?noteEl\.value:undefined/,
    "取消提交携带可选备注"
  );

  await store.updateRegressionTask(projectDir, pending.id, {
    status: "claimed",
    claimedBy: "runner-1",
    claimedAt: "2026-10-18T00:00:00.000Z"
  });
  const claimedHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}`),
    deps
  );
  assert.match(claimedHtml.body, />停止执行</, "运行中提供停止执行");
  assert.match(claimedHtml.body, /data-task-action="cancel"/, "claimed 提供取消");
  assert.match(claimedHtml.body, /id="task-cancel-note"/, "claimed 取消备注输入");
  assert.match(claimedHtml.body, /运行中可直接释放回队列/, "运行中释放指引");
  assert.match(claimedHtml.body, /data-confirm="确认停止该任务？领取方：runner-1/, "停止确认含领取方与后果");
  assert.match(claimedHtml.body, /aosInlineConfirm\(b,/, "三动作走站内确认（去原生 confirm）");
  assert.match(claimedHtml.body, /window\.aosBindTaskActions=/, "动作绑定可被刷新重绑（P1 修复）");
  assert.match(claimedHtml.body, /aosOnRefresh=function/, "注册刷新钩子");
  assert.match(claimedHtml.body, /data-aos-bound/, "重复绑定守卫");
  assert.doesNotMatch(claimedHtml.body, /[^a-zA-Z_.]confirm\(/, "无原生 confirm 残留");
  assert.match(claimedHtml.body, /id="task-action-status"[^>]*role="status"/, "动作失败内联回报");

  await store.updateRegressionTask(projectDir, pending.id, { status: "running" });
  const runningHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}`),
    deps
  );
  assert.match(runningHtml.body, /data-task-action="cancel"/, "running 提供取消");
  assert.match(runningHtml.body, /id="task-cancel-note"/, "running 取消备注输入");

  await store.updateRegressionTask(projectDir, pending.id, { status: "stopping" });
  const stoppingHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}`),
    deps
  );
  assert.match(stoppingHtml.body, /停止中/, "stopping 徽章");
  assert.match(stoppingHtml.body, /data-task-action="cancel"/, "stopping 仍可重复取消（幂等）");
  assert.match(stoppingHtml.body, /id="task-cancel-note"/, "stopping 取消备注输入");
  assert.match(stoppingHtml.body, /等待执行机确认/, "ack 指引（离线时为下次心跳读取）");
  assert.doesNotMatch(stoppingHtml.body, /data-task-action="release"/, "确认前不可释放");
  assert.doesNotMatch(stoppingHtml.body, /data-task-action="rerun"/, "确认前不可重派");
  await store.updateRegressionTask(projectDir, pending.id, {
    status: "pending",
    claimedBy: null,
    claimedAt: null
  });

  const projectAfter = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectAfter.body, new RegExp(`待领取：[\\s\\S]{0,300}task=${pending.id}`), "在跑什么/待领取可点对象");
  assert.match(projectAfter.body, /执行中：|待领取：/, "活动行渲染");

  const flashHtml = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}&dispatched=${pending.id}`
    ),
    deps
  );
  assert.match(flashHtml.body, /已派发任务/, "派发回执");
  assert.match(flashHtml.body, /section=audit/, "回执链接审计");

  const gatedDeps = {
    ...deps,
    capabilities: { actions: false, usage: false, mode: "standalone" }
  };
  const gatedHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pending.id}`),
    gatedDeps
  );
  assert.match(gatedHtml.body, /只读模式/, "能力关闭时释放给可见原因");

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
  assert.match(missing.contentType, /text\/html/, "HTML 路由 404 出站内错误页");
  assert.match(missing.body, /← 多项目总览/, "错误页给返回入口");

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
  assert.match(html.body, /失败分析/);
  assert.match(html.body, /失败处理路径/, "结果页按失败处理旅程组织");
  assert.match(html.body, /发现 → 证据 → 裁决 → 修用例\/建单 → 复跑/);
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
  assert.match(projectHtml.body, /view=review/, "项目页有失败分析入口");
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
  assert.match(html.body, /统计/);
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

test("panel web: 项目页 runner 区块（在线灯/设备 chips/工具徽标）+ 含表单页不整页刷新", async () => {
  const { deps, projectDir, store } = await makeHarness();
  await store.upsertRunner({
    rootPath: projectDir,
    name: "r-1",
    hostname: "mac-1",
    hostId: "h-1",
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    artifactBaseUrl: "http://mac-1:8770"
  });
  const fleetTask = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs-fleet", featureKey: "f-fleet" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.acquireDeviceLeases({
    hostId: "h-1",
    taskId: fleetTask.id,
    projectId: "p-fleet",
    serials: ["emulator-5554"]
  });
  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /执行机/);
  assert.match(html.body, /c-badge-success/, "在线徽章");
  assert.match(html.body, /在线/);
  assert.match(html.body, /emulator-5554/);
  assert.match(html.body, /adb ✓/);
  assert.match(html.body, /appium ✗/);
  assert.match(html.body, /http:\/\/mac-1:8770/);
  assert.match(html.body, /设备容量/);
  assert.match(html.body, /任务队列/);
  assert.match(html.body, /设备租约/);
  assert.match(html.body, /有效/, "租约状态");
  assert.doesNotMatch(html.body, /http-equiv="refresh"/, "含表单项目页不整页刷新（修复 I4）");

  const fleetJson = JSON.parse(
    (
      await handlePanelRequest(
        new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}`),
        deps
      )
    ).body
  );
  assert.deepEqual(fleetJson.fleet.runners, { online: 1, offline: 0 });
  assert.deepEqual(fleetJson.fleet.devices, { total: 1, ios: 0, android: 1, busy: 1 });
  assert.equal(fleetJson.fleet.queue.pending, 1);
  assert.equal(fleetJson.fleet.leases.length, 1);
  assert.equal(fleetJson.fleet.leases[0].taskId, fleetTask.id);

  const clean = await makeHarness();
  const cleanHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(clean.projectDir)}`),
    clean.deps
  );
  assert.match(cleanHtml.body, /暂无执行机心跳/);
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
    platforms: ["android"],
    capabilities: ["android"]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${claimedTask.id}`),
    deps
  );
  assert.match(html.body, /已领取/);
  assert.match(html.body, /「r-1」（在线）/);
  assert.match(html.body, /DOMParser/, "活动任务页走局部轮询（console-main 就地替换）");
  assert.ok(!html.body.includes('http-equiv="refresh"'), "不再整页刷新");
  assert.match(html.body, /在线执行机会自动领取执行/);
  assert.doesNotMatch(html.body, /无在线执行机完整覆盖/);

  const pendingTask = await store.createRegressionTask(taskInput(["ios"]));
  const pendingHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${pendingTask.id}`),
    deps
  );
  assert.match(pendingHtml.body, /无在线执行机完整覆盖/, "pending 且无端覆盖 → 提示");

  await store.updateRegressionTask(projectDir, claimedTask.id, { status: "completed" });
  const doneHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${claimedTask.id}`),
    deps
  );
  assert.match(doneHtml.body, /已完成/);
  assert.doesNotMatch(doneHtml.body, /DOMParser/, "终态不轮询");
});

test("panel web: 产物链接（任务页/失败分析；无 runner → 纯路径）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const caseSetsDir = path.join(projectDir, ".artemis", "design", "case-sets");
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
        jsonPath: path.join(caseSetsDir, "x.json"),
        mdPath: path.join(caseSetsDir, "x.md"),
        xlsxPath: path.join(caseSetsDir, "x.xlsx")
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
      runner: null,
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
      manifestPath: path.join(projectDir, ".artemis", "design", "runs", "run-1.json"),
      comparison: null
    },
    cases: [
      {
        caseId: "case-1",
        name: "Case 1",
        featureKey: "f-1",
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
      }
    ]
  });

  const bareHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${task.id}`),
    deps
  );
  assert.doesNotMatch(bareHtml.body, /\/artifact\//, "无 runner → 纯路径");
  const bareReview = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=review`),
    deps
  );
  assert.doesNotMatch(bareReview.body, /打开证据/);

  const runner = await store.upsertRunner({
    rootPath: projectDir,
    name: "r-1",
    hostname: "mac-1",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false },
    artifactBaseUrl: "http://mac-1:8770"
  });
  await store.claimRegressionTask({
    rootPath: projectDir,
    runnerId: runner.id,
    platforms: ["android"],
    capabilities: ["android"]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${task.id}`),
    deps
  );
  assert.match(html.body, /href="http:\/\/mac-1:8770\/artifact\/design\/runs\/run-1\.json"/);
  assert.match(html.body, /href="http:\/\/mac-1:8770\/artifact\/design\/case-sets\/x\.json"/);
  assert.match(html.body, />xlsx<\/a>/);

  const review = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=review`),
    deps
  );
  assert.match(review.body, /打开证据/);
  assert.match(review.body, /href="http:\/\/mac-1:8770\/artifact\/traces\/trace-1"/);
});

test("panel web: 任务页显示重试次数（attempts > 1）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const task = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.claimRegressionTask({
    rootPath: projectDir,
    runnerId: "r-x",
    hostId: "h-x",
    instanceId: "i-x",
    platforms: ["android"],
    capabilities: ["android"]
  });
  await store.beginExecution({
    rootPath: projectDir,
    taskId: task.id,
    runnerId: "r-x",
    instanceId: "i-x"
  });
  await store.releaseRegressionTask({
    rootPath: projectDir,
    runnerId: "r-x",
    taskId: task.id
  });
  await store.claimRegressionTask({
    rootPath: projectDir,
    runnerId: "r-x",
    hostId: "h-x",
    instanceId: "i-x",
    platforms: ["android"],
    capabilities: ["android"]
  });
  await store.beginExecution({
    rootPath: projectDir,
    taskId: task.id,
    runnerId: "r-x",
    instanceId: "i-x"
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${task.id}`),
    deps
  );
  assert.match(html.body, /已尝试 2 次/);
  assert.match(html.body, /执行中/);
});

test("panel web: 定时回归区块 + 任务页来源显示", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const schedule = await store.createSchedule({
    rootPath: projectDir,
    name: "夜间回归",
    featureKeys: ["f-1", "f-2"],
    platforms: ["android", "ios"],
    baseline: "latest",
    everyMinutes: 720,
    createdBy: "cli"
  });
  await store.updateSchedule(projectDir, schedule.id, { lastNote: "缺 f-2" });
  const task = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "schedule:夜间回归"
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(html.body, /定时任务/);
  assert.match(html.body, /夜间回归/);
  assert.match(html.body, /每 720 分钟/);
  assert.match(html.body, /启用/);
  assert.match(html.body, /缺 f-2/);
  assert.match(html.body, new RegExp(`task=${task.id}`), "最近任务链接");
  assert.match(html.body, /id="schedule-form"/, "计划创建表单");
  assert.match(html.body, /panel\/api\/schedules/, "控制台动作端点");
  assert.match(html.body, new RegExp(`data-op="disable"[^>]*>停用|data-schedule="${schedule.id}"[^>]*data-op="disable"`));

  const gatedSchedule = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    { ...deps, capabilities: { actions: false, usage: false, mode: "standalone" } }
  );
  assert.match(gatedSchedule.body, /只读模式/, "能力关闭时计划动作给原因");
  assert.ok(!gatedSchedule.body.includes("panel/api/schedules"), "关闭时不渲染动作脚本");

  const taskHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${task.id}`),
    deps
  );
  assert.match(
    taskHtml.body,
    /来源 <span title="schedule:夜间回归">定时计划（夜间回归）<\/span>/,
    "任务来源中文化（title 保留原文）"
  );
  assert.match(taskHtml.body, /待执行/);

  const clean = await makeHarness();
  const cleanHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(clean.projectDir)}`),
    clean.deps
  );
  assert.match(cleanHtml.body, /暂无定时任务/);
});

function makeStatsRun({
  caseSetId = "cs-1",
  featureKey = "f-1",
  featureName = "登录流程",
  platform = "android",
  device = "emulator-5554",
  startedIso = "2026-10-14T10:00:00.000Z",
  total = 1
} = {}) {
  return {
    trigger: "cli",
    regressionTaskId: null,
    caseSetId,
    featureKey,
    featureName,
    platform,
    device,
    appVersion: null,
    status: "failed",
    startedAt: startedIso,
    finishedAt: startedIso,
    total,
    passed: 0,
    failed: total,
    flaky: 0,
    quarantined: 0,
    failureDomains: {},
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null
  };
}

function makeStatsCase({
  caseId,
  name = caseId,
  featureKey = "f-1",
  platform = "android",
  status = "failed",
  verdict = null,
  verdictBy = null,
  verdictAt = null,
  verdictNote = null,
  failureDomain = null
}) {
  return {
    caseId,
    name,
    featureKey,
    platform,
    status,
    traceId: null,
    failureDomain,
    failureConfidence: null,
    failureReason: null,
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict,
    verdictBy,
    verdictAt,
    verdictNote
  };
}

test("panel web: stats 环境清单表（设备/端/次数/功能/最近/备注；null 设备与空态）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: makeStatsRun({ total: 2 }),
    cases: [
      makeStatsCase({
        caseId: "case-1",
        name: "Case 1",
        failureDomain: "环境",
        verdict: "execution-deviation",
        verdictBy: "alice",
        verdictAt: "2026-10-14T12:00:00.000Z",
        verdictNote: "设备离线"
      }),
      makeStatsCase({
        caseId: "case-2",
        name: "Case 2",
        failureDomain: "环境",
        verdict: "execution-deviation",
        verdictBy: "alice",
        verdictAt: "2026-10-14T12:30:00.000Z",
        verdictNote: "网络抖动"
      })
    ]
  });
  const longNote = "长".repeat(130);
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T11:05:00.000Z",
    run: makeStatsRun({
      caseSetId: "cs-2",
      featureKey: "f-2",
      featureName: "设置",
      platform: "ios",
      device: null,
      startedIso: "2026-10-14T11:00:00.000Z"
    }),
    cases: [
      makeStatsCase({
        caseId: "case-3",
        name: "Case 3",
        featureKey: "f-2",
        platform: "ios",
        failureDomain: "环境",
        verdict: "execution-deviation",
        verdictBy: "bob",
        verdictAt: "2026-10-14T13:00:00.000Z",
        verdictNote: longNote
      })
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(
    html.body,
    /<th scope="col">设备<\/th><th scope="col">端<\/th><th scope="col">次数<\/th><th scope="col">涉及功能<\/th><th scope="col">最近裁决<\/th><th scope="col">备注摘要<\/th>/
  );
  assert.match(
    html.body,
    /<tr><td>emulator-5554<\/td><td>android<\/td><td>2<\/td><td>登录流程<\/td><td><time datetime="2026-10-14T12:30:00\.000Z"[^>]*>[^<]*<\/time><\/td><td>设备离线；网络抖动<\/td><\/tr>/,
    "环境行：设备/端/次数/功能/最近裁决（组内最大；相对时间）／备注（；连接）"
  );
  assert.match(
    html.body,
    /<tr><td>—<\/td><td>ios<\/td><td>1<\/td><td>设置<\/td><td><time datetime="2026-10-14T13:00:00\.000Z"[^>]*>[^<]*<\/time><\/td>/,
    "设备 null → —"
  );
  assert.ok(html.body.includes(`${longNote.slice(0, 120)}…`), "备注摘要截断 ~120 字");
  assert.ok(!html.body.includes(longNote), "超长备注不原样输出");

  const clean = await makeHarness();
  const emptyHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(clean.projectDir)}&view=stats`),
    clean.deps
  );
  assert.match(emptyHtml.body, /无执行偏差裁决/, "空态");
  assert.doesNotMatch(emptyHtml.body, /id="issues-form"/, "无应用缺陷 → 不渲染建单表单");
});

test("panel web: 归因→建单断链接上（CTA＋锚点＋项目导航当前态）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const run = await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: makeStatsRun({}),
    cases: [
      makeStatsCase({
        caseId: "case-app",
        name: "崩溃用例",
        failureDomain: "应用缺陷",
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T12:30:00.000Z"
      })
    ]
  });
  assert.ok(run.id);

  const review = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=review`),
    deps
  );
  assert.equal(review.status, 200);
  assert.match(review.body, /下一步：去建单（应用缺陷 1 条）→/, "归因页就地给建单出口");
  assert.match(review.body, /view=stats/, "CTA 指统计页");
  assert.match(review.body, /#issues/, "锚点直达建单块");
  assert.match(review.body, /aria-current="page"[^>]*>结果</, "review 高亮「结果」导航");
  assert.match(review.body, /<th scope="col">运行<\/th><th scope="col">时间<\/th>/, "行身份二列（运行短 id＋失败时间）");

  const stats = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`),
    deps
  );
  assert.match(stats.body, /<h3 id="issues">/, "统计页建单块锚点");
  assert.match(stats.body, /aria-current="page"[^>]*>结果</, "stats 高亮「结果」导航（同组合并）");

  const projectHtml = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectHtml.body, /未建单缺陷 1 项/, "项目 pulse 暴露失败路径数字");
  assert.match(projectHtml.body, /href="[^"]*view=review"/, "归因入口可点");

  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-15T10:05:00.000Z",
    run: makeStatsRun({}),
    cases: [
      makeStatsCase({
        caseId: "case-open",
        name: "待裁决用例",
        failureDomain: "用例缺陷",
        verdict: null
      })
    ]
  });
  const projectWithQueue = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.match(projectWithQueue.body, /先去裁决 1 条 →/, "主 CTA 随未裁决数切换");
});

test("panel web: stats 应用缺陷建单 UI（checkbox/已建单 chip/表单/JS/指引行）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const run = await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: makeStatsRun({}),
    cases: [
      makeStatsCase({
        caseId: "case-app",
        name: "崩溃用例",
        failureDomain: "应用缺陷",
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T12:30:00.000Z"
      }),
      makeStatsCase({
        caseId: "case-def",
        name: "期望写错",
        failureDomain: "用例缺陷",
        verdict: "case-defect",
        verdictBy: "alice",
        verdictAt: "2026-10-14T12:00:00.000Z"
      })
    ]
  });
  await store.setCaseIssueKey({
    rootPath: projectDir,
    runId: run.id,
    caseId: "case-app",
    jiraKey: "REGR-42"
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /应用缺陷 → 建单（Jira）/);
  assert.match(html.body, new RegExp(`name="issue-item" value="${run.id}\\|case-app"`), "复选框 value＝runId|caseId");
  assert.match(html.body, /<span class="chip">REGR-42<\/span>/, "已建单 chip（纯文本 KEY）");
  assert.doesNotMatch(html.body, /href="[^"]*REGR-42"/, "面板无 Jira 站点来源 → chip 不做链接");
  assert.match(html.body, /name="projectKey"/);
  assert.match(html.body, /placeholder="默认 JIRA_ISSUE_PROJECT"/);
  assert.match(html.body, /name="issueType"/);
  assert.match(html.body, /placeholder="默认 Bug"/);
  assert.match(html.body, /服务端签发预览回执/, "建单强制预览闸门（服务端回执）");
  assert.match(html.body, /\/panel\/api\/issues\/evidence/, "证据重试接线");
  assert.match(html.body, /data-evidence-retry/, "失败项重试按钮（动态渲染）");
  assert.match(html.body, /重试附件/, "重试按钮文案");
  assert.match(html.body, /建单（外部副作用）/, "按钮明示外部副作用");
  assert.match(html.body, /id="issues-count"/, "建单批量已选计数");
  assert.match(html.body, /bulk-tools/, "批量工具栏");
  assert.match(html.body, /name="labels"/);
  assert.match(html.body, /placeholder="逗号分隔"/);
  assert.match(html.body, />预览</);
  assert.match(html.body, />建单（外部副作用）</);
  assert.match(html.body, /id="issues-result"/);
  const formOpen = html.body.indexOf('<form id="issues-form"');
  const formClose = html.body.indexOf("</form>", formOpen);
  const formHtml = html.body.slice(formOpen, formClose);
  assert.ok(formOpen >= 0 && formClose > formOpen, "issues-form 开/闭标签存在");
  assert.match(
    formHtml,
    /name="issue-item" value="[^"]*case-app"/,
    "checkbox 位于 issues-form 作用域内（否则 form.querySelectorAll 采集为空）"
  );
  assert.match(formHtml, /name="projectKey"/, "表单字段位于 issues-form 内");
  assert.match(formHtml, /id="issues-result"/, "结果容器位于 issues-form 内");
  assert.match(html.body, /id="issues-preview"/, "预览按钮");
  assert.match(html.body, /id="issues-create"[^>]*disabled/, "建单默认禁用（须先预览）");
  assert.match(html.body, /id="issues-stale"/, "预览失效横幅");
  assert.match(html.body, /fetch\('\/panel\/api\/issues'/);
  assert.match(html.body, /if\(previewId!==null\)data\.previewId=previewId;/, "建单携带服务端预览回执");
  assert.match(html.body, /previewId=res\.j\.previewId/, "预览回执取自服务端响应");
  assert.doesNotMatch(html.body, /__aosIssuesPreviewed/, "布尔闸门已移除");
  assert.doesNotMatch(html.body, /location\.reload\(\)/, "成功后保留结果面板（不再 reload）");
  assert.match(html.body, /重新生成时响应与 tests\.md 会附上轮案例问题提示/, "案例问题指引行更新");
  assert.doesNotMatch(html.body, /后续接线/, "移除「自动化（P3）…后续接线」指引行");
  const statsScripts = [...html.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1]
  );
  for (const code of statsScripts) {
    assert.doesNotThrow(() => new Function(code), "stats 页脚本可解析");
  }
});

test("panel web: Jira 未配置前置拦截（不渲染预览/建单，给配置指引）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const run = await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: makeStatsRun({}),
    cases: [
      makeStatsCase({
        caseId: "case-app",
        name: "崩溃用例",
        failureDomain: "应用缺陷",
        verdict: "app-defect",
        verdictBy: "bob",
        verdictAt: "2026-10-14T12:30:00.000Z"
      })
    ]
  });
  assert.ok(run.id);
  const url = new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`);

  const gated = await handlePanelRequest(url, { ...deps, env: { JIRA_ISSUE_PROJECT: "AOS" } });
  assert.equal(gated.status, 200);
  assert.match(gated.body, /未检测到 Jira 凭据/, "未配置前置指引");
  assert.doesNotMatch(gated.body, /id="issues-preview"/, "不渲染预览（前置拦截）");
  assert.doesNotMatch(gated.body, /id="issues-create"/, "不渲染建单");
  assert.match(gated.body, /JIRA_BASE_URL/, "指引含配置项");

  const ready = await handlePanelRequest(url, {
    ...deps,
    env: { JIRA_BASE_URL: "https://x.atlassian.net", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "tok" }
  });
  assert.match(ready.body, /id="issues-preview"/, "凭据齐备时可用");
});

test("panel web: stats 建单 UI HTML 转义（名称/复选框 value 注入不裸出）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  const run = await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: makeStatsRun({}),
    cases: [
      makeStatsCase({
        caseId: 'ca"se',
        name: '"><script>alert(1)</script>',
        failureDomain: "应用缺陷",
        verdict: "app-defect",
        verdictAt: "2026-10-14T12:30:00.000Z"
      })
    ]
  });

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&view=stats`),
    deps
  );
  assert.doesNotMatch(html.body, /<script>alert\(1\)<\/script>/, "名称不裸出脚本标签");
  assert.match(html.body, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html.body, new RegExp(`name="issue-item" value="${run.id}\\|ca&quot;se"`), "复选框 value 转义引号");
});

function makeCompareRun({
  finishedIso = "2026-10-14T10:00:00.000Z",
  total = 4,
  passed = 4,
  flaky = 0,
  failureDomains = {},
  gateResult = "pass",
  caseSetId = null,
  featureKey = "f-1",
  featureName = "登录流程"
} = {}) {
  return {
    trigger: "cli",
    regressionTaskId: null,
    caseSetId,
    featureKey,
    featureName,
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    status: "completed",
    startedAt: finishedIso,
    finishedAt: finishedIso,
    total,
    passed,
    failed: Math.max(0, total - passed),
    flaky,
    quarantined: 0,
    failureDomains,
    gateResult,
    exitCode: gateResult === "pass" ? 0 : 1,
    manifestPath: null,
    comparison: null
  };
}

test("panel web: compare 口径说明行与列组（迷你图/域 chips/待办/运行）", async () => {
  const { deps, projectDir, store } = await makeHarness();

  const emptyHtml = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(emptyHtml.status, 200);
  assert.match(emptyHtml.body, /多项目对比/, "页头标题");
  assert.match(emptyHtml.body, /口径：窗口＝用例集最近 20 批/, "窗口口径");
  assert.match(emptyHtml.body, /任务积压为最近 200 条近似/, "任务积压近似口径");
  assert.match(emptyHtml.body, /执行机为最近 100 条近似/, "执行机近似口径");
  assert.match(emptyHtml.body, /数据源＝中央台账/, "数据源口径");
  assert.match(emptyHtml.body, /精确待办以失败分析为准/, "精确待办口径");
  assert.match(emptyHtml.body, /无用例集来源批次/, "无用例集来源批次 ≠ 读取失败");
  assert.match(emptyHtml.body, /看项目页/, "空态给项目页跳转（其余来源）");
  assert.doesNotMatch(emptyHtml.body, /读取失败/, "无 error 不出现降级标注");

  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: makeCompareRun({
      finishedIso: "2026-10-14T10:00:00.000Z",
      passed: 2,
      flaky: 2,
      failureDomains: { 应用缺陷: 2, 环境: 1 }
    }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T11:00:00.000Z",
    run: makeCompareRun({ finishedIso: "2026-10-14T11:00:00.000Z", passed: 3 }),
    cases: []
  });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T12:00:00.000Z",
    run: makeCompareRun({
      finishedIso: "2026-10-14T12:00:00.000Z",
      passed: 1,
      flaky: 1,
      gateResult: "fail",
      failureDomains: { 应用缺陷: 1 }
    }),
    cases: []
  });

  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /最近用例集批次（时间·门禁·通过率）/, "列组标记：最近用例集批次");
  assert.match(html.body, /仅计入「用例集」来源批次/, "口径显式声明来源范围");
  assert.match(html.body, /趋势（最近 10 批）/, "列组标记：趋势");
  assert.match(html.body, /质量（flaky·失败域 top3）/, "列组标记：质量");
  assert.match(html.body, /待办（未裁决·未建单·积压·failed）/, "列组标记：待办");
  assert.match(html.body, /执行（执行机·定时任务）/, "列组标记：执行");
  assert.doesNotMatch(html.body, /待办\(待\/领\/跑\/败\)/, "替换 T2 最小表格列");

  assert.match(
    html.body,
    /<div class="muted"><time datetime="2026-10-14T12:00:00\.000Z"[^>]*>[^<]*<\/time><\/div>/,
    "最近份批次时间（相对＋title 绝对）"
  );
  assert.match(html.body, /<span class="gate-fail">未通过<\/span> · 25%/, "门禁与通过率");
  assert.match(
    html.body,
    /<svg class="spark"[^>]*><polyline points="0,12 50,7 100,17"><\/polyline><\/svg>/,
    "内联 SVG 迷你图（三点：50%/75%/25%）"
  );
  assert.match(html.body, /flaky 3/, "flaky 为窗口内累加");
  assert.match(html.body, /<span class="chip" title="应用缺陷">应用缺陷 × 3<\/span>/, "失败域 top3 chips（中文＋title 原文）");
  assert.match(html.body, /<span class="chip" title="环境">环境 × 1<\/span>/, "失败域 chips 带 title 原文");
  assert.match(html.body, /未裁决失败 0 条 · 未建单缺陷 0 项/, "待办：未裁决/未建单");
  assert.match(html.body, /任务积压 0（待 0 \/ 领 0 \/ 跑 0） · 失败 0/, "待办：积压 p+c+r / 失败数");
  assert.match(html.body, /执行机 在线 0 · 设备 0/, "运行：执行机");
  assert.match(html.body, /定时任务 启用 0 · 最近触发 —/, "运行：定时回归");
});

test("panel web: trendPassRateSvg 纯函数（钳制 0–100/断点/≤10 点/空）", () => {
  assert.equal(trendPassRateSvg([]), "", "无点 → 空串");
  assert.equal(trendPassRateSvg([{ at: null, passRate: null }]), "", "全 null → 空串");
  assert.equal(trendPassRateSvg([{ at: null, passRate: Number.NaN }]), "", "NaN 视同缺数");

  const clamped = trendPassRateSvg([
    { at: null, passRate: 2 },
    { at: null, passRate: -1 }
  ]);
  assert.match(clamped, /^<svg class="spark"[^>]*>/, "根元素为 svg.spark");
  assert.match(clamped, /<polyline points="0,2 100,22"><\/polyline>/, "数值钳制 0–100（y 落在 2–22）");

  const broken = trendPassRateSvg([
    { at: null, passRate: 1 },
    { at: null, passRate: null },
    { at: null, passRate: 0.5 },
    { at: null, passRate: 0.5 }
  ]);
  assert.match(broken, /<circle cx="0" cy="2" r="1.5"><\/circle>/, "孤立点画圆");
  assert.match(broken, /<polyline points="66.67,12 100,12"><\/polyline>/, "null 点断开两段");
  assert.equal((broken.match(/<polyline/g) ?? []).length, 1, "断点不跨 null 连线");

  const many = trendPassRateSvg(
    Array.from({ length: 12 }, () => ({ at: null, passRate: 0.5 }))
  );
  const points = /<polyline points="([^"]+)"/.exec(many);
  assert.ok(points, "多点 → polyline");
  assert.equal(points[1].split(" ").length, 10, "仅取最近 10 点");
});

test("panel web: compare 降级行（读取失败标注 + 其余列 —）", async () => {
  const { deps, store } = await makeHarness();
  const throwing = new Proxy(store, {
    get(target, prop) {
      if (prop === "listSuiteRuns") {
        return async () => {
          throw new Error("boom <&>");
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), {
    ...deps,
    store: throwing
  });
  assert.equal(html.status, 200);
  assert.match(html.body, /读取失败：boom &lt;&amp;&gt;/, "行内可见标注且转义");

  const rowChunk = html.body.split("<tr>").find((chunk) => chunk.includes("读取失败"));
  assert.ok(rowChunk, "降级行存在");
  const cells = [...rowChunk.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((match) => match[1]);
  assert.equal(cells.length, 7, "七个列组");
  assert.match(cells[1], /未归属主机/, "降级行仍显示主机列");
  assert.deepEqual(
    cells.slice(2),
    Array(5).fill('<span class="muted">—</span>'),
    "error 行其余数据列全部 —"
  );
});

test("panel web: 下发向导（?section=dispatch 只读预览）与 JSON 形状", async () => {
  const { deps, projectDir } = await makeHarness();
  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&section=dispatch&source=case-set`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /下发回归/);
  assert.match(html.body, /③ 预览回显/);
  assert.match(html.body, /id="dispatch-submit"/, "确认派发可操作（动作层已接线）");
  assert.match(html.body, /panel\/api\/tasks/);
  assert.ok(!html.body.includes('http-equiv="refresh"'), "表单页不自动刷新");

  const json = await handlePanelRequest(
    new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}&section=dispatch`),
    deps
  );
  assert.equal(json.status, 200);
  const payload = JSON.parse(json.body);
  assert.equal(payload.view, "dispatch");
  assert.ok(Array.isArray(payload.setOptions));
});

test("panel web: compare 空态（无项目）", async () => {
  const store = new MemoryStore();
  const deps = { store, env: {}, serviceRepo: makeReadyRepo(), buildStale: false };
  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /暂无项目/, "空态提示");
  assert.match(html.body, /c-empty-cell" colspan="7">暂无项目/, "空态占位行（colspan=7，无数据行）");
});

test("panel web: compare 与总览互链；项目名链接项目页", async () => {
  const { deps, projectDir } = await makeHarness();

  const overview = await handlePanelRequest(new URL("http://x/panel"), deps);
  assert.match(
    overview.body,
    /<a href="\/panel\?view=compare">多项目对比<\/a>/,
    "L1 页头「多项目对比」链接"
  );

  const compare = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.match(compare.body, /<a href="\/panel">← 多项目总览<\/a>/, "对比页回链 L1");
  assert.ok(
    compare.body.includes(
      `<a href="/panel?project=${encodeURIComponent(projectDir)}"><code>demo</code></a>`
    ),
    "项目名链接项目页"
  );
});

test("panel web: compare HTML 转义（项目名/失败域注入不裸出）", async () => {
  const store = new MemoryStore();
  const workspace = makeTempDir("aos-panel-web-compare-xss-");
  const projectDir = path.join(workspace, "xss");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  await store.upsertProject({ rootPath: projectDir, name: '"><script>alert(1)</script>' });
  await store.recordSuiteRun({
    rootPath: projectDir,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: makeCompareRun({ failureDomains: { '"><img src=x onerror=alert(1)>': 1 } }),
    cases: []
  });

  const deps = {
    store,
    env: {},
    workspaceRoot: workspace,
    serviceRepo: makeReadyRepo(),
    buildStale: false
  };
  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.doesNotMatch(html.body, /<script>alert\(1\)<\/script>/, "项目名不裸出脚本标签");
  assert.doesNotMatch(html.body, /<img src=x/, "失败域不裸出标签");
  assert.match(html.body, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("panel web: compare 功能对齐通过率收敛到 ≤100%（异常 passRate 钳制）", async () => {
  const { deps } = await makeAlignedProjects({ passed: 8, total: 4 });
  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.doesNotMatch(html.body, /200%/, "对齐表通过率不超 100%");
  assert.match(html.body, /100%/, "钳制后显示 100%");
});

async function makeAlignedProjects({ source = "figma:KEY", featureName = "登录流程", passed = 2, total = 4, flaky = 0, passedB, totalB, flakyB } = {}) {
  const store = new MemoryStore();
  const workspace = makeTempDir("aos-panel-web-align-");
  const repo = makeReadyRepo();
  const project = async (name, metrics) => {
    const dir = path.join(workspace, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
    fs.writeFileSync(path.join(dir, ".env"), COMPLETE_DOTENV, "utf-8");
    await store.upsertProject({ rootPath: dir, name });
    const set = await store.recordCaseSet({
      rootPath: dir,
      source,
      basename: "tests",
      features: [
        { key: "f-1", name: featureName, caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
      ]
    });
    await store.recordSuiteRun({
      rootPath: dir,
      createdAt: "2026-10-14T10:00:00.000Z",
      run: makeCompareRun({
        finishedIso: "2026-10-14T10:05:00.000Z",
        caseSetId: set.id,
        featureKey: "f-1",
        featureName,
        ...metrics
      }),
      cases: []
    });
    return { dir, set };
  };
  const a = await project("align-a", { passed, total, flaky });
  const b = await project("align-b", {
    passed: passedB ?? passed,
    total: totalB ?? total,
    flaky: flakyB ?? flaky
  });
  const deps = { store, env: {}, workspaceRoot: workspace, serviceRepo: repo, buildStale: false };
  return { a, b, store, workspace, repo, deps };
}

test("panel web: compare 功能对齐区块（表头/小表/口径说明/未匹配计数）", async () => {
  const { store, workspace, repo, deps } = await makeAlignedProjects({
    passed: 2,
    total: 4,
    flaky: 1,
    passedB: 3,
    totalB: 4,
    flakyB: 0
  });

  // 第三个项目：唯一功能 → 未匹配
  const dirC = path.join(workspace, "align-c");
  fs.mkdirSync(dirC, { recursive: true });
  fs.writeFileSync(path.join(dirC, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  fs.writeFileSync(path.join(dirC, ".env"), COMPLETE_DOTENV, "utf-8");
  await store.upsertProject({ rootPath: dirC, name: "align-c" });
  const setC = await store.recordCaseSet({
    rootPath: dirC,
    source: "figma:OTHER",
    basename: "tests",
    features: [
      { key: "f-c", name: "注册流程", caseCount: 1, screens: [], jsonPath: "/x.json", mdPath: "/x.md", xlsxPath: "/x.xlsx" }
    ]
  });
  await store.recordSuiteRun({
    rootPath: dirC,
    createdAt: "2026-10-14T10:00:00.000Z",
    run: makeCompareRun({
      finishedIso: "2026-10-14T10:05:00.000Z",
      caseSetId: setC.id,
      featureKey: "f-c",
      featureName: "注册流程",
      passed: 1,
      total: 2
    }),
    cases: []
  });

  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /功能对齐（跨项目）/, "区块标题");
  assert.match(html.body, /<th scope="col">项目<\/th><th scope="col">通过率<\/th><th scope="col">批次<\/th><th scope="col">flaky<\/th><th scope="col">未裁决<\/th><th scope="col">最近<\/th>/, "小表列头");
  assert.match(html.body, /登录流程/, "显示名");
  assert.match(html.body, /figma:KEY/, "sourceLabel");
  assert.match(html.body, /2 个项目/, "项目数");
  assert.match(html.body, /align-a/, "项目 a 行");
  assert.match(html.body, /align-b/, "项目 b 行");
  assert.match(html.body, /50%/, "通过率（a 2/4）");
  assert.match(html.body, /75%/, "通过率（b 3/4）");
  assert.match(html.body, /匹配规则/, "口径说明：匹配规则");
  assert.match(html.body, /窗口＝用例集最近 20 批/, "口径说明：窗口");
  assert.match(html.body, /误报口径/, "口径说明：误报口径");
  assert.match(html.body, /未匹配 1 个（仅单项目出现）/, "口径说明：未匹配计数");
});

test("panel web: compare 功能对齐空态（无组 → 说明行 + 未匹配计数）", async () => {
  const { deps } = await makeHarness();
  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /功能对齐（跨项目）/, "区块仍渲染");
  assert.match(html.body, /暂无跨项目对齐的功能/, "空态文案");
  assert.match(html.body, /未匹配 0 个（仅单项目出现）/, "未匹配计数为 0");
  assert.doesNotMatch(html.body, /<th>项目<\/th><th>通过率<\/th>/, "空态不渲染小表");
});

test("panel web: compare 功能对齐 HTML 转义（显示名/源注入不裸出）", async () => {
  const { deps } = await makeAlignedProjects({
    source: 'figma:KEY"><img src=x onerror=alert(1)>',
    featureName: '"><script>alert(1)</script>'
  });
  const html = await handlePanelRequest(new URL("http://x/panel?view=compare"), deps);
  assert.equal(html.status, 200);
  assert.doesNotMatch(html.body, /<script>alert\(1\)<\/script>/, "显示名不裸出脚本标签");
  assert.doesNotMatch(html.body, /<img src=x/, "源不裸出标签");
  assert.match(html.body, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("panel web: workspace 内未登记项目可经绝对路径直达（overview 链接同形）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const workspace = makeTempDir("aos-panel-web-ws-");
  const projectDir = path.join(workspace, "disk-only");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  const deps = { store, env: {}, workspaceRoot: workspace, serviceRepo: repo, buildStale: false };

  const direct = await handlePanelRequest(
    new URL(`http://x/panel.json?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.equal(direct.status, 200);
  assert.equal(JSON.parse(direct.body).project.name, "disk-only");

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /接入/);

  const outside = await handlePanelRequest(
    new URL(`http://x/panel.json?project=${encodeURIComponent(repo)}`),
    deps
  );
  assert.equal(outside.status, 404, "工作区外绝对路径必须 404");
});

test("panel web: 任务卡展示取消来源/操作人/备注/时间（取消后不再渲染取消按钮）", async () => {
  const store = new MemoryStore();
  const repo = makeReadyRepo();
  const projectDir = makeTempDir("aos-panel-cancel-");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "aos.config.jsonc"), JSON.stringify(baseConfig()), "utf-8");
  await store.upsertProject({ rootPath: projectDir, name: "p" });
  const task = await store.createRegressionTask({
    rootPath: projectDir,
    refs: [{ caseSetId: "cs", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  await store.cancelRegressionTask({
    rootPath: projectDir,
    taskId: task.id,
    source: "local-cli",
    actor: "louis",
    actorHostId: "h-a",
    note: "面板核对",
    at: "2026-10-21T02:00:00.000Z"
  });
  const deps = { store, env: {}, serviceRepo: repo, buildStale: false };
  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&task=${encodeURIComponent(task.id)}`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /已取消/, "状态中文文案");
  assert.match(html.body, /取消：来源 local-cli · 操作人 louis · 时间 2026-10-21T02:00:00\.000Z · 备注 面板核对/);
  assert.doesNotMatch(html.body, /data-task-action="cancel"/, "终态不再提供取消");
  assert.doesNotMatch(html.body, /id="task-cancel-note"/, "终态不渲染备注输入");
});

test("panel web: 项目事件页（筛选/消费状态）", async () => {
  const { deps, projectDir, store } = await makeHarness();
  await store.recordProjectEvent(projectDir, {
    eventId: "evt-run-1",
    type: "run.finished",
    source: "runner",
    runId: "run-1",
    status: "passed",
    payload: { ok: true }
  });
  await store.recordProjectEvent(projectDir, {
    eventId: "evt-feedback-1",
    type: "feedback.request",
    source: "agent",
    status: "open",
    payload: { message: "请补充失败证据" }
  });

  const base = `http://x/panel.json?project=${encodeURIComponent(projectDir)}&section=events`;
  const all = JSON.parse((await handlePanelRequest(new URL(base), deps)).body);
  assert.equal(all.view, "events");
  assert.equal(all.events.length, 2);
  assert.equal(all.events[0].type, "feedback.request", "事件新→旧");
  assert.equal(all.events[0].consumedAt, null);

  const pending = JSON.parse(
    (await handlePanelRequest(new URL(`${base}&type=feedback.request&consumed=0`), deps)).body
  );
  assert.equal(pending.events.length, 1);
  assert.equal(pending.events[0].eventId, "evt-feedback-1");
  assert.equal(pending.events[0].payload, undefined, "默认不回显 payload");

  const withPayload = JSON.parse(
    (await handlePanelRequest(new URL(`${base}&payload=1`), deps)).body
  );
  assert.equal(withPayload.events[0].payload.message, "请补充失败证据");

  assert.equal(await store.markProjectEventsConsumed(projectDir, ["evt-feedback-1"]), 1);
  const consumed = JSON.parse(
    (await handlePanelRequest(new URL(`${base}&type=feedback.request&consumed=1`), deps)).body
  );
  assert.equal(consumed.events.length, 1);

  const html = await handlePanelRequest(
    new URL(`http://x/panel?project=${encodeURIComponent(projectDir)}&section=events`),
    deps
  );
  assert.equal(html.status, 200);
  assert.match(html.body, /<h1>项目事件<\/h1>/);
  assert.match(html.body, /feedback\.request/);
  assert.match(html.body, /未消费|已消费/);
  assert.match(html.body, /反馈请求/, "反馈过滤入口");
  assert.match(html.body, /aos_event_poll|GET \/events\//, "轮询/上报入口");

  const payloadHtml = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(projectDir)}&section=events&payload=1`
    ),
    deps
  );
  assert.match(payloadHtml.body, /显示 payload/);
  assert.match(payloadHtml.body, /请补充失败证据/);
});
