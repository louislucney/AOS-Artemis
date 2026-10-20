import { payloadBytes } from "./payload.js";

export {
  normalizeSince,
  payloadBytes,
  payloadHash,
  stableStringify
} from "./payload.js";

export const EVENT_TYPES = [
  "run.started",
  "run.step",
  "run.finished",
  "case.started",
  "case.result",
  "artifact.created",
  "log.entry",
  "feedback.request"
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_SOURCES = ["project", "executor", "agent", "ci"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_STATUSES = ["started", "passed", "failed", "skipped", "error", "info"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const TERMINAL_EVENT_STATUSES = ["passed", "failed", "skipped", "error"] as const;

const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_FIELD_CHARS = 128;
const MAX_PAYLOAD_BYTES = 32 * 1024;

export interface ValidatedEventInput {
  eventId: string;
  type: EventType;
  source: EventSource;
  at: string;
  runId: string | null;
  caseId: string | null;
  step: number | null;
  status: EventStatus | null;
  payload: unknown;
}

export type EventValidationResult =
  | { ok: true; value: ValidatedEventInput }
  | { ok: false; error: string; field?: string };

function fail(error: string, field?: string): EventValidationResult {
  return field === undefined ? { ok: false, error } : { ok: false, error, field };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (text === "" || text.length > MAX_FIELD_CHARS) return { ok: false };
  return { ok: true, value: text };
}

function requiresPayload(type: EventType): boolean {
  return type === "artifact.created" || type === "log.entry" || type === "feedback.request";
}

function requiresTerminalStatus(type: EventType): boolean {
  return type === "run.finished" || type === "case.result";
}

export function validateEventInput(
  input: unknown,
  now: Date = new Date()
): EventValidationResult {
  const record = asRecord(input);
  if (!record) return fail("事件必须是 JSON 对象", "input");

  const eventId = typeof record.eventId === "string" ? record.eventId.trim() : "";
  if (!EVENT_ID_RE.test(eventId)) {
    return fail("eventId 必须是 1-128 位 [A-Za-z0-9._:-]", "eventId");
  }

  const type = record.type;
  if (typeof type !== "string" || !EVENT_TYPES.includes(type as EventType)) {
    return fail(`type 必须是以下之一：${EVENT_TYPES.join(", ")}`, "type");
  }
  const eventType = type as EventType;

  const sourceValue = record.source === undefined ? "project" : record.source;
  if (typeof sourceValue !== "string" || !EVENT_SOURCES.includes(sourceValue as EventSource)) {
    return fail(`source 必须是以下之一：${EVENT_SOURCES.join(", ")}`, "source");
  }

  let status: EventStatus | null = null;
  if (record.status !== undefined && record.status !== null) {
    if (
      typeof record.status !== "string" ||
      !EVENT_STATUSES.includes(record.status as EventStatus)
    ) {
      return fail(`status 必须是以下之一：${EVENT_STATUSES.join(", ")}`, "status");
    }
    status = record.status as EventStatus;
  }

  const runId = optionalText(record.runId);
  if (!runId.ok) return fail("runId 必须是 1-128 字符的字符串", "runId");
  const caseId = optionalText(record.caseId);
  if (!caseId.ok) return fail("caseId 必须是 1-128 字符的字符串", "caseId");

  let step: number | null = null;
  if (record.step !== undefined && record.step !== null) {
    if (typeof record.step !== "number" || !Number.isInteger(record.step) || record.step < 0) {
      return fail("step 必须是非负整数", "step");
    }
    step = record.step;
  }

  let at: string;
  if (record.at === undefined || record.at === null) {
    at = now.toISOString();
  } else {
    const milliseconds = typeof record.at === "string" ? Date.parse(record.at) : Number.NaN;
    if (Number.isNaN(milliseconds)) return fail("at 必须是可解析的 ISO 8601 时间", "at");
    at = new Date(milliseconds).toISOString();
  }

  const payload = record.payload === undefined ? null : record.payload;
  if (requiresPayload(eventType) && asRecord(payload) === null) {
    return fail(`${eventType} 需要 payload 对象`, "payload");
  }
  if (payloadBytes(payload) > MAX_PAYLOAD_BYTES) {
    return fail("payload 超过 32 KiB", "payload");
  }

  if (eventType.startsWith("run.") && runId.value === null) {
    return fail(`${eventType} 需要 runId`, "runId");
  }
  if (eventType === "run.step" && step === null) {
    return fail("run.step 需要 step", "step");
  }
  if (requiresTerminalStatus(eventType)) {
    if (status === null || !TERMINAL_EVENT_STATUSES.includes(status as (typeof TERMINAL_EVENT_STATUSES)[number])) {
      return fail(`${eventType} 的 status 必须是 ${TERMINAL_EVENT_STATUSES.join("/")}`, "status");
    }
  }
  if (eventType.startsWith("case.") && caseId.value === null) {
    return fail(`${eventType} 需要 caseId`, "caseId");
  }
  if (eventType === "artifact.created" && runId.value === null && caseId.value === null) {
    return fail("artifact.created 需要 runId 或 caseId", "runId");
  }

  return {
    ok: true,
    value: {
      eventId,
      type: eventType,
      source: sourceValue as EventSource,
      at,
      runId: runId.value,
      caseId: caseId.value,
      step,
      status,
      payload
    }
  };
}
