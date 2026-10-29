import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { createWebProject } from "../dist/web/project-service.js";
import {
  buildScriptSetBundle,
  SCRIPT_SET_GENERATOR,
  storeScriptSet
} from "../dist/web/script-set.js";
import { buildZip } from "../dist/web/zip.js";

const CASES = [
  {
    caseId: "TC-1",
    steps: ["1. 启动 App", "2. 点击“登录”"],
    expected: "页面显示“成功”",
    preconditions: []
  },
  {
    caseId: "TC-2",
    steps: ["1. 启动 App", "2. 扫描 QR 码"],
    expected: "页面显示“成功”",
    preconditions: []
  }
];

function bundle(overrides = {}) {
  return buildScriptSetBundle({
    appId: "com.example.app",
    platform: "android",
    sourceExcelAssetId: "excel-1",
    packageAssetId: "pkg-1",
    cases: CASES,
    preconditionMode: "strict",
    ...overrides
  });
}

async function workspace(t, name = "acme") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-script-set-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore();
  const { rootPath } = await createWebProject({
    store,
    workspaceRoot: dir,
    name,
    platforms: ["android"],
    appPackage: "com.example.app"
  });
  return { store, rootPath };
}

async function asset(store, rootPath, kind, filename, content) {
  return storeWebAsset({
    store,
    rootPath,
    kind,
    filename,
    buffer: Buffer.from(content)
  });
}

test("script-set: manifest/flow 产物与计数", () => {
  const result = bundle();
  assert.equal(result.ready, 1);
  assert.equal(result.unresolved, 1);
  assert.equal(result.manifest.generator, SCRIPT_SET_GENERATOR);
  assert.equal(result.manifest.counts.cases, 2);
  assert.equal(result.manifest.counts.ready, 1);
  assert.equal(result.manifest.counts.unresolved, 1);
  const summary = result.manifest.cases.find((entry) => entry.caseId === "TC-1");
  assert.equal(summary.status, "ready");
  assert.equal(summary.flow, "flows/TC-1.yaml");
  assert.ok(result.files.some((entry) => entry.path === "flows/TC-1.yaml"));
  assert.ok(!result.files.some((entry) => entry.path === "flows/TC-2.yaml"));
  assert.ok(result.zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  assert.equal(result.sha256.length, 64);
});

test("script-set: 相同输入生成相同 zip/sha，manifest 可解析", () => {
  const first = bundle();
  const second = bundle();
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.files, second.files);
  const manifestFile = first.files.find((entry) => entry.path === "manifest.json");
  const parsed = JSON.parse(manifestFile.content);
  assert.equal(parsed.platform, "android");
  assert.equal(parsed.sourceExcelAssetId, "excel-1");
  assert.equal(parsed.packageAssetId, "pkg-1");
  assert.equal(parsed.preconditionMode, "strict");
  assert.equal(parsed.inferNavigationTap, false);
  assert.equal(parsed.includeSoftText, false);
  assert.equal(parsed.assertionDocHash, first.manifest.assertionDocHash);
});

test("script-set: assertionDocHash 随预期变化", () => {
  const first = bundle();
  const changed = bundle({
    cases: [
      { ...CASES[0], expected: "页面显示“失败”" },
      CASES[1]
    ]
  });
  assert.notEqual(first.manifest.assertionDocHash, changed.manifest.assertionDocHash);
});

test("script-set: caseId 文件名清洗与重名处理", () => {
  const result = buildScriptSetBundle({
    appId: "com.example.app",
    platform: "android",
    sourceExcelAssetId: "excel-1",
    packageAssetId: "pkg-1",
    cases: [
      { caseId: "TC/1", steps: ["1. 启动 App", "2. 点击“登录”"], expected: "页面显示“成功”" },
      { caseId: "TC:1", steps: ["1. 启动 App", "2. 点击“登录”"], expected: "页面显示“成功”" }
    ]
  });
  assert.equal(result.ready, 2);
  const flows = result.manifest.cases.map((entry) => entry.flow);
  assert.deepEqual(flows, ["flows/TC_1.yaml", "flows/TC_1-2.yaml"]);
});

