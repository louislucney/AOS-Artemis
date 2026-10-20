import fs from "node:fs";
import path from "node:path";

export interface VisionHealthRecord {
  traceId: string;
  model: string | null;
  status: string | null;
  startedAt: string | null;
  reason: string;
}

export interface VisionHealth {
  tracesDir: string;
  checked: number;
  degraded: number;
  byReason: Array<{ reason: string; count: number }>;
  recent: VisionHealthRecord[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Read-only scan of project traces for iOS multimodal degradation. It only
 * reports recorded failures; successful calls are not logged (no body capture
 * on success). Missing/broken traces are skipped silently. */
export function scanVisionHealth(
  tracesDir: string,
  options: { limit?: number; recentLimit?: number } = {}
): VisionHealth {
  const limit = Math.max(1, Math.trunc(options.limit ?? 50));
  const recentLimit = Math.max(1, Math.trunc(options.recentLimit ?? 10));
  const result: VisionHealth = {
    tracesDir,
    checked: 0,
    degraded: 0,
    byReason: [],
    recent: []
  };
  let names: string[];
  try {
    names = fs
      .readdirSync(tracesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ios-"))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return result;
  }

  const reasons = new Map<string, number>();
  for (const name of names) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(tracesDir, name, "run.json"), "utf-8")) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    result.checked += 1;
    const reason = asString(parsed.vision_degraded);
    if (reason === null) continue;
    result.degraded += 1;
    const normalized = normalizeReason(reason);
    reasons.set(normalized, (reasons.get(normalized) ?? 0) + 1);
    if (result.recent.length < recentLimit) {
      result.recent.push({
        traceId: asString(parsed.trace_id) ?? name,
        model: asString(parsed.model),
        status: asString(parsed.status),
        startedAt: asString(parsed.started_at),
        reason: normalized
      });
    }
  }

  result.byReason = [...reasons.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => ({ reason, count }));
  return result;
}
