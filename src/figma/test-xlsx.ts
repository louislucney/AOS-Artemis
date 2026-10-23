import { createHash } from "node:crypto";
import fs from "node:fs";

import ExcelJS from "exceljs";

import { errorMessage } from "../util.js";
import {
  designRefLine,
  expectedResultLines,
  openQuestionLines,
  summarizeCases,
  testDataLines,
  type CaseSummary
} from "./case-view.js";
import type { ApiReview, GeneratedTest } from "./test-gen.js";

export interface WorkbookCoverage {
  complete?: boolean;
  uncoveredScreens?: string[];
  uncoveredEdges?: string[];
  explore?: {
    complete?: boolean;
    uncoveredScreens?: string[];
    uncoveredEdges?: string[];
  };
}

export interface WorkbookMeta {
  source: string;
  generatedAt: string;
  counts: { cases: number; screens: number; edges: number };
  summary?: CaseSummary;
  coverage?: WorkbookCoverage;
  warnings?: number;
  apiReview?: ApiReview;
}

const WORKBOOK_SHEET = "测试用例";
const SUMMARY_SHEET = "汇总";
const WORKBOOK_HEADERS = [
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
];

const EXECUTOR_SHEET = "执行器";
const CASE_PLACEHOLDER = /\{\{\s*(index|case\.[A-Za-z][\w]*)\s*\}\}/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\s*\{\{\s*([A-Za-z][\w.]*)\s*\}\}\s*$/;
const NUMERIC_PLACEHOLDERS = new Set([
  "index",
  "counts.cases",
  "counts.screens",
  "counts.edges",
  "counts.withTestData",
  "counts.openQuestions"
]);

function substitute(text: string, resolve: (key: string) => string | undefined): string {
  return text.replace(PLACEHOLDER, (match, key: string) => resolve(key) ?? match);
}

function fillCell(cell: ExcelJS.Cell, resolve: (key: string) => string | undefined): void {
  if (typeof cell.value !== "string") return;
  const raw = cell.value;
  const single = raw.match(SINGLE_PLACEHOLDER);
  if (single) {
    const key = single[1]!;
    const value = resolve(key);
    if (value === undefined) return;
    cell.value = NUMERIC_PLACEHOLDERS.has(key) ? Number(value) : value;
    if (typeof cell.value === "string" && value.includes("\n")) {
      cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
    }
    return;
  }
  const next = substitute(raw, resolve);
  if (next === raw) return;
  cell.value = next;
  if (next.includes("\n")) cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
}

function renderStepsCell(testCase: GeneratedTest): string {
  const prelude = (testCase.humanPrelude ?? testCase.prelude ?? []).map(
    (step, stepIndex) => `P${stepIndex + 1}) ${step}`
  );
  const steps = (testCase.humanSteps ?? testCase.steps).map(
    (step, stepIndex) => `${stepIndex + 1}) ${step}`
  );
  return [...prelude, ...steps].join("\n");
}

export function humanStepsHashFromParts(
  steps: string,
  preconditions: string[],
  expected = "",
  testData = ""
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        steps: steps.replace(/\r\n/g, "\n").trim(),
        preconditions: preconditions.join("；"),
        expected: expected.replace(/\r\n/g, "\n").trim(),
        testData: testData.replace(/\r\n/g, "\n").trim()
      })
    )
    .digest("hex");
}

export function humanStepsHash(testCase: GeneratedTest): string {
  return humanStepsHashFromParts(
    renderStepsCell(testCase),
    testCase.preconditions ?? [],
    expectedCell(testCase),
    testDataCell(testCase)
  );
}

function textOrFallback(values: string[] | undefined, fallback: string): string {
  const list = (values ?? []).filter((value) => value.trim() !== "");
  return list.length > 0 ? list.join("\n") : fallback;
}

function displayIdOf(testCase: GeneratedTest): string {
  return testCase.displayId?.trim() ? testCase.displayId : "—";
}

