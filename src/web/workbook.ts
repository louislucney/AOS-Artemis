import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { logWarn } from "../log.js";
import { errorMessage } from "../util.js";
import { csvToXlsxBuffer, CsvError, looksLikeCsv, type CsvEncoding } from "./csv.js";

export type WorkbookCopyErrorCode =
  | "same-path"
  | "invalid-original"
  | "unsupported-encoding"
  | "too-large"
  | "copy-unreadable";

export class WorkbookCopyError extends Error {
  readonly code: WorkbookCopyErrorCode;

  constructor(code: WorkbookCopyErrorCode, message: string) {
    super(message);
    this.name = "WorkbookCopyError";
    this.code = code;
  }
}

export interface WorkbookCopyInfo {
  /** 生成副本时原件的格式；沿用已有有效副本时恒为 xlsx。 */
  format: "xlsx" | "csv";
  encoding?: CsvEncoding;
  /** 本次是否新建了副本（false＝沿用已有有效副本）。 */
  created: boolean;
}

/** 工作副本固定路径：`<projectRoot>/.artemis/web/workbook/<assetId>.xlsx`（派生物，可覆盖改写）。 */
export function workbookCopyPath(projectRoot: string, assetId: string): string {
  return path.join(path.resolve(projectRoot), ".artemis", "web", "workbook", `${assetId}.xlsx`);
}

type WorkbookInspection =
  | { ok: true }
  | { ok: false; reason: "read"; error: unknown }
  | { ok: false; reason: "parse"; error: unknown };

async function inspectBuffer(buffer: Buffer): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  if (workbook.worksheets.length === 0) throw new Error("工作簿没有工作表");
}

/**
 * 区分「读文件失败」（EACCES/EMFILE/EIO/EISDIR，可能是瞬时或权限问题）与
 * 「解析/校验失败」（截断、非 xlsx、无工作表，确定需要重建）。
 */
async function inspectWorkbook(filePath: string): Promise<WorkbookInspection> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    return { ok: false, reason: "read", error };
  }
  try {
    await inspectBuffer(buffer);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "parse", error };
  }
}

interface OriginalWorkbook {
  format: "xlsx" | "csv";
  encoding?: CsvEncoding;
  /** 可直接写入工作副本的 xlsx 字节（CSV 原件已转码）。 */
  data: Buffer;
}

function isZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

/**
 * 原件只读读取：`.csv` 扩展名或「内容像 CSV 且不是 zip」时转成 xlsx 字节；
 * 其余按 xlsx 校验，损坏则 `invalid-original`。绝不把 CSV 原文当作 xlsx 复制。
 */
async function readOriginal(originalPath: string): Promise<OriginalWorkbook> {
  let buffer: Buffer;
  try {
    buffer = await readFile(originalPath);
  } catch (error) {
    throw new WorkbookCopyError(
      "invalid-original",
      `Excel 原件无法读取（文件不可读）：${originalPath}（${errorMessage(error)}）`
    );
  }

  const csvByExtension = path.extname(originalPath).toLowerCase() === ".csv";
  if (!isZipMagic(buffer) && (csvByExtension || looksLikeCsv(buffer))) {
    try {
      const converted = await csvToXlsxBuffer(buffer);
      return { format: "csv", encoding: converted.encoding, data: converted.buffer };
    } catch (error) {
      const code: WorkbookCopyErrorCode =
        error instanceof CsvError && error.code === "unsupported-encoding"
          ? "unsupported-encoding"
          : error instanceof CsvError && error.code === "too-large"
            ? "too-large"
            : "invalid-original";
      throw new WorkbookCopyError(
        code,
        `CSV 原件无法读取：${originalPath}（${errorMessage(error)}）`
      );
    }
  }

  try {
    await inspectBuffer(buffer);
  } catch (error) {
    throw new WorkbookCopyError(
      "invalid-original",
      `Excel 原件无法读取（文件损坏或不是有效的 .xlsx）：${originalPath}（${errorMessage(error)}）`
    );
  }
  return { format: "xlsx", data: buffer };
}

/** 重建前把损坏副本改名留档，避免直接删除用户可能还需要取证的坏文件。 */
async function quarantineCorruptCopy(target: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = `${target}.corrupt-${stamp}`;
  for (let suffix = 1; ; suffix += 1) {
    try {
      await access(candidate);
      candidate = `${target}.corrupt-${stamp}-${suffix}`;
    } catch {
      break;
    }
  }
  await rename(target, candidate);
  return candidate;
}

/**
 * 确保工作副本存在且可读：原件只读，仅在副本缺失或损坏时生成；副本有效时原样保留
 * （含人工/系统写入）。CSV 原件在这里转成规范 xlsx（工作表 `csv`），不是按字节复制。
 * 副本解析失败时先改名为 `<copy>.corrupt-<ts>` 再从原件重建；
 * 副本读文件失败（权限/句柄/IO）不重建、不删除，直接抛 `copy-unreadable`。
 * 原件本身不可读则 `invalid-original` 拒绝，不产生"看起来可写"的坏副本。
 */
export async function ensureWorkbookCopy(
  originalPath: string,
  workbookPath: string
): Promise<WorkbookCopyInfo> {
  const original = path.resolve(originalPath);
  const target = path.resolve(workbookPath);
  if (original === target) {
    throw new WorkbookCopyError("same-path", `工作副本不能是原件本身：${target}`);
  }

  let exists = false;
  try {
    await access(target);
    exists = true;
  } catch {
    /* 副本不存在，走生成 */
  }
  if (exists) {
    const inspection = await inspectWorkbook(target);
    if (inspection.ok) return { format: "xlsx", created: false };
    if (inspection.reason === "read") {
      throw new WorkbookCopyError(
        "copy-unreadable",
        `工作副本无法读取（未重建，保留原文件）：${target}（${errorMessage(inspection.error)}）`
      );
    }
    const quarantined = await quarantineCorruptCopy(target);
    logWarn(`工作副本不可读，已改名留档并从原件重建：${target} → ${quarantined}`);
  }

  const source = await readOriginal(original);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const handle = await open(target, "wx");
    try {
      await handle.writeFile(source.data);
    } finally {
      await handle.close();
    }
  } catch (error) {
    // 并发创建：另一写者已先写；重新校验它可用，坏文件则把错误暴露给调用方。
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const inspection = await inspectWorkbook(target);
      if (inspection.ok) return { format: "xlsx", created: false };
      throw new Error(
        `并发生成的工作副本不可读：${target}（${errorMessage(inspection.error)}）`
      );
    }
    throw error;
  }
  return {
    format: source.format,
    created: true,
    ...(source.encoding === undefined ? {} : { encoding: source.encoding })
  };
}
