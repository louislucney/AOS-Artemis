import fs from "node:fs";
import path from "node:path";

export interface SidecarRetentionOptions {
  maxAgeDays?: number;
  maxFiles?: number;
  now?: number;
}

export interface SidecarRetentionPolicy {
  maxAgeDays: number;
  maxFiles: number;
}

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_FILES = 500;

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 0 表示关闭该维度；非法值回退默认。 */
export function sidecarRetentionFromEnv(env: NodeJS.ProcessEnv): SidecarRetentionPolicy {
  return {
    maxAgeDays: nonNegativeInt(env.AOS_TASK_SIDECAR_RETENTION_DAYS, DEFAULT_MAX_AGE_DAYS),
    maxFiles: nonNegativeInt(env.AOS_TASK_SIDECAR_MAX_FILES, DEFAULT_MAX_FILES)
  };
}

/** 清理目录下 `.json` 旁车：先按 mtime 新→旧保留 maxFiles，再删除超过 maxAgeDays 的文件。 */
export function pruneJsonSidecars(
  dir: string,
  options: SidecarRetentionOptions = {}
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return 0;
  }
  const now = options.now ?? Date.now();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const entries: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      entries.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      /* 已被并发清理 */
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  entries.forEach((entry, index) => {
    const tooMany = maxFiles > 0 && index >= maxFiles;
    const tooOld =
      maxAgeDays > 0 && now - entry.mtimeMs > maxAgeDays * 24 * 60 * 60 * 1000;
    if (!tooMany && !tooOld) return;
    try {
      fs.rmSync(entry.file, { force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  });
  return removed;
}
