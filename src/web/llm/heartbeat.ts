import type { ProjectStore } from "../../db/types.js";

export const DEFAULT_LLM_WORKER_TTL_MS = 90_000;

export interface LlmWorkerStatus {
  online: boolean;
  hostId: string | null;
  instanceId: string | null;
  lastSeenAt: string | null;
  ageMs: number | null;
}

interface LlmWorkerEnv {
  instanceId?: unknown;
  lastSeenAt?: unknown;
  pid?: unknown;
  version?: unknown;
}

export function llmWorkerTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_LLM_WORKER_TTL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_WORKER_TTL_MS;
}

/** P0 单实例心跳：写 hosts.env.llmWorker；不新增 PG 表。 */
export async function recordLlmWorkerHeartbeat(input: {
  store: ProjectStore;
  hostId: string;
  instanceId: string;
  nowMs?: number;
  pid?: number;
  version?: string;
}): Promise<LlmWorkerStatus> {
  const nowMs = input.nowMs ?? Date.now();
  const lastSeenAt = new Date(nowMs).toISOString();
  const host = await input.store.getHost(input.hostId).catch(() => null);
  await input.store.upsertHost({
    id: input.hostId,
    env: {
      ...(host?.env ?? {}),
      llmWorker: {
        instanceId: input.instanceId,
        lastSeenAt,
        pid: input.pid ?? process.pid,
        version: input.version ?? null
      }
    }
  });
  return {
    online: true,
    hostId: input.hostId,
    instanceId: input.instanceId,
    lastSeenAt,
    ageMs: 0
  };
}

export async function getLlmWorkerStatus(input: {
  store: ProjectStore;
  nowMs?: number;
  ttlMs?: number;
}): Promise<LlmWorkerStatus> {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_LLM_WORKER_TTL_MS;
  const hosts = await input.store.listHosts().catch(() => []);
  let best: LlmWorkerStatus = {
    online: false,
    hostId: null,
    instanceId: null,
    lastSeenAt: null,
    ageMs: null
  };
  for (const host of hosts) {
    const raw = host.env?.llmWorker;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as LlmWorkerEnv;
    if (typeof value.lastSeenAt !== "string") continue;
    const at = Date.parse(value.lastSeenAt);
    if (!Number.isFinite(at)) continue;
    const ageMs = Math.max(0, nowMs - at);
    if (best.ageMs !== null && ageMs >= best.ageMs) continue;
    best = {
      online: ageMs <= ttlMs,
      hostId: host.id,
      instanceId: typeof value.instanceId === "string" ? value.instanceId : null,
      lastSeenAt: value.lastSeenAt,
      ageMs
    };
  }
  return best;
}