function moduleOf(testCase: GeneratedTest): string {
  return testCase.module?.trim() ? testCase.module : "未分组";
}

function sectionOf(testCase: GeneratedTest): string {
  return testCase.section?.trim() ? testCase.section : "未指定";
}

function testDataCell(testCase: GeneratedTest): string {
  return textOrFallback(testDataLines(testCase), "n/a（无显式数据）");
}

function expectedCell(testCase: GeneratedTest): string {
  return textOrFallback(expectedResultLines(testCase), "—（无显式期望）");
}

function openQuestionsCell(testCase: GeneratedTest): string {
  return textOrFallback(openQuestionLines(testCase), "—");
}

function relatedCasesCell(testCase: GeneratedTest): string {
  const list = (testCase.relatedCases ?? []).filter((value) => value.trim() !== "");
  return list.length > 0 ? list.join(", ") : "—";
}

function casePlaceholderValues(testCase: GeneratedTest, index: number): Map<string, string> {
  return new Map([
    ["index", String(index + 1)],
    ["case.name", testCase.displayName ?? testCase.name],
    ["case.screens", displayScreensOf(testCase).join(" → ")],
    ["case.preconditions", (testCase.preconditions ?? []).join("；")],
    ["case.steps", renderStepsCell(testCase)],
    ["case.prelude", (testCase.humanPrelude ?? testCase.prelude ?? []).map((step, stepIndex) => `P${stepIndex + 1}) ${step}`).join("\n")],
    ["case.startScreen", testCase.startScreen ?? ""],
    ["case.continuation", testCase.continuation === true ? "是" : "否"],
    ["case.taskDesc", testCase.taskDesc],
    ["case.displayId", displayIdOf(testCase)],
    ["case.module", moduleOf(testCase)],
    ["case.section", sectionOf(testCase)],
    ["case.testData", testDataLines(testCase).join("\n")],
    ["case.relatedCases", relatedCasesCell(testCase)],
    ["case.expectations", expectedResultLines(testCase).join("\n")],
    ["case.designRefs", designRefLine(testCase)],
    ["case.openQuestions", openQuestionLines(testCase).join("\n")],
    ["case.notes", notesCell(testCase)],
    ["case.humanization", humanizationNote(testCase)],
    ["case.humanSteps", (testCase.humanSteps ?? testCase.steps).join("\n")],
    ["case.variantLabel", testCase.variant?.label ?? ""],
    ["case.variantExpected", (testCase.variant?.expected ?? []).join("\n")]
  ]);
}

function metaPlaceholderValues(meta: WorkbookMeta, summary: CaseSummary): Map<string, string> {
  return new Map([
    ["meta.source", meta.source],
    ["meta.generatedAt", meta.generatedAt],
    ["counts.cases", String(meta.counts.cases)],
    ["counts.screens", String(meta.counts.screens)],
    ["counts.edges", String(meta.counts.edges)],
    ["counts.withTestData", String(summary.withTestData)],
    ["counts.openQuestions", String(summary.openQuestions)]
  ]);
}

function findCaseTemplateRow(sheet: ExcelJS.Worksheet): number | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let hit = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === "string" && CASE_PLACEHOLDER.test(cell.value)) hit = true;
    });
    if (hit) return rowNumber;
  }
  return null;
}

/** Fill a user workbook: the first row holding a case-level placeholder is
 * replicated per case (styles preserved), then `{{meta.*}}`/`{{counts.*}}`
 * are substituted everywhere. Unknown placeholders stay verbatim. */
