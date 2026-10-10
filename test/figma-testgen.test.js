import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { buildFlowGraph, flowGraphWarnings } from "../dist/figma/flows.js";
import {
  computeFlowCoverage,
  figmaGenerateTests,
  generateTestCases,
  linearizeFlows,
  linearizeFlowsWithStats,
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
    kind: testCase.expectations[0].kind
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
  assert.match(testCase.taskDesc, /探索到达「Checkout」/, "legacy edges render as exploration");
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
