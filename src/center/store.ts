import { PostgresStore } from "../db/postgres.js";
import type { HostRecord, ProjectStore } from "../db/types.js";

export const CENTER_DATABASE_ENV = "MOBILE_TESTING_DATABASE_URL";

/** 中心 CLI（host / 远端套件任务）只读中心 PG：缺连接串直接失败，不回落文件台账。 */
export async function openCenterStore(env: NodeJS.ProcessEnv = process.env): Promise<PostgresStore> {
  const url = (env[CENTER_DATABASE_ENV] ?? "").trim();
  if (url === "") {
    throw new Error(`host/queue 命令需要 ${CENTER_DATABASE_ENV}`);
  }
  return await PostgresStore.create(url);
}

export type HostReferenceLookup =
  | { ok: true; host: HostRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "ambiguous"; candidates: HostRecord[] };

/** `--host` 解析：精确 id 优先；否则按 hostname 唯一匹配（重名不猜，交回候选）。 */
export async function resolveHostReference(
  store: ProjectStore,
  reference: string
): Promise<HostReferenceLookup> {
  const trimmed = reference.trim();
  if (trimmed === "") return { ok: false, reason: "not-found" };
  const exact = await store.getHost(trimmed);
  if (exact !== null) return { ok: true, host: exact };
  const matches = (await store.listHosts()).filter((host) => host.hostname === trimmed);
  if (matches.length === 1) return { ok: true, host: matches[0]! };
  if (matches.length === 0) return { ok: false, reason: "not-found" };
  return { ok: false, reason: "ambiguous", candidates: matches };
}
