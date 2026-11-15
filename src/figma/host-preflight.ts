import { statfs } from "node:fs/promises";

export interface HostPreflightResult {
  ok: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  freePercent: number | null;
  minFreePercent: number;
  reason: "insufficient-disk" | "unavailable" | null;
  message: string;
}

export interface HostPreflightOptions {
  rootPath: string;
  env?: NodeJS.ProcessEnv;
  statfsFn?: typeof statfs;
}

const DEFAULT_MIN_FREE_PERCENT = 10;

function minFreePercentFrom(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseFloat(env.AOS_RUNNER_MIN_FREE_DISK_PCT ?? "");
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MIN_FREE_PERCENT;
  return Math.min(raw, 100);
}

/** 执行机宿主磁盘门禁：只检查项目所在卷，不检查设备本身。
 * 读取失败标 unavailable 但不阻断（避免不同文件系统/容器误伤）。 */
export async function checkHostDisk(options: HostPreflightOptions): Promise<HostPreflightResult> {
  const env = options.env ?? process.env;
  const minFreePercent = minFreePercentFrom(env);
  const statfsFn = options.statfsFn ?? statfs;
  try {
    const stats = await statfsFn(options.rootPath);
    const blockSize = Number(stats.bsize);
    const blocks = Number(stats.blocks);
    const available = Number(stats.bavail);
    if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || !Number.isFinite(available) || blockSize <= 0 || blocks <= 0) {
      return {
        ok: true,
        freeBytes: null,
        totalBytes: null,
        freePercent: null,
        minFreePercent,
        reason: "unavailable",
        message: "执行机磁盘信息不可用（不阻断）"
      };
    }
    const freeBytes = available * blockSize;
    const totalBytes = blocks * blockSize;
    const freePercent = totalBytes === 0 ? null : (freeBytes / totalBytes) * 100;
    if (minFreePercent > 0 && freePercent !== null && freePercent < minFreePercent) {
      return {
        ok: false,
        freeBytes,
        totalBytes,
        freePercent,
        minFreePercent,
        reason: "insufficient-disk",
        message: `执行机磁盘不足：项目卷剩余 ${freePercent.toFixed(1)}%，低于 AOS_RUNNER_MIN_FREE_DISK_PCT=${minFreePercent}%`
      };
    }
    return {
      ok: true,
      freeBytes,
      totalBytes,
      freePercent,
      minFreePercent,
      reason: null,
      message: `执行机磁盘剩余 ${freePercent === null ? "未知" : `${freePercent.toFixed(1)}%`}`
    };
  } catch (error) {
    return {
      ok: true,
      freeBytes: null,
      totalBytes: null,
      freePercent: null,
      minFreePercent,
      reason: "unavailable",
      message: `执行机磁盘信息不可用（不阻断）：${error instanceof Error ? error.message : String(error)}`
    };
  }
}
