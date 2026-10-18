import { FileStore } from "./file.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { ProjectStore } from "./types.js";

export interface CreateStoreResult {
  store: ProjectStore;
  kind: "postgres" | "file" | "memory";
  degraded: boolean;
  reason: string | null;
}

/** 存储装配（强制持久）：PostgreSQL → 项目文件台账（.artemis/ledger）→ 会话内存（仅最后兜底，如实标注）。 */
export async function createProjectStore(databaseUrl?: string | null): Promise<CreateStoreResult> {
  const url = (databaseUrl ?? process.env.MOBILE_TESTING_DATABASE_URL ?? "").trim();
  if (url !== "") {
    try {
      const store = await PostgresStore.create(url);
      const alive = await store.ping();
      if (!alive) throw new Error("ping failed");
      return { store, kind: "postgres", degraded: false, reason: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return tryFileStore(
        `PostgreSQL 连接失败（${message}）：已改用项目文件台账（.artemis/ledger，数据仍持久；PG 恢复后历史不自动回流）。`
      );
    }
  }
  return tryFileStore("未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账（.artemis/ledger，随项目持久）。");
}

async function tryFileStore(reason: string): Promise<CreateStoreResult> {
  try {
    const store = await FileStore.create();
    return { store, kind: "file", degraded: false, reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      store: new MemoryStore(),
      kind: "memory",
      degraded: true,
      reason: `${message}。本次会话使用内存，数据不会持久。`
    };
  }
}

export { FileStore } from "./file.js";
export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";
export type { ProjectStore } from "./types.js";