function applyTemplate(
  workbook: ExcelJS.Workbook,
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  summary: CaseSummary
): void {
  const metaMap = metaPlaceholderValues(meta, summary);
  let templateRows = 0;
  for (const sheet of workbook.worksheets) {
    const templateRow = findCaseTemplateRow(sheet);
    if (templateRow === null) continue;
    templateRows += 1;
    if (cases.length === 0) {
      sheet.spliceRows(templateRow, 1);
      continue;
    }
    if (cases.length > 1) sheet.duplicateRow(templateRow, cases.length - 1, true);
    cases.forEach((testCase, index) => {
      const row = sheet.getRow(templateRow + index);
      const caseMap = casePlaceholderValues(testCase, index);
      row.eachCell({ includeEmpty: false }, (cell) => {
        fillCell(cell, (key) => caseMap.get(key) ?? metaMap.get(key));
      });
    });
  }
  if (templateRows === 0) {
    throw new Error("Excel 模版缺少行级占位符（如 {{case.name}}、{{index}}）");
  }
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        fillCell(cell, (key) => metaMap.get(key));
      });
    });
  }
}

function coverageValue(coverage: WorkbookCoverage | undefined): string {
  if (!coverage) return "n/a";
  const screens = coverage.uncoveredScreens?.length ?? 0;
  const edges = coverage.uncoveredEdges?.length ?? 0;
  const complete = coverage.complete === true;
  return complete ? "complete" : `incomplete（未覆盖屏幕 ${screens} · 跳转 ${edges}）`;
}

function exploreCoverageValue(coverage: WorkbookCoverage | undefined): string {
  const explore = coverage?.explore;
  if (!explore) return "n/a";
  const screens = explore.uncoveredScreens?.length ?? 0;
  const edges = explore.uncoveredEdges?.length ?? 0;
  return explore.complete === true
    ? "complete"
    : `有缺口（未覆盖屏幕 ${screens} · 跳转 ${edges}；仅报告）`;
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  summary: CaseSummary
): void {
  const sheet = workbook.addWorksheet(SUMMARY_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: "项", key: "item", width: 24 },
    { header: "值", key: "value", width: 54 },
    { header: "说明", key: "note", width: 46 }
  ];
  sheet.getRow(1).font = { bold: true };
  const rows: Array<[string, string, string]> = [
    ["来源", meta.source, "生成或导入的输入"],
    ["生成时间", meta.generatedAt, ""],
    ["用例总数", String(meta.counts.cases), "当前产物范围"],
    ["屏幕数", String(meta.counts.screens), ""],
    ["跳转数", String(meta.counts.edges), ""],
    ["功能数", String(summary.modules.length), summary.modules.join("、") || "—"],
    ["Section 数", String(summary.sections.length), summary.sections.join("、") || "—"],
    ["有测试数据用例", String(summary.withTestData), "来自 acceptance.data"],
    ["待确认条目", String(summary.openQuestions), "来自 acceptance.questions"],
    ["变体组数", String(summary.variantGroups), "P1 变体标记"],
    ["硬覆盖", coverageValue(meta.coverage), "complete 只按硬覆盖判定"],
    ["探索覆盖", exploreCoverageValue(meta.coverage), "inferred 边仅报告"],
    ["警告数", meta.warnings === undefined ? "n/a" : String(meta.warnings), "设计源与生成期"],
    [
      "API 变更",
      meta.apiReview?.status ?? "n/a",
      meta.apiReview?.status === "pending" ? "待补充接口说明；相关执行前需补齐" : ""
    ],
    ["执行统计", "待执行（由 suite report 回填）", "生成计划不写执行结果"],
    ["平台/版本/设备", "n/a", "由运行期台账提供"]
  ];
  for (const [item, value, note] of rows) sheet.addRow({ item, value, note });
  sheet.eachRow((row) => {
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
  });
}

function displayScreensOf(testCase: GeneratedTest): string[] {
  return testCase.displayScreens ?? testCase.screens;
}

