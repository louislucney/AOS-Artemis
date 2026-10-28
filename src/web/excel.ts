import ExcelJS from "exceljs";

import {
  CANONICAL_FIELDS,
  CANONICAL_FIELD_LABELS,
  normalizeExcelHeader,
  REQUIRED_CANONICAL_FIELDS,
  type CanonicalField,
  type ExcelColumnMap
} from "./excel-columns.js";

export {
  CANONICAL_FIELDS,
  CANONICAL_FIELD_LABELS,
  COLUMN_ALIASES,
  normalizeExcelHeader,
  REQUIRED_CANONICAL_FIELDS,
  semanticFingerprint,
  suggestExcelMapping,
  type CanonicalField,
  type ExcelColumnMap
} from "./excel-columns.js";

export interface ParsedExcelCase {
  caseId: string;
  name: string;
  steps: string[];
  expected: string | null;
  preconditions: string[];
  module: string | null;
  priority: string | null;
  testData: string | null;
  testId: string | null;
  rowNumber: number;
}

export interface ParsedExcelRejection {
  row: number;
  reason: string;
}

export interface ParsedExcel {
  sheetName: string;
  headers: string[];
  cases: ParsedExcelCase[];
  rejected: ParsedExcelRejection[];
}

export interface ParseExcelInput {
  sheetName?: string;
  headerRow?: number;
  mapping: ExcelColumnMap;
}

export type ExcelMappingErrorCode =
  | "invalid-workbook"
  | "sheet-not-found"
  | "invalid-header-row"
  | "missing-header"
  | "missing-required"
  | "column-not-found"
  | "duplicate-column"
  | "merged-cells";

export class ExcelMappingError extends Error {
  readonly code: ExcelMappingErrorCode;

  constructor(code: ExcelMappingErrorCode, message: string) {
    super(message);
    this.name = "ExcelMappingError";
    this.code = code;
  }
}

const MAX_ROWS = 10000;
const MAX_COLUMNS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function plainText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value).trim();
  const record = value as unknown as Record<string, unknown>;
  const rich = record.richText;
  if (Array.isArray(rich)) {
    return rich
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  if (typeof record.text === "string") return record.text.trim();
  if (record.result !== undefined && record.result !== null) {
    return plainText(record.result as ExcelJS.CellValue);
  }
  if (typeof record.error === "string") return record.error.trim();
  return "";
}

interface ReadCell {
  text: string;
  /** 公式没有缓存结果：读不到值，不能让该行静默变空。 */
  formulaWithoutCache: boolean;
}

function readCell(cell: ExcelJS.Cell): ReadCell {
  const formulaType = cell.formulaType;
  if (formulaType === ExcelJS.FormulaType.Master || formulaType === ExcelJS.FormulaType.Shared) {
    // 注意：不能读 cell.value —— exceljs 的 FormulaValue 复制模型时丢弃 falsy result，
    // 缓存值 0/false/"" 会被误判为「无缓存」。cell.result 保留原始缓存值。
    const cached = cell.result;
    return {
      text: plainText(cached as ExcelJS.CellValue),
      formulaWithoutCache: cached === undefined || cached === null
    };
  }
  return { text: plainText(cell.value), formulaWithoutCache: false };
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return value;
}

/** 步骤/前置按换行拆分；每行保留原始措辞（含编号前缀），只去首尾空白与空行。 */
function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function pickSheet(workbook: ExcelJS.Workbook, sheetName: string | undefined): ExcelJS.Worksheet {
  if (sheetName === undefined) {
    const first = workbook.worksheets[0];
    if (!first) throw new ExcelMappingError("invalid-workbook", "工作簿没有工作表");
    return first;
  }
  const wanted = sheetName.trim();
  const found = workbook.worksheets.find((sheet) => sheet.name.trim() === wanted);
  if (!found) {
    const names = workbook.worksheets.map((sheet) => sheet.name).join("、");
    throw new ExcelMappingError(
      "sheet-not-found",
      `工作表不存在：${sheetName}；当前工作表：${names === "" ? "（空）" : names}`
    );
  }
  return found;
}

function resolveColumns(headers: string[], mapping: ExcelColumnMap): Map<CanonicalField, number> {
  const normalized = headers.map(normalizeExcelHeader);
  const resolved = new Map<CanonicalField, number>();
  for (const field of CANONICAL_FIELDS) {
    const mapped = mapping[field];
    if (mapped === undefined) continue;
    const wanted = normalizeExcelHeader(mapped);
    if (wanted === "") continue;
    const index = normalized.indexOf(wanted);
    if (index === -1) {
      throw new ExcelMappingError(
        "column-not-found",
        `映射的列不存在：「${mapped}」（${CANONICAL_FIELD_LABELS[field]}）`
      );
    }
    const owner = [...resolved.entries()].find(([, value]) => value === index);
    if (owner !== undefined) {
      throw new ExcelMappingError(
        "duplicate-column",
        `同一列「${headers[index]}」被映射给「${CANONICAL_FIELD_LABELS[owner[0]]}」和「${CANONICAL_FIELD_LABELS[field]}」`
      );
    }
    resolved.set(field, index);
  }
  const missing = REQUIRED_CANONICAL_FIELDS.filter((field) => !resolved.has(field));
  if (missing.length > 0) {
    throw new ExcelMappingError(
      "missing-required",
      `缺少必需列：${missing.map((field) => CANONICAL_FIELD_LABELS[field]).join("、")}`
    );
  }
  return resolved;
}

