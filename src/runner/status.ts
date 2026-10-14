/** Runner 心跳在线判定（默认 TTL＝3×心跳周期 30s）。 */
export const RUNNER_TTL_DEFAULT_MS = 90_000;

export function runnerTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_RUNNER_TTL_MS?.trim();
  if (!raw) return RUNNER_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : RUNNER_TTL_DEFAULT_MS;
}

/** 未来时间（时钟偏差）视为在线；非法时间视为离线。 */
export function isRunnerOnline(lastSeenAt: string, nowMs: number, ttlMs: number): boolean {
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen <= ttlMs;
}
