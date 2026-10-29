import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { errorMessage, writeFileAtomic } from "../util.js";
import { normalizeExcelHeader } from "./excel-columns.js";
import {
  cellText,
  findHeaderColumn,
  lastNonEmptyHeaderColumn,
  SYSTEM_COLUMNS
} from "./writeback.js";
import { findUnsupportedParts, lostParts, readXlsxParts } from "./xlsx-parts.js";

export type PlatformResultStatus = "PASS" | "FAIL" | "SKIP" | "ERROR";

export type PlatformResultPlatform = "android" | "ios";

/**
 * 平台结果列固定两列（可见）：AOS Result / IOS Result。只写本 job 平台的值，
 * 另一列保持原样（空或人工内容），保证同一份工作副本可被两端共享。
 */
export const PLATFORM_RESULT_COLUMNS = [
  { platform: "android", header: "AOS Result" },
  { platform: "ios", header: "IOS Result" }
] as const satisfies ReadonlyArray<{ platform: PlatformResultPlatform; header: string }>;

export type PlatformResultErrorCode =
  | "invalid-workbook"
  | "sheet-not-found"
  | "invalid-header-row"
  | "invalid-case-id-header"
  | "case-id-header-not-found"
  | "merged-header"
  | "unsupported-parts"
  | "parts-lost"
  | "write-failed"
  | "same-as-original";

export class PlatformResultError extends Error {
  readonly code: PlatformResultErrorCode;

  constructor(code: PlatformResultErrorCode, message: string) {
    super(message);
    this.name = "PlatformResultError";
    this.code = code;
  }
}

export interface PlatformResultRow {
  caseId: string;
  status: PlatformResultStatus;
}

export interface WritePlatformResultsInput {
  workbookPath: string;
  sheetName: string;
  caseIdHeader: string;
  platform: PlatformResultPlatform;
  rows: PlatformResultRow[];
  /** 表头行号，默认 1。 */
  headerRow?: number;
  /**
   * 原件（只读源）的表头。存在该表头＝列属于原件（人工内容默认冻结）；
   * 缺省表示来源未知，任何已存在的平台列都按人工内容保护。
   */
  sourceHeaders?: string[];
  /** 原件路径（可选）：与工作副本同一路径时拒绝写回，运行期兜底不可变约定。 */
  originalPath?: string;
}

export interface WritePlatformResultsResult {
  /** 本 job 平台列的位置。 */
  column: number;
  header: string;
  /** 本 job 平台列是否由本次追加（不是原件/工作副本既有列）。 */
  appended: boolean;
  /**
   * `fixed`＝平台列在 8 列摘要之前（新工作副本）；`legacy`＝既有 8 列在前、平台列追加在后
   * （旧工作副本，不插列以免破坏 journal cellRef）。
   */
  layout: "fixed" | "legacy";
  warnings: string[];
}

interface PlannedPlatformWrite {
  cell: ExcelJS.Cell;
  rowNumber: number;
  column: number;
  caseId: string;
  value: string;
}

async function loadWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    throw new PlatformResultError(
      "invalid-workbook",
      `无法读取工作副本（${errorMessage(error)}）：${path.resolve(filePath)}`
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new PlatformResultError(
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
    throw new PlatformResultError(
      "sheet-not-found",
      `工作表不存在：${sheetName}；当前工作表：${names === "" ? "（空）" : names}`
    );
  }
  return sheet;
}

function isFormula(cell: ExcelJS.Cell): boolean {
  return cell.type === ExcelJS.ValueType.Formula;
}

function assertHeaderNotMerged(
  sheet: ExcelJS.Worksheet,
  headerRow: number,
  columnNumber: number,
  label: string
): void {
  const cell = sheet.getCell(headerRow, columnNumber);
  if (!cell.isMerged) return;
  throw new PlatformResultError(
    "merged-header",
    `表头单元格 ${cell.address}（${label}）与合并区重叠：请取消合并后重试（不自动拆分）`
  );
}

const UNSUPPORTED_PARTS_HINT =
  "exceljs 重写会丢失这些对象；请先移除图表/透视表/宏/切片器/ActiveX，或改用「单独结果文件」保存结果（工作副本不会被改写）";