function assertNoMergedCells(
  sheet: ExcelJS.Worksheet,
  resolved: Map<CanonicalField, number>,
  headerRow: number,
  rowCount: number
): void {
  for (const [field, index] of resolved) {
    for (let rowNumber = headerRow; rowNumber <= rowCount; rowNumber += 1) {
      const cell = sheet.getRow(rowNumber).getCell(index + 1);
      if (!cell.isMerged) continue;
      throw new ExcelMappingError(
        "merged-cells",
        `映射列「${CANONICAL_FIELD_LABELS[field]}」含合并单元格（${cell.address}）：请取消合并后重新上传`
      );
    }
  }
}

interface LoadedSheet {
  sheet: ExcelJS.Worksheet;
  rowCount: number;
  columnCount: number;
  headerRow: number;
  headers: string[];
}

async function loadSheet(
  buffer: Buffer,
  options: { sheetName?: string; headerRow?: number }
): Promise<LoadedSheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new ExcelMappingError(
      "invalid-workbook",
      `无法读取工作簿（文件损坏或不是有效的 .xlsx）：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const sheet = pickSheet(workbook, options.sheetName);
  const rowCount = sheet.rowCount ?? 0;
  const columnCount = sheet.columnCount ?? 0;
  if (rowCount > MAX_ROWS || columnCount > MAX_COLUMNS) {
    throw new ExcelMappingError(
      "invalid-workbook",
      `工作表维度异常（${rowCount} 行 × ${columnCount} 列，上限 ${MAX_ROWS} 行 × ${MAX_COLUMNS} 列）：请拆表后重试`
    );
  }
  const headerRow = options.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > rowCount) {
    throw new ExcelMappingError(
      "invalid-header-row",
      `表头行无效：${String(options.headerRow)}（工作表共 ${rowCount} 行）`
    );
  }
  const headers: string[] = [];
  for (let column = 1; column <= columnCount; column += 1) {
    headers.push(readCell(sheet.getRow(headerRow).getCell(column)).text);
  }
  if (headers.every((header) => header === "")) {
    throw new ExcelMappingError("missing-header", `工作表缺少表头（第 ${headerRow} 行为空）`);
  }
  return { sheet, rowCount, columnCount, headerRow, headers };
}

export interface ExcelHeaders {
  sheetName: string;
  headers: string[];
}

/** 只读表头（预览用）：即使缺少必填列也能拿到 headers/sheetName，供列映射建议。 */
export async function readExcelHeaders(
  buffer: Buffer,
  options: { sheetName?: string; headerRow?: number } = {}
): Promise<ExcelHeaders> {
  const loaded = await loadSheet(buffer, options);
  return { sheetName: loaded.sheet.name, headers: loaded.headers };
}

/**
 * 任意 Excel 测试文档 → 规范用例：按 `mapping` 的表头文本定位列（不依赖列顺序），
 * 必填 `caseId`/`steps` 缺失即显式失败；公式用缓存值、无缓存则拒绝该行；合并单元格拒绝整个工作表。
 */
export async function parseExcel(buffer: Buffer, input: ParseExcelInput): Promise<ParsedExcel> {
  const { sheet, rowCount, headerRow, headers } = await loadSheet(buffer, {
    sheetName: input.sheetName,
    headerRow: input.headerRow
  });

  const resolved = resolveColumns(headers, input.mapping);
  assertNoMergedCells(sheet, resolved, headerRow, rowCount);

  const cases: ParsedExcelCase[] = [];
  const rejected: ParsedExcelRejection[] = [];
  const firstRowByCaseId = new Map<string, number>();
  for (let rowNumber = headerRow + 1; rowNumber <= rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = new Map<CanonicalField, string>();
    const formulaIssues: string[] = [];
    for (const [field, index] of resolved) {
      const cell = readCell(row.getCell(index + 1));
      if (cell.formulaWithoutCache && REQUIRED_CANONICAL_FIELDS.includes(field)) {
        formulaIssues.push(`公式单元格无缓存值（${CANONICAL_FIELD_LABELS[field]}）`);
      }
      values.set(field, cell.formulaWithoutCache ? "" : cell.text);
    }
    if (formulaIssues.length > 0) {
      rejected.push({ row: rowNumber, reason: formulaIssues.join("；") });
      continue;
    }
    if ([...values.values()].every((value) => value === "")) continue;

    const caseId = values.get("caseId") ?? "";
    if (caseId === "") {
      rejected.push({ row: rowNumber, reason: "缺少用例编号" });
      continue;
    }
    const rawSteps = values.get("steps") ?? "";
    if (rawSteps === "") {
      rejected.push({ row: rowNumber, reason: "缺少步骤" });
      continue;
    }
    const firstRow = firstRowByCaseId.get(caseId);
    if (firstRow !== undefined) {
      rejected.push({ row: rowNumber, reason: `用例编号重复：${caseId}（保留第 ${firstRow} 行）` });
      continue;
    }
    firstRowByCaseId.set(caseId, rowNumber);

    cases.push({
      caseId,
      name: values.get("name") ?? "",
      steps: splitLines(rawSteps),
      expected: optionalText(values.get("expected")),
      preconditions: splitLines(values.get("preconditions") ?? ""),
      module: optionalText(values.get("module")),
      priority: optionalText(values.get("priority")),
      testData: optionalText(values.get("testData")),
      testId: optionalText(values.get("testId")),
      rowNumber
    });
  }

  return { sheetName: sheet.name, headers, cases, rejected };
}
