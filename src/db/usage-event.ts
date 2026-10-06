import { randomUUID } from "node:crypto";

import type { RecordUsageEventInput, UsageErrorClass, UsageEventRecord } from "./types.js";

export const USAGE_ERROR_SUMMARY_MAX = 300;
export const USAGE_EVENT_DEFAULT_LIMIT = 100;

const USAGE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "validation",
  "figma",
  "artemis",
  "timeout",
  "internal",
  "unknown"
]);

export function isUsageErrorClass(value: unknown): value is UsageErrorClass {
  return typeof value === "string" && USAGE_ERROR_CLASSES.has(value);
}

export function buildUsageEvent(
  input: RecordUsageEventInput,
  projectId: string | null
): UsageEventRecord {
  const summary = input.errorSummary ?? null;
  return {
    id: randomUUID(),
    projectId,
    at: input.at ?? new Date().toISOString(),
    tool: input.tool,
    family: input.family,
    ok: input.ok,
    durationMs: input.durationMs,
    errorClass: input.errorClass ?? null,
    errorSummary: summary === null ? null : summary.slice(0, USAGE_ERROR_SUMMARY_MAX),
    signals: (input.signals ?? []).map((signal) => ({ ...signal })),
    argKeys: [...(input.argKeys ?? [])],
    traceId: input.traceId ?? null
  };
}

export function normalizeUsageLimit(limit?: number): number {
  return Number.isFinite(limit) && (limit as number) >= 1
    ? Math.floor(limit as number)
    : USAGE_EVENT_DEFAULT_LIMIT;
}

export function retentionCutoffIso(retentionDays: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - retentionDays * 86_400_000).toISOString();
}
