import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { buildFlowGraph, flowGraphWarnings } from "../dist/figma/flows.js";
import {
  applyObservations,
  reviewEdge,
  saveReconciliation
} from "../dist/figma/reconciliation.js";
import { serializeScreenMap } from "../dist/diff/screen-map.js";
import {
  applyAcceptanceVariants,
  assignRelatedCases,
  computeFlowCoverage,
  designFingerprintFor,
  disambiguateSemanticIds,
  figmaGenerateTests,
  flowGraphFingerprint,
  generateTestCases,
  humanElementLabel,
  identifierFromLayerName,
  identifierSuggestionsFromGraph,
  linearizeFlows,
  linearizeFlowsWithStats,
  renderMarkdown,
  updateTestsApiReview
} from "../dist/figma/test-gen.js";
import { normalizeElementLabel } from "../dist/diff/screen-map.js";
import { renderTestsWorkbook } from "../dist/figma/test-xlsx.js";
import { expectedResultLines } from "../dist/figma/case-view.js";
import { deriveCasePreconditions } from "../dist/figma/preconditions.js";
import { importTestDocument } from "../dist/workflow/excel-import.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";
import { syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

test("assignRelatedCases: module/shared screens, cap 3, subset scope", () => {
  const make = (id, displayId, module, screens) => ({
    id,
    displayId,
    module,
    screens,
    name: id,
    steps: [],
    preconditions: [],
    taskDesc: "",
    continuation: false,
    startScreen: screens[0],
    prelude: [],
    expectations: [],
    preflight: { screen: screens[0], hints: [] }
  });
  const a = make("a", "TC_000001", "结算", ["Home", "Checkout", "Done"]);
  const b = make("b", "TC_000002", "结算", ["Home", "Checkout", "Done"]);
  const c = make("c", "TC_000003", "结算", ["Home"]);
  const d = make("d", "TC_000004", "支付", ["Other"]);
  const cases = [a, b, c, d];
  assignRelatedCases(cases);
  assert.deepEqual(a.relatedCases, ["TC_000002", "TC_000003"]);
  assert.deepEqual(b.relatedCases, ["TC_000001", "TC_000003"]);
  assert.deepEqual(c.relatedCases, ["TC_000001", "TC_000002"]);
  assert.deepEqual(d.relatedCases, []);

  const many = [
    a,
    b,
    c,
    make("e", "TC_000005", "结算", ["Checkout"]),
    make("f", "TC_000006", "结算", ["Done"])
  ];
  assignRelatedCases(many);
  assert.equal(a.relatedCases.length, 3, "最多 3 条");

  assignRelatedCases([a, b]);
  assert.deepEqual(a.relatedCases, ["TC_000002"], "子集只引用子集内用例");
  assert.deepEqual(b.relatedCases, ["TC_000001"]);
});

test("applyAcceptanceVariants: same label on different screens keeps unique ids", () => {
  const base = {
    id: "case-aaaaaa111111",
    semanticId: "sem-aaaaaa111111",
    displayId: "TC_111111",
    name: "Home → Checkout",
    displayName: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」"],
    preconditions: [],
    taskDesc: "task\n【AOS-EXPECT】{}",
    continuation: false,
    startScreen: "Home",
    prelude: [],
    expectations: [],
    preflight: { screen: "Home", hints: [] }
  };
  const cases = [base];
  applyAcceptanceVariants(
    cases,
    [
      { screen: "Home", label: "same", data: [], expected: [] },
      { screen: "Checkout", label: "same", data: [], expected: [] }
    ],
    []
  );
  assert.equal(cases.length, 3);
  const clones = cases.filter((testCase) => testCase.variant !== undefined);
  assert.equal(new Set(clones.map((testCase) => testCase.id)).size, 2);
  assert.equal(new Set(clones.map((testCase) => testCase.semanticId)).size, 2);
  assert.equal(new Set(clones.map((testCase) => testCase.displayId)).size, 2);
});

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
    "用例编号",
    "模块",
    "Section",
    "测试数据",
    "关联用例",
    "预期结果",
    "备注/待确认"
  ]);
  assert.equal(sheet.getRow(1).font.bold, true);
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 1);

  const row = sheet.getRow(2);
  assert.equal(row.getCell(1).value, 1);
  assert.equal(row.getCell(2).value, cases[0].name);
  assert.equal(row.getCell(3).value, cases[0].screens.join(" → "));
  assert.equal(row.getCell(4).value, cases[0].preconditions.join("；"));
  assert.equal(
    row.getCell(5).value,
    (cases[0].humanSteps ?? cases[0].steps)
      .map((step, index) => `${index + 1}) ${step}`)
      .join("\n")
  );
  assert.equal(row.getCell(6).value, "—");
  assert.equal(row.getCell(7).value, "未分组");
  assert.equal(row.getCell(8).value, cases[0].preflight.screen);
  assert.equal(row.getCell(9).value, "n/a（无显式数据）");
  assert.equal(row.getCell(10).value, "—");
  assert.equal(row.getCell(11).value, expectedResultLines(cases[0]).join("\n"));
  assert.equal(row.getCell(12).value, "—");
  assert.equal(row.getCell(4).alignment?.wrapText, true);
  assert.equal(row.getCell(5).alignment?.wrapText, true);

  const executor = workbook.getWorksheet("执行器");
  assert.ok(executor, "隐藏执行器 sheet 存在");
  assert.equal(executor.state, "hidden");
  assert.equal(executor.getRow(2).getCell(1).value, cases[0].id);
  assert.equal(executor.getRow(2).getCell(4).value, cases[0].taskDesc);
  assert.match(String(executor.getRow(2).getCell(5).value), /Home/);
  assert.doesNotMatch(String(sheet.getRow(2).getCell(5).value), /设计元素|i18n|a11y/);
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
  assert.equal(sheet.getRow(2).getCell(2).value, payload.flows[0].displayName ?? payload.flows[0].name);
  assert.equal(
    sheet.getRow(2).getCell(3).value,
    (payload.flows[0].displayScreens ?? payload.flows[0].screens).join(" → ")
  );
  assert.equal(sheet.getRow(2).getCell(4).value, payload.flows[0].preconditions.join("；"));
  assert.equal(
    sheet.getRow(2).getCell(5).value,
    (payload.flows[0].humanSteps ?? payload.flows[0].steps)
      .map((step, index) => `${index + 1}) ${step}`)
      .join("\n")
  );
  const executor = workbook.getWorksheet("执行器");
  assert.equal(executor.getRow(2).getCell(4).value, payload.flows[0].taskDesc);
});

