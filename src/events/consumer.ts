import type { ProjectEventRecord, ProjectStore } from "../db/types.js";

const TERMINAL = new Set(["passed", "failed", "skipped", "error"]);

/** 事件驱动 task_stats 更新（P2）：仅当事件 payload 显式携带 traceId 时生效；
 * 30s 轮询仍作为 artemis 权威状态的兜底。 */
export async function applyProjectEventToLedger(
  store: ProjectStore,
  rootPath: string,
  event: ProjectEventRecord
): Promise<boolean> {
  if (event.status === null || !TERMINAL.has(event.status)) return false;
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const traceId = (payload as { traceId?: unknown }).traceId;
  if (typeof traceId !== "string" || traceId.trim() === "") return false;
  return await store.markTaskFinished(rootPath, traceId.trim(), event.status);
}
