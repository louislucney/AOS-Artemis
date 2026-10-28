import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

import { logWarn } from "../log.js";
import { errorMessage } from "../util.js";

export type WorkbookCopyErrorCode = "same-path" | "invalid-original";

export class WorkbookCopyError extends Error {
  readonly code: WorkbookCopyErrorCode;

  constructor(code: WorkbookCopyErrorCode, message: string) {
    super(message);
    this.name = "WorkbookCopyError";
    this.code = code;
  }
}

/** 工作副本固定路径：`<projectRoot>/.artemis/web/workbook/<assetId>.xlsx`（派生物，可覆盖改写）。 */
export function workbookCopyPath(projectRoot: string, assetId: string): string {
  return path.join(path.resolve(projectRoot), ".artemis", "web", "workbook", `${assetId}.xlsx`);
}

async function readableWorkbook(filePath: string): Promise<boolean> {
  try {
    const workbook = new ExcelJS.Workbook();
    const buffer = await readFile(filePath);
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    return workbook.worksheets.length > 0;
  } catch {
    return false;
  }
}

async function assertReadableOriginal(originalPath: string): Promise<void> {
  if (await readableWorkbook(originalPath)) return;
  throw new WorkbookCopyError(
    "invalid-original",
    `Excel 原件无法读取（文件损坏或不是有效的 .xlsx）：${originalPath}`
  );
}

/**
 * 确保工作副本存在且可读：原件只读，仅在副本缺失或损坏时复制；副本有效时原样保留
 * （含人工/系统写入）。损坏副本先删除再从原件重建（best-effort，失败保留异常）；
 * 原件本身不可读则 `invalid-original` 拒绝，不产生"看起来可写"的坏副本。
 */
export async function ensureWorkbookCopy(
  originalPath: string,
  workbookPath: string
): Promise<void> {
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
    /* 副本不存在，走复制 */
  }
  if (exists) {
    if (await readableWorkbook(target)) return;
    logWarn(`工作副本不可读，准备从原件重建：${target}`);
    await rm(target, { force: true });
  }

  await assertReadableOriginal(original);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(original, target, constants.COPYFILE_EXCL);
  } catch (error) {
    // 并发创建：另一写者已先复制；重新校验它可用，坏文件则把错误暴露给调用方。
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await readableWorkbook(target)) return;
      throw new Error(`并发生成的工作副本不可读：${target}（${errorMessage(error)}）`);
    }
    throw error;
  }
}
