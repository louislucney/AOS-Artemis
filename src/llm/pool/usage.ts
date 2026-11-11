import type { NormalizedUsage } from "../../db/types.js";

export type { NormalizedUsage };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function outputCount(record: Record<string, unknown>): number {
  return count(record.completion_tokens) ?? count(record.output_tokens) ?? 0;
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  const record = asObject(raw);
  if (record === null) return null;
  const anthropicInput = count(record.input_tokens);
  const prompt = count(record.prompt_tokens);
  if (anthropicInput === null && prompt === null) return null;

  let baseInputTokens: number;
  let cacheCreationTokens: number;
  let cacheReadTokens: number;

  if (anthropicInput !== null) {
    baseInputTokens = anthropicInput;
    cacheCreationTokens = count(record.cache_creation_input_tokens) ?? 0;
    cacheReadTokens = count(record.cache_read_input_tokens) ?? 0;
  } else if (
    count(record.prompt_cache_hit_tokens) !== null ||
    count(record.prompt_cache_miss_tokens) !== null
  ) {
    cacheReadTokens = count(record.prompt_cache_hit_tokens) ?? 0;
    cacheCreationTokens = count(record.cache_creation_input_tokens) ?? 0;
    const miss = count(record.prompt_cache_miss_tokens);
    baseInputTokens = miss ?? Math.max(0, (prompt ?? 0) - cacheReadTokens);
  } else {
    const details = asObject(record.prompt_tokens_details);
    if (details !== null) {
      cacheReadTokens = count(details.cached_tokens) ?? 0;
      cacheCreationTokens = count(record.cache_creation_input_tokens) ?? 0;
      baseInputTokens = Math.max(0, (prompt ?? 0) - cacheReadTokens);
    } else {
      cacheReadTokens = count(record.cache_read_input_tokens) ?? 0;
      cacheCreationTokens = count(record.cache_creation_input_tokens) ?? 0;
      baseInputTokens = Math.max(0, (prompt ?? 0) - cacheReadTokens - cacheCreationTokens);
    }
  }

  const outputTokens = outputCount(record);
  return {
    baseInputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens: baseInputTokens + cacheCreationTokens + cacheReadTokens + outputTokens
  };
}

export function estimatedUsage(promptTokens: number, outputTokens: number): NormalizedUsage {
  const baseInputTokens = count(promptTokens) ?? 0;
  const output = count(outputTokens) ?? 0;
  return {
    baseInputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: output,
    totalTokens: baseInputTokens + output
  };
}
