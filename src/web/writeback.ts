import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { errorMessage, writeFileAtomic } from "../util.js";
import { normalizeExcelHeader } from "./excel-columns.js";
import { findUnsupportedParts, lostParts, readXlsxParts } from "./xlsx-parts.js";

/** 系统列固定 8 列，顺序即写回/表头追加顺序。 */
export const SYSTEM_COLUMNS = [
  { key: "scriptFile", header: "建议｜脚本文件" },
  { key: "expectedHint", header: "建议｜关键预期" },
  { key: "result", header: "执行｜结果" },
  { key: "device", header: "执行｜设备与系统" },
  { key: "package", header: "执行｜安装包" },
  { key: "startedAt", header: "执行｜开始时间" },
  { key: "finishedAt", header: "执行｜结束时间" },
  { key: "traceId", header: "执行｜traceId" }
] as const;

export type SystemColumnKey = (typeof SYSTEM_COLUMNS)[number]["key"];

export interface WritebackRow {
  caseId: string;
  values: Partial<Record<SystemColumnKey, string>>;
}

/** 实际落盘的单元格（供调用方写 journal；`cellRef` 已带工作表名，跨表不冲突）。 */
export interface WritebackCellWrite {
  caseId: string;
  key: SystemColumnKey;
  value: string;
  cellRef: string;
  address: string;
  rowNumber: number;
  columnNumber: number;
}

/**
 * 计数口径：`written`/`failed` 按单元格；`skipped` 按写入尝试（未知/空用例编号行按行计一次，
 * 其余按单元格）。缺失/空字符串值不产生写入尝试，也不计数。
 */
export interface WritebackResult {
  written: number;
  skipped: number;
  failed: number;
  columns: string[];
  warnings: string[];
  writtenCells: WritebackCellWrite[];
}

export interface WritebackInput {
  workbookPath: string;
  assetId: string;
  sheetName: string;
  caseIdHeader: string;
  rows: WritebackRow[];
  lastSystemValue: (caseId: string, key: SystemColumnKey) => Promise<string | null>;
  /** 表头行号，默认 1（与 Excel 导入映射一致）。 */
  headerRow?: number;
  /** 冷启动时是否沿用既有系统列：默认 false＝冻结（无 journal 的非空格视为人工/不可信）。 */
  adoptExistingSystemColumns?: boolean;
  /** 原件路径（可选）：与工作副本同一路径时拒绝写回，运行期兜底不可变约定。 */
  originalPath?: string;
  /** 维度上限，默认 10000 行 × 200 列（按实际使用单元格计，见 `writebackWorkbook`）。 */
  maxRows?: number;
  maxColumns?: number;
}

export type WritebackErrorCode =
  | "invalid-workbook"
  | "sheet-not-found"
  | "invalid-header-row"
  | "invalid-case-id-header"
  | "case-id-header-not-found"
  | "merged-header"
  | "same-as-original"
  | "unsupported-parts"
  | "parts-lost"
  | "verify-failed";

export class WritebackError extends Error {
  readonly code: WritebackErrorCode;

  constructor(code: WritebackErrorCode, message: string) {
    super(message);
    this.name = "WritebackError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function plainText(value: ExcelJS.CellValue | undefined): string {
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

/** 单元格文本（公式取缓存结果）；与写回/journal 同口径，重上传重播种复用。 */
export function cellText(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Formula) {
    return plainText(cell.result as ExcelJS.CellValue | undefined);
  }
  return plainText(cell.value);
}

function isFormula(cell: ExcelJS.Cell): boolean {
  return cell.type === ExcelJS.ValueType.Formula;
}

const MAX_WRITE_ROWS = 10000;
const MAX_WRITE_COLUMNS = 200;

async function loadWorkbookBuffer(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    throw new WritebackError(
      "invalid-workbook",
      `无法读取工作副本（文件损坏或不是有效的 .xlsx）：${errorMessage(error)}`
    );
  }
  return workbook;
}

const UNSUPPORTED_PARTS_HINT =
  "exceljs 重写会丢失这些对象；请先移除图表/透视表/宏/切片器/ActiveX，或改用「单独结果文件」保存结果（原工作副本不会被改写）";

