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
  const importAudit = await store.listAudit(runtime.project.rootDir, { domain: "import" });
  assert.ok(
    importAudit.some((event) => event.action === "excel.imported" && event.result === "ok"),
    "导入落审计"
  );
  const set = first.sets[0];
  assert.equal(set.caseCount, 1);
  assert.equal(set.feature, "cases");
  assert.equal(set.featureKey, "imp-cases");
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
  assert.deepEqual(
    result.sets.map((set) => set.featureKey).sort(),
    ["imp-multi-交易", "imp-multi-账户"].sort()
  );
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

test("importTestDocument: 同一文档内容更新 → featureKey 稳定（最新份可取代旧版）", async () => {
  const { dir, runtime, store } = await project();
  const file = path.join(dir, "cases.xlsx");
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const v1 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v1.ok, true);
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"],
    ["下单", "提交订单", "出现订单号"]
  ]);
  const v2 = await importTestDocument(runtime, { excelPath: file });
  assert.equal(v2.ok, true);
  assert.equal(v2.status, "imported");
  assert.notEqual(v2.sourceId, v1.sourceId);
  assert.equal(v2.sets[0].featureKey, v1.sets[0].featureKey);
  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 2);
  assert.equal(sets[0].source, v2.sourceId, "最新份排在最前");
  assert.equal(sets[0].features[0].key, v1.sets[0].featureKey);
});

test("importTestDocument: 登记失败回滚本地归档，重试可重新导入（不落 skipped 假象）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  let failures = 1;
  const originalRecordCaseSet = runtime.store.recordCaseSet.bind(runtime.store);
  runtime.store.recordCaseSet = async (input) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("db down");
    }
    return originalRecordCaseSet(input);
  };
  const file = path.join(dir, "cases.xlsx");
  await writeSheet(file, [
    ["用例名", "步骤", "预期"],
    ["登录", "点击登录", "进入首页"]
  ]);
  const failed = await importTestDocument(runtime, { excelPath: file });
  assert.equal(failed.ok, false);
  assert.ok(failed.error.includes("登记失败"), failed.error);
  const setsDir = caseSetsDir(runtime.configDirAbs);
  const leftovers = fs.existsSync(setsDir)
    ? fs.readdirSync(setsDir).filter((name) => /\.(json|md|xlsx)$/.test(name))
    : [];
  assert.deepEqual(leftovers, [], `leftovers: ${leftovers.join(",")}`);

  const retry = await importTestDocument(runtime, { excelPath: file });
  assert.equal(retry.ok, true);
  assert.equal(retry.status, "imported");
  assert.equal((await store.listCaseSets(runtime.project.rootDir, 10)).length, 1);
});

test("importTestDocument: 扩展别名不改变旧导入器的 first-match 优先级", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "precedence.xlsx"), [
    ["用例ID", "用例编号", "用例名", "测试过程", "步骤", "预期"],
    ["EXT-1", "C-1", "登录", "错误过程", "点击登录", "进入首页"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.equal(flow.displayId, "C-1", "displayId 仍绑定旧别名列「用例编号」，不被前置「用例ID」抢走");
  assert.ok(flow.taskDesc.includes("点击登录"), flow.taskDesc);
  assert.ok(!flow.taskDesc.includes("错误过程"), flow.taskDesc);
  assert.ok(flow.steps[0].includes("点击登录"), JSON.stringify(flow.steps));
});

test("importTestDocument: displayId/testData 旧别名锁定（展示编号/测试数据）", async () => {
  const { dir, runtime } = await project();
  const file = await writeSheet(path.join(dir, "legacy-aliases.xlsx"), [
    ["用例名", "步骤", "展示编号", "测试数据"],
    ["登录", "点击登录", "D-9", "账号: demo\n密码: 123456"]
  ]);
  const result = await importTestDocument(runtime, { excelPath: file });
  assert.equal(result.ok, true, JSON.stringify(result));
  const document = JSON.parse(fs.readFileSync(result.sets[0].jsonPath, "utf8"));
  const flow = document.flows[0];
  assert.equal(flow.displayId, "D-9");
  assert.deepEqual(flow.testData, ["账号: demo", "密码: 123456"]);
  assert.ok(flow.taskDesc.includes("【测试数据】"), flow.taskDesc);
  assert.ok(flow.taskDesc.includes("账号: demo"), flow.taskDesc);
});
