import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

import { rewriteCasesForWeb } from "../dist/figma/web-wording.js";
import { renderCmsWorkbook, templateHasCasePlaceholders } from "../dist/open/template-map.js";

function testCase(overrides = {}) {
  return {
    id: "case-1",
    displayId: "TC_000001",
    name: "登录 → 首页",
    screens: ["登录页", "首页"],
    steps: ["点击「登录」，验证进入「首页」"],
    preconditions: ["打开应用并停留在「登录页」"],
    taskDesc: "【设计流程端到端验证】打开应用…",
    continuation: false,
    startScreen: "登录页",
    prelude: [],
    expectations: [{ screen: "首页", hints: [], provenance: "explicit", confidence: "high", kind: "assert" }],
    preflight: { screen: "登录页", hints: [] },
    feature: "login",
    module: "登录",
    ...overrides
  };
}

const META = {
  source: "figma",
  generatedAt: "2026-10-21T00:00:00.000Z",
  model: "deepseek-chat",
  counts: { cases: 1, screens: 2 }
};

test("web wording: drops mobile taskDesc and uses page language", () => {
  const [rewritten] = rewriteCasesForWeb([testCase()]);
  assert.equal(rewritten.taskDesc, "");
  assert.deepEqual(rewritten.preconditions, ["打开页面并停留在「登录页」"]);
  assert.ok(!JSON.stringify(rewritten).includes("打开应用"));
});

test("cms workbook: default 7 columns", async () => {
  const buffer = await renderCmsWorkbook([testCase()], META);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(
    sheet.getRow(1).values.slice(1, 8),
    ["用例编号", "功能", "用例名称", "前置条件", "操作步骤", "预期结果", "优先级"]
  );
  const row = sheet.getRow(2);
  assert.equal(row.getCell(1).value, "TC_000001");
  assert.equal(row.getCell(2).value, "登录");
  assert.equal(row.getCell(7).value, "P2");
});

test("cms workbook: header-mapped template keeps its own columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aos-cms-xlsx-"));
  const template = join(dir, "template.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("公司模版");
    sheet.addRow(["用例标题", "功能", "步骤", "预期结果", "备注"]);
    await workbook.xlsx.writeFile(template);

    const buffer = await renderCmsWorkbook([testCase()], META, { templatePath: template });
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(buffer);
    const outSheet = out.worksheets[0];
    assert.equal(outSheet.getRow(2).getCell(1).value, "登录 → 首页");
    assert.equal(outSheet.getRow(2).getCell(2).value, "登录");
    assert.match(String(outSheet.getRow(2).getCell(3).value), /点击「登录」/);
    assert.match(String(outSheet.getRow(2).getCell(4).value), /→ 首页/);
    assert.equal(outSheet.getRow(2).getCell(5).value, null, "额外列保持空白");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cms workbook: missing required header is actionable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aos-cms-xlsx-"));
  const template = join(dir, "bad.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("模版");
    sheet.addRow(["用例编号", "功能", "用例名称", "前置条件", "操作步骤"]);
    await workbook.xlsx.writeFile(template);
    await assert.rejects(
      () => renderCmsWorkbook([testCase()], META, { templatePath: template }),
      /缺少必需列：预期结果/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cms workbook: placeholder template is detected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aos-cms-xlsx-"));
  const template = join(dir, "ph.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("模版");
    sheet.addRow(["#", "名称"]);
    sheet.addRow(["{{index}}", "{{case.name}}"]);
    await workbook.xlsx.writeFile(template);
    assert.equal(await templateHasCasePlaceholders(template), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