async function verifyWrittenCells(
  filePath: string,
  sheetName: string,
  expected: Array<{ address: string; value: string; key: string; caseId: string }>
): Promise<void> {
  const workbook = await loadWorkbookBuffer(await readFile(filePath));
  const sheet = pickSheet(workbook, sheetName);
  const mismatches: string[] = [];
  for (const entry of expected) {
    const actual = cellText(sheet.getCell(entry.address));
    if (actual !== entry.value) {
      mismatches.push(
        `${entry.caseId}「${entry.key}」${entry.address} 期望「${entry.value}」实际「${actual}」`
      );
    }
  }
  if (mismatches.length > 0) {
    throw new WritebackError(
      "verify-failed",
      `写回自检失败（${mismatches.length} 格值不一致，工作副本未替换）：${mismatches
        .slice(0, 5)
        .join("；")}`
    );
  }
}

function pickSheet(workbook: ExcelJS.Workbook, sheetName: string): ExcelJS.Worksheet {
  const wanted = sheetName.trim();
  const sheet = workbook.worksheets.find((candidate) => candidate.name.trim() === wanted);
  if (!sheet) {
    const names = workbook.worksheets.map((candidate) => candidate.name).join("、");
    throw new WritebackError(
      "sheet-not-found",
      `工作表不存在：${sheetName}；当前工作表：${names === "" ? "（空）" : names}`
    );
  }
  return sheet;
}

/** 表头单元格落在合并区内：拒绝写回，不拆合并（拆分会移动他人数据）。 */
function assertHeaderNotMerged(
  sheet: ExcelJS.Worksheet,
  headerRow: number,
  columnNumber: number,
  label: string
): void {
  const cell = sheet.getCell(headerRow, columnNumber);
  if (!cell.isMerged) return;
  throw new WritebackError(
    "merged-header",
    `表头单元格 ${cell.address}（${label}）与合并区重叠：请取消合并后重试（不自动拆分）`
  );
}

/**
 * 8 列写回引擎：原件只读，调用方传入已复制的工作副本；系统列按表头复用、缺失则追加，
 * 只写空白格或未被人工改动的系统格（以 journal 判定归属；无 journal 的既有系统列按系统格刷新并告警）。
 *
 * 维度上限按**实际使用**计：行用 `actualRowCount`（样式-only 远行不计），列用表头/使用列宽；
 * 可用 `maxRows`/`maxColumns` 覆盖。注意 exceljs 往返会丢弃图表/透视/宏等不支持对象（见 DESIGN §13.253）。
 */
