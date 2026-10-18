import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function harness() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  const rootPath = runtime.project.rootDir;
  await store.upsertProject({ rootPath, name: "p" });
  await store.recordCaseSet({
    rootPath,
    source: "figma:x",
    basename: "回归",
    features: [
      { key: "f", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  await store.recordAudit(rootPath, { domain: "suite", action: "run.recorded", result: "ok", summary: "s" });
  const deps = { store, env: {} };
  return { deps, rootPath };
}

function sectionUrl(rootPath, section) {
  const params = new URLSearchParams({ project: rootPath });
  if (section !== null) params.set("section", section);
  return new URL(`http://x/panel?${params.toString()}`);
}

test("console a11y: 每页唯一 h1、zh-CN、focus-visible、无禁用语义", async () => {
  const { deps, rootPath } = await harness();
  const pages = [
    ["overview", new URL("http://x/panel")],
    ["project", sectionUrl(rootPath, null)],
    ["dispatch", sectionUrl(rootPath, "dispatch")],
    ["library", sectionUrl(rootPath, "library")],
    ["archive", sectionUrl(rootPath, "archive")],
    ["audit", sectionUrl(rootPath, "audit")],
    ["ops", sectionUrl(rootPath, "ops")]
  ];
  for (const [name, url] of pages) {
    const html = await handlePanelRequest(url, deps);
    assert.equal(html.status, 200, name);
    assert.match(html.body, /lang="zh-CN"/, name);
    const h1Count = (html.body.match(/<h1[ >]/g) ?? []).length;
    assert.equal(h1Count, 1, `${name}: 恰一个 h1`);
    assert.match(html.body, /:focus-visible/, `${name}: 焦点可见样式`);
    assert.match(html.body, /@media \(max-width:960px\)/, `${name}: 窄屏适配`);
    assert.ok(!/color:\s*#86868B/i.test(html.body), `${name}: 正文禁用法外灰（装饰色不得进正文）`);
    assert.ok(!html.body.includes('http-equiv="refresh"'), `${name}: 默认无整页刷新`);
  }
});

test("console a11y: 表格语义（th scope）与表单页刷新纪律", async () => {
  const { deps, rootPath } = await harness();
  const archive = await handlePanelRequest(sectionUrl(rootPath, "archive"), deps);
  assert.match(archive.body, /<th scope="col">/);
  const dispatch = await handlePanelRequest(sectionUrl(rootPath, "dispatch"), deps);
  assert.match(dispatch.body, /<form/);
  assert.ok(!dispatch.body.includes('http-equiv="refresh"'), "含表单页永不整页刷新");
  const ops = await handlePanelRequest(sectionUrl(rootPath, "ops"), deps);
  assert.ok(!ops.body.includes('http-equiv="refresh"'));
});
