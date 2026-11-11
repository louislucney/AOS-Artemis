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
    metadata: { origin: "generated", platform: "android", ready: 3, partial: 2, unresolved: 1 }
  });
  const materials = await store.createWebAsset({
    rootPath,
    kind: "materials",
    filename: "accounts.json",
    sha256: "f".repeat(64),
    size: 256,
    storagePath: path.join(
      rootPath,
      ".artemis",
      "web",
      "assets",
      "materials",
      `${"f".repeat(64)}.json`
    ),
    uploadedBy: "alice",
    metadata: { secret: true }
  });
  const reference = await store.createWebAsset({
    rootPath,
    kind: "reference",
    filename: "login.png",
    sha256: "g".repeat(64),
    size: 64,
    storagePath: path.join(
      rootPath,
      ".artemis",
      "web",
      "assets",
      "reference",
      `${"g".repeat(64)}.png`
    ),
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
  return { deps, rootPath, asset, escapedAsset, pkg, generated, materials, reference, mapping, store };
}

function assetsUrl(rootPath, hostId = null, tab = "all") {
  const params = new URLSearchParams({ project: rootPath, section: "assets", tab });
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

function multipartBody(
  boundary,
  {
    project,
    filename = "cases.xlsx",
    content,
    kind = "excel",
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="project"\r\n\r\n${project}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
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

  assert.ok(
    html.indexOf('id="asset-upload"') < html.indexOf('id="excel-assets"'),
    "上传卡在资产表之前（打开页面即可看到）"
  );
  assert.match(html, /id="design-import-modal"/, "设计增强导入弹窗");
  assert.match(html, /window\.aosDesignImport/, "导入按钮先走设计预检");
  assert.match(html, /id="asset-upload-form"/, "上传表单");
  assert.match(html, /data-import-excel="[^"]+"/, "Excel 资产可一键导入用例库");
  assert.match(html, /id="asset-upload"/, "上传锚点");
  assert.match(html, /id="asset-kind"[^>]*aria-label="资产类型"/, "资产类型选择");
  assert.match(html, /<option value="package">安装包（APK\/IPA）<\/option>/, "安装包类型");
  assert.match(html, /<option value="materials">测试资料（materials）<\/option>/, "测试资料类型");
  assert.match(html, /<option value="reference">参考图（L2 reference）<\/option>/, "参考图类型");
  assert.match(html, /参考图（L2）/);
  assert.match(html, /login\.png/);
  const scripts = inlineScripts(html).join("\n");
  assert.match(scripts, /kind==='reference'/, "上传脚本支持 reference");
  assert.match(scripts, /endsWith\('\.png'\)/, "文件识别支持 PNG");
  assert.match(scripts, /endsWith\('\.pen'\)/, "文件识别支持 .pen 参考图");
  assert.match(
    html,
    /type="file"[^>]*accept="\.xlsx,\.csv,\.apk,\.ipa,\.zip,\.json,\.txt,\.png,\.jpg,\.jpeg,\.webp,\.pen"/,
    "允许 Excel/CSV/APK/IPA/测试资料/参考图"
  );
  assert.match(html, /id="asset-file"/, "文件控件");
  assert.match(html, /id="asset-drop"[^>]*class="c-dropzone"/, "拖放区");
  assert.match(html, /拖入 Excel \/ CSV \/ APK \/ IPA \/ 测试资料/, "拖放提示");
  assert.match(html, /id="asset-secret"/, "secret 标记");
  assert.match(html, /安装包资产/, "安装包资产卡片");
  assert.match(html, /测试资料资产/, "测试资料资产卡片");
  assert.match(html, /accounts\.json/, "测试资料文件名");
  assert.match(html, /app\.apk/, "安装包文件名");
  assert.match(html, /\/panel\/api\/projects\/assets/, "multipart 上传端点");
  assert.doesNotMatch(html, /脚本集（历史）/, "不再提供历史脚本集入口");
  assert.doesNotMatch(html, /id="script-gen-form"/, "不再提供脚本生成表单");
  assert.doesNotMatch(html, /\/panel\/api\/projects\/scripts\/generate/, "不再提供脚本生成端点");


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

  const ownScripts = inlineScripts(html).filter(
    (code) => code.includes("asset-upload-form") && code.includes("/panel/api/projects/assets")
  );
  assert.equal(ownScripts.length, 1, "资产页脚本存在");
  assert.match(ownScripts[0], /Excel 仅支持 \.xlsx\/\.csv/, "客户端校验 Excel 扩展名");
  assert.match(ownScripts[0], /安装包仅支持 \.apk\/\.ipa/, "客户端校验安装包扩展名");
  assert.match(ownScripts[0], /测试资料仅支持 \.zip\/\.json\/\.csv\/\.txt/, "客户端校验测试资料扩展名");
  assert.match(ownScripts[0], /fd\.append\('secret','true'\)/, "secret 随 materials 上传");
  assert.match(ownScripts[0], /dragenter/, "拖放 hover 态");
  assert.doesNotMatch(ownScripts[0], /requestSubmit/, "拖放只选文件，不自动上传");
  assert.match(ownScripts[0], /已选择文件，点击「上传资产」/, "拖放后提示点击上传");
  assert.match(ownScripts[0], /_uploaded/, "上传成功强制刷新并展示结果");
  assert.match(ownScripts[0], /uSyncKind/, "按扩展名自动切换 Excel/安装包类型");
  assert.match(ownScripts[0], /\/panel\/api\/import/, "资产导入用例库端点");
  assert.match(html, /id="package-assets"/, "安装包资产锚点");
  assert.match(html, /id="excel-assets"/, "Excel 资产锚点");
  assert.doesNotThrow(() => new Function(ownScripts[0]), "资产页内联脚本可解析");
});

test("assets hub: overview / case-sets / packages tabs", async (t) => {
  const { deps, rootPath } = await setup(t);
  const overview = await handlePanelRequest(assetsUrl(rootPath, null, "overview"), deps);
  assert.equal(overview.status, 200);
  assert.match(overview.body, /资产概览/);
  assert.match(overview.body, /新建测试/);
  assert.doesNotMatch(overview.body, /id="excel-assets"/, "概览不直接铺 Excel 表");

  const caseSets = await handlePanelRequest(assetsUrl(rootPath, null, "case-sets"), deps);
  assert.equal(caseSets.status, 200);
  assert.match(caseSets.body, /测试资产 · 用例集/);
  assert.match(caseSets.body, /导入 Excel/);

  const packages = await handlePanelRequest(assetsUrl(rootPath, null, "packages"), deps);
  assert.equal(packages.status, 200);
  assert.match(packages.body, /安装包资产版本/);
  assert.doesNotMatch(packages.body, /id="excel-assets"/);
});

test("assets hub: APK/IPA 按平台各自编号，不互相递增", async (t) => {
  const { deps, rootPath, store } = await setup(t);
  await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.ipa",
    sha256: "i".repeat(64),
    size: 4096,
    storagePath: path.join(
      rootPath,
      ".artemis",
      "web",
      "assets",
      "package",
      `${"i".repeat(64)}.ipa`
    ),
    uploadedBy: "alice",
    metadata: {}
  });

  const response = await handlePanelRequest(assetsUrl(rootPath, null, "packages"), deps);
  assert.equal(response.status, 200);
  const html = String(response.body);
  assert.match(html, /<th scope="col">平台<\/th>/);
  assert.match(html, /app\.apk[\s\S]*?Android[\s\S]*?<code>v1<\/code>/);
  assert.match(html, /app\.ipa[\s\S]*?iOS[\s\S]*?<code>v1<\/code>/);
  assert.doesNotMatch(html, /app\.ipa[\s\S]{0,160}<code>v2<\/code>/);
});

