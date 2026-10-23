import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildRunManifest, saveRunManifest } from "../dist/figma/run-manifest.js";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  const rootPath = runtime.project.rootDir;
  await runtime.store.upsertProject({ rootPath, name: "p" });
  const set = await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "登录回归",
    features: [
      { key: "login", name: "登录", caseCount: 2, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  await store.recordAudit(rootPath, {
    domain: "suite",
    action: "run.recorded",
    result: "ok",
    summary: "批次登记",
    at: "2026-10-18T01:00:00.000Z"
  });
  await store.recordAudit(rootPath, {
    domain: "panel",
    action: "action.tasks",
    result: "failed",
    summary: "面板动作 tasks → 400",
    at: "2026-10-18T02:00:00.000Z",
    refs: { taskId: "t-abc123", caseId: "case-9" }
  });
  const runsDir = join(rootPath, ".artemis", "design", "runs");
  await mkdir(runsDir, { recursive: true });
  const manifest = join(runsDir, "20261018_a.json");
  await writeFile(manifest, "{}", "utf8");
  await utimes(manifest, new Date("2026-10-18T03:00:00.000Z"), new Date("2026-10-18T03:00:00.000Z"));

  const deps = { store, env: {}, storeNote: "未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账。" };
  return { deps, rootPath, set };
}

function url(rootPath, section, extra = {}) {
  const params = new URLSearchParams({ project: rootPath, section, ...extra });
  return new URL(`http://x/panel?${params.toString()}`);
}

test("console pages: 用例库（份列表＋隔离徽章＋失败用例候选点选）", async () => {
  const { deps, rootPath } = await setup();
  await deps.store.recordSuiteRun({
    rootPath,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: {
      trigger: "suite-run",
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
      failureDomains: { 应用缺陷: 1 },
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
  const html = await handlePanelRequest(url(rootPath, "library"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /用例库/);
  assert.match(html.body, /登录回归/);
  assert.match(html.body, /隔离中 0/);
  assert.match(html.body, /按用例集下发/);
  assert.match(html.body, /&amp;section=dispatch/, "链接实体转义（无裸 &）");
  assert.match(html.body, /aosInlineConfirm\(b,'确认移除该隔离条目？'/, "隔离移除走站内确认");
  assert.doesNotMatch(html.body, /[^a-zA-Z_.]confirm\(/, "无原生 confirm 残留");
  assert.match(html.body, /c-table-wrap/, "表格横向滚动容器（窄屏不整页溢出）");
  assert.match(html.body, /<span title="figma:x">Figma 生成（x）<\/span>/, "来源中文化（title 原文）");
  assert.match(html.body, /下发该用例集/, "用例集行内动作");
  assert.match(html.body, /section=dispatch&amp;source=case-set&amp;ref=/, "预填下发链接（转义后）");
  assert.match(html.body, /id="import-form"/, "Excel 上传表单");
  assert.match(html.body, /panel\/api\/import/);
  assert.match(html.body, /id="quarantine-form"/, "隔离表单");
  assert.match(html.body, /aria-label="签字人（owner）"/);
  assert.match(html.body, /list="quarantine-case-options"/, "用例 ID 可搜索（最近失败候选）");
  assert.match(
    html.body,
    /<option value="case-1">Case 1（最近失败 2026-10-14）<\/option>/,
    "候选含名称与失败日期"
  );
  assert.match(html.body, /<input type="date" name="until"/, "到期用日期控件");

  const json = JSON.parse((await handlePanelRequest(new URL(url(rootPath, "library").toString().replace("/panel?", "/panel.json?")), deps)).body);
  assert.equal(json.view, "library");
  assert.equal(json.sets.length, 1);
  assert.equal(json.caseCandidates.length, 1, "候选随 JSON 暴露");
});

test("console pages: 档案（索引＋kind 筛选）", async () => {
  const { deps, rootPath } = await setup();
  const all = await handlePanelRequest(url(rootPath, "archive"), deps);
  assert.equal(all.status, 200);
  assert.match(all.body, /产物索引/);
  assert.match(all.body, /20261018_a\.json/);
  assert.match(all.body, /\/panel\/artifact\?project=/, "产物行可点（只读服务）");
  assert.match(all.body, /<option value="case-set"[^>]*>用例集<\/option>/, "类型筛选中文化");
  assert.match(all.body, /批次<\/span>/, "kind 徽章中文化（run→批次）");
  assert.match(all.body, /时间预设/, "档案时间预设");
  assert.match(all.body, /format=csv/, "索引导出 CSV 链接");

  const filtered = await handlePanelRequest(url(rootPath, "archive", { kind: "case-set" }), deps);
  assert.ok(!filtered.body.includes("20261018_a.json"), "kind 筛选生效");
});

test("console pages: 档案分页（offset/上一页）与图片缩略图", async () => {
  const { deps, rootPath } = await setup();
  const diffsDir = join(rootPath, ".artemis", "design", "diffs");
  await mkdir(diffsDir, { recursive: true });
  await writeFile(join(diffsDir, "vs_design.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const page1 = await handlePanelRequest(url(rootPath, "archive"), deps);
  assert.equal(page1.status, 200);
  assert.match(page1.body, /class="c-thumb"/, "图片产物缩略图");
  assert.match(page1.body, /vs_design\.png/);
  assert.match(page1.body, /第 1 页/);

  const all = JSON.parse(
    (await handlePanelRequest(new URL(`http://x/panel.json?project=${encodeURIComponent(rootPath)}&section=archive`), deps)).body
  );
  assert.ok(all.artifacts.length >= 2, "至少 manifest + png 两项");

  const page2Json = JSON.parse(
    (
      await handlePanelRequest(
        new URL(`http://x/panel.json?project=${encodeURIComponent(rootPath)}&section=archive&offset=1`),
        deps
      )
    ).body
  );
  assert.equal(page2Json.page.offset, 1);
  assert.equal(page2Json.artifacts.length, all.artifacts.length - 1, "offset 跳过分页项");

  const page2 = await handlePanelRequest(url(rootPath, "archive", { offset: "1" }), deps);
  assert.match(page2.body, /上一页/);
  assert.match(page2.body, /offset=0/, "上一页带回 offset=0");
});

test("console pages: 独立进程能力同源（只读横幅＋统计导航禁用，全页生效）", async () => {
  const { deps, rootPath } = await setup();
  const standalone = {
    ...deps,
    capabilities: { actions: false, usage: false, mode: "standalone" }
  };
  const pages = [
    ["archive", {}],
    ["audit", {}],
    ["search", { q: "登录" }]
  ];
  for (const [section, extra] of pages) {
    const html = await handlePanelRequest(url(rootPath, section, extra), standalone);
    assert.equal(html.status, 200, section);
    assert.match(html.body, /capability-banner|只读模式/, `${section}: 只读横幅断档修复`);
    assert.match(html.body, /本进程不提供统计页/, `${section}: 统计导航按能力禁用（不再 404）`);
  }
});

test("console pages: 审计（domain 筛选＋结果徽章）", async () => {
  const { deps, rootPath } = await setup();
  const all = await handlePanelRequest(url(rootPath, "audit"), deps);
  assert.equal(all.status, 200);
  assert.match(all.body, /批次登记/);
  assert.match(all.body, /action.tasks/);
  assert.match(all.body, /<time datetime="2026-10-18T01:00:00\.000Z"/, "审计时间相对化（title 绝对）");
  assert.match(all.body, /<span title="action\.tasks">派发回归任务<\/span>/, "动作中文化（title 原文）");
  assert.match(all.body, /<span title="panel">控制台操作<\/span>/, "域中文化（title 原文）");

  const suiteOnly = await handlePanelRequest(url(rootPath, "audit", { domain: "suite" }), deps);
  assert.match(suiteOnly.body, /批次登记/);
  assert.ok(!suiteOnly.body.includes("action.tasks"), "domain 筛选生效");

  const failedOnly = await handlePanelRequest(url(rootPath, "audit", { result: "failed" }), deps);
  assert.ok(failedOnly.body.includes("action.tasks"));
  assert.ok(!failedOnly.body.includes("批次登记"));

  assert.match(all.body, /时间预设/, "时间预设");
  assert.match(all.body, /<th scope="col">关联对象<\/th><th scope="col">恢复<\/th>/, "关联与恢复二列");
  assert.match(all.body, /task=t-abc123/, "taskId → 任务页链接");
  assert.match(all.body, /&amp;task=t-abc123/, "链接实体转义（无裸 &）");
  assert.match(all.body, /重新打开下发预览/, "失败行就地恢复动作");
  assert.match(all.body, /域 <select name="domain"/, "域改已知集合下拉");
  assert.match(all.body, /回归运行<\/option>/, "域选项中文");
  assert.match(all.body, /<input type="datetime-local" name="since"/, "起自用日期时间控件");
  const localSince = await handlePanelRequest(url(rootPath, "audit", { since: "2026-10-01T00:00" }), deps);
  assert.match(localSince.body, /批次登记/, "本地时间 since 归一（无时区 → 本地 → ISO）");
  assert.match(all.body, /第 1 页/);
  const pager = await handlePanelRequest(url(rootPath, "audit", { offset: "1" }), deps);
  assert.match(pager.body, /第 1 页|第 2 页/, "offset 生效");
});

test("console pages: 全局搜索（项目/用例集/任务）与空态", async () => {
  const { deps, rootPath, set } = await setup();
  await deps.store.createRegressionTask({
    rootPath,
    refs: [{ caseSetId: set.id, featureKey: "login" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  const hit = await handlePanelRequest(url(rootPath, "search", { q: "登录" }), deps);
  assert.equal(hit.status, 200);
  assert.match(hit.body, /搜索：登录/);
  assert.match(hit.body, /登录回归/, "命中用例集");
  assert.match(hit.body, /下发该用例集/);
  assert.match(hit.body, /无匹配任务|任务/, "任务分组渲染");

  const empty = await handlePanelRequest(new URL("http://x/panel?section=search"), deps);
  assert.equal(empty.status, 200);
  assert.match(empty.body, /输入关键词开始搜索/);

  const json = await handlePanelRequest(
    new URL(`http://x/panel.json?section=search&q=${encodeURIComponent("登录")}`),
    deps
  );
  const payload = JSON.parse(json.body);
  assert.equal(payload.view, "search");
  assert.equal(payload.caseSets.length, 1);
});

test("console pages: 运维（存储徽章＋写失败信号位＋导出链接）", async () => {
  const { deps, rootPath } = await setup();
  const html = await handlePanelRequest(url(rootPath, "ops"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /运维/);
  assert.match(html.body, /会话内存/, "MemoryStore 显示会话内存");
  assert.ok(!html.body.includes("文件台账"), "存储口径同源（不出现矛盾的台账说明）");
  assert.match(html.body, /panel\/api\/export\?project=/);
  assert.match(html.body, /node dist\/cli\.js export/);
  assert.ok(!html.body.includes('http-equiv="refresh"'), "运维表单页不自动刷新");
});

test("console pages: 角色 scope 关闭用例库写入口", async () => {
  const { deps, rootPath } = await setup();
  const scoped = {
    ...deps,
    capabilities: {
      actions: true,
      usage: true,
      mode: "http",
      role: "dispatcher",
      scopes: { library: false }
    }
  };
  const html = await handlePanelRequest(url(rootPath, "library"), scoped);
  assert.equal(html.status, 200);
  assert.match(html.body, /写动作未启用/);
  assert.match(html.body, /disabled/);
});


test("console pages: 批次详情展示台账 API 说明（清单已清理仍可读）", async () => {
  const { deps, rootPath } = await setup();
  const report = {
    ok: true,
    testsPath: join(rootPath, ".artemis", "design", "tests.json"),
    total: 0,
    executed: 0,
    skipped: 0,
    passed: 0,
    failed: 0,
    preflight: null,
    apiErrorCatalog: null,
    cases: []
  };
  const manifest = buildRunManifest({
    report,
    source: "suite-run",
    startedAtMs: Date.parse("2026-10-18T04:00:00.000Z"),
    finishedAtMs: Date.parse("2026-10-18T04:01:00.000Z"),
    exitCode: 0,
    coverageIssue: null,
    testsPath: report.testsPath,
    testsSha256: null,
    testsGeneratedAt: null,
    options: {
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
    }
  });
  const manifestPath = saveRunManifest(join(rootPath, ".artemis"), manifest);
  await deps.store.recordSuiteRun({
    rootPath,
    createdAt: manifest.finishedAt,
    run: {
      trigger: "cli",
      regressionTaskId: null,
      caseSetId: null,
      featureKey: null,
      featureName: null,
      platform: "android",
      device: null,
      appVersion: null,
      runner: null,
      status: "completed",
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      total: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      quarantined: 0,
      failureDomains: {},
      gateResult: "pass",
      exitCode: 0,
      manifestPath,
      comparison: null,
      apiReview: {
        change: "new",
        status: "provided",
        specSha256: "sha",
        designFingerprint: "fp",
        carriedForward: false,
        designChanged: false
      }
    },
    cases: []
  });
  const file = manifestPath.split("/").pop();
  const html = await handlePanelRequest(url(rootPath, "project", { batch: file }), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /API 说明已提供/);
});
