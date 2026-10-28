import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type WorkbookCopyErrorCode = "same-path";

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

/**
 * 确保工作副本存在：原件只读，仅在其缺失时复制一次；副本已存在时不覆盖（保留人工/系统写入）。
 * 调用方必须先复制再写回，原件 sha 不因写回改变。
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
  try {
    await access(target);
    return;
  } catch {
    /* copy below */
  }
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(original, target, constants.COPYFILE_EXCL);
  } catch (error) {
    // 并发创建同份副本：另一个写者已先复制，保留先到者内容。
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}
