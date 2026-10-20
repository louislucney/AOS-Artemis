import fs from "node:fs";
import path from "node:path";

import type {
  LegacyLedgerImportResult,
  ProjectStore,
  RegressionTaskRecord,
  UsageEventRecord
} from "../db/types.js";
import { errorMessage } from "../util.js";

export interface LegacyLedgerSnapshot {
  usage: UsageEventRecord[];
  regressionTasks: RegressionTaskRecord[];
  warnings: string[];
  ledgerDir: string;
}

export interface LegacyLedgerMigrationResult {
  ok: boolean;
  dryRun: boolean;
  ledgerDir: string;
  counts: LegacyLedgerImportResult | null;
  warnings: string[];
  error?: string;
}

function readJsonLines(file: string, label: string, warnings: string[]): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return [];
  const entries: Record<string, unknown>[] = [];
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") {
        entries.push(parsed as Record<string, unknown>);
      } else {
        warnings.push(`${label} 第 ${index + 1} 行缺少 id，已跳过`);
      }
    } catch {
      warnings.push(`${label} 第 ${index + 1} 行不是合法 JSON，已跳过`);
    }
  }
  return entries;
}

function dedupeById<T extends { id: string }>(entries: T[], label: string, warnings: string[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      warnings.push(`${label} 存在重复 id ${entry.id}，仅保留一条`);
      continue;
    }
    seen.add(entry.id);
    kept.push(entry);
  }
  return kept;
}

export function readLegacyLedger(rootPath: string): LegacyLedgerSnapshot {
  const ledgerDir = path.join(rootPath, ".artemis", "ledger");
  const warnings: string[] = [];
  const usage = dedupeById(
    readJsonLines(path.join(ledgerDir, "usage.jsonl"), "usage.jsonl", warnings) as unknown as UsageEventRecord[],
    "usage_events",
    warnings
  );

  let regressionTasks: RegressionTaskRecord[] = [];
  const stateFile = path.join(ledgerDir, "state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as {
        state?: { regressionTasks?: unknown };
      };
      const tasks = parsed?.state?.regressionTasks;
      if (Array.isArray(tasks)) {
        regressionTasks = dedupeById(
          tasks.filter((entry): entry is RegressionTaskRecord =>
            entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
          ),
          "regression_tasks",
          warnings
        );
      }
    } catch {
      warnings.push("state.json 无法解析，跳过 regression_tasks");
    }
  } else {
    warnings.push("state.json 不存在，跳过 regression_tasks");
  }

  return { usage, regressionTasks, warnings, ledgerDir };
}

export async function migrateLegacyLedger(
  store: ProjectStore,
  rootPath: string,
  options: { dryRun?: boolean } = {}
): Promise<LegacyLedgerMigrationResult> {
  const dryRun = options.dryRun !== false;
  const snapshot = readLegacyLedger(rootPath);
  const base = {
    dryRun,
    ledgerDir: snapshot.ledgerDir,
    warnings: snapshot.warnings
  };
  if (typeof store.importLegacyLedger !== "function") {
    return {
      ...base,
      ok: false,
      counts: null,
      error: "历史台账迁移需要中心 PostgreSQL（当前存储为 " + store.kind + "）"
    };
  }
  try {
    const counts = await store.importLegacyLedger(
      rootPath,
      { usage: snapshot.usage, regressionTasks: snapshot.regressionTasks },
      dryRun
    );
    return { ...base, ok: true, counts };
  } catch (error) {
    return { ...base, ok: false, counts: null, error: errorMessage(error) };
  }
}
