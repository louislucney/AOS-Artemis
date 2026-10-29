import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { createWebProject } from "../dist/web/project-service.js";

async function workbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(["用例编号", "步骤", "期望结果", "前置条件"]);
  sheet.addRow(["TC-1", "1. 启动 App\n2. 点击“登录”", "页面显示“成功”", ""]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-panel-script-gen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore();
  const { rootPath } = await createWebProject({
    store,
    workspaceRoot: dir,
    name: "acme",
    platforms: ["android"],
    appPackage: "com.example.app"
  });
  const excel = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer()
  });
  const pkg = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app.apk",
    buffer: Buffer.from("fake-apk")
  });
  return { dir, store, rootPath, excel, pkg, deps: { store, env: {}, workspaceRoot: dir } };
}

function request(body, overrides = {}) {
  return {
    method: "POST",
    url: new URL("http://localhost/panel/api/projects/scripts/generate"),
    body,
    headers: {},
    ...overrides
  };
}

test("panel script gen: dry-run 返回 manifest，不写资产", async (t) => {
  const { store, rootPath, excel, pkg, deps } = await setup(t);
  const response = await handlePanelActionRequest(
    request({
      project: rootPath,
      excelAssetId: excel.id,
      packageAssetId: pkg.id,
      platform: "android",
      preconditionMode: "strict",
      dryRun: true
    }),
    deps
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.ready, 1);
  assert.equal(payload.asset, null);
  assert.equal(payload.manifest.sourceExcelAssetId, excel.id);
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 0);
});

test("panel script gen: 写入 scripts 资产并返回版本", async (t) => {
  const { store, rootPath, excel, pkg, deps } = await setup(t);
  const response = await handlePanelActionRequest(
    request({
      project: rootPath,
      excelAssetId: excel.id,
      packageAssetId: pkg.id,
      platform: "android",
      preconditionMode: "assume-prepared"
    }),
    deps
  );
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.created, true);
  assert.equal(payload.asset.kind, "scripts");
  assert.equal(payload.asset.metadata.platform, "android");
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 1);
});

test("panel script gen: viewer 403；非法平台 400", async (t) => {
  const { rootPath, excel, pkg, deps } = await setup(t);
  const viewer = await handlePanelActionRequest(
    request(
      {
        project: rootPath,
        excelAssetId: excel.id,
        packageAssetId: pkg.id,
        platform: "android"
      },
      { identity: { name: "alice", role: "viewer", source: "user" } }
    ),
    deps
  );
  assert.equal(viewer.status, 403);

  const badPlatform = await handlePanelActionRequest(
    request({
      project: rootPath,
      excelAssetId: excel.id,
      packageAssetId: pkg.id,
      platform: "web"
    }),
    deps
  );
  assert.equal(badPlatform.status, 400);
});
