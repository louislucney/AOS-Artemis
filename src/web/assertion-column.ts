import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { logWarn } from "../log.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { AssertionDoc } from "./assertions.js";
import { normalizeExcelHeader } from "./excel-columns.js";
import { cellText } from "./writeback.js";
import { lostParts, readXlsxParts } from "./xlsx-parts.js";

export const ASSERTION_COLUMN_HEADER = "__aos_assertions";
const HEADER_ROW = 1;

export type AssertionColumnErrorCode =
  | "invalid-workbook"
  | "sheet-not-found"
  | "invalid-case-id-header"
  | "case-id-header-not-found"
  | "merged-header"
  | "parts-lost"
  | "write-failed";

export class AssertionColumnError extends Error {
  readonly code: AssertionColumnErrorCode;

  constructor(code: AssertionColumnErrorCode, message: string) {
    super(message);
    this.name = "AssertionColumnError";
    this.code = code;
  }
}

export interface WriteAssertionColumnInput {
  workbookPath: string;
  sheetName: string;
  caseIdHeader: string;
  assertions: Map<string, AssertionDoc>;
}

export interface WriteAssertionColumnResult {
  column: number;
  written: number;
  warnings: string[];
}

export interface ReadAssertionColumnInput {
  workbookPath: string;
  sheetName: string;
  caseIdHeader: string;
}

interface LocatedColumn {
  sheet: ExcelJS.Worksheet;
  anchorColumn: number;
  assertionColumn: number;
  appended: boolean;
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    throw new AssertionColumnError(
      "invalid-workbook",
      `无法读取工作副本（${errorMessage(error)}）：${filePath}`
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new AssertionColumnError(
      "invalid-workbook",
      `无法读取工作副本（文件损坏或不是有效的 .xlsx）：${errorMessage(error)}`
    );
  }
  return workbook;
}

function pickSheet(workbook: ExcelJS.Workbook, sheetName: string): ExcelJS.Worksheet {
  const wanted = sheetName.trim();
  const sheet = workbook.worksheets.find((candidate) => candidate.name.trim() === wanted);
  if (!sheet) {
    const names = workbook.worksheets.map((candidate) => candidate.name).join("、");
    throw new AssertionColumnError(
      "sheet-not-found",
      `工作表不存在：${sheetName}；当前工作表：${names === "" ? "（空）" : names}`
    );
  }
  return sheet;
}

function locateColumn(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  caseIdHeader: string,
  forWrite: boolean
): LocatedColumn {
  const sheet = pickSheet(workbook, sheetName);
  const wantedCaseId = normalizeExcelHeader(caseIdHeader);
  if (wantedCaseId === "") {
    throw new AssertionColumnError("invalid-case-id-header", "用例编号表头为空：请传入当前工作表的用例编号列名");
  }
  const columnCount = Math.max(sheet.columnCount ?? 0, sheet.getRow(HEADER_ROW).cellCount ?? 0);

  let anchorColumn = 0;
  for (let column = 1; column <= columnCount; column += 1) {
    if (normalizeExcelHeader(cellText(sheet.getCell(HEADER_ROW, column))) === wantedCaseId) {
      anchorColumn = column;
      break;
    }
  }
  if (anchorColumn === 0) {
    throw new AssertionColumnError(
      "case-id-header-not-found",
      `表头行第 ${HEADER_ROW} 行找不到用例编号列：「${caseIdHeader}」`
    );
  }

  const wantedAssertions = normalizeExcelHeader(ASSERTION_COLUMN_HEADER);
  for (let column = 1; column <= columnCount; column += 1) {
    if (normalizeExcelHeader(cellText(sheet.getCell(HEADER_ROW, column))) !== wantedAssertions) continue;
    if (sheet.getCell(HEADER_ROW, column).isMerged) {
      throw new AssertionColumnError(
        "merged-header",
        `断言列表头 ${sheet.getCell(HEADER_ROW, column).address} 与合并区重叠：请取消合并后重试`
      );
    }
    return { sheet, anchorColumn, assertionColumn: column, appended: false };
  }

  let lastHeaderColumn = anchorColumn;
  for (let column = anchorColumn; column <= columnCount; column += 1) {
    if (cellText(sheet.getCell(HEADER_ROW, column)) !== "") lastHeaderColumn = column;
  }
  const assertionColumn = lastHeaderColumn + 1;
  if (forWrite && sheet.getCell(HEADER_ROW, assertionColumn).isMerged) {
    throw new AssertionColumnError(
      "merged-header",
      `断言列表头 ${sheet.getCell(HEADER_ROW, assertionColumn).address} 与合并区重叠：请取消合并后重试`
    );
  }
  return { sheet, anchorColumn, assertionColumn, appended: true };
}

function isAssertionDoc(value: unknown): value is AssertionDoc {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.source === "excel.expected" &&
    Array.isArray(record.steps) &&
    Array.isArray(record.manual) &&
    Array.isArray(record.ambiguous)
  );
}

