import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
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
  await store.createWebProject({
    rootPath,
    name: "acme",
    normalizedName: "acme",
    platforms: ["android"]
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
  const pkg = await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.apk",
    sha256: "d".repeat(64),
    size: 1024,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "package", `${"d".repeat(64)}.apk`),
    uploadedBy: "alice",
    metadata: {}
  });
  const generated = await store.createWebAsset({
    rootPath,
    kind: "scripts",
    filename: "aos-scripts-android-abc.zip",
    sha256: "e".repeat(64),
    size: 512,
    storagePath: path.join(rootPath, ".artemis", "web", "assets", "scripts", `${"e".repeat(64)}.zip`),
    uploadedBy: "aos",
    metadata: { origin: "generated", platform: "android", ready: 3, unresolved: 1 }
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
  return { deps, rootPath, asset, escapedAsset, pkg, generated, mapping, store };
}

function assetsUrl(rootPath, hostId = null) {
  const params = new URLSearchParams({ project: rootPath, section: "assets" });
  if (hostId !== null) params.set("host", hostId);
  return new URL(`http://x/panel?${params.toString()}`);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
}

async function xlsxBuffer(headers) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(headers);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function multipartBody(boundary, { project, filename = "cases.xlsx", content }) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="project"\r\n\r\n${project}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nexcel\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
      "utf8"
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")
  ]);
}

test("web assets page: asset versions, upload form and mapping hooks", async (t) => {
  const { deps, rootPath, asset, pkg } = await setup(t);
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
  assert.match(html, /type="file"[^>]*accept="\.xlsx,\.csv"/, "允许 .xlsx/.csv");
  assert.match(html, /id="asset-file"/, "文件控件");
  assert.match(html, /\/panel\/api\/projects\/assets/, "multipart 上传端点");
  assert.match(html, /生成 Maestro 脚本/, "脚本生成卡片");
  assert.match(html, /id="script-gen-form"/, "脚本生成表单");
  assert.match(html, /\/panel\/api\/projects\/scripts\/generate/, "脚本生成端点");
  assert.match(html, new RegExp(`<option value="${pkg.id}"`), "安装包选项");
  assert.match(html, /aos-scripts-android-abc\.zip/, "脚本集列表");


  assert.match(html, /id="asset-select"/, "资产选择");
  assert.match(html, new RegExp(`<option value="${asset.id}"`), "资产选项");
  assert.match(html, /name="headerRow"[^>]*value="1"/, "表头行默认 1");
  assert.match(html, /\/panel\/api\/projects\/excel\/preview/, "预览端点");
  assert.match(html, /\/panel\/api\/projects\/excel\/mapping/, "保存映射端点");
  assert.match(html, /id="mapping-save"/, "保存映射按钮");
  assert.match(html, /id="asset-upload-submit"[^>]*data-busy-label="上传中…"/, "上传防重复提交");
  assert.match(html, /id="mapping-preview-submit"[^>]*data-busy-label="预览中…"/, "预览防重复提交");
  assert.match(html, /id="mapping-save"[^>]*data-busy-label="保存中…"/, "保存防重复提交");
  assert.match(html, /id="asset-select"[^>]*data-preview-reset="1"/, "资产变更重置预览");
  assert.match(html, /id="asset-header-row"[^>]*data-preview-reset="1"/, "表头行变更重置预览");
  assert.match(html, /addEventListener\('change',resetPreview\)/, "预览重置 hook");

  assert.match(html, /<code>用例<\/code>/, "已有映射工作表");
  assert.match(html, /用例编号→用例编号/, "已有映射字段");
  assert.match(html, /alice/, "映射保存人");

  assert.match(html, /a&lt;b&gt;\.xlsx/, "文件名转义");
  assert.ok(!html.includes("a<b>.xlsx"), "原始文件名不直出");

  const ownScripts = inlineScripts(html).filter((code) =>
    code.includes("/panel/api/projects/assets")
  );
  assert.equal(ownScripts.length, 1, "资产页脚本存在");
  assert.match(ownScripts[0], /仅支持 \.xlsx\/\.csv 文件/, "客户端校验 CSV 扩展名");
  assert.doesNotThrow(() => new Function(ownScripts[0]), "资产页内联脚本可解析");
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
  assert.equal(payload.packages.length, 1);
  assert.equal(payload.scripts.length, 1);
  assert.equal(payload.appPackage, null);

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

test("web assets page: archived project shows status and disables writes", async (t) => {
  const { deps, rootPath, store } = await setup(t);
  await store.archiveWebProject(rootPath, "2026-10-28T00:00:00.000Z");
  const response = await handlePanelRequest(assetsUrl(rootPath), {
    ...deps,
    capabilities: { actions: true, usage: true, mode: "http", role: "maintainer" }
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /已归档/);
  assert.match(response.body, /id="asset-upload-submit"[^>]* disabled/);
  assert.match(response.body, /id="mapping-save"[^>]* disabled/);
  assert.ok(
    !response.body.includes("/panel/api/projects/excel/mapping"),
    "归档页不注入写脚本"
  );

  const json = await handlePanelRequest(
    new URL(`http://x/panel.json?project=${encodeURIComponent(rootPath)}&section=assets`),
    deps
  );
  assert.equal(JSON.parse(json.body).projectStatus, "archived");
});

test("web asset upload and mapping save clear the panel cache", async (t) => {
  const { deps, rootPath } = await setup(t);
  let cleared = 0;
  const cache = {
    get() {
      return undefined;
    },
    set() {},
    clear() {
      cleared += 1;
    }
  };
  const cacheDeps = { ...deps, cache };
  const identity = { name: "alice", role: "maintainer", source: "user" };
  const boundary = "----aosAssetsUi";
  const rawBody = multipartBody(boundary, {
    project: rootPath,
    content: await xlsxBuffer(["用例编号", "步骤"])
  });

  const upload = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/assets"),
      body: {},
      rawBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
      identity
    },
    cacheDeps
  );
  assert.equal(upload.status, 200);
  assert.equal(cleared, 1, "上传成功清空面板缓存");
  const assetId = JSON.parse(upload.body).asset.id;

  const save = await handlePanelActionRequest(
    {
      method: "POST",
      url: new URL("http://localhost/panel/api/projects/excel/mapping"),
      body: {
        project: rootPath,
        assetId,
        sheetName: "用例",
        headerRow: 1,
        columnMap: { caseId: "用例编号", steps: "步骤" }
      },
      identity
    },
    cacheDeps
  );
  assert.equal(save.status, 200);
  assert.equal(cleared, 2, "保存映射成功清空面板缓存");
});