test("figma_generate_tests: saveArtifacts 可关闭 md/xlsx/caseSets，tests.json 仍落盘", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(
    await figmaGenerateTests(runtime, {
      saveArtifacts: { markdown: false, xlsx: false, caseSets: false }
    })
  );
  assert.equal(payload.ok, true);
  assert.ok(payload.savedTo.json);
  assert.equal(payload.savedTo.markdown, undefined);
  assert.equal(payload.savedTo.xlsx, undefined);
  assert.equal(payload.savedTo.caseSets, undefined);

  const designDir = path.join(dir, ".artemis", "design");
  assert.equal(fs.existsSync(path.join(designDir, "tests.json")), true);
  assert.equal(fs.existsSync(path.join(designDir, "tests.md")), false);
  assert.equal(fs.existsSync(path.join(designDir, "tests.xlsx")), false);
  assert.equal(fs.existsSync(path.join(designDir, "case-sets")), false);
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
    (payload.flows[0].humanSteps ?? payload.flows[0].steps)
      .map((step, index) => `${index + 1}) ${step}`)
      .join("\n")
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
  assert.match(markdown, /<summary>执行器指令（agent 读取）<\/summary>/);
  assert.match(markdown, /```text/);
});

function chainGraph() {
  const screen = (id, name) => ({ id, name, suggestedRoute: `/${name}`, childNames: [], textHints: [] });
  const edge = (id, from, to) => ({
    from: { id: from.id, name: from.name },
    to: to ? { id: to.id, name: to.name } : null,
    element: { id, name: `To ${to ? to.name : "?"}`, type: "BUTTON" },
    textHints: [],
    trigger: "ON_CLICK",
    actionType: "NODE"
  });
  const home = screen("s1", "Home");
  const a = screen("s2", "A");
  const b = screen("s3", "B");
  const c = screen("s4", "C");
  const d = screen("s5", "D");
  const e = screen("s6", "E");
  return {
    screens: [home, a, b, c, d, e],
    edges: [edge("e1", home, a), edge("e2", a, b), edge("e3", b, c), edge("e4", c, d), edge("e5", home, e)],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };
}

test("linearizeFlows: coverage-greedy keeps the longest journey first", () => {
  const graph = chainGraph();
  const paths = linearizeFlows(graph);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].length, 4, "long chain selected before the short branch");
  assert.deepEqual(
    paths[1].map((edge) => edge.to.name),
    ["E"]
  );
  const cases = generateTestCases(graph);
  assert.deepEqual(cases[0].screens, ["Home", "A", "B", "C", "D"]);
  assert.deepEqual(cases[1].screens, ["Home", "E"]);
});

test("linearizeFlows: redundant parallel-edge paths are dropped once coverage is complete", () => {
  const graph = chainGraph();
  graph.edges.push({
    ...graph.edges[0],
    element: { id: "e1b", name: "CTA alt", type: "BUTTON" }
  });
  const { paths, stats } = linearizeFlowsWithStats(graph);
  assert.equal(paths.length, 2, "chain + E; the parallel Home→A duplicate adds no coverage");
  assert.equal(stats.keptPaths, 2);
  assert.equal(stats.droppedPaths, 1);
  assert.equal(stats.truncated, false);
});

test("linearizeFlows: hitting the exploration cap with full coverage is not truncation", () => {
  const graph = chainGraph();
  graph.screens = graph.screens.filter((screen) => screen.name !== "E");
  graph.edges = graph.edges.filter((edge) => edge.to?.name !== "E");
  for (const edge of [...graph.edges]) {
    graph.edges.push({
      ...edge,
      element: { id: `${edge.element.id}b`, name: `${edge.element.name} alt`, type: "BUTTON" }
    });
  }
  const { paths, stats } = linearizeFlowsWithStats(graph, { maxFlows: 1 });
  assert.equal(paths.length, 1);
  assert.equal(stats.truncated, false, "all screens/edges are covered; cap only dropped duplicates");
});

test("linearizeFlows: case order is deterministic across runs", () => {
  const first = generateTestCases(chainGraph()).map((entry) => entry.id);
  const second = generateTestCases(chainGraph()).map((entry) => entry.id);
  assert.deepEqual(first, second);
});

test("linearizeFlows: maxDepth splits long journeys into contiguous segments instead of dropping the tail", () => {
  const graph = chainGraph();
  const { stats } = linearizeFlowsWithStats(graph, { maxDepth: 2 });
  assert.equal(stats.depthSplits, 1, "one kept case continues from the capped screen");
  assert.equal(stats.truncated, false, "segmentation is not truncation: nothing is dropped");

  const cases = generateTestCases(graph, { maxDepth: 2 });
  assert.deepEqual(cases[0].screens, ["Home", "A", "B"], "first segment stops at the depth cap");
  assert.equal(cases[0].continuation, false);
  assert.equal(cases[1].continuation, true, "follow-up is marked as a continuation segment");
  assert.equal(cases[1].startScreen, "B");
  assert.equal(cases[1].prelude.length, 2, "entry → cut navigation is replayable");
  assert.equal(cases[1].preflight.screen, "Home", "preflight checks the journey entry");
  assert.deepEqual(
    cases[1].screens,
    ["Home", "A", "B", "C", "D"],
    "continuation covers the full journey (prelude + segment)"
  );
  assert.deepEqual(cases[2].screens, ["Home", "E"]);
  assert.match(cases[1].taskDesc, /开始前：打开应用并确保停留在「Home」页/);
  assert.match(cases[1].taskDesc, /前导导航（仅到达起点，不计入断言）：/);
  assert.match(cases[1].taskDesc, /P1\) /);
  assert.match(cases[1].taskDesc, /用例步骤：/);
  assert.match(cases[1].taskDesc, /【AOS-EXPECT】/);
  assert.match(
    cases[1].preconditions.join("；"),
    /开始前应用停留在「Home」页/,
    "preconditions describe the actual entry, not the cut screen"
  );

  const markdown = renderMarkdown(cases, { source: "unit-test", generatedAt: "2026-10-10T00:00:00Z" });
  assert.match(markdown, /接续段：先按前导导航到「B」/);
  assert.match(markdown, /P1\) /);

  const coverage = computeFlowCoverage(graph, cases, stats);
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.uncoveredScreens, []);
  assert.deepEqual(coverage.uncoveredEdges, []);
});

test("generateTestCases: per-step expectations are machine-readable and aligned with steps", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const [testCase] = generateTestCases(graph);

  assert.equal(testCase.continuation, false);
  assert.equal(testCase.startScreen, "Home");
  assert.deepEqual(testCase.prelude, []);
  assert.equal(testCase.expectations.length, testCase.steps.length);
  assert.equal(testCase.expectations[0].screen, "Checkout");
  assert.ok(testCase.expectations[0].hints.includes("Pay now"));
  assert.equal(testCase.expectations[0].provenance, "explicit");
  assert.equal(testCase.expectations[0].confidence, "high");
  assert.equal(testCase.preflight.screen, "Home");
  assert.ok(testCase.preflight.hints.includes("Welcome Back"));

  const line = testCase.taskDesc
    .split("\n")
    .find((entry) => entry.includes("【AOS-EXPECT】"));
  assert.ok(line, "taskDesc carries the machine-readable expectation block");
  const payload = JSON.parse(line.slice(line.indexOf("【AOS-EXPECT】") + "【AOS-EXPECT】".length));
  assert.deepEqual(payload.start, {
    screen: testCase.preflight.screen,
    hints: testCase.preflight.hints
  });
  assert.equal(payload.steps.length, testCase.steps.length);
  assert.deepEqual(payload.steps[0], {
    index: 1,
    screen: testCase.expectations[0].screen,
    hints: testCase.expectations[0].hints,
    provenance: testCase.expectations[0].provenance,
    confidence: testCase.expectations[0].confidence,
    kind: testCase.expectations[0].kind,
    hintsSource: "runtime-text"
  });
  assert.equal(payload.steps[0].provenance, "explicit");
  assert.equal(payload.steps[0].confidence, "high");
  assert.equal(payload.steps[0].kind, "assert");
  assert.equal(payload.steps[0].index, 1);
  assert.equal(payload.steps[1].screen, "Success", "AFTER_TIMEOUT step keeps its destination");
});

test("figma_generate_tests: legacy flows.json (no provenance) normalizes conservatively", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: ["Welcome"] },
        { id: "s2", name: "Checkout", suggestedRoute: "/checkout", childNames: [], textHints: ["Pay now"] }
      ],
      edges: [
        {
          from: { id: "s1", name: "Home" },
          to: { id: "s2", name: "Checkout" },
          element: { id: "e1", name: "CTA", type: "INSTANCE" },
          textHints: ["Buy now"],
          trigger: "ON_CLICK",
          actionType: "NODE"
        }
      ],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  const testCase = payload.flows[0];
  assert.equal(testCase.expectations[0].provenance, "legacy-unknown");
  assert.equal(testCase.expectations[0].confidence, "low");
  assert.equal(testCase.expectations[0].kind, "explore");
  assert.deepEqual(testCase.expectations[0].hints, [], "conservative: no hard hints from legacy edges");
  assert.match(testCase.taskDesc, /探索进入「Checkout」|探索到达「Checkout」/, "legacy edges render as exploration");
  assert.equal(payload.reconciliation, undefined, "no asset file: generation is unchanged");
});

test("figma_generate_tests: upgraded reconciliation edges generate hard assertions", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "首頁",
          suggestedRoute: "/",
          childNames: [],
          textHints: [],
          provenance: "explicit",
          confidence: "high"
        },
        {
          id: "s2",
          name: "選擇門市",
          suggestedRoute: "/store",
          childNames: [],
          textHints: [{ text: "選擇門市", textClass: "runtime-text" }],
          provenance: "inferred",
          confidence: "low"
        }
      ],
      edges: [
        {
          from: { id: "s1", name: "首頁" },
          to: { id: "s2", name: "選擇門市" },
          element: { id: "e", name: "推断跳转（按画板排布）", type: "INFERRED" },
          textHints: [],
          trigger: "INFERRED",
          actionType: "INFERRED",
          provenance: "inferred",
          confidence: "low"
        }
      ],
      entryScreens: ["首頁"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(designDir, "reconciliation.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      edges: [
        {
          from: "首頁",
          to: "選擇門市",
          designProvenance: "inferred",
          provenance: "runtime-observed",
          status: "upgraded",
          traces: ["t1"],
          hits: 1,
          lastSeenAt: "2026-10-10T00:00:00.000Z"
        }
      ]
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.equal(payload.reconciliation.upgradedEdges, 1);
  const testCase = payload.flows[0];
  assert.equal(testCase.expectations[0].kind, "assert");
  assert.equal(testCase.expectations[0].provenance, "runtime-observed");
  assert.deepEqual(testCase.expectations[0].hints, ["選擇門市"]);
  assert.match(testCase.steps[0], /验证进入「選擇門市」/);
  assert.equal(testCase.taskDesc.includes("探索"), false, "promoted edge is no longer an exploration step");
});

test("figma_generate_tests: confirmed edges assert and rejected edges are dropped", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const inferredEdge = (fromId, fromName, toId, toName) => ({
    from: { id: fromId, name: fromName },
    to: { id: toId, name: toName },
    element: { id: `e-${fromId}`, name: "推断跳转（按画板排布）", type: "INFERRED" },
    textHints: [],
    trigger: "INFERRED",
    actionType: "INFERRED",
    provenance: "inferred",
    confidence: "low"
  });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "A",
          suggestedRoute: "/a",
          childNames: [],
          textHints: [],
          provenance: "inferred",
          confidence: "low"
        },
        {
          id: "s2",
          name: "B",
          suggestedRoute: "/b",
          childNames: [],
          textHints: [{ text: "乙页", textClass: "runtime-text" }],
          provenance: "inferred",
          confidence: "low"
        },
        {
          id: "s3",
          name: "C",
          suggestedRoute: "/c",
          childNames: [],
          textHints: [],
          provenance: "inferred",
          confidence: "low"
        }
      ],
      edges: [inferredEdge("s1", "A", "s2", "B"), inferredEdge("s2", "B", "s3", "C")],
      entryScreens: ["A"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const base = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [
      { from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: false },
      { from: "B", to: "C", designProvenance: "inferred", traceId: "t1", reached: false }
    ],
    "2026-10-10T00:00:00.000Z"
  ).asset;
  const confirmed = reviewEdge(base, {
    from: "A",
    to: "B",
    decision: "confirmed",
    reviewer: "louis",
    at: "2026-10-10T01:00:00.000Z"
  });
  if ("error" in confirmed) throw new Error(confirmed.error);
  const rejected = reviewEdge(confirmed.asset, {
    from: "B",
    to: "C",
    decision: "rejected",
    reviewer: "louis",
    at: "2026-10-10T02:00:00.000Z"
  });
  if ("error" in rejected) throw new Error(rejected.error);
  saveReconciliation(runtime.configDirAbs, rejected.asset);

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.equal(payload.reconciliation.confirmedEdges, 1);
  assert.equal(payload.reconciliation.rejectedEdges, 1);
  assert.equal(payload.counts.edges, 1, "rejected edges are dropped from the generated graph");
  const testCase = payload.flows[0];
  assert.equal(testCase.expectations[0].provenance, "human-confirmed");
  assert.equal(testCase.expectations[0].kind, "assert");
});

test("figma_generate_tests: pending reconciliation entries never promote (unadjudicated)", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "A",
          suggestedRoute: "/a",
          childNames: [],
          textHints: [],
          provenance: "inferred",
          confidence: "low"
        },
        {
          id: "s2",
          name: "B",
          suggestedRoute: "/b",
          childNames: [],
          textHints: [],
          provenance: "inferred",
          confidence: "low"
        }
      ],
      edges: [
        {
          from: { id: "s1", name: "A" },
          to: { id: "s2", name: "B" },
          element: { id: "e1", name: "推断跳转（按画板排布）", type: "INFERRED" },
          textHints: [],
          trigger: "INFERRED",
          actionType: "INFERRED",
          provenance: "inferred",
          confidence: "low"
        }
      ],
      entryScreens: ["A"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const pending = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [{ from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: false }],
    "2026-10-10T00:00:00.000Z"
  ).asset;
  saveReconciliation(runtime.configDirAbs, pending);

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.reconciliation, undefined, "unadjudicated entries never promote");
  assert.equal(payload.flows[0].expectations[0].kind, "explore");
});

test("figma_generate_tests: element-map identifiers appear in step notes", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify(buildFlowGraph(syntheticFlowDocument()))
  );
  fs.writeFileSync(
    path.join(designDir, "screen-map.json"),
    serializeScreenMap({
      version: 1,
      entries: [],
      elements: [
        {
          screen: "Checkout",
          text: "Buy now",
          observedLabel: "Buy now",
          identifier: "buyNowCta",
          confidence: 1,
          source: "observed",
          hits: 2,
          lastSeenAt: "2026-10-10T00:00:00.000Z"
        }
      ]
    })
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.match(payload.flows[0].steps[0], /a11y: buyNowCta/);
});

test("generateTestCases: inferred edges become exploration steps", () => {
  const graph = {
    screens: [
      {
        id: "s1",
        name: "首頁",
        suggestedRoute: "/",
        childNames: [],
        textHints: [{ text: "早安", textClass: "runtime-text" }],
        provenance: "explicit",
        confidence: "high"
      },
      {
        id: "s2",
        name: "門市",
        suggestedRoute: "/store",
        childNames: [],
        textHints: [{ text: "選擇門市", textClass: "runtime-text" }],
        provenance: "explicit",
        confidence: "high"
      },
      {
        id: "s3",
        name: "訂單",
        suggestedRoute: "/order",
        childNames: [],
        textHints: [{ text: "訂單狀態", textClass: "runtime-text" }],
        provenance: "inferred",
        confidence: "low"
      }
    ],
    edges: [
      {
        from: { id: "s1", name: "首頁" },
        to: { id: "s2", name: "門市" },
        element: { id: "e1", name: "門市入口", type: "BUTTON" },
        textHints: [],
        trigger: "ON_CLICK",
        actionType: "NODE",
        provenance: "explicit",
        confidence: "high"
      },
      {
        from: { id: "s2", name: "門市" },
        to: { id: "s3", name: "訂單" },
        element: { id: "e2", name: "推断跳转（按画板排布）", type: "INFERRED" },
        textHints: [],
        trigger: "INFERRED",
        actionType: "INFERRED",
        provenance: "inferred",
        confidence: "low"
      }
    ],
    entryScreens: ["首頁"],
    unresolvedDestinations: []
  };

  const [testCase] = generateTestCases(graph);
  assert.equal(testCase.steps.length, 2);
  assert.match(testCase.steps[0], /^点击「門市入口」/, "explicit steps keep the hard-assert path");
  assert.match(testCase.steps[0], /页面应出现「選擇門市」/);
  assert.match(testCase.steps[1], /^探索到达「訂單」/);
  assert.ok(!testCase.steps[1].includes("应"), "exploration steps carry no assertions");

  assert.equal(testCase.expectations[0].kind, "assert");
  assert.deepEqual(testCase.expectations[0].hints, ["選擇門市"]);
  assert.equal(testCase.expectations[1].kind, "explore");
  assert.deepEqual(testCase.expectations[1].hints, [], "explore steps carry no hard hints");
  assert.equal(testCase.expectations[1].screen, "訂單", "the exploration goal is kept");
  assert.match(testCase.taskDesc, /含 1 步探索/);

  const line = testCase.taskDesc.split("\n").find((entry) => entry.includes("【AOS-EXPECT】"));
  const block = JSON.parse(line.slice(line.indexOf("【AOS-EXPECT】") + "【AOS-EXPECT】".length));
  assert.equal(block.steps[0].kind, "assert");
  assert.equal(block.steps[1].kind, "explore");

  const markdown = renderMarkdown([testCase], { source: "test", generatedAt: "now" });
  assert.match(markdown, /1\) 点击「門市入口」/);
  assert.match(markdown, /2\) 探索到达「訂單」/);
});

test("generateTestCases: exploration wording respects trigger semantics (timeout/back/unknown)", () => {
  const screens = [
    { id: "s1", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] },
    { id: "s2", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] }
  ];
  const baseEdge = {
    from: { id: "s1", name: "A" },
    to: { id: "s2", name: "B" },
    element: { id: "e", name: "E", type: "INFERRED" },
    textHints: [],
    trigger: "INFERRED",
    actionType: "INFERRED",
    provenance: "inferred",
    confidence: "low"
  };
  const graphOf = (edge) => ({ screens, edges: [edge], entryScreens: ["A"], unresolvedDestinations: [] });

  const [timeoutCase] = generateTestCases(
    graphOf({ ...baseEdge, trigger: "AFTER_TIMEOUT", triggerTimeoutMs: 2000 })
  );
  assert.match(timeoutCase.steps[0], /^等待 2 秒后确认到达「B」/);

  const [backCase] = generateTestCases(graphOf({ ...baseEdge, back: true }));
  assert.match(backCase.steps[0], /^探索返回上一屏/);

  const [unknownCase] = generateTestCases(graphOf({ ...baseEdge, to: null }));
  assert.match(unknownCase.steps[0], /^探索未知跳转/);
});

test("generateTestCases: assertions consume runtime text only (starbucks regression)", () => {
  const graph = {
    screens: [
      {
        id: "s1",
        name: "首頁",
        suggestedRoute: "/",
        childNames: ["Flow/Section"],
        textHints: [
          { text: "早安, Amy☀️", textClass: "runtime-text" },
          { text: "刊頭廣告 - 活動跑馬燈", textClass: "annotation" }
        ],
        provenance: "inferred",
        confidence: "low"
      },
      {
        id: "s2",
        name: "選擇門市",
        suggestedRoute: "/store",
        childNames: ["我的最愛", "全部"],
        textHints: [{ text: "選擇門市", textClass: "runtime-text" }],
        provenance: "inferred",
        confidence: "low"
      }
    ],
    edges: [
      {
        from: { id: "s1", name: "首頁" },
        to: { id: "s2", name: "選擇門市" },
        element: { id: "e1", name: "選擇門市", type: "BUTTON" },
        textHints: [
          { text: "元素批注", textClass: "annotation" },
          { text: "內用點餐", textClass: "runtime-text" }
        ],
        trigger: "ON_CLICK",
        actionType: "NODE",
        provenance: "explicit",
        confidence: "high"
      }
    ],
    entryScreens: ["首頁"],
    unresolvedDestinations: []
  };

  const [testCase] = generateTestCases(graph);
  assert.deepEqual(testCase.expectations[0].hints, ["選擇門市"], "runtime text only; layer names excluded");
  assert.deepEqual(testCase.preflight.hints, ["早安, Amy☀️"], "annotation excluded from start hints");
  assert.match(testCase.steps[0], /点击「內用點餐」/, "annotation element hint skipped for locators");
  assert.ok(!testCase.steps[0].includes("元素批注"));
  assert.ok(!testCase.taskDesc.includes("刊頭廣告 - 活動跑馬燈"), "annotation never reaches the task");

  const line = testCase.taskDesc.split("\n").find((entry) => entry.includes("【AOS-EXPECT】"));
  const block = JSON.parse(line.slice(line.indexOf("【AOS-EXPECT】") + "【AOS-EXPECT】".length));
  assert.deepEqual(block.steps[0].hints, ["選擇門市"]);
  assert.deepEqual(block.start.hints, ["早安, Amy☀️"]);
});

test("linearizeFlows: default maxDepth walks a 22-edge pen-style chain end to end", () => {
  const screens = Array.from({ length: 23 }, (_, index) => ({
    id: `s${index + 1}`,
    name: `S${index + 1}`,
    suggestedRoute: `/s${index + 1}`,
    childNames: [],
    textHints: []
  }));
  const edges = screens.slice(0, -1).map((from, index) => ({
    from: { id: from.id, name: from.name },
    to: { id: screens[index + 1].id, name: screens[index + 1].name },
    element: { id: `e${index + 1}`, name: `推断跳转（按画板排布）`, type: "INFERRED" },
    textHints: [],
    trigger: "INFERRED",
    actionType: "INFERRED"
  }));
  const graph = { screens, edges, entryScreens: ["S1"], unresolvedDestinations: [] };

  const cases = generateTestCases(graph);
  assert.equal(cases.length, 1, "the whole chain is one continuous case");
  assert.equal(cases[0].steps.length, 22);
  assert.equal(cases[0].screens.length, 23);
  const coverage = computeFlowCoverage(graph, cases, linearizeFlowsWithStats(graph).stats);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.truncated, false);
});

function makeOrphanFlowsProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const graph = buildFlowGraph(syntheticFlowDocument());
  graph.screens.push({
    id: "99:1",
    name: "Orphan",
    suggestedRoute: "/orphan",
    childNames: [],
    textHints: []
  });
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(graph), "utf-8");
  return dir;
}

test("figma_generate_tests: coverage complete on a clean graph; requireFullCoverage writes normally", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { requireFullCoverage: true }));
  assert.equal(payload.ok, true);
  assert.equal(payload.coverage.complete, true);
  assert.equal(payload.coverage.truncated, false);
  assert.deepEqual(payload.coverage.uncoveredScreens, []);
  assert.deepEqual(payload.coverage.uncoveredEdges, []);
  assert.ok(fs.existsSync(payload.savedTo.json));
});

test("figma_generate_tests: exploration steps land in all three artifacts", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: ["Welcome"] },
        { id: "s2", name: "Checkout", suggestedRoute: "/checkout", childNames: [], textHints: ["Pay now"] }
      ],
      edges: [
        {
          from: { id: "s1", name: "Home" },
          to: { id: "s2", name: "Checkout" },
          element: { id: "e1", name: "CTA", type: "INSTANCE" },
          textHints: ["Buy now"],
          trigger: "ON_CLICK",
          actionType: "NODE"
        }
      ],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));
  assert.ok(fs.existsSync(payload.savedTo.xlsx));

  const saved = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.match(saved.flows[0].steps[0], /^探索到达「Checkout」/);
  assert.equal(saved.flows[0].expectations[0].kind, "explore");
  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /探索到达「Checkout」/);
});

test("figma_generate_tests: uncovered screen fails requireFullCoverage without writing files", async () => {
  const dir = makeOrphanFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const report = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(report.ok, true);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(report.coverage.uncoveredScreens, ["Orphan"]);

  const gated = parseToolResult(await figmaGenerateTests(runtime, { requireFullCoverage: true }));
  assert.equal(gated.ok, false);
  assert.match(gated.error, /流程覆盖不完整/);
  assert.match(gated.error, /Orphan/);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.xlsx")), false);
});

test("computeFlowCoverage: truncation and uncovered transitions mark incomplete", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const cases = generateTestCases(graph);
  assert.equal(computeFlowCoverage(graph, cases).complete, true);

  const truncated = computeFlowCoverage(graph, cases, { truncated: true, entryFallback: false });
  assert.equal(truncated.complete, false);
  assert.equal(truncated.truncated, true);

  const partial = computeFlowCoverage(graph, [{ ...cases[0], screens: ["Home"] }], {
    truncated: false,
    entryFallback: false
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.uncoveredScreens, ["Checkout", "Success"]);
  assert.deepEqual(partial.uncoveredEdges, ["Home → Checkout", "Checkout → Success"]);
});

test("computeFlowCoverage: inferred edges are explore-only (hard gate not inflated)", () => {
  const screens = [
    {
      id: "s1",
      name: "A",
      suggestedRoute: "/a",
      childNames: [],
      textHints: [],
      provenance: "inferred",
      confidence: "low"
    },
    {
      id: "s2",
      name: "B",
      suggestedRoute: "/b",
      childNames: [],
      textHints: [],
      provenance: "inferred",
      confidence: "low"
    }
  ];
  const edges = [
    {
      from: { id: "s1", name: "A" },
      to: { id: "s2", name: "B" },
      element: { id: "e", name: "E", type: "INFERRED" },
      textHints: [],
      trigger: "INFERRED",
      actionType: "INFERRED",
      provenance: "inferred",
      confidence: "low"
    }
  ];
  const graph = { screens, edges, entryScreens: ["A"], unresolvedDestinations: [] };

  const full = computeFlowCoverage(graph, [{ screens: ["A", "B"] }]);
  assert.equal(full.complete, true, "no hard targets: the gate is vacuously complete");
  assert.equal(full.explore.complete, true);
  assert.deepEqual(full.uncoveredScreens, []);

  const partial = computeFlowCoverage(graph, [{ screens: ["A"] }]);
  assert.equal(partial.complete, true, "exploration gaps never gate");
  assert.equal(partial.explore.complete, false);
  assert.deepEqual(partial.explore.uncoveredScreens, ["B"]);
  assert.deepEqual(partial.explore.uncoveredEdges, ["A → B"]);

  const hard = buildFlowGraph(syntheticFlowDocument());
  const hardPartial = computeFlowCoverage(hard, [{ screens: ["Home"] }]);
  assert.equal(hardPartial.complete, false, "confirmed evidence still gates");
  assert.deepEqual(hardPartial.uncoveredScreens, ["Checkout", "Success"]);
  assert.equal(hardPartial.explore.complete, true);

  const legacyGraph = {
    screens: [
      { id: "s1", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] },
      { id: "s2", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] }
    ],
    edges: [],
    entryScreens: ["A"],
    unresolvedDestinations: []
  };
  const legacy = computeFlowCoverage(legacyGraph, [{ screens: ["A"] }]);
  assert.equal(legacy.complete, false, "legacy artifacts stay gating (fail loud, never weakened)");
  assert.deepEqual(legacy.uncoveredScreens, ["B"]);
});

test("flowGraphWarnings: no-entry, unreachable screens and unresolved destinations", () => {
  const screen = (id, name) => ({ id, name, suggestedRoute: `/${name}`, childNames: [], textHints: [] });
  const edge = (from, to) => ({
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    element: { id: `${from.id}:1`, name: "Tap", type: "BUTTON" },
    textHints: [],
    trigger: "ON_CLICK",
    actionType: "NODE"
  });

  const home = screen("1", "Home");
  const loop = screen("2", "Loop");
  const warnings = flowGraphWarnings({
    screens: [home, loop],
    edges: [edge(loop, loop)],
    entryScreens: [home.name],
    unresolvedDestinations: ["9:9"]
  });
  assert.deepEqual(
    warnings.map((warning) => warning.code),
    ["unreachable-screens", "unresolved-destinations"]
  );
  assert.deepEqual(warnings[0].details, ["Loop"]);
  assert.deepEqual(warnings[1].details, ["9:9"]);

  const noEntry = flowGraphWarnings({
    screens: [home, loop],
    edges: [edge(home, loop), edge(loop, home)],
    entryScreens: [],
    unresolvedDestinations: []
  });
  assert.deepEqual(
    noEntry.map((warning) => warning.code),
    ["no-entry"]
  );

  assert.deepEqual(
    flowGraphWarnings(buildFlowGraph(syntheticFlowDocument())),
    []
  );
});

const BRANCH_EDGE = (id, from, to) => ({
  from: { id: from.id, name: from.name },
  to: { id: to.id, name: to.name },
  element: { id, name: `To ${to.name}`, type: "BUTTON" },
  textHints: [],
  trigger: "ON_CLICK",
  actionType: "NODE"
});

function makeBranchFlowsProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const home = { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] };
  const a = { id: "s2", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] };
  const b = { id: "s3", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] };
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [home, a, b],
      edges: [BRANCH_EDGE("e1", home, a), BRANCH_EDGE("e2", home, b)],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  return dir;
}

test("figma_generate_tests: truncated exploration blocks requireFullCoverage", async () => {
  const dir = makeBranchFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const report = parseToolResult(await figmaGenerateTests(runtime, { maxFlows: 1, save: false }));
  assert.equal(report.ok, true);
  assert.equal(report.coverage.truncated, true);
  assert.equal(report.coverage.complete, false);

  const gated = parseToolResult(
    await figmaGenerateTests(runtime, { maxFlows: 1, requireFullCoverage: true })
  );
  assert.equal(gated.ok, false);
  assert.match(gated.error, /截断/);
  assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), false);
});

test("figma_generate_tests: entry fallback is a warning, not a completeness failure", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const a = { id: "s1", name: "A", suggestedRoute: "/a", childNames: [], textHints: [] };
  const b = { id: "s2", name: "B", suggestedRoute: "/b", childNames: [], textHints: [] };
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [a, b],
      edges: [BRANCH_EDGE("e1", a, b), BRANCH_EDGE("e2", b, a)],
      entryScreens: [],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(
    await figmaGenerateTests(runtime, { requireFullCoverage: true, save: false })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.coverage.entryFallback, true);
  assert.equal(payload.coverage.complete, true);
});

test("generateTestCases: acceptance criteria back hard assertions with a source field", () => {
  const edge = (fromId, fromName, toId, toName) => ({
    from: { id: fromId, name: fromName },
    to: { id: toId, name: toName },
    element: { id: `e-${fromId}`, name: "按钮", type: "BUTTON" },
    textHints: [],
    trigger: "ON_CLICK",
    actionType: "NODE",
    provenance: "explicit",
    confidence: "high"
  });
  const graph = {
    screens: [
      {
        id: "s1",
        name: "A",
        suggestedRoute: "/a",
        childNames: [],
        textHints: [],
        provenance: "explicit",
        confidence: "high"
      },
      {
        id: "s2",
        name: "B",
        suggestedRoute: "/b",
        childNames: [],
        textHints: [{ text: "普通文本", textClass: "runtime-text" }],
        acceptance: ["金额正确", "显示订单号"],
        provenance: "explicit",
        confidence: "high"
      },
      {
        id: "s3",
        name: "C",
        suggestedRoute: "/c",
        childNames: [],
        textHints: [{ text: "提示文本", textClass: "runtime-text" }],
        provenance: "explicit",
        confidence: "high"
      }
    ],
    edges: [edge("s1", "A", "s2", "B"), edge("s2", "B", "s3", "C")],
    entryScreens: ["A"],
    unresolvedDestinations: []
  };

  const [testCase] = generateTestCases(graph);
  assert.deepEqual(testCase.expectations[0].hints, ["金额正确", "显示订单号"]);
  assert.equal(testCase.expectations[0].hintsSource, "acceptance");
  assert.deepEqual(testCase.expectations[1].hints, ["提示文本"]);
  assert.equal(testCase.expectations[1].hintsSource, "runtime-text");
  assert.match(testCase.steps[0], /金额正确/);

  const line = testCase.taskDesc.split("\n").find((entry) => entry.includes("【AOS-EXPECT】"));
  const block = JSON.parse(line.slice(line.indexOf("【AOS-EXPECT】") + "【AOS-EXPECT】".length));
  assert.equal(block.steps[0].hintsSource, "acceptance");
  assert.equal(block.steps[1].hintsSource, "runtime-text");
});

test("figma_generate_tests: acceptance.json overrides win over annotations", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "A",
          suggestedRoute: "/a",
          childNames: [],
          textHints: [],
          provenance: "explicit",
          confidence: "high"
        },
        {
          id: "s2",
          name: "B",
          suggestedRoute: "/b",
          childNames: [],
          textHints: [{ text: "普通文本", textClass: "runtime-text" }],
          acceptance: ["注释口径"],
          provenance: "explicit",
          confidence: "high"
        }
      ],
      edges: [
        {
          from: { id: "s1", name: "A" },
          to: { id: "s2", name: "B" },
          element: { id: "e1", name: "按钮", type: "BUTTON" },
          textHints: [],
          trigger: "ON_CLICK",
          actionType: "NODE",
          provenance: "explicit",
          confidence: "high"
        }
      ],
      entryScreens: ["A"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(designDir, "acceptance.json"),
    JSON.stringify({ screens: { B: ["人工口径"] } }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.deepEqual(payload.flows[0].expectations[0].hints, ["人工口径"]);
  assert.equal(payload.flows[0].expectations[0].hintsSource, "acceptance");
});

test("figma_generate_tests: acceptance applies once the navigation is upgraded", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      screens: [
        {
          id: "s1",
          name: "A",
          suggestedRoute: "/a",
          childNames: [],
          textHints: [],
          provenance: "inferred",
          confidence: "low"
        },
        {
          id: "s2",
          name: "B",
          suggestedRoute: "/b",
          childNames: [],
          textHints: [{ text: "普通文本", textClass: "runtime-text" }],
          acceptance: ["金额正确"],
          provenance: "explicit",
          confidence: "high"
        }
      ],
      edges: [
        {
          from: { id: "s1", name: "A" },
          to: { id: "s2", name: "B" },
          element: { id: "e1", name: "推断跳转（按画板排布）", type: "INFERRED" },
          textHints: [],
          trigger: "INFERRED",
          actionType: "INFERRED",
          provenance: "inferred",
          confidence: "low"
        }
      ],
      entryScreens: ["A"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const observed = applyObservations(
    { version: 1, updatedAt: null, edges: [] },
    [{ from: "A", to: "B", designProvenance: "inferred", traceId: "t1", reached: true }],
    "2026-10-10T00:00:00.000Z"
  ).asset;
  saveReconciliation(runtime.configDirAbs, observed);

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  const testCase = payload.flows[0];
  assert.equal(testCase.expectations[0].kind, "assert", "upgraded navigation enables hard assertions");
  assert.equal(testCase.expectations[0].hintsSource, "acceptance");
  assert.deepEqual(testCase.expectations[0].hints, ["金额正确"]);
});

function mkVerdictCase(caseId, verdict, extra = {}) {
  return {
    caseId,
    name: extra.name ?? `Case ${caseId}`,
    featureKey: "f-1",
    platform: "android",
    status: "failed",
    traceId: extra.traceId ?? null,
    failureDomain: "用例缺陷",
    failureConfidence: "medium",
    failureReason: "断言未命中",
    durationMs: null,
    quarantined: false,
    flaky: false,
    verdict,
    verdictBy: verdict === null ? null : "alice",
    verdictAt: verdict === null ? null : "2026-10-14T12:00:00.000Z",
    verdictNote: extra.note ?? null,
    jiraIssueKey: extra.jiraKey ?? null
  };
}

function mkVerdictRun(overrides = {}) {
  return {
    trigger: "cli",
    regressionTaskId: null,
    caseSetId: "cs-1",
    featureKey: "f-1",
    featureName: "登录",
    platform: "android",
    device: "emulator-5554",
    appVersion: null,
    runner: null,
    status: "failed",
    startedAt: "2026-10-14T10:00:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
    total: 1,
    passed: 0,
    failed: 1,
    flaky: 0,
    quarantined: 0,
    failureDomains: { 用例缺陷: 1 },
    gateResult: "fail",
    exitCode: 1,
    manifestPath: null,
    comparison: null,
    ...overrides
  };
}

test("figma_generate_tests: 匹配的案例问题裁决进入 feedback.caseDefects（total/byFeature 过滤）", async () => {
  const dir = makeFlowsProject();
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy(), store });

  const first = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(first.feedback, undefined, "无裁决 → 无 feedback 字段");
  const featureKey = first.features[0].key;

  await runtime.store.upsertProject({ rootPath: dir, name: "p" });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:05:00.000Z",
    run: mkVerdictRun({ featureKey, featureName: "登录" }),
    cases: [
      mkVerdictCase("case-a", "case-defect", { name: "验证码登录", note: "期望文案有误" }),
      mkVerdictCase("case-b", "case-defect", { name: "密码登录", note: null })
    ]
  });
  await store.recordSuiteRun({
    rootPath: dir,
    createdAt: "2026-10-14T10:06:00.000Z",
    run: mkVerdictRun({ caseSetId: "cs-other", featureKey: "f-other", featureName: "其他" }),
    cases: [mkVerdictCase("case-x", "case-defect", { note: null })]
  });

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.ok(payload.feedback, "存在匹配裁决 → feedback 字段");
  assert.deepEqual(Object.keys(payload.feedback), ["caseDefects"]);
  assert.equal(payload.feedback.caseDefects.total, 2);
  assert.deepEqual(
    payload.feedback.caseDefects.byFeature.map((entry) => entry.featureKey),
    [featureKey],
    "非本次功能 key 被过滤"
  );
  assert.equal(payload.feedback.caseDefects.byFeature[0].featureName, "登录");
  assert.deepEqual(
    payload.feedback.caseDefects.byFeature[0].cases.map((entry) => entry.caseId),
    ["case-a", "case-b"]
  );
});

test("figma_generate_tests: store 抛错 → warnings 标注且生成照常", async () => {
  const dir = makeFlowsProject();
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy(), store });
  runtime.store.listSuiteRuns = async () => {
    throw new Error("store down");
  };

  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.equal(payload.feedback, undefined, "store 不可读 → 无 feedback 字段");
  const warning = payload.warnings?.find((entry) => entry.code === "case-defect-feedback-unavailable");
  assert.ok(warning, "warnings 含案例问题反馈读取失败标注");
  assert.equal(warning.message, "案例问题反馈读取失败（跳过；不影响生成）");
  assert.ok(payload.flows.length > 0, "生成照常");
});

test("renderMarkdown: 带 feedback 追加裁决反馈段；不带/空不出现", () => {
  const cases = generateTestCases(buildFlowGraph(syntheticFlowDocument()));
  const feedback = {
    byFeature: [
      {
        featureKey: "f-login",
        featureName: "登录",
        count: 2,
        cases: [
          { caseId: "case-a", name: "验证码登录", note: "期望文案有误" },
          { caseId: "case-b", name: "密码登录", note: null }
        ]
      }
    ]
  };
  const md = renderMarkdown(cases, { source: "t", generatedAt: "now" }, { feedback });
  assert.match(md, /## 上轮案例问题修订提示（裁决反馈）/);
  assert.match(
    md,
    /- 功能「登录」：2 条（case-a「验证码登录」；备注：期望文案有误）（case-b「密码登录」）/
  );

  const without = renderMarkdown(cases, { source: "t", generatedAt: "now" });
  assert.doesNotMatch(without, /上轮案例问题修订提示/);

  const empty = renderMarkdown(cases, { source: "t", generatedAt: "now" }, { feedback: { byFeature: [] } });
  assert.doesNotMatch(empty, /上轮案例问题修订提示/);
});

test("figma_generate_tests: 文件模式把 flows warnings 写进响应/tests.json/tests.md", async () => {
  const dir = makeFlowsProject();
  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  const raw = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  const flowsWarnings = [
    {
      code: "unresolved-destinations",
      message: "2 个跳转目标不在当前解析范围内（跨文件/跨页跳转？）：对应边无目的地",
      details: ["Success", "Settings"]
    },
    { code: "no-entry", message: "原型未识别到入口屏（所有屏幕都有入边）" }
  ];
  fs.writeFileSync(flowsPath, JSON.stringify({ ...raw, warnings: flowsWarnings }), "utf-8");

  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, { screens: false }));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.designWarnings.slice(0, 2), flowsWarnings);
  assert.equal(payload.designWarningsSummary.total, payload.designWarnings.length);
  assert.equal(payload.designWarningsSummary.byCode["unresolved-destinations"], 1);
  assert.equal(payload.designWarningsSummary.bySource.flows, 2);
  assert.ok(
    payload.warnings.some((entry) => entry.code === "no-entry"),
    "合并后的 warnings 也含设计源警告"
  );

  const saved = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.deepEqual(saved.designWarnings, payload.designWarnings);
  assert.deepEqual(saved.designWarningsSummary, payload.designWarningsSummary);

  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /## 警告（设计源与生成期，不阻断生成）/);
  assert.match(markdown, /unresolved-destinations/);
  assert.match(markdown, /跨文件\/跨页跳转/);
  assert.match(markdown, /明细：Success、Settings/);
});

test("figma_generate_tests: URL 模式现算 flowGraphWarnings", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const originalTtl = process.env.AOS_FIGMA_CACHE_TTL_MS;
  process.env.FIGMA_ACCESS_TOKEN = "figma-warning-token";
  process.env.AOS_FIGMA_CACHE_TTL_MS = "0";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.figma.com" && url.pathname === "/v1/files/warn123") {
      return new Response(
        JSON.stringify({
          name: "Warn App",
          document: {
            id: "0:0",
            name: "Doc",
            type: "DOCUMENT",
            children: [
              {
                id: "1:0",
                name: "Page",
                type: "PAGE",
                children: [
                  { id: "2:1", name: "Home", type: "FRAME", children: [] },
                  { id: "2:2", name: "Detail", type: "FRAME", children: [] }
                ]
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const payload = parseToolResult(
      await figmaGenerateTests(runtime, {
        url: "https://www.figma.com/design/warn123/Warn-App",
        screens: false
      })
    );
    assert.equal(payload.ok, true);
    const warning = payload.designWarnings.find((entry) => entry.code === "no-interactions");
    assert.ok(warning, "URL 模式现算 no-interactions");
    assert.match(warning.message, /2 个屏幕未检测到任何原型交互/);
    assert.equal(payload.designWarningsSummary.byCode["no-interactions"], 1);
    assert.ok(payload.designWarningsSummary.bySource.generated >= 1);

    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, ".artemis", "design", "tests.json"), "utf-8")
    );
    assert.deepEqual(saved.designWarnings, payload.designWarnings);
    const markdown = fs.readFileSync(path.join(dir, ".artemis", "design", "tests.md"), "utf-8");
    assert.match(markdown, /## 警告（设计源与生成期，不阻断生成）/);
    assert.match(markdown, /no-interactions/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    if (originalTtl === undefined) delete process.env.AOS_FIGMA_CACHE_TTL_MS;
    else process.env.AOS_FIGMA_CACHE_TTL_MS = originalTtl;
  }
});

test("figma_generate_tests: 无警告时 md 不出现空小节", () => {
  const cases = generateTestCases(buildFlowGraph(syntheticFlowDocument()));
  const without = renderMarkdown(cases, { source: "t", generatedAt: "now" });
  assert.doesNotMatch(without, /警告（设计源与生成期/);

  const empty = renderMarkdown(cases, { source: "t", generatedAt: "now" }, { designWarnings: [] });
  assert.doesNotMatch(empty, /警告（设计源与生成期/);
});

test("figma_generate_tests: flows 与生成期 warnings 合并去重（同 code+message 只留一条）", async () => {
  const dir = makeFlowsProject();
  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  const raw = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  const shared = {
    code: "case-defect-feedback-unavailable",
    message: "案例问题反馈读取失败（跳过；不影响生成）"
  };
  fs.writeFileSync(
    flowsPath,
    JSON.stringify({
      ...raw,
      warnings: [shared, { code: "no-entry", message: "原型未识别到入口屏" }]
    }),
    "utf-8"
  );

  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  runtime.store.listSuiteRuns = async () => {
    throw new Error("store down");
  };
  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));

  const same = payload.designWarnings.filter((entry) => entry.code === shared.code);
  assert.equal(same.length, 1, "同 code+message 只保留一条");
  assert.deepEqual(same[0], shared);
  assert.equal(payload.designWarningsSummary.bySource.flows, 2);
  assert.equal(
    Object.values(payload.designWarningsSummary.bySource).reduce((sum, count) => sum + count, 0),
    payload.designWarningsSummary.total
  );
  assert.ok(
    payload.warnings.some((entry) => entry.code === shared.code),
    "生成期 warnings 仍保留"
  );
});

test("figma_generate_tests: 登记失败警告晚于落盘 → 响应与 tests.json 快照一致", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  runtime.store.recordCaseSet = async () => {
    throw new Error("store down");
  };

  const payload = parseToolResult(await figmaGenerateTests(runtime, { screens: false }));
  assert.equal(payload.ok, true);
  assert.ok(
    payload.warnings.some((entry) => entry.code === "case-set-registration-failed"),
    "晚到的登记失败警告仍在 warnings 中可见"
  );
  assert.equal(
    payload.designWarnings.some((entry) => entry.code === "case-set-registration-failed"),
    false,
    "登记期警告不进入落盘快照（避免改写已登记指纹）"
  );

  const saved = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.deepEqual(saved.designWarnings, payload.designWarnings);
  assert.deepEqual(saved.designWarningsSummary, payload.designWarningsSummary);
});

test("figma_generate_tests: acceptance v2 enriches display fields, taskDesc, xlsx and summary", async () => {
  const dir = makeFlowsProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(
    path.join(designDir, "acceptance.json"),
    JSON.stringify(
      {
        screens: { Home: ["人工首页口径"] },
        data: { Home: ["账号：已登录"], Checkout: ["商品：拿铁"] },
        questions: { Checkout: ["是否支持优惠券？"] },
        section: { Home: "结算流程" }
      },
      null,
      2
    )
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.equal(payload.schemaVersion, 2);
  const testCase = payload.flows[0];
  assert.match(testCase.displayId, /^TC_[0-9a-f]{6}$/);
  assert.equal(testCase.section, "结算流程");
  assert.ok(testCase.module.length > 0, "module 由功能名填充");
  assert.deepEqual(testCase.designRefs.screens, testCase.screens);
  assert.equal(testCase.designRefs.nodeIds.length, testCase.screens.length);
  assert.ok(
    testCase.designRefs.nodeIds.every((id) => typeof id === "string" && id.length > 0),
    "屏幕按顺序带节点 id"
  );
  assert.ok(
    typeof testCase.designRefs.route === "string" && testCase.designRefs.route.length > 0,
    "入口屏路由存在"
  );
  assert.deepEqual(testCase.testData, ["账号：已登录", "商品：拿铁"]);
  assert.deepEqual(testCase.openQuestions, ["是否支持优惠券？"]);
  assert.match(testCase.taskDesc, /【测试数据】/);
  assert.match(testCase.taskDesc, /- 账号：已登录/);
  assert.match(testCase.taskDesc, /【待确认】/);
  assert.match(testCase.taskDesc, /- 是否支持优惠券？/);

  assert.equal(payload.summary.cases, payload.flows.length);
  assert.equal(payload.summary.withTestData, payload.flows.length);
  assert.equal(payload.summary.openQuestions, 1);
  assert.equal(payload.summary.modules.length, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  const row = workbook.getWorksheet("测试用例").getRow(2);
  assert.equal(row.getCell(6).value, testCase.displayId);
  assert.equal(row.getCell(7).value, testCase.module);
  assert.equal(row.getCell(8).value, "结算流程");
  assert.match(String(row.getCell(9).value), /账号：已登录/);
  assert.ok(String(row.getCell(11).value).length > 0, "预期结果与步骤对齐");
  assert.match(String(row.getCell(12).value), /是否支持优惠券/);
  const summarySheet = workbook.getWorksheet("汇总");
  assert.ok(summarySheet, "汇总 sheet 存在");
  const summaryRows = new Map();
  summarySheet.eachRow((entry) => {
    summaryRows.set(String(entry.getCell(1).value), String(entry.getCell(2).value));
  });
  assert.equal(summaryRows.get("用例总数"), String(payload.flows.length));
  assert.match(summaryRows.get("执行统计"), /待执行/);

  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, new RegExp(`${testCase.displayId} · .* / 结算流程`));
  assert.match(markdown, /测试数据：/);
  assert.match(markdown, /预期结果：/);
  assert.match(markdown, /待确认：/);

  const caseSet = payload.savedTo.caseSets?.[0];
  assert.ok(caseSet, "功能归档存在");
  const caseSetJson = JSON.parse(fs.readFileSync(caseSet.json, "utf-8"));
  assert.equal(caseSetJson.summary.cases, caseSetJson.flows.length);
});

test("figma_generate_tests: invalid acceptance details warn without blocking", async () => {
  const dir = makeFlowsProject();
  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "acceptance.json"),
    JSON.stringify({
      data: { Home: "not-an-array" },
      questions: { Home: ["待确认项"] },
      section: "bad",
      variants: [{ screen: "Home" }, { screen: "Checkout", label: "bad-data", data: "nope" }, "nope"]
    })
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.ok(
    (payload.warnings ?? []).some((entry) => entry.code === "acceptance-details-invalid"),
    "非法 acceptance 条目可见"
  );
  assert.ok(
    (payload.warnings ?? []).some(
      (entry) => entry.code === "acceptance-details-invalid" && entry.message.includes("variants")
    ),
    "非法 variants 条目可见"
  );
  assert.deepEqual(payload.flows[0].testData, []);
  assert.deepEqual(payload.flows[0].openQuestions, ["待确认项"]);
  const scopedWarnings = payload.flows[0].designWarnings ?? [];
  assert.ok(
    scopedWarnings.some(
      (warning) =>
        warning.code === "acceptance-details-invalid" &&
        (warning.scope?.screens ?? []).includes("Home")
    ),
    "Home 作用域的设计警告挂到用例"
  );
  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /设计警告：/);
  assert.match(markdown, /acceptance-details-invalid/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  assert.match(
    String(workbook.getWorksheet("测试用例").getRow(2).getCell(12).value),
    /设计警告（acceptance-details-invalid）/
  );
});

test("figma_generate_tests: P1 variants clone with unique ids, expectations, related cases and design refs", async () => {
  const dir = makeFlowsProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(
    path.join(designDir, "acceptance.json"),
    JSON.stringify(
      {
        data: { Checkout: ["商品：拿铁"] },
        variants: [
          {
            screen: "Checkout",
            label: "优惠券已满",
            data: ["优惠券：已满"],
            expected: ["提示不可用"]
          }
        ]
      },
      null,
      2
    )
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  const bases = payload.flows.filter(
    (testCase) => testCase.variant === undefined && testCase.screens.includes("Checkout")
  );
  assert.ok(bases.length > 0, "存在覆盖 Checkout 的基准用例");
  const clones = payload.flows.filter(
    (testCase) => testCase.variant?.label === "优惠券已满"
  );
  assert.equal(clones.length, bases.length, "每条命中基准用例克隆一次");
  const base = bases[0];
  const clone = clones.find(
    (testCase) => testCase.screens.join("|") === base.screens.join("|")
  );
  assert.ok(clone, "基准用例有对应克隆");
  assert.notEqual(clone.id, base.id);
  assert.notEqual(clone.displayId, base.displayId);
  assert.deepEqual(clone.variant, {
    group: "Checkout",
    label: "优惠券已满",
    expected: ["提示不可用"]
  });
  assert.deepEqual(clone.steps, base.steps);
  assert.deepEqual(clone.expectations, base.expectations);
  assert.ok(clone.testData.includes("商品：拿铁"));
  assert.ok(clone.testData.includes("优惠券：已满"));
  assert.match(clone.taskDesc, /【变体：优惠券已满】/);
  assert.match(clone.taskDesc, /- 数据：优惠券：已满/);
  assert.match(clone.taskDesc, /- 预期：提示不可用/);
  assert.ok(base.relatedCases.includes(clone.displayId));
  assert.ok(clone.relatedCases.includes(base.displayId));
  assert.ok(clone.designRefs.screens.includes("Checkout"));
  assert.equal(payload.summary.variantGroups, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(payload.savedTo.xlsx));
  const sheet = workbook.getWorksheet("测试用例");
  let cloneRow = null;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (sheet.getRow(rowNumber).getCell(6).value === clone.displayId) {
      cloneRow = sheet.getRow(rowNumber);
      break;
    }
  }
  assert.ok(cloneRow, "变体行存在");
  assert.match(String(cloneRow.getCell(10).value), new RegExp(base.displayId));
  assert.match(String(cloneRow.getCell(11).value), /变体预期（优惠券已满）：提示不可用/);

  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(markdown, /变体预期（优惠券已满）：提示不可用/);
});

test("figma_generate_tests: variant unmatched warns and >20 variants truncate", async () => {
  const dir = makeFlowsProject();
  const designDir = path.join(dir, ".artemis", "design");
  const variants = [
    { screen: "Nope", label: "no-screen" },
    ...Array.from({ length: 21 }, (_, index) => ({ screen: "Home", label: `v${index}` }))
  ];
  fs.writeFileSync(
    path.join(designDir, "acceptance.json"),
    JSON.stringify({ variants }, null, 2)
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.ok(
    (payload.warnings ?? []).some((entry) => entry.code === "variant-screen-unmatched"),
    "未命中屏幕告警"
  );
  assert.ok(
    (payload.warnings ?? []).some((entry) => entry.code === "acceptance-details-truncated"),
    "超过 20 条 variants 截断"
  );
  const homeBases = payload.flows.filter(
    (testCase) => testCase.variant === undefined && testCase.screens.includes("Home")
  ).length;
  assert.equal(
    payload.flows.filter((testCase) => testCase.variant !== undefined).length,
    19 * homeBases,
    "前 20 条 variants 中 1 条未命中，其余 19 条各克隆一次"
  );
});

test("renderTestsWorkbook: legacy case without new fields falls back to dash/n-a", async () => {
  const legacy = [
    {
      id: "case-123456789012",
      name: "Legacy → Home",
      screens: ["Legacy", "Home"],
      steps: ["点击「继续」"],
      preconditions: ["应用已安装"],
      taskDesc: "legacy task",
      continuation: false,
      startScreen: "Legacy",
      prelude: [],
      expectations: []
    }
  ];
  const buffer = await renderTestsWorkbook(legacy, {
    source: "legacy",
    generatedAt: "2026-10-20T00:00:00Z",
    counts: { cases: 1, screens: 2, edges: 1 }
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const row = workbook.getWorksheet("测试用例").getRow(2);
  assert.equal(row.getCell(6).value, "—");
  assert.equal(row.getCell(7).value, "未分组");
  assert.equal(row.getCell(8).value, "未指定");
  assert.equal(row.getCell(9).value, "n/a（无显式数据）");
  assert.equal(row.getCell(10).value, "—");
  assert.equal(row.getCell(11).value, "1) —（无显式期望）");
  assert.equal(row.getCell(12).value, "—");
  assert.ok(workbook.getWorksheet("汇总"));
});

test("renderTestsWorkbook template: display placeholders and summary counts", async () => {
  const dir = makeTempDir("aos-tpl-view-");
  const templatePath = path.join(dir, "template.xlsx");
  const template = new ExcelJS.Workbook();
  const sheet = template.addWorksheet("用例");
  sheet.getRow(1).values = [
    "{{index}}",
    "{{case.displayId}}",
    "{{case.module}}",
    "{{case.section}}",
    "{{case.testData}}",
    "{{case.expectations}}",
    "{{case.openQuestions}}",
    "{{case.relatedCases}}",
    "{{case.designRefs}}",
    "{{case.variantLabel}}",
    "{{case.variantExpected}}",
    "{{counts.withTestData}}",
    "{{counts.openQuestions}}",
    "{{case.unknown}}"
  ];
  await template.xlsx.writeFile(templatePath);
  const testCase = {
    id: "case-abcdef123456",
    name: "Home → Checkout",
    screens: ["Home", "Checkout"],
    steps: ["点击「Buy now」"],
    preconditions: ["应用已安装"],
    taskDesc: "task",
    continuation: false,
    startScreen: "Home",
    prelude: [],
    expectations: [{ screen: "Checkout", hints: ["订单号"], provenance: "design", confidence: "high", kind: "assert" }],
    displayId: "TC_123456",
    module: "结算",
    section: "首页",
    testData: ["账号：已登录"],
    relatedCases: ["TC_654321"],
    designRefs: {
      screens: ["Home", "Checkout"],
      nodeIds: ["1:1", "1:2"],
      route: "/"
    },
    openQuestions: ["是否支持优惠券？"],
    variant: {
      group: "Checkout",
      label: "优惠券已满",
      expected: ["提示不可用"]
    }
  };
  const buffer = await renderTestsWorkbook([testCase], {
    source: "unit-test",
    generatedAt: "2026-10-20T00:00:00Z",
    counts: { cases: 1, screens: 2, edges: 1 }
  }, { templatePath });
  const rendered = new ExcelJS.Workbook();
  await rendered.xlsx.load(buffer);
  const row = rendered.getWorksheet("用例").getRow(1);
  assert.equal(row.getCell(2).value, "TC_123456");
  assert.equal(row.getCell(3).value, "结算");
  assert.equal(row.getCell(4).value, "首页");
  assert.equal(row.getCell(5).value, "- 账号：已登录");
  assert.equal(row.getCell(6).value, "1) → Checkout：订单号\n变体预期（优惠券已满）：提示不可用");
  assert.equal(row.getCell(7).value, "- 是否支持优惠券？");
  assert.equal(row.getCell(8).value, "TC_654321");
  assert.equal(row.getCell(9).value, "Home(1:1) → Checkout(1:2)");
  assert.equal(row.getCell(10).value, "优惠券已满");
  assert.equal(row.getCell(11).value, "提示不可用");
  assert.equal(row.getCell(12).value, 1);
  assert.equal(row.getCell(13).value, 1);
  assert.equal(row.getCell(14).value, "{{case.unknown}}", "未知占位符原样保留");
});

test("identifier pre-mining: conservative layer-name heuristics", () => {
  assert.equal(identifierFromLayerName("btn_login"), "btn_login");
  assert.equal(identifierFromLayerName("login-button"), "login-button");
  assert.equal(identifierFromLayerName("loginButton"), "loginButton");
  assert.equal(identifierFromLayerName("testID: login_button"), "login_button");
  assert.equal(identifierFromLayerName("a11y=checkoutButton"), "checkoutButton");
  assert.equal(identifierFromLayerName("Button"), null);
  assert.equal(identifierFromLayerName("CTA Button"), null);
  assert.equal(identifierFromLayerName("登录按钮"), null);

  const graph = {
    screens: [],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s2", name: "Checkout" },
        element: { id: "e1", name: "btn_login", type: "BUTTON" },
        textHints: [{ text: "Buy now", textClass: "runtime-text" }],
        trigger: "ON_CLICK",
        actionType: "NODE",
        provenance: "explicit",
        confidence: "high"
      }
    ],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };
  const map = identifierSuggestionsFromGraph(graph);
  assert.equal(map.get(normalizeElementLabel("Buy now")), "btn_login");
});

test("figma_generate_tests: pre-mines a11y identifier from interaction layer name", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "Home", childNames: [], textHints: [] },
        { id: "s2", name: "Checkout", childNames: [], textHints: [] }
      ],
      edges: [
        {
          from: { id: "s1", name: "Home" },
          to: { id: "s2", name: "Checkout" },
          element: { id: "e1", name: "btn_login", type: "BUTTON" },
          textHints: [{ text: "Buy now", textClass: "runtime-text" }],
          trigger: "ON_CLICK",
          actionType: "NODE",
          provenance: "explicit",
          confidence: "high"
        }
      ],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.match(payload.flows[0].steps[0], /a11y: btn_login/);
});

test("figma_generate_tests: pre-mines a11y identifier from source locators", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "Home", childNames: [], textHints: [] },
        { id: "s2", name: "Checkout", childNames: [], textHints: [] }
      ],
      edges: [
        {
          from: { id: "s1", name: "Home" },
          to: { id: "s2", name: "Checkout" },
          element: { id: "e1", name: "Button", type: "BUTTON" },
          textHints: [{ text: "Buy now", textClass: "runtime-text" }],
          trigger: "ON_CLICK",
          actionType: "NODE",
          provenance: "explicit",
          confidence: "high"
        }
      ],
      entryScreens: ["Home"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(dir, "App.tsx"),
    '<Text testID="loginButton">Buy now</Text>\n',
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(payload.ok, true);
  assert.match(payload.flows[0].steps[0], /a11y: loginButton/);
});

test("generateTestCases: humanSteps 不污染技术引用，机器 steps 保留 grounding", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const [testCase] = generateTestCases(graph, {
    i18nKeys: new Map([["Buy now", "home.cta_button"]]),
    identifiers: new Map([[normalizeElementLabel("Buy now"), "buy-button"]])
  });
  assert.match(testCase.steps[0], /设计元素/);
  assert.match(testCase.steps[0], /i18n: home\.cta_button/);
  assert.match(testCase.steps[0], /a11y: buy-button/);
  assert.doesNotMatch((testCase.humanSteps ?? []).join("\n"), /设计元素|i18n|a11y|nodeId/);
  assert.ok(Array.isArray(testCase.displayScreens));
  assert.equal(testCase.displayScreens?.length, testCase.screens.length);
});

test("renderMarkdown: 嵌入设计图与 API 待补充区块", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const cases = generateTestCases(graph);
  const markdown = renderMarkdown(
    cases,
    { source: "unit-test", generatedAt: "2026-10-23T00:00:00Z" },
    {
      images: new Map([[cases[0].id, ["screens/figma-abc/Home.png"]]]),
      apiReview: {
        change: "new",
        status: "pending",
        apiSpec: null,
        apiSpecSha256: null,
        designFingerprint: "fp",
        updatedAt: "2026-10-23T00:00:00Z"
      }
    }
  );
  assert.match(markdown, /<img src="screens\/figma-abc\/Home.png"/);
  assert.match(markdown, /待补充 API 说明/);
  assert.doesNotMatch(markdown, /### artemis 任务描述/);
  assert.match(markdown, /<summary>执行器指令/);
});

test("figma_generate_tests: API pending/provided + 补说明保留 caseId 与三件套", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const pending = parseToolResult(await figmaGenerateTests(runtime, { apiChange: "new" }));
  assert.equal(pending.apiReview.status, "pending");
  assert.equal(pending.apiReviewNextAction, "provide-api-spec");
  const caseIds = pending.flows.map((entry) => entry.id);
  const originalTaskDesc = pending.flows[0].taskDesc;
  const markdownPath = path.join(dir, ".artemis", "design", "tests.md");
  assert.match(fs.readFileSync(markdownPath, "utf-8"), /待补充 API 说明/);

  const updated = await updateTestsApiReview(runtime, {
    apiChange: "new",
    apiSpec: "POST /orders\nrequest: {sku}\nresponse: {orderId}"
  });
  assert.equal(updated.review.status, "provided");
  assert.ok(updated.updatedArtifacts.some((file) => file.endsWith("tests.md")));
  assert.ok(updated.updatedArtifacts.some((file) => file.endsWith("tests.xlsx")));
  const tests = JSON.parse(fs.readFileSync(path.join(dir, ".artemis", "design", "tests.json"), "utf-8"));
  assert.deepEqual(tests.flows.map((entry) => entry.id), caseIds, "补说明不改变 caseId");
  assert.equal(tests.flows[0].taskDesc, originalTaskDesc, "补说明不改变 taskDesc");
  assert.match(fs.readFileSync(markdownPath, "utf-8"), /POST \/orders/);
  const caseSetsDir = path.join(dir, ".artemis", "design", "case-sets");
  const caseSetFile = fs.readdirSync(caseSetsDir).find((name) => name.endsWith(".json"));
  assert.ok(caseSetFile);
  const caseSet = JSON.parse(fs.readFileSync(path.join(caseSetsDir, caseSetFile), "utf-8"));
  assert.equal(caseSet.apiReview.status, "provided", "case-set 归档携带 API 说明");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(path.join(dir, ".artemis", "design", "tests.xlsx")));
  assert.ok(workbook.getWorksheet("API 说明"));
});

test("importTestDocument: 生成工作簿回环复用隐藏 taskDesc；编辑后重建并保留 caseId", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const generated = parseToolResult(await figmaGenerateTests(runtime, {}));
  const excelPath = path.join(dir, ".artemis", "design", "tests.xlsx");
  const imported = await importTestDocument(runtime, { excelPath });
  assert.equal(imported.ok, true);
  const firstSet = JSON.parse(fs.readFileSync(imported.sets[0].jsonPath, "utf-8"));
  const firstCase = firstSet.flows[0];
  assert.equal(firstCase.id, generated.flows[0].id, "导入保留隐藏 caseId");
  assert.equal(firstCase.taskDesc, generated.flows[0].taskDesc, "未编辑复用机器 taskDesc");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(excelPath));
  const sheet = workbook.getWorksheet("测试用例");
  sheet.getRow(2).getCell(5).value = "1) 点击「Buy now」后输入备注并继续";
  const editedPath = path.join(dir, "qa-edited.xlsx");
  await workbook.xlsx.writeFile(editedPath);
  const edited = await importTestDocument(runtime, { excelPath: editedPath });
  assert.equal(edited.ok, true);
  assert.match(edited.warnings.join("\n"), /步骤已编辑/);
  const editedSet = JSON.parse(fs.readFileSync(edited.sets[0].jsonPath, "utf-8"));
  assert.equal(editedSet.flows[0].id, generated.flows[0].id, "编辑后仍保留 caseId");
  assert.match(editedSet.flows[0].taskDesc, /输入备注并继续/);
});

test("figma_generate_tests: screens:false 写入可见 warning", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, { screens: false }));
  assert.equal(payload.ok, true);
  assert.ok(
    payload.warnings.some((warning) => warning.code === "screens-disabled"),
    "关闭截图不能静默"
  );
  const markdown = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.doesNotMatch(markdown, /<img src=/);
});

test("renderMarkdown: 4 屏全量嵌入且去重后不误报 screenshot-embed-mismatch", () => {
  const graph = chainGraph();
  const cases = generateTestCases(graph);
  assert.ok(cases[0].screens.length > 3, "用例包含超过 3 个屏幕");
  const images = new Map([[cases[0].id, ["a.png", "b.png", "c.png", "d.png"]]]);
  const markdown = renderMarkdown(
    [cases[0]],
    { source: "unit", generatedAt: "2026-10-23T00:00:00Z" },
    { images }
  );
  assert.equal((markdown.match(/<img\s/gi) ?? []).length, 4);
  const deduped = renderMarkdown(
    [cases[0]],
    { source: "unit", generatedAt: "2026-10-23T00:00:00Z" },
    { images: new Map([[cases[0].id, ["a.png", "a.png", "b.png"]]]) }
  );
  assert.equal((deduped.match(/<img\s/gi) ?? []).length, 2);
});

test("importTestDocument: 仅改预期/测试数据也重建 taskDesc 并保留 caseId", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const generated = parseToolResult(await figmaGenerateTests(runtime, {}));
  const excelPath = path.join(dir, ".artemis", "design", "tests.xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);
  const sheet = workbook.getWorksheet("测试用例");
  sheet.getRow(2).getCell(9).value = "账号：test-user";
  sheet.getRow(2).getCell(11).value = "页面显示新的确认提示";
  const editedPath = path.join(dir, "qa-data-edited.xlsx");
  await workbook.xlsx.writeFile(editedPath);
  const imported = await importTestDocument(runtime, { excelPath: editedPath });
  assert.equal(imported.ok, true);
  assert.match(imported.warnings.join("\n"), /步骤已编辑|执行描述/);
  const set = JSON.parse(fs.readFileSync(imported.sets[0].jsonPath, "utf-8"));
  const first = set.flows[0];
  assert.equal(first.id, generated.flows[0].id, "保留 caseId");
  assert.match(first.taskDesc, /页面显示新的确认提示/);
  assert.match(first.taskDesc, /账号：test-user/);
});

test("semanticId 只依赖路径骨架：机器 locator/i18n 变化不影响跨端身份", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const a = generateTestCases(graph, {});
  const b = generateTestCases(graph, {
    i18nKeys: new Map([["Buy now", "home.cta_button"]]),
    identifiers: new Map([[normalizeElementLabel("Buy now"), "buy-button"]])
  });
  assert.equal(a[0].semanticId, b[0].semanticId);
  assert.equal(a[0].displayId, b[0].displayId);
  assert.notEqual(a[0].steps[0], b[0].steps[0], "机器步骤仍可含平台 locator");
});


test("designFingerprintFor/flowsFingerprint: 同一 URL 的内容变化必须改变指纹", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const changed = JSON.parse(JSON.stringify(graph));
  changed.screens[0].textHints = [
    ...(changed.screens[0].textHints ?? []),
    { text: "New copy", textClass: "runtime-text" }
  ];
  const url = "https://www.figma.com/design/same-key/Same-Name";
  const baseFlow = flowGraphFingerprint(graph);
  const changedFlow = flowGraphFingerprint(changed);
  assert.notEqual(changedFlow, baseFlow);
  assert.equal(flowGraphFingerprint(JSON.parse(JSON.stringify(graph))), baseFlow);

  const baseDesign = designFingerprintFor({}, { flowsPath: "/tmp/flows.json", url, graph });
  const changedDesign = designFingerprintFor({}, { flowsPath: "/tmp/flows.json", url, graph: changed });
  assert.notEqual(changedDesign, baseDesign);
});

test("disambiguateSemanticIds: 同路径重复出现追加稳定序号，不合并用例", () => {
  const cases = [
    { semanticId: "sem-same" },
    { semanticId: "sem-same" },
    { semanticId: "sem-other" },
    { semanticId: "sem-same" }
  ];
  disambiguateSemanticIds(cases);
  assert.deepEqual(
    cases.map((entry) => entry.semanticId),
    ["sem-same", "sem-same-2", "sem-other", "sem-same-3"]
  );
});

test("figma_generate_tests: flows.features 作为最高优先 prior，并回写稳定 key/name", async () => {
  const dir = makeFlowsProject();
  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  const flows = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  const screens = flows.screens.map((screen) => screen.name);
  flows.features = [{ key: "f-pay-fixed", name: "支付流程", screens }];
  fs.writeFileSync(flowsPath, JSON.stringify(flows), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const first = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(first.ok, true);
  assert.equal(first.features[0].key, "f-pay-fixed");
  assert.equal(first.features[0].name, "支付流程");
  assert.equal(first.flows[0].module, "支付流程");
  const persisted = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  assert.deepEqual(persisted.features, [{ key: "f-pay-fixed", name: "支付流程", screens }]);

  const second = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(second.features[0].key, "f-pay-fixed");
  assert.equal(second.features[0].name, "支付流程");
});

test("figma_generate_tests: 首次生成把 features 写回 flows.json，save:false 不写", async () => {
  const dir = makeFlowsProject();
  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  const before = fs.readFileSync(flowsPath, "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const dry = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(dry.ok, true);
  assert.equal(fs.readFileSync(flowsPath, "utf-8"), before, "save:false 不修改 flows");

  const saved = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(saved.ok, true);
  const persisted = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  assert.ok(Array.isArray(persisted.features));
  assert.equal(persisted.features.length, saved.features.length);
  assert.equal(persisted.features[0].key, saved.features[0].key);
});

test("humanElementLabel: 无可见文本时优先消费已 grounding 的 vision label", () => {
  const graph = buildFlowGraph(syntheticFlowDocument());
  const edge = graph.edges[0];
  assert.ok(edge);
  const screen = graph.screens.find((entry) => entry.name === edge.from.name);
  assert.ok(screen);
  screen.elements = [
    {
      id: "vision-1",
      class: "button",
      intent: "submit",
      label: "立即购买",
      nodeId: edge.element.id,
      provenance: "vision-inferred",
      confidence: "low"
    }
  ];
  edge.textHints = [];
  const label = humanElementLabel(edge, graph);
  assert.equal(label.label, "立即购买");
  assert.equal(label.fallback, false);
  const cases = generateTestCases(graph);
  assert.match((cases[0].humanSteps ?? []).join("\n"), /立即购买/);
});

test("figma_generate_tests: apiSpec 显式错误码缺少 error-codes 规则时给出可操作告警", async () => {
  const dir = makeFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await figmaGenerateTests(runtime, {
      apiChange: "new",
      apiSpec: "POST /api/orders\n业务错误码 ORDER_NOT_FOUND（HTTP 404）"
    })
  );
  const warning = payload.designWarnings.find(
    (entry) => entry.code === "api-spec-error-codes-missing" || entry.code === "api-spec-error-codes-gap"
  );
  assert.ok(warning, "缺规则时应告警");
  assert.match(warning.message, /error-codes\.json/);

  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(
    path.join(designDir, "error-codes.json"),
    JSON.stringify({
      codes: {
        ORDER_NOT_FOUND: {
          match: "ORDER_NOT_FOUND",
          expect: "业务拒绝",
          handledPattern: "toast"
        }
      }
    }),
    "utf-8"
  );
  const matched = parseToolResult(
    await figmaGenerateTests(runtime, {
      apiChange: "new",
      apiSpec: "POST /api/orders\n业务错误码 ORDER_NOT_FOUND（HTTP 404）"
    })
  );
  assert.equal(
    matched.designWarnings.some(
      (entry) => entry.code === "api-spec-error-codes-missing" || entry.code === "api-spec-error-codes-gap"
    ),
    false
  );
});

test("figma_generate_tests: design.sharedDir 共享 flows 作为默认设计源", async () => {
  const shared = makeTempDir("aos-shared-flow-");
  const dir = makeTempProject({ config: baseConfig({ design: { sharedDir: shared } }) });
  const graph = buildFlowGraph(syntheticFlowDocument());
  fs.writeFileSync(path.join(shared, "flows.json"), JSON.stringify(graph), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.match(payload.source, new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(fs.existsSync(path.join(dir, ".artemis", "design", "tests.json")), "产物仍写项目本地");
});