test("web assets page: kind=package 预选安装包上传", async (t) => {
  const { deps, rootPath } = await setup(t);
  const response = await handlePanelRequest(
    new URL(
      `http://x/panel?project=${encodeURIComponent(rootPath)}&section=assets&kind=package`
    ),
    deps
  );
  assert.equal(response.status, 200);
  assert.match(response.body, /<option value="package" selected>安装包（APK\/IPA）<\/option>/);
  assert.match(response.body, /id="asset-upload"/);
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
  assert.equal(payload.scripts, undefined);
  assert.equal(payload.appPackage, null);

  assert.equal(payload.mappings[0].id, mapping.id);
});

test("web assets page: inline scripts parse", async (t) => {
  const { deps, rootPath } = await setup(t);
  const response = await handlePanelRequest(assetsUrl(rootPath), deps);
  assert.equal(response.status, 200);
  const scripts = inlineScripts(response.body);
  assert.ok(scripts.length >= 2, "主脚本 + 设计导入脚本");
  for (const [index, script] of scripts.entries()) {
    assert.doesNotThrow(() => new Function(script), `inline script ${index + 1} 语法错误`);
  }
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
    assert.ok(!response.body.includes('id="design-import-modal"'), `${role} 不渲染设计导入弹窗`);
  }

  const writable = await handlePanelRequest(assetsUrl(rootPath), {
    ...deps,
    capabilities: { actions: true, usage: true, mode: "http", role: "maintainer" }
  });
  assert.ok(!/id="asset-upload-submit"[^>]* disabled/.test(writable.body), "maintainer 可上传");
  assert.ok(!/id="mapping-save"[^>]* disabled/.test(writable.body), "maintainer 可保存");
  assert.match(writable.body, /\/panel\/api\/projects\/excel\/mapping/);
  assert.match(writable.body, /id="design-import-modal"/, "maintainer 看到设计导入弹窗");
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

test("web assets page: reference tab offers Figma URL import", async (t) => {
  const { deps, rootPath } = await setup(t);
  const response = await handlePanelRequest(assetsUrl(rootPath, null, "reference"), deps);
  assert.equal(response.status, 200);
  assert.match(response.body, /id="figma-reference-form"/);
  assert.match(response.body, /id="figma-reference-url"/);
  assert.match(response.body, /id="figma-reference-node"/);
  assert.match(response.body, /\/panel\/api\/projects\/assets\/figma/);
});

test("web assets page: reference PNG uploads as reference kind", async (t) => {
  const { deps, rootPath } = await setup(t);
  const identity = { name: "alice", role: "maintainer", source: "user" };
  const boundary = "----aosReferenceUi";
  const rawBody = multipartBody(boundary, {
    project: rootPath,
    kind: "reference",
    filename: "login.png",
    contentType: "image/png",
    content: Buffer.from("fake-png")
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
    deps
  );
  assert.equal(upload.status, 200);
  const body = JSON.parse(upload.body);
  assert.equal(body.asset.kind, "reference");
  assert.equal(body.asset.filename, "login.png");
});

test("web assets page: legacy web jobs do not count as asset usage", async (t) => {
  const { deps, rootPath, asset, pkg, store } = await setup(t);
  await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    executionMode: "maestro",
    jobSpec: {
      kind: "web-test",
      assignment: "auto",
      devicePinned: false,
      targetHostId: null,
      deviceSerial: null,
      requirements: { platform: "android", deviceKind: "any" },
      deviceLeaseId: null,
      excelAssetId: asset.id,
      packageAssetId: pkg.id,
      materialsAssetId: null,
      referenceAssetId: null,
      scriptSetId: null,
      executionMode: "maestro",
      caseFilter: { modules: [], caseIds: [] },
      retry: 0,
      allowStaleScript: false,
      allowPartialUnresolved: true,
      assetSnapshot: [
        {
          id: pkg.id,
          kind: "package",
          filename: "app.apk",
          sha256: "d".repeat(64),
          size: 1024
        }
      ]
    }
  });
  const response = await handlePanelRequest(assetsUrl(rootPath, null, "packages"), deps);
  assert.equal(response.status, 200);
  assert.match(response.body, /app\.apk[\s\S]*?<td>0<\/td>/);
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
  assert.match(response.body, /panel\?new=1#new-project/, "归档页给新建项目入口");
  assert.doesNotMatch(response.body, /恢复项目状态/, "不承诺不存在的恢复动作");
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
