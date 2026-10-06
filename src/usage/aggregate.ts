import type {
  UsageErrorClass,
  UsageEventFamily,
  UsageEventQuery,
  UsageEventRecord
} from "../db/types.js";
import { normalizeUsageLimit } from "../db/usage-event.js";

export const USAGE_EVENT_LIST_MAX = 200;

export const USAGE_DEGRADATION_CODES: readonly string[] = [
  "ios-log-unsupported",
  "ios-unsupported",
  "lossless_fallback",
  "param_ignored",
  "simctl_fallback",
  "skipped_occupied",
  "skipped_unmanaged",
  "vision_degraded"
];

const DEGRADATION_CODE_SET: ReadonlySet<string> = new Set(USAGE_DEGRADATION_CODES);

const QUOTED_PATTERN = /"[^"]*"|'[^']*'/g;
const PATH_PATTERN = /[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)+/g;
const UUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_PATTERN = /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{8,}\b/g;
const TOKEN_PATTERN = /[A-Za-z0-9_+/=-]{24,}/g;
const NUMBER_PATTERN = /\d+(?:\.\d+)?/g;

export interface UsageToolSummary {
  tool: string;
  count: number;
  ok: number;
  error: number;
  successRate: number;
  p50: number | null;
  p95: number | null;
}

export interface UsageFamilyCount {
  family: UsageEventFamily;
  count: number;
}

export interface UsageDayCount {
  day: string;
  count: number;
}

export interface UsageSummary {
  total: number;
  ok: number;
  error: number;
  successRate: number;
  p50: number | null;
  p95: number | null;
  byTool: UsageToolSummary[];
  byFamily: UsageFamilyCount[];
  byDay: UsageDayCount[];
  zeroCallTools: string[];
}

export interface UsageErrorClassCount {
  errorClass: UsageErrorClass | null;
  count: number;
}

export interface UsageTemplateCluster {
  template: string;
  count: number;
  tools: string[];
}

export interface UsageSignalCount {
  code: string;
  field: string | null;
  count: number;
}

export interface UsageCodeCount {
  code: string;
  count: number;
}

export interface UsageArgKeyCount {
  key: string;
  count: number;
}

export interface UsageToolArgKeys {
  tool: string;
  keys: UsageArgKeyCount[];
}

