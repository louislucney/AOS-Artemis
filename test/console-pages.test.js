import assert from "node:assert/strict";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  const rootPath = runtime.project.rootDir;
  await store.upsertProject({ rootPath, name: "p" });
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
    at: "2026-10-18T02:00:00.000Z"
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

test("console pages: 用例库（份列表＋隔离徽章）", async () => {
  const { deps, rootPath } = await setup();
  const html = await handlePanelRequest(url(rootPath, "library"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /用例库/);
  assert.match(html.body, /登录回归/);
  assert.match(html.body, /隔离中 0/);
  assert.match(html.body, /按份下发/);

  const json = JSON.parse((await handlePanelRequest(new URL(url(rootPath, "library").toString().replace("/panel?", "/panel.json?")), deps)).body);
  assert.equal(json.view, "library");
  assert.equal(json.sets.length, 1);
});

test("console pages: 档案（索引＋kind 筛选）", async () => {
  const { deps, rootPath } = await setup();
  const all = await handlePanelRequest(url(rootPath, "archive"), deps);
  assert.equal(all.status, 200);
  assert.match(all.body, /产物索引/);
  assert.match(all.body, /20261018_a\.json/);

  const filtered = await handlePanelRequest(url(rootPath, "archive", { kind: "case-set" }), deps);
  assert.ok(!filtered.body.includes("20261018_a.json"), "kind 筛选生效");
});

test("console pages: 审计（domain 筛选＋结果徽章）", async () => {
  const { deps, rootPath } = await setup();
  const all = await handlePanelRequest(url(rootPath, "audit"), deps);
  assert.equal(all.status, 200);
  assert.match(all.body, /批次登记/);
  assert.match(all.body, /action.tasks/);

  const suiteOnly = await handlePanelRequest(url(rootPath, "audit", { domain: "suite" }), deps);
  assert.match(suiteOnly.body, /批次登记/);
  assert.ok(!suiteOnly.body.includes("action.tasks"), "domain 筛选生效");

  const failedOnly = await handlePanelRequest(url(rootPath, "audit", { result: "failed" }), deps);
  assert.ok(failedOnly.body.includes("action.tasks"));
  assert.ok(!failedOnly.body.includes("批次登记"));
});

test("console pages: 运维与数据（存储徽章＋写失败信号位＋导出链接）", async () => {
  const { deps, rootPath } = await setup();
  const html = await handlePanelRequest(url(rootPath, "ops"), deps);
  assert.equal(html.status, 200);
  assert.match(html.body, /运维与数据/);
  assert.match(html.body, /会话内存/, "MemoryStore 显示会话内存");
  assert.match(html.body, /panel\/api\/export\?project=/);
  assert.match(html.body, /node dist\/cli\.js export/);
  assert.ok(!html.body.includes('http-equiv="refresh"'), "运维表单页不自动刷新");
});
