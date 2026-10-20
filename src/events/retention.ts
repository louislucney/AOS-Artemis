export interface EventRetentionPolicy {
  days: number;
  max: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function eventRetentionPolicy(env: NodeJS.ProcessEnv = process.env): EventRetentionPolicy {
  return {
    days: positiveInteger(env.AOS_EVENTS_RETENTION_DAYS, 30),
    max: positiveInteger(env.AOS_EVENTS_MAX, 50000)
  };
}

export function eventCutoffIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString();
}