export interface UsageSignals {
  errorClasses: UsageErrorClassCount[];
  unclassified: UsageTemplateCluster[];
  signalCodes: UsageSignalCount[];
  degradations: UsageCodeCount[];
  argKeys: UsageToolArgKeys[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareErrorClass(a: UsageErrorClass | null, b: UsageErrorClass | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareStrings(a, b);
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? null;
}

export function normalizeUsageErrorTemplate(summary: string | null): string {
  const base = (summary ?? "").replace(/\s+/g, " ").trim();
  if (base === "") return "<no-summary>";
  return base
    .replace(QUOTED_PATTERN, "<str>")
    .replace(PATH_PATTERN, "<path>")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(HEX_PATTERN, "<hex>")
    .replace(TOKEN_PATTERN, "<token>")
    .replace(NUMBER_PATTERN, "<num>");
}

export function usageSummary(
  events: readonly UsageEventRecord[],
  catalog?: readonly string[]
): UsageSummary {
  let ok = 0;
  const durations: number[] = [];
  const toolStats = new Map<string, { count: number; ok: number; durations: number[] }>();
  const familyCounts = new Map<UsageEventFamily, number>();
  const dayCounts = new Map<string, number>();

  for (const event of events) {
    if (event.ok) ok += 1;
    durations.push(event.durationMs);
    let stats = toolStats.get(event.tool);
    if (!stats) {
      stats = { count: 0, ok: 0, durations: [] };
      toolStats.set(event.tool, stats);
    }
    stats.count += 1;
    if (event.ok) stats.ok += 1;
    stats.durations.push(event.durationMs);
    familyCounts.set(event.family, (familyCounts.get(event.family) ?? 0) + 1);
    const day = event.at.slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  durations.sort((a, b) => a - b);
  const byTool = [...toolStats.entries()]
    .map(([tool, stats]) => {
      stats.durations.sort((a, b) => a - b);
      return {
        tool,
        count: stats.count,
        ok: stats.ok,
        error: stats.count - stats.ok,
        successRate: stats.ok / stats.count,
        p50: percentile(stats.durations, 50),
        p95: percentile(stats.durations, 95)
      };
    })
    .sort((a, b) => b.count - a.count || compareStrings(a.tool, b.tool));

  const byFamily = [...familyCounts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.family, b.family));

  const byDay = [...dayCounts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => compareStrings(a.day, b.day));

  const seenTools = new Set(toolStats.keys());
  const zeroCallTools = catalog
    ? [...new Set(catalog)].filter((tool) => !seenTools.has(tool)).sort(compareStrings)
    : [];

  const total = events.length;
  return {
    total,
    ok,
    error: total - ok,
    successRate: total === 0 ? 0 : ok / total,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    byTool,
    byFamily,
    byDay,
    zeroCallTools
  };
}

export function usageSignals(events: readonly UsageEventRecord[]): UsageSignals {
  const classCounts = new Map<UsageErrorClass | null, number>();
  const clusters = new Map<string, { count: number; tools: Set<string> }>();
  const signalCounts = new Map<string, UsageSignalCount>();
  const degradationCounts = new Map<string, number>();
  const argKeyCounts = new Map<string, Map<string, number>>();

  for (const event of events) {
    classCounts.set(event.errorClass, (classCounts.get(event.errorClass) ?? 0) + 1);

    if (event.errorClass === "unknown" || (!event.ok && event.errorClass === null)) {
      const template = normalizeUsageErrorTemplate(event.errorSummary);
      let cluster = clusters.get(template);
      if (!cluster) {
        cluster = { count: 0, tools: new Set<string>() };
        clusters.set(template, cluster);
      }
      cluster.count += 1;
      cluster.tools.add(event.tool);
    }

    for (const signal of event.signals) {
      const field = signal.field ?? null;
      const key = `${signal.code}\u0000${field ?? ""}`;
      const existing = signalCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        signalCounts.set(key, { code: signal.code, field, count: 1 });
      }
      if (DEGRADATION_CODE_SET.has(signal.code)) {
        degradationCounts.set(signal.code, (degradationCounts.get(signal.code) ?? 0) + 1);
      }
    }

    let toolKeys = argKeyCounts.get(event.tool);
    if (!toolKeys) {
      toolKeys = new Map<string, number>();
      argKeyCounts.set(event.tool, toolKeys);
    }
    for (const key of new Set(event.argKeys)) {
      toolKeys.set(key, (toolKeys.get(key) ?? 0) + 1);
    }
  }

  const errorClasses = [...classCounts.entries()]
    .map(([errorClass, count]) => ({ errorClass, count }))
    .sort((a, b) => b.count - a.count || compareErrorClass(a.errorClass, b.errorClass));

  const unclassified = [...clusters.entries()]
    .map(([template, cluster]) => ({
      template,
      count: cluster.count,
      tools: [...cluster.tools].sort(compareStrings)
    }))
    .sort((a, b) => b.count - a.count || compareStrings(a.template, b.template));

  const signalCodes = [...signalCounts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.field ?? "", b.field ?? "")
  );

  const degradations = [...degradationCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || compareStrings(a.code, b.code));

  const argKeys = [...argKeyCounts.entries()]
    .map(([tool, keys]) => ({
      tool,
      keys: [...keys.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || compareStrings(a.key, b.key))
    }))
    .sort((a, b) => compareStrings(a.tool, b.tool));

  return { errorClasses, unclassified, signalCodes, degradations, argKeys };
}

export function usageEvents(
  events: readonly UsageEventRecord[],
  query: UsageEventQuery = {}
): UsageEventRecord[] {
  const matched = events.filter((event) => {
    if (query.tool && event.tool !== query.tool) return false;
    if (query.status === "ok" && !event.ok) return false;
    if (query.status === "error" && event.ok) return false;
    if (query.since && event.at < query.since) return false;
    if (query.until && event.at > query.until) return false;
    return true;
  });
  matched.sort((a, b) => compareStrings(b.at, a.at) || compareStrings(b.id, a.id));
  const limit = Math.min(USAGE_EVENT_LIST_MAX, normalizeUsageLimit(query.limit));
  return matched.slice(0, limit);
}
