import type { LlmBudgetPeriod } from "../../db/types.js";

export const LLM_USAGE_RETENTION_DAYS_DEFAULT = 365;
export const LLM_RESERVATION_TTL_MS_DEFAULT = 600_000;
export const LLM_USAGE_EVENTS_DEFAULT_LIMIT = 5000;
export const LLM_USAGE_EVENTS_MAX_LIMIT = 50000;

export function budgetPeriodKey(period: LlmBudgetPeriod, at?: string): string {
  if (period === "total") return "total";
  if (period === "none") return "all";
  const date = at === undefined ? new Date() : new Date(at);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const iso = valid.toISOString();
  return period === "daily" ? iso.slice(0, 10) : iso.slice(0, 7);
}

export function llmUsageRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AOS_LLM_USAGE_RETENTION_DAYS ?? "").trim();
  if (raw === "") return LLM_USAGE_RETENTION_DAYS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : LLM_USAGE_RETENTION_DAYS_DEFAULT;
}

export function llmReservationTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AOS_LLM_RESERVATION_TTL_MS ?? "").trim();
  if (raw === "") return LLM_RESERVATION_TTL_MS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : LLM_RESERVATION_TTL_MS_DEFAULT;
}

export function llmUsageEventsLimit(limit?: number): number {
  if (limit === undefined) return LLM_USAGE_EVENTS_DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return LLM_USAGE_EVENTS_DEFAULT_LIMIT;
  const capped = Math.floor(limit);
  if (capped < 1) return LLM_USAGE_EVENTS_DEFAULT_LIMIT;
  return Math.min(capped, LLM_USAGE_EVENTS_MAX_LIMIT);
}

export function llmUsageRetentionCutoffIso(
  retentionDays: number,
  nowMs: number = Date.now()
): string {
  return new Date(nowMs - retentionDays * 86_400_000).toISOString();
}
