/** 接入会话（IDE 客户端）在线判定：`hosts.client_seen_at` 在 `AOS_CLIENT_TTL_MS` 内视为在线。 */
export const CLIENT_TTL_DEFAULT_MS = 120_000;

export function clientTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_CLIENT_TTL_MS?.trim();
  if (!raw) return CLIENT_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : CLIENT_TTL_DEFAULT_MS;
}

/** 未来时间（时钟偏差）视为在线；非法时间/缺失视为离线。 */
export function isClientOnline(lastSeenAt: string | null, nowMs: number, ttlMs: number): boolean {
  if (lastSeenAt === null) return false;
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen <= ttlMs;
}
