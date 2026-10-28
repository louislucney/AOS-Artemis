import { readFile } from "node:fs/promises";

import ExcelJS from "exceljs";

import type { ExcelMappingRecord, ProjectStore } from "../db/types.js";
import { errorMessage } from "../util.js";
import { COLUMN_ALIASES, normalizeExcelHeader } from "./excel-columns.js";
import { readExcelHeaders } from "./excel.js";
import { cellText, SYSTEM_COLUMNS, type SystemColumnKey } from "./writeback.js";

export type SystemColumnMode = "inherit" | "human";

export const SYSTEM_COLUMN_MODES: readonly SystemColumnMode[] = ["inherit", "human"];

/** 系统列标记前缀（写回追加的 8 列传头都带其中之一）。 */
export const SYSTEM_COLUMN_PREFIXES = ["建议｜", "执行｜"] as const;

/** 缺省＝human：不信任下载后重上传的系统格，全部按人工内容冻结。 */
export const DEFAULT_SYSTEM_COLUMN_MODE: SystemColumnMode = "human";

const MAX_MISMATCHED_REPORTED = 100;

const SYSTEM_COLUMN_BY_HEADER = new Map(
  SYSTEM_COLUMNS.map((column) => [normalizeExcelHeader(column.header), column])
);

export function parseSystemColumnMode(raw: unknown): SystemColumnMode | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (SYSTEM_COLUMN_MODES as readonly string[]).includes(value)
    ? (value as SystemColumnMode)
    : null;
}

/**
 * 识别表头里的系统列候选：`建议｜`/`执行｜` 前缀、且位于用例编号列右侧（与写回同一锚点规则）。
 * 返回表头原文；前缀命中但不在 8 个固定系统列内的（如 `执行｜备注`）仍是人工列，重播种时会跳过。
 */
export function detectSystemColumns(
  headers: string[],
  caseIdHeader?: string | null
): string[] {
  const wanted = normalizeExcelHeader(caseIdHeader ?? "");
  const anchor = wanted === "" ? -1 : headers.map(normalizeExcelHeader).indexOf(wanted);
  const start = anchor === -1 ? 0 : anchor;
  const found: string[] = [];
  for (let index = start; index < headers.length; index += 1) {
    const header = headers[index]!.trim();
    if (header === "") continue;
    if (!SYSTEM_COLUMN_PREFIXES.some((prefix) => header.startsWith(prefix))) continue;
    if (found.includes(header)) continue;
    found.push(header);
  }
  return found;
}

/** 用例编号表头：优先已保存映射的写法，其次别名表，按表头顺序取首个命中。 */
export function resolveCaseIdHeader(
  headers: string[],
  preferred?: string | null
): string | null {
  const normalized = headers.map(normalizeExcelHeader);
  const candidates = [preferred ?? "", ...COLUMN_ALIASES.caseId];
  for (const candidate of candidates) {
    const wanted = normalizeExcelHeader(candidate);
    if (wanted === "") continue;
    const index = normalized.indexOf(wanted);
    if (index !== -1) return headers[index]!.trim();
  }
  return null;
}

export interface RebaseWorkbookJournalInput {
  store: ProjectStore;
  rootPath: string;
  /** 上一版本 excel 资产；缺省/未知表示没有可比对的 journal（全部冻结，不伪造）。 */
  previousAssetId: string | null;
  newAssetId: string;
  /** 工作表名；缺省＝第一张表。 */
  sheetName?: string;
  workbookPath: string;
  /** 显式系统列表头；缺省按表头前缀识别。 */
  systemHeaders?: string[];
  mode?: SystemColumnMode;
  /** 显式用例编号表头；缺省取上一版本保存的映射，再退回别名表。 */
  caseIdHeader?: string | null;
  headerRow?: number;
  actor?: string | null;
  writtenAt?: string;
}

/**
 * 计数口径：`rebased` 按格（已写入或已存在的 journal 行），`frozen` 按非空系统格
 * （保持人工归属，含 `mismatched`），`mismatched` 只列「上一版本 journal 有值但当前格不同」的格。
 */
