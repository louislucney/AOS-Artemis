import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { caseSetsDir } from "../dist/figma/case-sets.js";
import { preflightGeneratedTests } from "../dist/figma/preflight.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function project() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  return { dir, runtime, store };
}

async function writeSheet(file, rows, mutate) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) sheet.addRow(row);
  if (mutate) mutate(sheet);
  await workbook.xlsx.writeFile(file);
  return file;
}

function sha8(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}

test("importTestDocument: 单模块 → 三件套 + 源副本 + 登记（真实数据/断言口径）", async () => {
  const { dir, runtime, store } = await project();
  const file = await writeSheet(path.join(dir, "cases.xlsx"), [
    ["用例名", "步骤", "预期", "前置"],
    ["登录", "输入账号密码并点击登录", "进入首页", "应用已安装"]
  ]);
  const first = await importTestDocument(runtime, { excelPath: file });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.status, "imported");
  assert.equal(first.sets.length, 1);
  const set = first.sets[0];
  assert.equal(set.caseCount, 1);
  assert.equal(set.feature, "cases");
  assert.match(set.featureKey, /^imp-[a-z0-9-]+-[0-9a-f]{8}$/);
  for (const filePath of [set.jsonPath, set.mdPath, set.xlsxPath]) {
    assert.ok(fs.existsSync(filePath), filePath);
  }
  const document = JSON.parse(fs.readFileSync(set.jsonPath, "utf8"));
  assert.equal(first.sourceId, `imported:cases.xlsx@${sha8(file)}`);
  assert.equal(document.meta.source, first.sourceId);
  assert.match(document.flows[0].id, new RegExp(`^imp-${sha8(file)}-2$`));
  assert.ok(document.flows[0].taskDesc.includes("【真实数据】"));
  assert.ok(document.flows[0].steps[0].includes("应出现「进入首页」"));
  assert.equal(document.flows[0].expectations[0].kind, "assert");

  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath: set.jsonPath });
  assert.equal(preflight.cases, 1);
  assert.deepEqual(preflight.weakCases, []);
  assert.deepEqual(preflight.dataPolicy.missing, []);
  assert.equal(preflight.artifacts.excelPresent, true);

  const sourceCopies = fs.readdirSync(caseSetsDir(runtime.configDirAbs)).filter((name) => name.endsWith(".source.xlsx"));
  assert.equal(sourceCopies.length, 1);
  assert.ok(first.sourceCopy.endsWith(".source.xlsx"));

  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].source, first.sourceId);
  assert.match(sets[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(sets[0].features[0].key, set.featureKey);
  assert.equal(sets[0].features[0].caseCount, 1);

  const second = await importTestDocument(runtime, { excelPath: file });
  assert.equal(second.ok, true);
  assert.equal(second.status, "skipped");
  assert.equal(second.sets[0].jsonPath, set.jsonPath);
  assert.equal(fs.readdirSync(caseSetsDir(runtime.configDirAbs)).filter((name) => name.endsWith(".json")).length, 1);
  assert.equal((await store.listCaseSets(runtime.project.rootDir, 10)).length, 1);
});

test("importTestDocument: 按模块拆集（一个登记记录，多 features）", async () => {
  const { dir, runtime, store } = await project();
  const file = await writeSheet(path.join(dir, "multi.xlsx"), [
    ["用例名", "步骤", "预期", "模块"],
    ["登录", "点击登录", "进入首页", "账户"],
    ["下单", "提交订单", "出现订单号", "交易"],
    ["退款", "申请退款", "出现退款单", "交易"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sets.length, 2);
  assert.deepEqual(result.sets.map((set) => set.feature).sort(), ["交易", "账户"]);
  assert.deepEqual(result.sets.map((set) => set.caseCount).sort(), [1, 2]);
  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].features.length, 2);
});

test("importTestDocument: columns 覆盖列名", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "custom.xlsx"), [
    ["编号", "操作", "结果"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const result = await importTestDocument(runtime, {
    excelPath: file,
    columns: { name: "编号", steps: "操作", expected: "结果" }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  assert.equal(document.flows[0].name, "登录");
  assert.ok(document.flows[0].steps[0].includes("应出现「进入首页」"));
});

test("importTestDocument: 缺必填列 → ok:false（列出当前表头）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "bad.xlsx"), [
    ["编号", "说明"],
    ["登录", "点击登录"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("缺少必需列"));
  assert.ok(result.error.includes("用例名"));
  assert.ok(result.error.includes("步骤"));
  assert.ok(result.error.includes("编号、说明"));
});

test("importTestDocument: 无预期 → explore 步骤（弱断言豁免）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "explore.xlsx"), [
    ["用例名", "步骤"],
    ["随便点点", "浏览首页"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  assert.ok(document.flows[0].steps[0].startsWith("探索"));
  assert.equal(document.flows[0].expectations[0].kind, "explore");
  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath: result.sets[0].jsonPath });
  assert.deepEqual(preflight.weakCases, []);
});