async function verifyPlatformReadback(
  tempPath: string,
  sheetName: string,
  headerRow: number,
  assertionHeaders: Array<{ column: number; header: string }>,
  writes: PlannedPlatformWrite[]
): Promise<void> {
  const workbook = await loadWorkbook(tempPath);
  const sheet = pickSheet(workbook, sheetName);
  const mismatches: string[] = [];
  for (const entry of assertionHeaders) {
    if (cellText(sheet.getCell(headerRow, entry.column)) !== entry.header) {
      mismatches.push(`表头 ${sheet.getCell(headerRow, entry.column).address}`);
    }
  }
  for (const write of writes) {
    const cell = sheet.getCell(write.rowNumber, write.column);
    if (cellText(cell) !== write.value) {
      mismatches.push(`${write.caseId}（${cell.address}）`);
    }
  }
  if (mismatches.length > 0) {
    throw new PlatformResultError(
      "write-failed",
      `写回自检失败（${mismatches.length} 格不一致，工作副本未替换）：${mismatches
        .slice(0, 5)
        .join("；")}`
    );
  }
}

/**
 * 平台结果列写回：复用既有 `AOS Result`/`IOS Result`（可见列），缺失时在最后一个非空表头后
 * 追加；只写本 job 平台对应的列，另一列保持原样。追加列（原件没有该表头）是系统列，可跨轮
 * 刷新；原件已有的同名列视为人工列，非空单元格冻结并告警（无平台列 journal，见 DESIGN §13.267）。
 * 写盘走临时文件 + 回读校验 + rename，原件只读约束由调用方保证。
 */
