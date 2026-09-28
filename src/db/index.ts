import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { ProjectStore } from "./types.js";

export interface CreateStoreResult {
  store: ProjectStore;
  degraded: boolean;
  reason: string | null;
}

/** Build the project store from AOS_DATABASE_URL; degrades to in-memory on failure. */
export async function createProjectStore(databaseUrl?: string | null): Promise<CreateStoreResult> {
  const url = (databaseUrl ?? process.env.AOS_DATABASE_URL ?? "").trim();
  if (!url) {
    return {
      store: new MemoryStore(),
      degraded: true,
      reason: "未配置 AOS_DATABASE_URL：使用会话内存存储（切换/条目仅本次进程有效）。"
    };
  }
  try {
    const store = await PostgresStore.create(url);
    const alive = await store.ping();
    if (!alive) throw new Error("ping failed");
    return { store, degraded: false, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      store: new MemoryStore(),
      degraded: true,
      reason: `PostgreSQL 连接失败（${message}）：已降级为会话内存存储。`
    };
  }
}

export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";
export type { ProjectStore } from "./types.js";
