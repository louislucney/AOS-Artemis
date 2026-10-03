import ExcelJS from "exceljs";

import { errorMessage } from "../util.js";
import type { GeneratedTest } from "./test-gen.js";

export interface WorkbookMeta {
  source: string;
  generatedAt: string;
  counts: { cases: number; screens: number; edges: number };
}

const WORKBOOK_SHEET = "测试用例";
const WORKBOOK_HEADERS = ["#", "用例名称", "涉及页面", "前置假设", "步骤", "artemis 任务描述"];
const CASE_PLACEHOLDER = /\{\{\s*(index|case\.[A-Za-z][\w]*)\s*\}\}/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;
const SINGLE_PLACEHOLDER = /^\s*\{\{\s*([A-Za-z][\w.]*)\s*\}\}\s*$/;
const NUMERIC_PLACEHOLDERS = new Set(["index", "counts.cases", "counts.screens", "counts.edges"]);

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

function casePlaceholderValues(testCase: GeneratedTest, index: number): Map<string, string> {
  return new Map([
    ["index", String(index + 1)],
    ["case.name", testCase.name],
    ["case.screens", testCase.screens.join(" → ")],
    ["case.preconditions", testCase.preconditions.join("；")],
    ["case.steps", testCase.steps.map((step, stepIndex) => `${stepIndex + 1}) ${step}`).join("\n")],
    ["case.taskDesc", testCase.taskDesc]
  ]);
}

function metaPlaceholderValues(meta: WorkbookMeta): Map<string, string> {
  return new Map([
    ["meta.source", meta.source],
    ["meta.generatedAt", meta.generatedAt],
    ["counts.cases", String(meta.counts.cases)],
    ["counts.screens", String(meta.counts.screens)],
    ["counts.edges", String(meta.counts.edges)]
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
function applyTemplate(workbook: ExcelJS.Workbook, cases: GeneratedTest[], meta: WorkbookMeta): void {
  const metaMap = metaPlaceholderValues(meta);
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

function defaultTestsWorkbook(cases: GeneratedTest[]): ExcelJS.Workbook {
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
    { header: WORKBOOK_HEADERS[5], key: "taskDesc", width: 70 }
  ];
  sheet.getRow(1).font = { bold: true };
  cases.forEach((testCase, index) => {
    const row = sheet.addRow({
      index: index + 1,
      name: testCase.name,
      screens: testCase.screens.join(" → "),
      preconditions: testCase.preconditions.join("；"),
      steps: testCase.steps.map((step, stepIndex) => `${stepIndex + 1}) ${step}`).join("\n"),
      taskDesc: testCase.taskDesc
    });
    row.getCell(4).alignment = { wrapText: true, vertical: "top" };
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
    row.getCell(6).alignment = { wrapText: true, vertical: "top" };
  });
  return workbook;
}

/** Render the generated cases as an .xlsx buffer: a ready-to-use sheet by
 * default, or a filled `{{...}}` template when `options.templatePath` is set. */
export async function renderTestsWorkbook(
  cases: GeneratedTest[],
  meta: WorkbookMeta,
  options: { templatePath?: string } = {}
): Promise<Buffer> {
  if (!options.templatePath) {
    const workbook = defaultTestsWorkbook(cases);
    workbook.creator = "aos-mcp";
    workbook.lastModifiedBy = "aos-mcp";
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
  applyTemplate(workbook, cases, meta);
  const rendered = await workbook.xlsx.writeBuffer();
  return Buffer.from(rendered);
}