function humanizationNote(testCase: GeneratedTest): string {
  const humanization = testCase.humanization;
  if (humanization === undefined) return "";
  if (humanization.fallbacks < 3 && humanization.density <= 0.2) return "";
  return `人类层降级：${humanization.fallbacks}/${humanization.elements} 个元素回退为通用名称（${
    humanization.fallbackLabels.join("、") || "—"
  }），请结合设计图核对。`;
}

function notesCell(testCase: GeneratedTest): string {
  const notes = openQuestionsCell(testCase);
  const degradation = humanizationNote(testCase);
  if (degradation === "") return notes;
  return notes === "—" ? degradation : `${notes}\n${degradation}`;
}

function addExecutorSheet(workbook: ExcelJS.Workbook, cases: GeneratedTest[]): void {
  const sheet = workbook.addWorksheet(EXECUTOR_SHEET, { state: "hidden" });
  sheet.columns = [
    { header: "用例编号", key: "caseId", width: 40 },
    { header: "展示编号", key: "displayId", width: 14 },
    { header: "人类步骤哈希", key: "humanStepsHash", width: 20 },
    { header: "artemis 任务描述", key: "taskDesc", width: 90 },
    { header: "设计引用", key: "designRefs", width: 40 },
    { header: "语义编号", key: "semanticId", width: 20 }
  ];
  sheet.getRow(1).font = { bold: true };
  for (const testCase of cases) {
    const row = sheet.addRow({
      caseId: testCase.id,
      displayId: displayIdOf(testCase),
      humanStepsHash: humanStepsHash(testCase),
      taskDesc: testCase.taskDesc,
      designRefs: designRefLine(testCase),
      semanticId: testCase.semanticId ?? ""
    });
    row.getCell(4).alignment = { wrapText: true, vertical: "top" };
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
  }
}

function addApiReviewSheet(workbook: ExcelJS.Workbook, review: ApiReview | undefined): void {
  if (review === undefined) return;
  const sheet = workbook.addWorksheet("API 说明");
  sheet.columns = [
    { header: "项目", key: "item", width: 18 },
    { header: "内容", key: "value", width: 100 }
  ];
  const statusLabel =
    review.status === "provided"
      ? "已提供"
      : review.status === "pending"
        ? "待补充"
        : review.status === "not-applicable"
          ? "无 API 变更"
          : "未确认";
  const rows: Array<[string, string]> = [
    ["状态", statusLabel],
    ["变更类型", review.change],
    ["沿用上次说明", review.carriedForward === true ? "是（请复核）" : "否"]
  ];
  if (review.apiSpec !== null && review.apiSpec.trim() !== "") rows.push(["接口说明", review.apiSpec]);
  for (const [item, value] of rows) sheet.addRow({ item, value });
  sheet.eachRow((row) => {
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
  });
}

function defaultTestsWorkbook(
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  summary: CaseSummary
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(WORKBOOK_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }]
  });
  sheet.columns = [
    { header: WORKBOOK_HEADERS[0], key: "index", width: 5 },
    { header: WORKBOOK_HEADERS[1], key: "name", width: 36 },
    { header: WORKBOOK_HEADERS[2], key: "screens", width: 30 },
    { header: WORKBOOK_HEADERS[3], key: "preconditions", width: 40 },
    { header: WORKBOOK_HEADERS[4], key: "steps", width: 60 },
    { header: WORKBOOK_HEADERS[5], key: "displayId", width: 12 },
    { header: WORKBOOK_HEADERS[6], key: "module", width: 16 },
    { header: WORKBOOK_HEADERS[7], key: "section", width: 16 },
    { header: WORKBOOK_HEADERS[8], key: "testData", width: 30 },
    { header: WORKBOOK_HEADERS[9], key: "relatedCases", width: 18 },
    { header: WORKBOOK_HEADERS[10], key: "expectations", width: 50 },
    { header: WORKBOOK_HEADERS[11], key: "openQuestions", width: 30 }
  ];
  sheet.getRow(1).font = { bold: true };
  cases.forEach((testCase, index) => {
    const row = sheet.addRow({
      index: index + 1,
      name: testCase.displayName ?? testCase.name,
      screens: displayScreensOf(testCase).join(" → "),
      preconditions: (testCase.preconditions ?? []).join("；"),
      steps: renderStepsCell(testCase),
      displayId: displayIdOf(testCase),
      module: moduleOf(testCase),
      section: sectionOf(testCase),
      testData: testDataCell(testCase),
      relatedCases: relatedCasesCell(testCase),
      expectations: expectedCell(testCase),
      openQuestions: notesCell(testCase)
    });
    for (const cellIndex of [4, 5, 6, 9, 10, 11, 12]) {
      row.getCell(cellIndex).alignment = { wrapText: true, vertical: "top" };
    }
    for (const cellIndex of [7, 8]) {
      row.getCell(cellIndex).alignment = { vertical: "top" };
    }
  });
  addExecutorSheet(workbook, cases);
  addApiReviewSheet(workbook, meta.apiReview);
  addSummarySheet(workbook, cases, meta, summary);
  return workbook;
}

