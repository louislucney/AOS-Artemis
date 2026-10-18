import type { ProjectStore } from "./types.js";

export type StoreKind = ProjectStore["kind"];

/** 存储标签（统一口径）：PostgreSQL / 文件台账（.artemis/ledger）/ 会话内存（仅本次进程，数据不持久）。 */
export function storeKindLabel(kind: StoreKind): string {
  if (kind === "postgres") return "PostgreSQL";
  if (kind === "file") return "文件台账（.artemis/ledger）";
  return "会话内存（仅本次进程，数据不持久）";
}

/** 紧凑标签（徽章/表格）。 */
export function storeKindShortLabel(kind: StoreKind): string {
  if (kind === "postgres") return "PostgreSQL";
  if (kind === "file") return "文件台账";
  return "会话内存";
}

/** 真实易失模式仅限 memory；文件台账为持久默认。 */
export function storeKindDegraded(kind: StoreKind): boolean {
  return kind === "memory";
}
