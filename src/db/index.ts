import { FileStore } from "./file.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore, isMigrationIncompleteError } from "./postgres.js";
import type { ProjectStore } from "./types.js";

export interface CreateStoreResult {
  store: ProjectStore;
  kind: "postgres" | "file" | "memory";
  degraded: boolean;
  reason: string | null;
}

export interface CreateStoreDeps {
  /** 测试注入：缺省 `PostgresStore.create`。 */
  createPostgres?: (url: string) => Promise<ProjectStore>;
}

/** 存储装配（强制持久）：PostgreSQL → 项目文件台账（.artemis/ledger）→ 会话内存（仅最后兜底，如实标注）。
 * 迁移未完成（`AOS_MIGRATION_INCOMPLETE`）不降级：schema 有问题时必须显式失败。 */
export async function createProjectStore(
  databaseUrl?: string | null,
  deps: CreateStoreDeps = {}
): Promise<CreateStoreResult> {
  const url = (databaseUrl ?? process.env.MOBILE_TESTING_DATABASE_URL ?? "").trim();
  if (url !== "") {
    try {
      const createPostgres = deps.createPostgres ?? ((input: string) => PostgresStore.create(input));
      const store = await createPostgres(url);
      const alive = await store.ping();
      if (!alive) throw new Error("ping failed");
      return { store, kind: "postgres", degraded: false, reason: null };
    } catch (error) {
      if (isMigrationIncompleteError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return tryFileStore(
        `PostgreSQL 连接失败（${message}）：已改用项目文件台账（.artemis/ledger，数据仍持久；PG 恢复后历史不自动回流）。`
      );
    }
  }
  const legacyUrl = (process.env.AOS_DATABASE_URL ?? "").trim();
  if (legacyUrl !== "") {
    return tryFileStore(
      "检测到已废弃的 AOS_DATABASE_URL（服务只读取 MOBILE_TESTING_DATABASE_URL，旧名不生效）：已使用项目文件台账（.artemis/ledger），本次数据不会写入 PostgreSQL。请改用 MOBILE_TESTING_DATABASE_URL 后重启。"
    );
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
export {
  MigrationIncompleteError,
  MIGRATION_INCOMPLETE_CODE,
  isMigrationIncompleteError
} from "./postgres.js";
export type { ProjectStore } from "./types.js";