/** Render the generated cases as an .xlsx buffer: a ready-to-use sheet by
 * default, or a filled `{{...}}` template when `options.templatePath` is set. */
export async function renderTestsWorkbook(
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  options: { templatePath?: string } = {}
): Promise<Buffer> {
  const summary = meta.summary ?? summarizeCases(cases);
  if (!options.templatePath) {
    const workbook = defaultTestsWorkbook(cases, meta, summary);
    workbook.creator = "mobile-testing-mcp";
    workbook.lastModifiedBy = "mobile-testing-mcp";
    workbook.description = meta.source;
    const generatedAt = new Date(meta.generatedAt);
    if (!Number.isNaN(generatedAt.getTime())) {
      workbook.created = generatedAt;
      workbook.modified = generatedAt;
    }
    const rendered = await workbook.xlsx.writeBuffer();
    return Buffer.from(rendered);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(options.templatePath);
  } catch (error) {
    throw new Error(
      `Excel 模版无法读取（仅支持 .xlsx）: ${options.templatePath}（${errorMessage(error)}）`
    );
  }
  applyTemplate(workbook, cases, meta, summary);
  const rendered = await workbook.xlsx.writeBuffer();
  return Buffer.from(rendered);
}

export function upsertApiReviewMarkdown(markdown: string, review: ApiReview): string {
  const block = renderApiReviewMarkdown(review);
  const existing = markdown.match(/^> \*\*API 变更：[\s\S]*?(?=\n## |\n# )/m);
  if (existing) return markdown.replace(existing[0], block);
  const headerEnd = markdown.indexOf("\n\n");
  if (headerEnd < 0) return `${markdown}\n${block}`;
  return `${markdown.slice(0, headerEnd + 2)}${block}\n\n${markdown.slice(headerEnd + 2)}`;
}

export function renderApiReviewMarkdown(review: ApiReview): string {
  const label =
    review.status === "provided"
      ? "已提供 API 说明"
      : review.status === "pending"
        ? "待补充 API 说明（先生成，相关执行前需补齐）"
        : review.status === "not-applicable"
          ? "无 API 变更"
          : "API 变更未确认";
  const lines = [`> **API 变更：${label}**${review.carriedForward ? "（沿用上次说明，请复核）" : ""}`];
  if (review.apiSpec !== null && review.apiSpec.trim() !== "") {
    lines.push("", "<details>", "<summary>API 说明</summary>", "", "```text", review.apiSpec, "```", "", "</details>");
  }
  return lines.join("\n");
}

export async function updateWorkbookApiReview(
  filePath: string,
  review: ApiReview
): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const existing = workbook.getWorksheet("API 说明");
  if (existing) workbook.removeWorksheet(existing.id);
  addApiReviewSheet(workbook, review);
  await workbook.xlsx.writeFile(filePath);
  return true;
}