test("zip: 确定性、路径排序、可被 unzip 读取", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = buildZip([
    { path: "b.txt", content: "B" },
    { path: "a.txt", content: "A" }
  ]);
  const second = buildZip([
    { path: "a.txt", content: "A" },
    { path: "b.txt", content: "B" }
  ]);
  assert.deepEqual(first, second);
  const file = path.join(dir, "scripts.zip");
  await writeFile(file, first);
  const listing = spawnSync("unzip", ["-Z1", file], { encoding: "utf8" });
  if (listing.error?.code === "ENOENT") {
    t.skip("unzip 不可用");
    return;
  }
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n"), ["a.txt", "b.txt"]);
  const content = spawnSync("unzip", ["-p", file, "a.txt"], { encoding: "utf8" });
  assert.equal(content.stdout, "A");
});

test("zip: 拒绝路径穿越、空段与重复路径", () => {
  assert.throws(() => buildZip([{ path: "../secret.txt", content: "x" }]), /非法/);
  assert.throws(() => buildZip([{ path: "a//b.txt", content: "x" }]), /非法/);
  assert.throws(
    () =>
      buildZip([
        { path: "a.txt", content: "1" },
        { path: "a.txt", content: "2" }
      ]),
    /重复/
  );
});

test("script-set: 写入 assets、metadata 与幂等复用", async (t) => {
  const { store, rootPath } = await workspace(t);
  const excel = await asset(store, rootPath, "excel", "cases.xlsx", "excel");
  const pkg = await asset(store, rootPath, "package", "app.apk", "pkg");
  const result = bundle({
    sourceExcelAssetId: excel.id,
    packageAssetId: pkg.id
  });
  const first = await storeScriptSet({ store, rootPath, bundle: result });
  assert.equal(first.created, true);
  assert.equal(first.asset.kind, "scripts");
  assert.equal(first.asset.metadata.sourceExcelAssetId, excel.id);
  assert.equal(first.asset.metadata.packageAssetId, pkg.id);
  assert.equal(first.asset.metadata.platform, "android");
  assert.equal(first.asset.metadata.origin, "generated");
  assert.equal(first.asset.metadata.generatorVersion, 1);
  assert.equal(first.asset.metadata.assertionDocHash, result.manifest.assertionDocHash);

  const second = await storeScriptSet({ store, rootPath, bundle: result });
  assert.equal(second.created, false);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 1);
});

test("script-set: 新 Excel 绑定生成新版本，不复用旧资产", async (t) => {
  const { store, rootPath } = await workspace(t);
  const excel = await asset(store, rootPath, "excel", "cases.xlsx", "excel");
  const pkg = await asset(store, rootPath, "package", "app.apk", "pkg");
  const first = await storeScriptSet({
    store,
    rootPath,
    bundle: bundle({ sourceExcelAssetId: excel.id, packageAssetId: pkg.id })
  });
  const nextExcel = await asset(store, rootPath, "excel", "cases-v2.xlsx", "excel-v2");
  const second = await storeScriptSet({
    store,
    rootPath,
    bundle: bundle({ sourceExcelAssetId: nextExcel.id, packageAssetId: pkg.id })
  });
  assert.equal(second.created, true);
  assert.notEqual(second.asset.id, first.asset.id);
  assert.equal((await store.listWebAssets(rootPath, "scripts")).length, 2);
});

test("script-set: 无 ready 用例或缺少绑定拒绝写入", async (t) => {
  const { store, rootPath } = await workspace(t);
  const unusable = buildScriptSetBundle({
    appId: "com.example.app",
    platform: "android",
    sourceExcelAssetId: "excel-1",
    packageAssetId: "pkg-1",
    cases: [CASES[1]]
  });
  await assert.rejects(
    storeScriptSet({ store, rootPath, bundle: unusable }),
    (error) => error.code === "script-set-unusable"
  );

  const invalid = bundle({ sourceExcelAssetId: "" });
  await assert.rejects(
    storeScriptSet({ store, rootPath, bundle: invalid }),
    (error) => error.code === "invalid-bundle"
  );
});
