import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { buildFlowGraph } from "../dist/figma/flows.js";
import {
  figmaGenerateTests,
  generateTestCases,
  linearizeFlows,
  renderMarkdown
} from "../dist/figma/test-gen.js";
import { renderTestsWorkbook } from "../dist/figma/test-xlsx.js";
import { deriveCasePreconditions } from "../dist/figma/preconditions.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";
import { syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

test("linearizeFlows: chains consecutive interactions into a path and stops at back edges", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const flows = linearizeFlows(graph);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].length, 3);
  assert.equal(flows[0][0].to.name, "Checkout");
  assert.equal(flows[0][1].trigger, "AFTER_TIMEOUT");
  assert.equal(flows[0][2].back, true);
});

test("generateTestCases: artemis task descriptions with locators and assertions", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const cases = generateTestCases(graph);

  assert.equal(cases.length, 1);
  const testCase = cases[0];
  assert.equal(testCase.name, "Home → Checkout → Success");
  assert.deepEqual(testCase.screens, ["Home", "Checkout", "Success"]);

  assert.match(testCase.steps[0], /点击「Buy now」（设计元素：CTA Button）/);
  assert.match(testCase.steps[0], /验证进入「Checkout」/);
  assert.match(testCase.steps[0], /「Pay now」/, "assertion hints from destination screen");
  assert.match(testCase.steps[1], /^等待 2 秒/);
  assert.match(testCase.steps[2], /返回上一页/);

  assert.match(testCase.taskDesc, /【设计流程端到端验证】Home → Checkout → Success/);
  assert.match(testCase.taskDesc, /1\) 点击「Buy now」/);
  assert.match(testCase.taskDesc, /PASS\/FAIL/);
  assert.deepEqual(testCase.preconditions, [
    "应用已安装且可正常启动",
    "开始前应用停留在「Home」页"
  ]);
  assert.match(
    testCase.taskDesc,
    /前置假设：应用已安装且可正常启动；开始前应用停留在「Home」页。/
  );
});

test("preconditions: login and list screens add data assumptions deterministically", () => {
  assert.deepEqual(deriveCasePreconditions(["登录", "商品列表", "Home"]), [
    "应用已安装且可正常启动",
    "开始前应用停留在「登录」页",
    "「登录」需要有效账号可完成登录",
    "「商品列表」需要已有可操作数据（列表非空）"
  ]);
  assert.deepEqual(deriveCasePreconditions(["Home"], { entryFallback: true }), [
    "应用已安装且可正常启动",
    "开始前应用停留在「Home」页",
    "入口屏未声明：起始页按「Home」推断"
  ]);
});

test("generateTestCases: entry screens with incoming edges are not treated as starts", () => {
  const graph = buildFlowGraph(syntheticFlowDocument({ extraEntry: true }));
  assert.deepEqual(graph.entryScreens, ["Settings"]);

  const cases = generateTestCases(graph);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].name, "Settings → Home → Checkout → Success");
  assert.match(cases[0].steps[0], /点击「Go home」/);
});

test("generateTestCases: frozen i18n keys are attached when strings.json mapping is provided", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const cases = generateTestCases(graph, {
    i18nKeys: new Map([["Buy now", "home.cta_button"]])
  });
  assert.match(cases[0].steps[0], /设计元素：CTA Button；i18n: home\.cta_button/);
  assert.match(cases[0].taskDesc, /i18n: home\.cta_button/);
});

test("renderTestsWorkbook: default sheet with header, case rows and readable styling", async () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const cases = generateTestCases(graph);
  const buffer = await renderTestsWorkbook(cases, {
    source: "unit-test",
    generatedAt: "2026-09-29T00:00:00Z",
    counts: { cases: 1, screens: 3, edges: 3 }
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("测试用例");
  assert.ok(sheet, "default sheet exists");
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    "#",
    "用例名称",
    "涉及页面",
    "前置假设",
    "步骤",
    "artemis 任务描述"
  ]);
  assert.equal(sheet.getRow(1).font.bold, true);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);

  const row = sheet.getRow(2);
  assert.equal(row.getCell(1).value, 1);
  assert.equal(row.getCell(2).value, cases[0].name);
  assert.equal(row.getCell(3).value, cases[0].screens.join(" → "));
  assert.equal(row.getCell(4).value, cases[0].preconditions.join("；"));
  assert.equal(row.getCell(5).value, cases[0].steps.map((step, index) => `${index + 1}) ${step}`).join("\n"));
  assert.equal(row.getCell(6).value, cases[0].taskDesc);
  assert.equal(row.getCell(4).alignment?.wrapText, true);
  assert.equal(row.getCell(5).alignment?.wrapText, true);
  assert.equal(row.getCell(6).alignment?.wrapText, true);
});

function makeFlowsProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const graph = buildFlowGraph(syntheticFlowDocument());
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(graph), "utf-8");
  return dir;
}

test("figma_generate_tests: default run writes tests.xlsx alongside json and md", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.ok(payload.savedTo.xlsx.endsWith(`${path.sep}design${path.sep}tests.xlsx`));
  assert.ok(fs.existsSync(payload.savedTo.xlsx));
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  const sheet = workbook.getWorksheet("测试用例");
  assert.ok(sheet);
  assert.equal(sheet.getRow(2).getCell(1).value, 1);
  assert.equal(sheet.getRow(2).getCell(2).value, payload.flows[0].name);
  assert.equal(sheet.getRow(2).getCell(3).value, payload.flows[0].screens.join(" → "));
  assert.equal(sheet.getRow(2).getCell(4).value, payload.flows[0].preconditions.join("；"));
  assert.equal(
    sheet.getRow(2).getCell(5).value,
    payload.flows[0].steps.map((step, index) => `${index + 1}) ${step}`).join("\n")
  );
  assert.equal(sheet.getRow(2).getCell(6).value, payload.flows[0].taskDesc);
});

test("figma_generate_tests: excelPath overrides output and save:false writes nothing", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const dry = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(dry.ok, true);
  assert.equal(dry.savedTo, undefined);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.xlsx")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.md")), false);

  const payload = parseToolResult(await figmaGenerateTests(runtime, { excelPath: "qa/cases.xlsx" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.savedTo.xlsx, path.join(dir, "qa", "cases.xlsx"));
  assert.ok(fs.existsSync(payload.savedTo.xlsx));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  assert.ok(workbook.getWorksheet("测试用例"));
});

