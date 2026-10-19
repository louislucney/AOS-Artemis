import fs from "node:fs";
import path from "node:path";

import { designDir } from "../figma/design-store.js";

/** 设计源警告的统一形态：flows.json `warnings` 与 tests.json `designWarnings` 同构。 */
export interface DesignWarning {
  code: string;
  message: string;
  details?: string[];
}

export interface WarningSummary {
  available: boolean;
  total: number;
  byCode: Record<string, number>;
  codes: string[];
  bySource?: Record<string, number>;
  snapshotAt?: string;
  stale?: boolean;
}

export interface WarningRead {
  warnings: DesignWarning[];
  snapshotAt: string | null;
  available: boolean;
}

export interface MergedWarnings {
  warnings: DesignWarning[];
  bySource: Record<string, number>;
}

export interface ResolvedDesignWarnings {
  warnings: DesignWarning[];
  summary: WarningSummary;
  source: "tests" | "flows" | "none";
  snapshotAt: string | null;
  stale: boolean;
}

interface WarningSnapshot extends WarningRead {
  mtimeMs: number | null;
}

export function normalizeWarnings(raw: unknown): DesignWarning[] {
  if (!Array.isArray(raw)) return [];
  const warnings: DesignWarning[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof record.code !== "string" || record.code.trim() === "") continue;
    if (typeof record.message !== "string" || record.message.trim() === "") continue;
    const warning: DesignWarning = { code: record.code, message: record.message };
    if (Array.isArray(record.details)) {
      const details = record.details.filter((detail): detail is string => typeof detail === "string");
      if (details.length > 0) warning.details = details;
    }
    warnings.push(warning);
  }
  return warnings;
}

function unavailableSnapshot(): WarningSnapshot {
  return { warnings: [], snapshotAt: null, available: false, mtimeMs: null };
}

function readSnapshot(file: string, field: "warnings" | "designWarnings"): WarningSnapshot {
  try {
    const stat = fs.statSync(file);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unavailableSnapshot();
    }
    return {
      warnings: normalizeWarnings((parsed as Record<string, unknown>)[field]),
      snapshotAt: stat.mtime.toISOString(),
      available: true,
      mtimeMs: stat.mtime.getTime()
    };
  } catch {
    return unavailableSnapshot();
  }
}

export function readFlowsWarnings(configDirAbs: string): WarningRead {
  const { warnings, snapshotAt, available } = readSnapshot(
    path.join(designDir(configDirAbs), "flows.json"),
    "warnings"
  );
  return { warnings, snapshotAt, available };
}

export function readTestsWarnings(
  configDirAbs: string,
  options: { testsPath?: string } = {}
): WarningRead {
  const file = options.testsPath ?? path.join(designDir(configDirAbs), "tests.json");
  const { warnings, snapshotAt, available } = readSnapshot(file, "designWarnings");
  return { warnings, snapshotAt, available };
}

/** 按 `code + "\0" + message` 去重并保留首次出现顺序；`bySource` 将每条唯一警告记给首个贡献来源，各值之和等于 `warnings.length`。 */
export function mergeWarnings(
  inputs: Array<{ warnings: DesignWarning[]; source: string }>
): MergedWarnings {
  const warnings: DesignWarning[] = [];
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const input of inputs) {
    if (!counts.has(input.source)) counts.set(input.source, 0);
    for (const warning of input.warnings) {
      const key = `${warning.code}\u0000${warning.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
      counts.set(input.source, (counts.get(input.source) ?? 0) + 1);
    }
  }
  return { warnings, bySource: Object.fromEntries(counts) };
}

export function summarizeWarnings(
  warnings: DesignWarning[],
  options: {
    available?: boolean;
    bySource?: Record<string, number>;
    snapshotAt?: string;
    stale?: boolean;
  } = {}
): WarningSummary {
  const counts = new Map<string, number>();
  const codes: string[] = [];
  for (const warning of warnings) {
    if (!counts.has(warning.code)) codes.push(warning.code);
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }
  const summary: WarningSummary = {
    available: options.available ?? true,
    total: warnings.length,
    byCode: Object.fromEntries(counts),
    codes
  };
  if (options.bySource !== undefined) summary.bySource = { ...options.bySource };
  if (options.snapshotAt !== undefined) summary.snapshotAt = options.snapshotAt;
  if (options.stale !== undefined) summary.stale = options.stale;
  return summary;
}

/** tests 快照优先、flows 回退；仅当采用 tests 且 flows 更新时标 stale（需重跑生成）。 */
export function resolveDesignWarnings(
  configDirAbs: string,
  options: { testsPath?: string; prefer?: "tests" | "flows" } = {}
): ResolvedDesignWarnings {
  const tests = readSnapshot(
    options.testsPath ?? path.join(designDir(configDirAbs), "tests.json"),
    "designWarnings"
  );
  const flows = readSnapshot(path.join(designDir(configDirAbs), "flows.json"), "warnings");
  const prefer = options.prefer === "flows" ? "flows" : "tests";
  const ordered: Array<{ source: "tests" | "flows"; snapshot: WarningSnapshot }> =
    prefer === "flows"
      ? [
          { source: "flows", snapshot: flows },
          { source: "tests", snapshot: tests }
        ]
      : [
          { source: "tests", snapshot: tests },
          { source: "flows", snapshot: flows }
        ];
  const chosen = ordered.find((entry) => entry.snapshot.available) ?? null;
  if (chosen === null) {
    return {
      warnings: [],
      summary: summarizeWarnings([], { available: false, stale: false }),
      source: "none",
      snapshotAt: null,
      stale: false
    };
  }
  const stale =
    chosen.source === "tests" &&
    flows.available &&
    tests.mtimeMs !== null &&
    flows.mtimeMs !== null &&
    flows.mtimeMs > tests.mtimeMs;
  const snapshotAt = chosen.snapshot.snapshotAt;
  return {
    warnings: chosen.snapshot.warnings,
    summary: summarizeWarnings(chosen.snapshot.warnings, {
      available: true,
      ...(snapshotAt !== null ? { snapshotAt } : {}),
      stale
    }),
    source: chosen.source,
    snapshotAt,
    stale
  };
}
