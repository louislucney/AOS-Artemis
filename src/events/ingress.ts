import type {
  ProjectEventQuery,
  ProjectEventRecord,
  ProjectStore
} from "../db/types.js";
import { sleep } from "../util.js";
import { applyProjectEventToLedger } from "./consumer.js";
import { normalizeSince } from "./payload.js";
import { validateEventInput } from "./protocol.js";

export class EventValidationError extends Error {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "EventValidationError";
    this.field = field;
  }
}

export interface EventIngressContext {
  store: ProjectStore;
  rootPath: string;
  storage: "postgres" | "file" | "memory";
  degraded: string | null;
}

export interface EventAck {
  accepted: boolean;
  duplicate: boolean;
  payloadMismatch?: boolean;
  serverId: string;
  eventId: string;
  receivedAt: string;
  storage: "postgres" | "file" | "memory";
  degraded: string | null;
}

export function degradedReason(store: ProjectStore, note: string | null): string | null {
  return store.kind === "memory" ? note ?? "内存会话存储，数据不持久" : null;
}

export interface EventList {
  events: ProjectEventRecord[];
  returned: number;
  /** 下一轮游标：本页最大 seq；空页回显请求的 afterSeq。 */
  nextSeq: number;
  includePayload: boolean;
  storage: "postgres" | "file" | "memory";
  degraded: string | null;
}

export interface EventPollOptions extends ProjectEventQuery {
  /** 无新事件时的最长等待（毫秒），上限 30s；0 表示立即返回。 */
  waitMs?: number;
  /** 返回后把本页事件标记为已消费（consumed_at）。 */
  consume?: boolean;
  signal?: AbortSignal;
}

function requireStoreMethod<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("event store unavailable");
  return value;
}

export async function reportProjectEvent(
  context: EventIngressContext,
  input: unknown
): Promise<EventAck> {
  const validation = validateEventInput(input);
  if (!validation.ok) throw new EventValidationError(validation.error, validation.field);
  const record = requireStoreMethod(context.store.recordProjectEvent);
  const result = await record.call(context.store, context.rootPath, validation.value);
  setImmediate(() => {
    void context.store
      .recordAudit(context.rootPath, {
        domain: "project-event",
        action: result.record.type,
        result: "ok",
        summary: `${result.record.type} ${result.record.eventId}`.slice(0, 300),
        refs: {
          eventId: result.record.eventId,
          ...(result.record.runId !== null ? { runId: result.record.runId } : {}),
          ...(result.record.caseId !== null ? { caseId: result.record.caseId } : {}),
          ...(result.record.status !== null ? { status: result.record.status } : {})
        }
      })
      .catch(() => {
        /* audit is best-effort and must not affect the ack */
      });
  });
  if (!result.duplicate) {
    setImmediate(() => {
      void applyProjectEventToLedger(context.store, context.rootPath, result.record).catch(() => {
        /* ledger projection is best-effort; polling remains the fallback */
      });
    });
  }
  return {
    accepted: !result.duplicate,
    duplicate: result.duplicate,
    ...(result.payloadMismatch ? { payloadMismatch: true } : {}),
    serverId: result.record.id,
    eventId: result.record.eventId,
    receivedAt: result.record.receivedAt,
    storage: context.storage,
    degraded: context.degraded
  };
}

export async function listProjectEvents(
  context: EventIngressContext,
  input: ProjectEventQuery = {}
): Promise<EventList> {
  if (input.since !== undefined && normalizeSince(input.since) === null) {
    throw new EventValidationError("since 必须是可解析的 ISO 8601 时间", "since");
  }
  if (
    input.afterSeq !== undefined &&
    (!Number.isInteger(input.afterSeq) || input.afterSeq < 0)
  ) {
    throw new EventValidationError("afterSeq 必须是非负整数", "afterSeq");
  }
  const list = requireStoreMethod(context.store.listProjectEvents);
  const includePayload = input.includePayload === true;
  const max = includePayload ? 50 : 200;
  const requested = input.limit ?? 50;
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, max));
  const events = await list.call(context.store, context.rootPath, {
    ...input,
    limit,
    includePayload
  });
  const nextSeq = events.reduce(
    (max, event) => (event.seq > max ? event.seq : max),
    input.afterSeq ?? 0
  );
  return {
    events,
    returned: events.length,
    nextSeq,
    includePayload,
    storage: context.storage,
    degraded: context.degraded
  };
}

export async function pollProjectEvents(
  context: EventIngressContext,
  input: EventPollOptions = {}
): Promise<EventList> {
  const { waitMs: rawWait, consume, signal, ...query } = input;
  const waitMs = Math.max(
    0,
    Math.min(Number.isFinite(rawWait) ? Math.floor(rawWait ?? 0) : 0, 30_000)
  );
  const deadline = Date.now() + waitMs;
  for (;;) {
    const listed = await listProjectEvents(context, { ...query, order: "asc" });
    if (listed.returned > 0 || Date.now() >= deadline || signal?.aborted) {
      if (consume === true && listed.returned > 0) {
        const mark = requireStoreMethod(context.store.markProjectEventsConsumed);
        const consumedAt = new Date().toISOString();
        await mark.call(context.store, context.rootPath, listed.events.map((event) => event.eventId), consumedAt);
        listed.events = listed.events.map((event) => ({ ...event, consumedAt }));
      }
      return listed;
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}