const TEMPLATE_CASES = [
  {
    name: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」", "等待 2 秒"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "task one"
  },
  {
    name: "Settings",
    screens: ["Settings"],
    steps: ["点击「Go home」"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: "task two"
  }
];

const TEMPLATE_META = {
  source: "unit-test",
  generatedAt: "2026-09-29T00:00:00Z",
  counts: { cases: 2, screens: 3, edges: 2 }
};

async function writeTestTemplate(filePath, { withCaseRow = true } = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.getCell("A1").value = "来源：{{meta.source}}";
  sheet.getCell("B1").value = "{{counts.cases}} 条";
  sheet.getRow(2).values = ["用例名", "步骤"];
  if (withCaseRow) {
    sheet.getRow(3).values = [
      "{{index}}",
      "{{case.name}}",
      "{{case.steps}}",
      "{{case.taskDesc}}",
      "固定说明",
      "{{unknown.key}}",
      "{{case.preconditions}}"
    ];
    for (let column = 1; column <= 6; column += 1) {
      sheet.getRow(3).getCell(column).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFF2CC" }
      };
    }
    sheet.getRow(3).getCell(2).font = { bold: true };
  }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

test("renderTestsWorkbook template: meta placeholders, row replication and styles", async () => {
  const dir = makeTempDir("aos-tpl-");
  const templatePath = await writeTestTemplate(path.join(dir, "template.xlsx"));
  const buffer = await renderTestsWorkbook(TEMPLATE_CASES, TEMPLATE_META, { templatePath });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("用例");
  assert.equal(sheet.getCell("A1").value, "来源：unit-test");
  assert.equal(sheet.getCell("B1").value, "2 条");

  assert.equal(sheet.getRow(2).getCell(1).value, "用例名");
  assert.equal(sheet.getRow(3).getCell(1).value, 1);
  assert.equal(sheet.getRow(3).getCell(2).value, "Home → Checkout");
  assert.equal(sheet.getRow(3).getCell(3).value, "1) 点击「Buy now」\n2) 等待 2 秒");
  assert.equal(sheet.getRow(3).getCell(4).value, "task one");
  assert.equal(sheet.getRow(3).getCell(5).value, "固定说明");
  assert.equal(sheet.getRow(3).getCell(6).value, "{{unknown.key}}");
  assert.equal(sheet.getRow(3).getCell(7).value, "应用已安装且可正常启动");
  assert.equal(sheet.getRow(3).getCell(3).alignment?.wrapText, true);

  assert.equal(sheet.getRow(4).getCell(1).value, 2);
  assert.equal(sheet.getRow(4).getCell(2).value, "Settings");
  assert.equal(sheet.getRow(4).getCell(3).value, "1) 点击「Go home」");
  assert.equal(sheet.getRow(4).getCell(4).value, "task two");
  assert.equal(sheet.getRow(4).getCell(1).fill.fgColor.argb, "FFFFF2CC");
  assert.equal(sheet.getRow(4).getCell(2).font.bold, true);
});

test("renderTestsWorkbook template: rejects a template without case-level placeholders", async () => {
  const dir = makeTempDir("aos-tpl-");
  const templatePath = await writeTestTemplate(path.join(dir, "template.xlsx"), { withCaseRow: false });
  await assert.rejects(
    () => renderTestsWorkbook(TEMPLATE_CASES, TEMPLATE_META, { templatePath }),
    /行级占位符/
  );
});

test("renderTestsWorkbook template: zero cases removes the template row and keeps meta", async () => {
  const dir = makeTempDir("aos-tpl-");
  const templatePath = await writeTestTemplate(path.join(dir, "template.xlsx"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  workbook.getWorksheet("用例").getCell("A4").value = "底部说明";
  await workbook.xlsx.writeFile(templatePath);

  const buffer = await renderTestsWorkbook([], { ...TEMPLATE_META, counts: { cases: 0, screens: 0, edges: 0 } }, { templatePath });
  const rendered = new ExcelJS.Workbook();
  await rendered.xlsx.load(buffer);
  const sheet = rendered.getWorksheet("用例");
  assert.equal(sheet.getCell("A1").value, "来源：unit-test");
  assert.equal(sheet.getCell("B1").value, "0 条");
  assert.equal(sheet.getRow(3).getCell(1).value, "底部说明");
  assert.equal(sheet.rowCount, 3);
});

test("renderTestsWorkbook template: meta-only sheets are allowed beside a case row sheet", async () => {
  const dir = makeTempDir("aos-tpl-");
  const templatePath = path.join(dir, "template.xlsx");
  const workbook = new ExcelJS.Workbook();
  const casesSheet = workbook.addWorksheet("用例");
  casesSheet.getRow(1).values = ["{{index}}", "{{case.name}}"];
  const metaSheet = workbook.addWorksheet("说明");
  metaSheet.getCell("A1").value = "共 {{counts.cases}} 条流程";
  await workbook.xlsx.writeFile(templatePath);

  const buffer = await renderTestsWorkbook(TEMPLATE_CASES, TEMPLATE_META, { templatePath });
  const rendered = new ExcelJS.Workbook();
  await rendered.xlsx.load(buffer);
  assert.equal(rendered.getWorksheet("说明").getCell("A1").value, "共 2 条流程");
  assert.equal(rendered.getWorksheet("说明").rowCount, 1);
  assert.equal(rendered.getWorksheet("用例").getRow(2).getCell(2).value, "Settings");
});

test("figma_generate_tests: excelTemplate fills the workbook and reports the template", async () => {
  const dir = makeFlowsProject();
  fs.mkdirSync(path.join(dir, "qa"), { recursive: true });
  const templatePath = await writeTestTemplate(path.join(dir, "qa", "template.xlsx"));
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { excelTemplate: "qa/template.xlsx" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.excel.template, templatePath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  const sheet = workbook.getWorksheet("用例");
  assert.equal(sheet.getCell("A1").value, `来源：${path.join(dir, ".artemis", "design", "flows.json")}`);
  assert.equal(sheet.getCell("B1").value, `${payload.flows.length} 条`);
  assert.equal(sheet.getRow(3).getCell(1).value, 1);
  assert.equal(sheet.getRow(3).getCell(2).value, payload.flows[0].name);
  assert.equal(
    sheet.getRow(3).getCell(3).value,
    payload.flows[0].steps.map((step, index) => `${index + 1}) ${step}`).join("\n")
  );
});

test("figma_generate_tests: unreadable excelTemplate fails before writing anything", async () => {
  const dir = makeFlowsProject();
  fs.mkdirSync(path.join(dir, "qa"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qa", "broken.xlsx"), "not a workbook", "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  for (const excelTemplate of ["qa/missing.xlsx", "qa/broken.xlsx"]) {
    const payload = parseToolResult(await figmaGenerateTests(runtime, { excelTemplate }));
    assert.equal(payload.ok, false);
    assert.match(payload.error, /模版/);
  }
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.xlsx")), false);
});

test("renderMarkdown: checklist + embedded task descriptions", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const markdown = renderMarkdown(generateTestCases(graph), {
    source: "unit-test",
    generatedAt: "2026-09-29T00:00:00Z"
  });
  assert.match(markdown, /# 设计流程测试用例/);
  assert.match(markdown, /- 前置假设：应用已安装且可正常启动/);
  assert.match(markdown, /- \[ \] 1\) 点击「Buy now」/);
  assert.match(markdown, /### artemis 任务描述/);
  assert.match(markdown, /```text/);
});
