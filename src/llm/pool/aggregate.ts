import type { LlmUsageQuery, LlmUsageRecord } from "../../db/types.js";

export interface LlmUsageBucket {
  key: string;
  bucket: string | null;
  requests: number;
  baseInputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicrosBase: number;
  unpricedRequests: number;
  fxMissingRequests: number;
}

export interface LlmUsageReport {
  baseCurrency: string;
  since: string | null;
  until: string | null;
  bucket: "hour" | "day" | "month" | null;
  groupBy: "project" | "model" | "token" | "none";
  totals: LlmUsageBucket;
  rows: LlmUsageBucket[];
}

function emptyBucket(key: string, bucket: string | null): LlmUsageBucket {
  return {
    key,
    bucket,
    requests: 0,
    baseInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costMicrosBase: 0,
    unpricedRequests: 0,
    fxMissingRequests: 0
  };
}

function addEvent(bucket: LlmUsageBucket, event: LlmUsageRecord): void {
  bucket.requests += 1;
  bucket.baseInputTokens += event.baseInputTokens;
  bucket.cacheCreationTokens += event.cacheCreationTokens;
  bucket.cacheReadTokens += event.cacheReadTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.totalTokens += event.totalTokens;
  bucket.costMicrosBase += event.costMicrosBase ?? 0;
  if (event.costMicros === null) {
    bucket.unpricedRequests += 1;
  } else if (event.costMicrosBase === null) {
    bucket.fxMissingRequests += 1;
  }
}

function bucketKey(at: string, bucket: "hour" | "day" | "month" | null): string | null {
  if (bucket === null) return null;
  if (bucket === "hour") return at.slice(0, 13);
  if (bucket === "day") return at.slice(0, 10);
  return at.slice(0, 7);
}

function groupKey(event: LlmUsageRecord, groupBy: LlmUsageReport["groupBy"]): string {
  if (groupBy === "project") return event.projectRoot ?? "(unknown)";
  if (groupBy === "model") return event.model;
  if (groupBy === "token") return event.poolTokenId ?? "(project-key)";
  return "all";
}

function baseCurrencyOf(events: readonly LlmUsageRecord[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.baseCurrency.trim() === "") continue;
    counts.set(event.baseCurrency, (counts.get(event.baseCurrency) ?? 0) + 1);
  }
  let best = "CNY";
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

export function aggregateLlmUsage(
  events: readonly LlmUsageRecord[],
  query: LlmUsageQuery = {}
): LlmUsageReport {
  const bucket = query.bucket ?? null;
  const groupBy = query.groupBy ?? "none";
  const filtered = events.filter(
    (event) =>
      (query.projectRoot === undefined || event.projectRoot === query.projectRoot) &&
      (query.poolTokenId === undefined || event.poolTokenId === query.poolTokenId) &&
      (query.provider === undefined || event.provider === query.provider) &&
      (query.model === undefined || event.model === query.model) &&
      (query.since === undefined || event.at >= query.since) &&
      (query.until === undefined || event.at <= query.until)
  );

  const totals = emptyBucket("all", null);
  const rows = new Map<string, LlmUsageBucket>();
  for (const event of filtered) {
    addEvent(totals, event);
    const timeKey = bucketKey(event.at, bucket);
    const key = `${groupKey(event, groupBy)}${timeKey === null ? "" : `@${timeKey}`}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = emptyBucket(key, timeKey);
      rows.set(key, row);
    }
    addEvent(row, event);
  }

  return {
    baseCurrency: baseCurrencyOf(filtered),
    since: query.since ?? null,
    until: query.until ?? null,
    bucket,
    groupBy,
    totals,
    rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))
  };
}
