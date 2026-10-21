import ExcelJS from "exceljs";

import { expectedResultLines } from "../figma/case-view.js";
import { renderTestsWorkbook } from "../figma/test-xlsx.js";
import type { GeneratedTest } from "../figma/test-gen.js";
import { errorMessage } from "../util.js";

const CMS_HEADERS = [
  "用例编号",
  "功能",
  "用例名称",
  "前置条件",
  "操作步骤",
  "预期结果",
  "优先级"
] as const;

const REQUIRED_HEADERS = ["用例名称", "操作步骤", "预期结果"] as const;

const HEADER_ALIASES: Record<string, string> = {
  用例标题: "用例名称",
  标题: "用例名称",
  步骤: "操作步骤",
  测试步骤: "操作步骤",
  预期: "预期结果",
  期望结果: "预期结果",
  模块: "功能",
  所属功能: "功能"
};

export interface CmsWorkbookMeta {
  source: string;
  generatedAt: string;
  model: string | null;
  maxFlows?: number;
  maxDepth?: number;
  counts: { cases: number; screens: number };
  warnings?: string[];
}

function normalizeHeader(value: string): string {
  const trimmed = value.trim();
  return HEADER_ALIASES[trimmed] ?? trimmed;
}

function caseCells(testCase: GeneratedTest): Record<(typeof CMS_HEADERS)[number], string> {
  return {
    用例编号: testCase.displayId?.trim() || testCase.id,
    功能: testCase.module?.trim() || testCase.feature?.trim() || "未分组",
    用例名称: testCase.name,
    前置条件: testCase.preconditions.join("\n"),
    操作步骤: [...testCase.prelude, ...testCase.steps]
      .map((step, index) => `${index + 1}) ${step}`)
      .join("\n"),
    预期结果: expectedResultLines(testCase).join("\n") || "—",
    优先级: "P2"
  };
}

export async function templateHasCasePlaceholders(templatePath: string): Promise<boolean> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);
  let found = false;
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "string" && /\{\{\s*(case\.|index)/.test(cell.value)) found = true;
      });
    });
  });
  return found;
}

function applyHeaderRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number
): Map<string, number> {
  const columns = new Map<string, number>();
  const row = sheet.getRow(rowNumber);
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (typeof cell.value !== "string") return;
    const header = normalizeHeader(cell.value);
    if ((CMS_HEADERS as readonly string[]).includes(header)) columns.set(header, colNumber);
  });
  const missing = REQUIRED_HEADERS.filter((header) => !columns.has(header));
  if (missing.length > 0) {
    throw new Error(`Excel 模版缺少必需列：${missing.join("、")}`);
  }
  return columns;
}

function findHeaderRow(sheet: ExcelJS.Worksheet): number | null {
  const limit = Math.min(sheet.rowCount, 20);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let matched = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === "string" && (CMS_HEADERS as readonly string[]).includes(normalizeHeader(cell.value))) {
        matched += 1;
      }
    });
    if (matched >= 2) return rowNumber;
  }
  return null;
}

function styleRow(row: ExcelJS.Row, columns: Map<string, number>): void {
  for (const colNumber of columns.values()) {
    row.getCell(colNumber).alignment = { vertical: "top", wrapText: true };
  }
}

/** Render CMS cases: placeholder template, header-mapped template, or default 7-column sheet. */
export async function renderCmsWorkbook(
  cases: GeneratedTest[],
  meta: CmsWorkbookMeta,
  options: { templatePath?: string } = {}
): Promise<Buffer> {
  if (options.templatePath) {
    if (await templateHasCasePlaceholders(options.templatePath)) {
      return renderTestsWorkbook(
        cases,
        {
          ...meta,
          warnings: meta.warnings?.length ?? 0,
          counts: { ...meta.counts, edges: 0 }
        },
        { templatePath: options.templatePath }
      );
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(options.templatePath);
    } catch (error) {
      throw new Error(
        `Excel 模版无法读取（仅支持 .xlsx）: ${options.templatePath}（${errorMessage(error)}）`
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("Excel 模版没有工作表");
    const headerRow = findHeaderRow(sheet);
    if (headerRow === null) {
      throw new Error(`Excel 模版缺少必需列：${REQUIRED_HEADERS.join("、")}`);
    }
    const columns = applyHeaderRow(sheet, headerRow);
    let rowNumber = headerRow + 1;
    for (const testCase of cases) {
      const cells = caseCells(testCase);
      const row = sheet.getRow(rowNumber);
      for (const [header, colNumber] of columns) {
        row.getCell(colNumber).value = cells[header as (typeof CMS_HEADERS)[number]];
      }
      styleRow(row, columns);
      row.commit();
      rowNumber += 1;
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "mobile-testing-mcp";
  const sheet = workbook.addWorksheet("测试用例");
  sheet.addRow([...CMS_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  for (const testCase of cases) {
    const cells = caseCells(testCase);
    sheet.addRow(CMS_HEADERS.map((header) => cells[header]));
  }
  sheet.columns.forEach((column, index) => {
    column.width = [14, 16, 30, 28, 46, 34, 10][index] ?? 18;
    column.alignment = { vertical: "top", wrapText: true };
  });
  workbook.created = new Date(meta.generatedAt);
  workbook.modified = new Date(meta.generatedAt);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
