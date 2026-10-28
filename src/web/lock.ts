import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { sleep } from "../util.js";

export const FILE_LOCK_TIMEOUT_MS = 30_000;
export const FILE_LOCK_POLL_MS = 25;

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string, timeoutMs: number) {
    super(`等待文件锁超时（${timeoutMs}ms）：${lockPath}`);
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * 跨进程文件锁：`wx` 独占创建锁文件，失败按 poll 重试直到超时；`fn` 结束（含抛错）必删锁。
 * 单进程内的排队由调用方复用同一 lockPath 自然串行；多实例的 PG advisory lock 后续接入。
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? FILE_LOCK_POLL_MS;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  let handle: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath, timeoutMs);
      await sleep(pollMs);
    }
  }

  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}