export interface RebaseWorkbookJournalResult {
  mode: SystemColumnMode;
  rebased: number;
  frozen: number;
  mismatched: string[];
  systemHeaders: string[];
  warnings: string[];
}

function emptyResult(
  mode: SystemColumnMode,
  warnings: string[],
  systemHeaders: string[] = []
): RebaseWorkbookJournalResult {
  return { mode, rebased: 0, frozen: 0, mismatched: [], systemHeaders, warnings };
}

/** 上一版本资产的最新列映射（工作表名 + 用例编号表头都以它为准）。 */
async function savedMapping(
  input: RebaseWorkbookJournalInput
): Promise<ExcelMappingRecord | null> {
  if (input.previousAssetId === null) return null;
  const mappings = await input.store.listExcelMappings(input.rootPath, input.previousAssetId);
  const mapping = mappings.find((candidate) => candidate.sheetName.trim() !== "");
  return mapping ?? null;
}

/**
 * 重上传工作副本时重播种系统格 journal：`inherit` 逐格与上一版本 journal 比对，一致才为新
 * asset 归属；`human` 不写 journal。只写 journal，绝不改单元格内容；同 newAssetId 重复调用幂等。
 */
export async function rebaseWorkbookJournal(
  input: RebaseWorkbookJournalInput
): Promise<RebaseWorkbookJournalResult> {
  const mode = input.mode ?? DEFAULT_SYSTEM_COLUMN_MODE;
  const warnings: string[] = [];
  const rootPath = input.rootPath;

  let buffer: Buffer;
  try {
    buffer = await readFile(input.workbookPath);
  } catch (error) {
    warnings.push(`无法读取工作副本（${errorMessage(error)}）：${input.workbookPath}`);
    return emptyResult(mode, warnings);
  }

  // 工作表名与用例编号表头必须成对取自上一版本保存的映射：多表工作簿默认读第一张表会
  // 静默错表（甚至读成空）。显式参数是唯一不需要映射的入口。
  const mapping = await savedMapping(input);
  const explicitCaseId = (input.caseIdHeader ?? "").trim();
  const mappedSheet = mapping?.sheetName.trim() ?? "";
  const targetSheet =
    input.sheetName ?? (mappedSheet === "" ? undefined : mappedSheet);
  const preferredCaseId =
    explicitCaseId !== "" ? explicitCaseId : (mapping?.columnMap.caseId ?? null);

  let headers: string[];
  let sheetName: string;
  try {
    const loaded = await readExcelHeaders(buffer, {
      ...(targetSheet === undefined ? {} : { sheetName: targetSheet }),
      ...(input.headerRow === undefined ? {} : { headerRow: input.headerRow })
    });
    headers = loaded.headers;
    sheetName = loaded.sheetName;
  } catch (error) {
    warnings.push(`无法读取工作簿表头（${errorMessage(error)}）`);
    return emptyResult(mode, warnings);
  }

  const inheritWithoutMapping =
    mode === "inherit" && mapping === null && explicitCaseId === "" && targetSheet === undefined;
  if (inheritWithoutMapping) {
    warnings.push(
      "上一版本没有保存列映射：无法确认工作表与用例编号列，系统格全部按人工内容冻结（请先保存列映射后重试 inherit）"
    );
  }

  const caseIdHeader = resolveCaseIdHeader(headers, preferredCaseId);
  if (caseIdHeader === null) {
    warnings.push("找不到用例编号列：无法重播种系统格 journal（全部按人工内容冻结）");
    return emptyResult(mode, warnings, []);
  }

  const requested =
    input.systemHeaders === undefined || input.systemHeaders.length === 0
      ? detectSystemColumns(headers, caseIdHeader)
      : input.systemHeaders;
  const located = new Map<SystemColumnKey, { header: string; column: number }>();
  const normalizedHeaders = headers.map(normalizeExcelHeader);
  const detected: string[] = [];
  for (const header of requested) {
    const wanted = normalizeExcelHeader(header);
    const column = normalizedHeaders.indexOf(wanted);
    if (column === -1) continue;
    detected.push(headers[column]!.trim());
    const system = SYSTEM_COLUMN_BY_HEADER.get(wanted);
    if (system === undefined) continue;
    if (!located.has(system.key)) {
      located.set(system.key, { header: system.header, column: column + 1 });
    }
  }
  if (located.size === 0) {
    if (mode === "inherit") {
      warnings.push("未识别到 8 个固定系统列：没有可重播种的系统格（全部按人工内容冻结）");
    }
    return emptyResult(mode, warnings, detected);
  }

  let sheet: ExcelJS.Worksheet | undefined;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    sheet = workbook.worksheets.find((candidate) => candidate.name === sheetName);
  } catch (error) {
    warnings.push(`无法读取工作簿（${errorMessage(error)}）`);
    return emptyResult(mode, warnings, detected);
  }
  if (sheet === undefined) {
    warnings.push(`工作表不存在：${sheetName}`);
    return emptyResult(mode, warnings, detected);
  }

  const headerRow = input.headerRow ?? 1;
  const caseIdColumn = normalizedHeaders.indexOf(normalizeExcelHeader(caseIdHeader)) + 1;
  const rowCount = sheet.actualRowCount ?? 0;
  const rows: Array<{ caseId: string; rowNumber: number }> = [];
  const seen = new Set<string>();
  for (let rowNumber = headerRow + 1; rowNumber <= rowCount; rowNumber += 1) {
    const caseId = cellText(sheet.getCell(rowNumber, caseIdColumn)).trim();
    if (caseId === "") continue;
    if (seen.has(caseId)) {
      warnings.push(`用例编号重复：${caseId}（保留首行，第 ${rowNumber} 行忽略）`);
      continue;
    }
    seen.add(caseId);
    rows.push({ caseId, rowNumber });
  }

  let rebased = 0;
  let frozen = 0;
  const mismatched: string[] = [];
  let mismatchedTruncated = false;
  const inheritEnabled = mode === "inherit" && !inheritWithoutMapping;

  for (const row of rows) {
    for (const [key, column] of located) {
      const cell = sheet.getCell(row.rowNumber, column.column);
      if (cell.isMerged) continue;
      const value = cellText(cell).trim();
      if (value === "") continue;

      if (!inheritEnabled) {
        frozen += 1;
        continue;
      }

      // 单格失败只冻结该格：已落地的 journal 行必须体现在计数/审计里（不能外层清零）。
      try {
        const previous =
          input.previousAssetId === null
            ? null
            : await input.store.lastExcelWritebackByCellKey(
                rootPath,
                input.previousAssetId,
                sheetName,
                row.caseId,
                key
              );
        const previousValue = previous === null ? "" : previous.value.trim();
        if (previousValue === "") {
          frozen += 1;
          continue;
        }
        if (previousValue !== value) {
          frozen += 1;
          if (mismatched.length < MAX_MISMATCHED_REPORTED) {
            mismatched.push(`${row.caseId}「${column.header}」`);
          } else {
            mismatchedTruncated = true;
          }
          continue;
        }

        const seeded = await input.store.lastExcelWritebackByCellKey(
          rootPath,
          input.newAssetId,
          sheetName,
          row.caseId,
          key
        );
        if (seeded !== null) {
          if (seeded.value.trim() === value) {
            rebased += 1;
          } else {
            frozen += 1;
          }
          continue;
        }

        await input.store.recordExcelWriteback({
          rootPath,
          assetId: input.newAssetId,
          sheetName,
          caseId: row.caseId,
          columnKey: key,
          cellRef: `${sheetName}!${cell.address}`,
          value,
          actor: input.actor ?? null,
          ...(input.writtenAt === undefined ? {} : { writtenAt: input.writtenAt })
        });
        rebased += 1;
      } catch (error) {
        frozen += 1;
        warnings.push(
          `重播种失败：${row.caseId}「${column.header}」（${errorMessage(error)}），按人工内容冻结`
        );
      }
    }
  }

  if (mismatchedTruncated) {
    warnings.push(
      `与上一版本 journal 不一致的系统格超过 ${MAX_MISMATCHED_REPORTED} 个，仅列出前 ${MAX_MISMATCHED_REPORTED} 个`
    );
  }

  return {
    mode,
    rebased,
    frozen,
    mismatched,
    systemHeaders: detected,
    warnings
  };
}
