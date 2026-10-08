import fs from "node:fs";
import path from "node:path";

export interface RetentionEntry {
  category: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface RetentionItem {
  category: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  ageDays: number;
}

export interface RetentionCategorySummary {
  id: string;
  total: number;
  overdue: number;
  overdueBytes: number;
  oldestModifiedAt: string | null;
}

export interface RetentionReport {
  generatedAt: string;
  cutoffDays: number;
  overdue: { count: number; totalBytes: number };
  categories: RetentionCategorySummary[];
  items: RetentionItem[];
  truncated: boolean;
}

export const RETENTION_CATEGORIES: Array<{ id: string; segments: string[] }> = [
  { id: "reports", segments: [".artemis", "design", "reports"] },
  { id: "evidence", segments: [".artemis", "design", "evidence"] },
  { id: "diffs", segments: [".artemis", "design", "diffs"] },
  { id: "traces", segments: [".artemis", "traces"] },
  { id: "crashes", segments: [".artemis", "crashes"] }
];

function walkFiles(root: string, category: string, out: RetentionEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, category, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = fs.statSync(abs);
      out.push({ category, path: abs, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* 文件在扫描期间消失：跳过 */
    }
  }
}

/** 只读扫描保留期候选产物（不删除任何文件）。 */
export function collectRetentionEntries(projectRoot: string): RetentionEntry[] {
  const out: RetentionEntry[] = [];
  for (const category of RETENTION_CATEGORIES) {
    walkFiles(path.join(projectRoot, ...category.segments), category.id, out);
  }
  return out;
}

export function buildRetentionReport(
  entries: RetentionEntry[],
  options: { days: number; nowMs: number; limit?: number; projectRoot?: string }
): RetentionReport {
  const limit = options.limit ?? 20;
  const cutoffMs = options.nowMs - options.days * 24 * 60 * 60 * 1000;
  const root = options.projectRoot ?? "";
  const relative = (abs: string): string =>
    root !== "" && abs.startsWith(root + path.sep) ? abs.slice(root.length + 1) : abs;

  const byCategory = new Map<string, RetentionCategorySummary>();
  for (const category of RETENTION_CATEGORIES) {
    byCategory.set(category.id, {
      id: category.id,
      total: 0,
      overdue: 0,
      overdueBytes: 0,
      oldestModifiedAt: null
    });
  }
  const overdueItems: RetentionItem[] = [];
  for (const entry of entries) {
    const summary = byCategory.get(entry.category) ?? {
      id: entry.category,
      total: 0,
      overdue: 0,
      overdueBytes: 0,
      oldestModifiedAt: null
    };
    byCategory.set(entry.category, summary);
    summary.total += 1;
    if (entry.mtimeMs < cutoffMs) {
      summary.overdue += 1;
      summary.overdueBytes += entry.sizeBytes;
      if (
        summary.oldestModifiedAt === null ||
        entry.mtimeMs < Date.parse(summary.oldestModifiedAt)
      ) {
        summary.oldestModifiedAt = new Date(entry.mtimeMs).toISOString();
      }
      overdueItems.push({
        category: entry.category,
        path: relative(entry.path),
        sizeBytes: entry.sizeBytes,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
        ageDays: Math.floor((options.nowMs - entry.mtimeMs) / (24 * 60 * 60 * 1000))
      });
    }
  }
  overdueItems.sort((left, right) => right.ageDays - left.ageDays);
  const totalBytes = overdueItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  return {
    generatedAt: new Date(options.nowMs).toISOString(),
    cutoffDays: options.days,
    overdue: { count: overdueItems.length, totalBytes },
    categories: [...byCategory.values()],
    items: overdueItems.slice(0, limit),
    truncated: overdueItems.length > limit
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
