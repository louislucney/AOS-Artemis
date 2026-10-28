import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { hostId = null } = {}) {
  const workspace = await tempDir(t, "aos-web-assets-ui-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({
    rootPath,
    name: "acme",
    ...(hostId === null ? {} : { hostId })
  });
  const asset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "回归用例.xlsx",
    sha256: "a".repeat(64),
    size: 2048,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "excel", `${"a".repeat(64)}.xlsx`),
    uploadedBy: "alice",
    metadata: {}
  });
  const escapedAsset = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "a<b>.xlsx",
    sha256: "c".repeat(64),
    size: 10,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "excel", `${"c".repeat(64)}.xlsx`),
    uploadedBy: "alice",
    metadata: {}
  });
  const mapping = await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    headerFingerprint: "b".repeat(64),
    columnMap: { caseId: "用例编号", steps: "操作步骤" },
    createdBy: "alice"
  });
  const deps = {
    store,
    env: {},
    workspaceRoot: workspace,
    buildStale: false
  };
  return { deps, rootPath, asset, escapedAsset, mapping };
}

function assetsUrl(rootPath, hostId = null) {
  const params = new URLSearchParams({ project: rootPath, section: "assets" });
  if (hostId !== null) params.set("host", hostId);
  return new URL(`http://x/panel?${params.toString()}`);
}

test("web assets page: asset versions, upload form and mapping hooks", async (t) => {
  const { deps, rootPath, asset } = await setup(t);
  const response = await handlePanelRequest(assetsUrl(rootPath), deps);
  assert.equal(response.status, 200);
  const html = response.body;

  assert.match(html, /测试资产/);
  assert.match(html, /回归用例\.xlsx/, "资产文件名");
  assert.match(html, /<code>v1<\/code>/, "版本");
  assert.match(html, /2\.0KB/, "大小");
  assert.match(html, new RegExp(`<code>${"a".repeat(12)}</code>`), "sha 短摘要");
  assert.match(html, /<time datetime="[^"]+"/, "上传时间");

  assert.match(html, /id="asset-upload-form"/, "上传表单");
  assert.match(html, /type="file"[^>]*accept="\.xlsx"/, "仅 .xlsx");
  assert.match(html, /id="asset-file"/, "文件控件");
  assert.match(html, /\/panel\/api\/projects\/assets/, "multipart 上传端点");

  assert.match(html, /id="asset-select"/, "资产选择");
  assert.match(html, new RegExp(`<option value="${asset.id}"`), "资产选项");
  assert.match(html, /name="headerRow"[^>]*value="1"/, "表头行默认 1");
  assert.match(html, /\/panel\/api\/projects\/excel\/preview/, "预览端点");
  assert.match(html, /\/panel\/api\/projects\/excel\/mapping/, "保存映射端点");
  assert.match(html, /id="mapping-save"/, "保存映射按钮");

  assert.match(html, /<code>用例<\/code>/, "已有映射工作表");
  assert.match(html, /用例编号→用例编号/, "已有映射字段");
  assert.match(html, /alice/, "映射保存人");

  assert.match(html, /a&lt;b&gt;\.xlsx/, "文件名转义");
  assert.ok(!html.includes("a<b>.xlsx"), "原始文件名不直出");
});

test("web assets JSON view exposes assets and mappings", async (t) => {
  const { deps, rootPath, asset, mapping } = await setup(t);
  const params = new URLSearchParams({ project: rootPath, section: "assets" });
  const response = await handlePanelRequest(new URL(`http://x/panel.json?${params.toString()}`), deps);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.view, "web-assets");
  assert.equal(payload.assets.length, 2);
  assert.ok(payload.assets.some((entry) => entry.id === asset.id), "含主资产");
  assert.equal(payload.mappings.length, 1);
  assert.equal(payload.mappings[0].id, mapping.id);
});

test("web assets page: viewer/dispatcher get no write actions", async (t) => {
  const { deps, rootPath } = await setup(t);
  for (const role of ["viewer", "dispatcher"]) {
    const response = await handlePanelRequest(assetsUrl(rootPath), {
      ...deps,
      capabilities: { actions: true, usage: true, mode: "http", role }
    });
    assert.equal(response.status, 200);
    assert.match(response.body, /id="asset-upload-submit"[^>]* disabled/, `${role} 上传禁用`);
    assert.match(response.body, /id="mapping-preview-submit"[^>]* disabled/, `${role} 预览禁用`);
    assert.match(response.body, /id="mapping-save"[^>]* disabled/, `${role} 保存禁用`);
    assert.match(response.body, /需要 maintainer\/admin/, `${role} 说明原因`);
    assert.ok(
      !response.body.includes("/panel/api/projects/excel/mapping"),
      `${role} 页面不暴露写动作脚本`
    );
  }

  const writable = await handlePanelRequest(assetsUrl(rootPath), {
    ...deps,
    capabilities: { actions: true, usage: true, mode: "http", role: "maintainer" }
  });
  assert.ok(!/id="asset-upload-submit"[^>]* disabled/.test(writable.body), "maintainer 可上传");
  assert.ok(!/id="mapping-save"[^>]* disabled/.test(writable.body), "maintainer 可保存");
  assert.match(writable.body, /\/panel\/api\/projects\/excel\/mapping/);
});

test("web assets page: panel actions off disables writes", async (t) => {
  const { deps, rootPath } = await setup(t);
  const response = await handlePanelRequest(assetsUrl(rootPath), {
    ...deps,
    capabilities: { actions: false, usage: true, mode: "standalone", role: "admin" }
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /id="asset-upload-submit"[^>]* disabled/);
  assert.match(response.body, /id="mapping-save"[^>]* disabled/);
});

test("project page links to assets and preserves host", async (t) => {
  const { deps, rootPath } = await setup(t, { hostId: "host-a" });
  const params = new URLSearchParams({ project: rootPath, host: "host-a" });
  const response = await handlePanelRequest(new URL(`http://x/panel?${params.toString()}`), deps);
  assert.equal(response.status, 200);
  assert.match(
    response.body,
    /href="\/panel\?project=[^"]+&amp;section=assets&amp;host=host-a"[^>]*>测试资产/,
    "项目页入口携带项目与主机"
  );
});