export async function writebackWorkbook(input: WritebackInput): Promise<WritebackResult> {
  if (
    input.originalPath !== undefined &&
    path.resolve(input.originalPath) === path.resolve(input.workbookPath)
  ) {
    throw new WritebackError(
      "same-as-original",
      `拒绝写回原件：workbookPath 与 originalPath 相同（${path.resolve(input.workbookPath)}）`
    );
  }

  const workbookBuffer = await readFile(input.workbookPath).catch((error: unknown) => {
    throw new WritebackError(
      "invalid-workbook",
      `无法读取工作副本（${errorMessage(error)}）：${input.workbookPath}`
    );
  });
  let partsBefore: string[];
  try {
    partsBefore = readXlsxParts(workbookBuffer);
  } catch (error) {
    throw new WritebackError(
      "invalid-workbook",
      `无法解析工作副本 OOXML 结构：${errorMessage(error)}`
    );
  }
  const unsupported = findUnsupportedParts(partsBefore);
  if (unsupported.length > 0) {
    throw new WritebackError(
      "unsupported-parts",
      `工作副本包含不支持写回的对象：${unsupported.join("、")}。${UNSUPPORTED_PARTS_HINT}`
    );
  }

  const workbook = await loadWorkbookBuffer(workbookBuffer);
  const sheet = pickSheet(workbook, input.sheetName);

  const rowCount = sheet.rowCount ?? 0;
  const headerRow = input.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1 || (rowCount > 0 && headerRow > rowCount)) {
    throw new WritebackError(
      "invalid-header-row",
      `表头行无效：${String(input.headerRow)}（工作表共 ${rowCount} 行）`
    );
  }

  const columnCount = Math.max(sheet.columnCount ?? 0, sheet.getRow(headerRow).cellCount ?? 0);
  const usedRowCount = sheet.actualRowCount ?? rowCount;
  const maxRows = input.maxRows ?? MAX_WRITE_ROWS;
  const maxColumns = input.maxColumns ?? MAX_WRITE_COLUMNS;
  if (usedRowCount > maxRows || columnCount > maxColumns) {
    throw new WritebackError(
      "invalid-workbook",
      `工作表维度异常（${usedRowCount} 行 × ${columnCount} 列，上限 ${maxRows} 行 × ${maxColumns} 列）：请拆表后重试`
    );
  }
  const wantedCaseId = normalizeExcelHeader(input.caseIdHeader);
  if (wantedCaseId === "") {
    throw new WritebackError("invalid-case-id-header", "用例编号表头为空：请传入当前工作表的用例编号列名");
  }

  let anchorColumn = 0;
  for (let column = 1; column <= columnCount; column += 1) {
    if (normalizeExcelHeader(cellText(sheet.getCell(headerRow, column))) === wantedCaseId) {
      anchorColumn = column;
      break;
    }
  }
  if (anchorColumn === 0) {
    throw new WritebackError(
      "case-id-header-not-found",
      `表头行第 ${headerRow} 行找不到用例编号列：「${input.caseIdHeader}」`
    );
  }

  // 只在表头行、从锚点向右定位；数据行里的游离数据不参与锚定。
  let lastHeaderColumn = anchorColumn;
  for (let column = anchorColumn; column <= columnCount; column += 1) {
    if (cellText(sheet.getCell(headerRow, column)) !== "") lastHeaderColumn = column;
  }

  const columns = new Map<SystemColumnKey, number>();
  const existingSystemKeys = new Set<SystemColumnKey>();
  for (const system of SYSTEM_COLUMNS) {
    const wanted = normalizeExcelHeader(system.header);
    for (let column = anchorColumn; column <= lastHeaderColumn; column += 1) {
      if (normalizeExcelHeader(cellText(sheet.getCell(headerRow, column))) === wanted) {
        columns.set(system.key, column);
        existingSystemKeys.add(system.key);
        break;
      }
    }
  }
  const appended: Array<{ key: SystemColumnKey; header: string; column: number }> = [];
  let nextColumn = lastHeaderColumn + 1;
  for (const system of SYSTEM_COLUMNS) {
    if (columns.has(system.key)) continue;
    columns.set(system.key, nextColumn);
    appended.push({ key: system.key, header: system.header, column: nextColumn });
    nextColumn += 1;
  }

  assertHeaderNotMerged(sheet, headerRow, anchorColumn, input.caseIdHeader);
  for (const system of SYSTEM_COLUMNS) {
    assertHeaderNotMerged(sheet, headerRow, columns.get(system.key)!, system.header);
  }

  const warnings: string[] = [];
  const rowByCaseId = new Map<string, number>();
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

  const writes: Array<{
    caseId: string;
    rowNumber: number;
    system: (typeof SYSTEM_COLUMNS)[number];
    value: string;
    cell: ExcelJS.Cell;
  }> = [];
  let skipped = 0;
  let failed = 0;
  const seenInputCaseIds = new Set<string>();

  for (const row of input.rows) {
    const caseId = (row.caseId ?? "").trim();
    if (caseId === "") {
      skipped += 1;
      warnings.push("写回行缺少用例编号，已跳过");
      continue;
    }
    if (seenInputCaseIds.has(caseId)) {
      skipped += 1;
      warnings.push(`写回行重复：${caseId}（保留首条值，后续行忽略）`);
      continue;
    }
    seenInputCaseIds.add(caseId);
    const rowNumber = rowByCaseId.get(caseId);
    if (rowNumber === undefined) {
      skipped += 1;
      warnings.push(`用例编号不存在：${caseId}（未写入）`);
      continue;
    }
    for (const system of SYSTEM_COLUMNS) {
      const raw = row.values[system.key];
      if (raw === undefined || raw === null) continue;
      const value = String(raw);
      if (value.trim() === "") continue;

      const cell = sheet.getCell(rowNumber, columns.get(system.key)!);
      if (cell.isMerged) {
        skipped += 1;
        warnings.push(
          `第 ${rowNumber} 行 ${caseId}「${system.header}」是合并单元格（${cell.address}），已跳过`
        );
        continue;
      }
      if (isFormula(cell)) {
        skipped += 1;
        warnings.push(
          `第 ${rowNumber} 行 ${caseId}「${system.header}」是公式单元格（${cell.address}），已跳过`
        );
        continue;
      }

      const current = cellText(cell);
      let last: string | null;
      try {
        last = await input.lastSystemValue(caseId, system.key);
      } catch (error) {
        failed += 1;
        warnings.push(
          `读取写回日志失败：${caseId}「${system.header}」（${errorMessage(error)}），已跳过`
        );
        continue;
      }
      const lastText = last === null || last === undefined || last.trim() === "" ? null : last.trim();
      if (lastText === null) {
        if (current !== "") {
          const adopt = input.adoptExistingSystemColumns === true && existingSystemKeys.has(system.key);
          if (!adopt) {
            skipped += 1;
            warnings.push(
              existingSystemKeys.has(system.key)
                ? `第 ${rowNumber} 行 ${caseId}「${system.header}」无写回日志，按人工内容冻结（${cell.address}，原值「${current}」）；如需沿用旧系统列请显式 adoptExistingSystemColumns`
                : `第 ${rowNumber} 行 ${caseId}「${system.header}」已有非系统内容（${cell.address}），已跳过`
            );
            continue;
          }
          warnings.push(
            `第 ${rowNumber} 行 ${caseId}「${system.header}」无写回日志，按系统格刷新（原值「${current}」）`
          );
        }
      } else if (current === "") {
        skipped += 1;
        warnings.push(
          `第 ${rowNumber} 行 ${caseId}「${system.header}」已被人工清空（${cell.address}），已跳过`
        );
        continue;
      } else if (current !== lastText) {
        skipped += 1;
        warnings.push(
          `第 ${rowNumber} 行 ${caseId}「${system.header}」含人工内容（系统上次写入「${lastText}」，当前「${current}」），已跳过（${cell.address}）`
        );
        continue;
      }

      writes.push({ caseId, rowNumber, system, value, cell });
    }
  }

  let written = 0;
  const writtenCells: WritebackCellWrite[] = [];
  if (writes.length > 0) {
    for (const entry of appended) {
      sheet.getCell(headerRow, entry.column).value = entry.header;
    }
    for (const write of writes) {
      write.cell.value = write.value;
    }
    const target = path.resolve(input.workbookPath);
    const tempPath = path.join(
      path.dirname(target),
      `.${path.basename(target)}.verify-${process.pid}-${Date.now()}.xlsx`
    );
    try {
      const buffer = Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
      writeFileAtomic(tempPath, buffer);
      const partsAfter = readXlsxParts(await readFile(tempPath));
      const lost = lostParts(partsBefore, partsAfter);
      if (lost.length > 0) {
        throw new WritebackError(
          "parts-lost",
          `写回后检测到工作簿 part 丢失：${lost.join("、")}。${UNSUPPORTED_PARTS_HINT}`
        );
      }
      await verifyWrittenCells(
        tempPath,
        sheet.name,
        writes.map((write) => ({
          address: write.cell.address,
          value: write.value,
          key: write.system.header,
          caseId: write.caseId
        }))
      );
      await rename(tempPath, target);
      for (const write of writes) {
        const cellRef = `${sheet.name}!${write.cell.address}`;
        written += 1;
        writtenCells.push({
          caseId: write.caseId,
          key: write.system.key,
          value: write.value,
          cellRef,
          address: write.cell.address,
          rowNumber: write.rowNumber,
          columnNumber: columns.get(write.system.key)!
        });
      }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof WritebackError) throw error;
      failed += writes.length;
      warnings.push(`工作副本保存失败：${errorMessage(error)}`);
    }
  }

  return {
    written,
    skipped,
    failed,
    columns: SYSTEM_COLUMNS.map((system) => system.header),
    warnings,
    writtenCells
  };
}