export async function writeAssertionColumn(
  input: WriteAssertionColumnInput
): Promise<WriteAssertionColumnResult> {
  const target = path.resolve(input.workbookPath);
  const workbookBuffer = await readFile(target).catch((error: unknown) => {
    throw new AssertionColumnError(
      "invalid-workbook",
      `无法读取工作副本（${errorMessage(error)}）：${target}`
    );
  });
  let partsBefore: string[];
  try {
    partsBefore = readXlsxParts(workbookBuffer);
  } catch (error) {
    throw new AssertionColumnError(
      "invalid-workbook",
      `无法解析工作副本 OOXML 结构：${errorMessage(error)}`
    );
  }

  const workbook = await loadWorkbook(target);
  const located = locateColumn(workbook, input.sheetName, input.caseIdHeader, true);
  const { sheet, anchorColumn, assertionColumn, appended } = located;
  const warnings: string[] = [];

  const rowByCaseId = new Map<string, number>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= HEADER_ROW) return;
    const idCell = row.getCell(anchorColumn);
    if (idCell.isMerged) {
      warnings.push(`第 ${rowNumber} 行用例编号是合并单元格（${idCell.address}），已跳过`);
      return;
    }
    const caseId = cellText(idCell);
    if (caseId === "") return;
    const existing = rowByCaseId.get(caseId);
    if (existing !== undefined) {
      warnings.push(`用例编号重复：${caseId}（保留第 ${existing} 行，第 ${rowNumber} 行忽略）`);
      return;
    }
    rowByCaseId.set(caseId, rowNumber);
  });

  let written = 0;
  const seen = new Set<string>();
  const writes: Array<{ cell: ExcelJS.Cell; value: string }> = [];
  for (const [rawCaseId, doc] of input.assertions) {
    const caseId = rawCaseId.trim();
    if (caseId === "") {
      warnings.push("断言行缺少用例编号，已跳过");
      continue;
    }
    if (seen.has(caseId)) {
      warnings.push(`断言行重复：${caseId}（保留首条，后续忽略）`);
      continue;
    }
    seen.add(caseId);
    const rowNumber = rowByCaseId.get(caseId);
    if (rowNumber === undefined) {
      warnings.push(`用例编号不存在：${caseId}（未写入断言）`);
      continue;
    }
    const cell = sheet.getCell(rowNumber, assertionColumn);
    if (cell.isMerged) {
      warnings.push(`第 ${rowNumber} 行 ${caseId} 断言列是合并单元格（${cell.address}），已跳过`);
      continue;
    }
    writes.push({ cell, value: JSON.stringify(doc) });
  }

  if (appended) sheet.getCell(HEADER_ROW, assertionColumn).value = ASSERTION_COLUMN_HEADER;
  sheet.getColumn(assertionColumn).hidden = true;
  sheet.getColumn(assertionColumn).width = 0;
  for (const write of writes) write.cell.value = write.value;

  const tempPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.assert-${process.pid}-${Date.now()}.xlsx`
  );
  try {
    const buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
    writeFileAtomic(tempPath, buffer);
    const partsAfter = readXlsxParts(await readFile(tempPath));
    const lost = lostParts(partsBefore, partsAfter);
    if (lost.length > 0) {
      throw new AssertionColumnError(
        "parts-lost",
        `写入断言列后检测到工作簿 part 丢失：${lost.join("、")}（工作副本未替换）`
      );
    }
    await rename(tempPath, target);
    written = writes.length;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof AssertionColumnError) throw error;
    throw new AssertionColumnError(
      "write-failed",
      `断言列保存失败（工作副本未替换）：${errorMessage(error)}`
    );
  }

  return { column: assertionColumn, written, warnings };
}

export async function readAssertionColumn(
  input: ReadAssertionColumnInput
): Promise<Map<string, AssertionDoc>> {
  const workbook = await loadWorkbook(path.resolve(input.workbookPath));
  const { sheet, anchorColumn, assertionColumn, appended } = locateColumn(
    workbook,
    input.sheetName,
    input.caseIdHeader,
    false
  );
  const result = new Map<string, AssertionDoc>();
  if (appended) return result;

  const rowCount = sheet.rowCount ?? 0;
  const firstRowByCaseId = new Set<string>();
  for (let rowNumber = HEADER_ROW + 1; rowNumber <= rowCount; rowNumber += 1) {
    const caseId = cellText(sheet.getCell(rowNumber, anchorColumn));
    if (caseId === "" || firstRowByCaseId.has(caseId)) continue;
    firstRowByCaseId.add(caseId);
    const cell = sheet.getCell(rowNumber, assertionColumn);
    const raw = cellText(cell);
    if (raw === "") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isAssertionDoc(parsed)) {
        logWarn(`断言列内容结构不合法（${sheet.name}!${cell.address}），已跳过`);
        continue;
      }
      result.set(caseId, parsed);
    } catch (error) {
      logWarn(`断言列 JSON 无法解析（${sheet.name}!${cell.address}）：${errorMessage(error)}`);
    }
  }
  return result;
}
