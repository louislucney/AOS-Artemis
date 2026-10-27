import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { preflightGeneratedTests } from "../dist/figma/preflight.js";
import { renderCmsWorkbook } from "../dist/open/template-map.js";
import { latestFeatures, normalizeKeyword, selectByScope } from "../dist/workflow/case-selection.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function generatedCase(overrides = {}) {
  return {
    id: "case-001",
    displayId: "TC_ABC123",
    name: "修改密码",
    module: "账户设置",
    feature: "账户设置",
    section: "账户设置",
    screens: ["首页"],
    displayScreens: ["首页"],
    steps: ["点击保存"],
    prelude: [],
    preconditions: ["已登录"],
    taskDesc: "",
    continuation: false,
    startScreen: "首页",
    expectations: [{ kind: "assert", text: "出现成功提示" }],
    preflight: { screen: "首页", hints: [] },
    ...overrides
  };
}

test("CMS cases.xlsx → Excel 导入 → 用例库可被 run_regression 选中", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });

  const cases = [
    generatedCase(),
    generatedCase({
      id: "case-002",
      displayId: "TC_DEF456",
      name: "退出登录",
      steps: ["点击退出"],
      expectations: [{ kind: "assert", text: "返回登录页" }]
    })
  ];
  const workbook = await renderCmsWorkbook(cases, {
    source: "figma:https://example.com/file",
    generatedAt: "2026-10-26T00:00:00.000Z",
    model: "test-model",
    counts: { cases: cases.length, screens: 1 }
  });
  const file = path.join(dir, "cms-cases.xlsx");
  fs.writeFileSync(file, workbook);

  const rendered = new ExcelJS.Workbook();
  await rendered.xlsx.load(workbook);
  const sheet = rendered.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "用例编号",
    "功能",
    "用例名称",
    "前置条件",
    "操作步骤",
    "预期结果",
    "优先级"
  ]);
  assert.equal(sheet.getRow(2).getCell(1).value, "TC_ABC123");
  assert.equal(sheet.getRow(2).getCell(2).value, "账户设置");
  assert.equal(sheet.getRow(2).getCell(4).value, "已登录");
  assert.equal(sheet.getRow(2).getCell(5).value, "1) 点击保存");
  assert.equal(sheet.getRow(2).getCell(6).value, "1) 出现成功提示");

  const imported = await importTestDocument(runtime, { excelPath: file });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.status, "imported");
  assert.equal(imported.sets.length, 1);
  const set = imported.sets[0];
  assert.equal(set.feature, "账户设置");
  assert.equal(set.featureKey, "imp-cms-cases-账户设置");
  assert.equal(set.caseCount, 2);
  assert.match(imported.sourceId, /^imported:cms-cases\.xlsx@[0-9a-f]{8}$/);

  const document = JSON.parse(fs.readFileSync(set.jsonPath, "utf8"));
  assert.equal(document.meta.source, imported.sourceId);
  assert.equal(document.meta.feature, "账户设置");
  assert.deepEqual(
    document.flows.map((flow) => flow.name),
    ["修改密码", "退出登录"]
  );
  assert.deepEqual(
    document.flows.map((flow) => flow.displayId),
    ["TC_ABC123", "TC_DEF456"]
  );
  assert.deepEqual(document.flows[0].preconditions, ["已登录"]);
  assert.ok(document.flows[0].steps[0].includes("应出现「1) 出现成功提示」"));
  assert.ok(document.flows[1].steps[0].includes("应出现「1) 返回登录页」"));
  assert.ok(document.flows.every((flow) => flow.taskDesc.includes("【真实数据】")));

  const sets = await store.listCaseSets(runtime.project.rootDir, 10);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].source, imported.sourceId);
  assert.equal(sets[0].features[0].name, "账户设置");
  assert.equal(sets[0].features[0].caseCount, 2);

  const targets = latestFeatures(sets);
  assert.deepEqual(
    targets.map((target) => target.feature),
    ["账户设置"]
  );
  assert.match(targets[0].provenance, /^导入自 cms-cases\.xlsx@[0-9a-f]{8}$/);
  const selected = selectByScope(targets, normalizeKeyword("修改密码"));
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].caseIds, [document.flows[0].id]);

  const preflight = preflightGeneratedTests(runtime.configDirAbs, { testsPath: set.jsonPath });
  assert.equal(preflight.cases, 2);
  assert.deepEqual(preflight.dataPolicy.missing, []);
  assert.equal(preflight.artifacts.excelPresent, true);
});
