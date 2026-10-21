/** 接入会话（IDE 客户端）在线判定：`hosts.client_seen_at` 在 `AOS_CLIENT_TTL_MS` 内视为在线。 */
export const CLIENT_TTL_DEFAULT_MS = 120_000;

/** 已结束接入会话的保留天数（`AOS_CLIENT_SESSION_RETENTION_DAYS`，0 = 不清理）。 */
export const CLIENT_SESSION_RETENTION_DAYS_DEFAULT = 7;

export function clientTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_CLIENT_TTL_MS?.trim();
  if (!raw) return CLIENT_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : CLIENT_TTL_DEFAULT_MS;
}

/** 缺省 7 天；非法/非整数（含 <1 的小数、溢出）回退 7；`0` 显式关闭清理。 */
export function hostSessionRetentionDaysFrom(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AOS_CLIENT_SESSION_RETENTION_DAYS?.trim();
  if (!raw) return CLIENT_SESSION_RETENTION_DAYS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return CLIENT_SESSION_RETENTION_DAYS_DEFAULT;
  return parsed;
}

/** 地址历史保留（`AOS_HOST_ADDR_HISTORY`）：仅字面 `0`/`false` 关闭；缺省开启。 */
export function hostAddressHistoryFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AOS_HOST_ADDR_HISTORY ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** 未来时间（时钟偏差）视为在线；非法时间/缺失视为离线。 */
export function isClientOnline(lastSeenAt: string | null, nowMs: number, ttlMs: number): boolean {
  if (lastSeenAt === null) return false;
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen <= ttlMs;
}
