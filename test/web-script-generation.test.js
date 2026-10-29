import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { createWebProject } from "../dist/web/project-service.js";
import {
  generateScriptSetForProject,
  ScriptGenerationError
} from "../dist/web/script-generation.js";
import { runWebCommand } from "../dist/web-command.js";

async function workbookBuffer(cases, headers = ["用例编号", "步骤", "期望结果", "前置条件"]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(headers);
  for (const entry of cases) sheet.addRow(entry);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-script-gen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore();
  const { rootPath } = await createWebProject({
    store,
    workspaceRoot: dir,
    name: options.name ?? "acme",
    platforms: options.platforms ?? ["android"],
    appPackage: options.appPackage ?? "com.example.app"
  });
  const excel = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: await workbookBuffer(
      options.cases ?? [
        ["TC-1", "1. 启动 App\n2. 点击“登录”", "页面显示“成功”", ""]
      ]
    )
  });
  const pkg = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app.apk",
    buffer: Buffer.from("fake-apk")
  });
  return { dir, store, rootPath, excel, pkg };
}

test("script-generation: dry-run 只出 manifest，不写 scripts 资产", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t);
  const result = await generateScriptSetForProject({
    store,
    rootPath,
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    platform: "android",
    dryRun: true
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.ready, 1);
  assert.equal(result.unresolved, 0);
  assert.equal(result.asset, null);
  assert.equal(result.manifest.sourceExcelAssetId, excel.id);
  assert.equal(result.manifest.packageAssetId, pkg.id);
  assert.equal(result.manifest.appId, "com.example.app");
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 0);
});

test("script-generation: 写入 scripts 资产并幂等复用", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t);
  const first = await generateScriptSetForProject({
    store,
    rootPath,
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    platform: "android"
  });
  assert.equal(first.created, true);
  assert.ok(first.asset);
  assert.equal(first.asset.metadata.sourceExcelAssetId, excel.id);
  assert.equal(first.asset.metadata.platform, "android");

  const second = await generateScriptSetForProject({
    store,
    rootPath,
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    platform: "android"
  });
  assert.equal(second.created, false);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 1);
});

test("script-generation: 项目/平台/资产/appId 错误显式", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t);
  await assert.rejects(
    generateScriptSetForProject({
      store,
      rootPath,
      excelAssetId: excel.id,
      packageAssetId: pkg.id,
      platform: "ios"
    }),
    (error) => error instanceof ScriptGenerationError && error.code === "platform-not-supported"
  );
  await assert.rejects(
    generateScriptSetForProject({
      store,
      rootPath,
      excelAssetId: pkg.id,
      packageAssetId: pkg.id,
      platform: "android"
    }),
    (error) => error instanceof ScriptGenerationError && error.code === "asset-kind-mismatch"
  );
  await assert.rejects(
    generateScriptSetForProject({
      store,
      rootPath,
      excelAssetId: excel.id,
      packageAssetId: pkg.id,
      platform: "android",
      appId: "bad-app-id"
    }),
    (error) => error instanceof ScriptGenerationError && error.code === "app-id-invalid"
  );
  await assert.rejects(
    generateScriptSetForProject({
      store,
      rootPath,
      excelAssetId: "missing",
      packageAssetId: pkg.id,
      platform: "android"
    }),
    (error) => error instanceof ScriptGenerationError && error.code === "asset-not-found"
  );
});

test("script-generation: strict 前置条件未就绪时 0 ready", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t, {
    cases: [["TC-1", "1. 启动 App\n2. 点击“登录”", "页面显示“成功”", "用户已登录"]]
  });
  const strict = await generateScriptSetForProject({
    store,
    rootPath,
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    platform: "android",
    dryRun: true
  });
  assert.equal(strict.ready, 0);
  assert.equal(strict.unresolved, 1);

  const assumed = await generateScriptSetForProject({
    store,
    rootPath,
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    platform: "android",
    preconditionMode: "assume-prepared",
    dryRun: true
  });
  assert.equal(assumed.ready, 1);
});

test("web CLI: dry-run JSON 输出 manifest 与计数", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t);
  const lines = [];
  const errors = [];
  const code = await runWebCommand(
    [
      "scripts",
      "generate",
      "--project",
      rootPath,
      "--excel",
      excel.id,
      "--package",
      pkg.id,
      "--platform",
      "android",
      "--dry-run",
      "--json"
    ],
    { store, log: (line) => lines.push(line), errorLog: (line) => errors.push(line) }
  );
  assert.equal(code, 0, errors.join("\n"));
  const output = JSON.parse(lines.join("\n"));
  assert.equal(output.ok, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.ready, 1);
  assert.equal(output.asset, null);
  assert.equal(output.manifest.appId, "com.example.app");
});

test("web CLI: 写入资产并支持第二次复用", async (t) => {
  const { store, rootPath, excel, pkg } = await setup(t);
  const lines = [];
  const errors = [];
  const args = [
    "scripts",
    "generate",
    "--project",
    rootPath,
    "--excel",
    excel.id,
    "--package",
    pkg.id,
    "--platform",
    "android"
  ];
  assert.equal(
    await runWebCommand(args, { store, log: (line) => lines.push(line), errorLog: (line) => errors.push(line) }),
    0,
    errors.join("\n")
  );
  assert.ok(lines.some((line) => line.includes("新建")));
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 1);

  lines.length = 0;
  assert.equal(
    await runWebCommand(args, { store, log: (line) => lines.push(line), errorLog: (line) => errors.push(line) }),
    0,
    errors.join("\n")
  );
  assert.ok(lines.some((line) => line.includes("复用")));
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 1);
});

test("web CLI: 参数错误 exit 2", async (t) => {
  const { store } = await setup(t);
  const errors = [];
  const code = await runWebCommand(["scripts", "generate", "--platform", "android"], {
    store,
    log: () => undefined,
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("缺少 --excel")));
});