export async function writePlatformResults(
  input: WritePlatformResultsInput
): Promise<WritePlatformResultsResult> {
  const jobHeader =
    PLATFORM_RESULT_COLUMNS.find((column) => column.platform === input.platform)?.header ??
    PLATFORM_RESULT_COLUMNS[0].header;
  const target = path.resolve(input.workbookPath);
  if (input.originalPath !== undefined && path.resolve(input.originalPath) === target) {
    throw new PlatformResultError(
      "same-as-original",
      `拒绝写回原件：workbookPath 与 originalPath 相同（${target}）`
    );
  }
  const workbookBuffer = await readFile(target).catch((error: unknown) => {
    throw new PlatformResultError(
      "invalid-workbook",
      `无法读取工作副本（${errorMessage(error)}）：${target}`
    );
  });
  let partsBefore: string[];
  try {
    partsBefore = readXlsxParts(workbookBuffer);
  } catch (error) {
    throw new PlatformResultError(
      "invalid-workbook",
      `无法解析工作副本 OOXML 结构：${errorMessage(error)}`
    );
  }

  const headerRow = input.headerRow ?? 1;
  const workbook = await loadWorkbook(target);
  const sheet = pickSheet(workbook, input.sheetName);
  const rowCount = sheet.rowCount ?? 0;
  if (!Number.isInteger(headerRow) || headerRow < 1 || (rowCount > 0 && headerRow > rowCount)) {
    throw new PlatformResultError(
      "invalid-header-row",
      `表头行无效：${String(input.headerRow)}（工作表共 ${rowCount} 行）`
    );
  }
  const wantedCaseId = normalizeExcelHeader(input.caseIdHeader);
  if (wantedCaseId === "") {
    throw new PlatformResultError(
      "invalid-case-id-header",
      "用例编号表头为空：请传入当前工作表的用例编号列名"
    );
  }
  const columnCount = Math.max(sheet.columnCount ?? 0, sheet.getRow(headerRow).cellCount ?? 0);

  const anchorColumn = findHeaderColumn(
    sheet,
    headerRow,
    input.caseIdHeader,
    1,
    columnCount
  );
  if (anchorColumn === 0) {
    throw new PlatformResultError(
      "case-id-header-not-found",
      `表头行第 ${headerRow} 行找不到用例编号列：「${input.caseIdHeader}」`
    );
  }

  const present = new Map<PlatformResultPlatform, number>();
  for (const platformColumn of PLATFORM_RESULT_COLUMNS) {
    const column = findHeaderColumn(sheet, headerRow, platformColumn.header, 1, columnCount);
    if (column > 0) present.set(platformColumn.platform, column);
  }

  const lastHeaderColumn = lastNonEmptyHeaderColumn(sheet, headerRow, anchorColumn, columnCount);
  const appendedHeaders: Array<{ column: number; header: string }> = [];
  let nextColumn = lastHeaderColumn + 1;
  for (const platformColumn of PLATFORM_RESULT_COLUMNS) {
    if (present.has(platformColumn.platform)) continue;
    present.set(platformColumn.platform, nextColumn);
    appendedHeaders.push({ column: nextColumn, header: platformColumn.header });
    nextColumn += 1;
  }

  assertHeaderNotMerged(sheet, headerRow, anchorColumn, input.caseIdHeader);
  for (const entry of appendedHeaders) {
    assertHeaderNotMerged(sheet, headerRow, entry.column, entry.header);
  }

  const systemColumns = SYSTEM_COLUMNS.map((system) =>
    findHeaderColumn(sheet, headerRow, system.header, 1, columnCount)
  ).filter((column) => column > 0);
  const platformColumns = [...present.values()];
  const layout: WritePlatformResultsResult["layout"] =
    systemColumns.length > 0 && Math.max(...platformColumns) > Math.min(...systemColumns)
      ? "legacy"
      : "fixed";

  const sourceHeaders =
    input.sourceHeaders === undefined
      ? null
      : new Set(
          input.sourceHeaders.map((header) => normalizeExcelHeader(header)).filter((header) => header !== "")
        );
  const reusedInSource =
    sourceHeaders === null ? true : sourceHeaders.has(normalizeExcelHeader(jobHeader));

  const rowByCaseId = new Map<string, number>();
  const warnings: string[] = [];
  if (appendedHeaders.length > 0 && layout === "legacy") {
    warnings.push(
      "platform-columns-after-system: 工作副本已有 8 列摘要（旧布局，或原件自带摘要列），平台结果列只能追加在其后；可见列顺序＝原件 + 8 列 + AOS/IOS，新建工作副本固定为原件 + AOS/IOS + 8 列"
    );
  }
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const idCell = row.getCell(anchorColumn);
    if (idCell.isMerged) {
      warnings.push(`第 ${rowNumber} 行用例编号是合并单元格（${idCell.address}），已跳过`);
      return;
    }
    if (isFormula(idCell)) {
      warnings.push(`第 ${rowNumber} 行用例编号是公式单元格（${idCell.address}），已跳过`);
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

  const jobColumn = present.get(input.platform)!;
  const planned: PlannedPlatformWrite[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    const caseId = (row.caseId ?? "").trim();
    if (caseId === "") {
      warnings.push("平台结果缺少用例编号，已跳过");
      continue;
    }
    if (seen.has(caseId)) {
      warnings.push(`平台结果重复：${caseId}（保留首条，后续忽略）`);
      continue;
    }
    seen.add(caseId);
    const rowNumber = rowByCaseId.get(caseId);
    if (rowNumber === undefined) {
      warnings.push(`用例编号不存在：${caseId}（未写入平台结果）`);
      continue;
    }
    const cell = sheet.getCell(rowNumber, jobColumn);
    if (cell.isMerged) {
      warnings.push(`第 ${rowNumber} 行 ${caseId}「${jobHeader}」是合并单元格（${cell.address}），已跳过`);
      continue;
    }
    if (isFormula(cell)) {
      warnings.push(`第 ${rowNumber} 行 ${caseId}「${jobHeader}」是公式单元格（${cell.address}），已跳过`);
      continue;
    }
    const current = cellText(cell);
    if (current === row.status) continue;
    if (reusedInSource && current !== "") {
      warnings.push(
        `第 ${rowNumber} 行 ${caseId}「${jobHeader}」含人工内容（${cell.address}，原值「${current}」），已冻结；平台结果列只写空单元格`
      );
      continue;
    }
    planned.push({ cell, rowNumber, column: jobColumn, caseId, value: row.status });
  }

  const unsupported = findUnsupportedParts(partsBefore);
  if (unsupported.length > 0) {
    throw new PlatformResultError(
      "unsupported-parts",
      `工作副本包含不支持写回的对象：${unsupported.join("、")}。${UNSUPPORTED_PARTS_HINT}`
    );
  }

  if (planned.length > 0 || appendedHeaders.length > 0) {
    for (const entry of appendedHeaders) {
      sheet.getCell(headerRow, entry.column).value = entry.header;
    }
    for (const write of planned) write.cell.value = write.value;

    const tempPath = path.join(
      path.dirname(target),
      `.${path.basename(target)}.platform-${process.pid}-${Date.now()}.xlsx`
    );
    try {
      const buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
      writeFileAtomic(tempPath, buffer);
      const partsAfter = readXlsxParts(await readFile(tempPath));
      const lost = lostParts(partsBefore, partsAfter);
      if (lost.length > 0) {
        throw new PlatformResultError(
          "parts-lost",
          `写入平台结果列后检测到工作簿 part 丢失：${lost.join("、")}（工作副本未替换）`
        );
      }
      await verifyPlatformReadback(
        tempPath,
        sheet.name,
        headerRow,
        appendedHeaders,
        planned
      );
      await rename(tempPath, target);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof PlatformResultError) throw error;
      throw new PlatformResultError(
        "write-failed",
        `平台结果列保存失败（工作副本未替换）：${errorMessage(error)}`
      );
    }
  }

  return {
    column: jobColumn,
    header: jobHeader,
    appended: appendedHeaders.some((entry) => entry.header === jobHeader),
    layout,
    warnings
  };
}
