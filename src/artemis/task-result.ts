import fs from "node:fs";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface TaskFailedItem {
  itemText: string | null;
  kind: string | null;
  evidence: string | null;
}

export interface TaskTestSummary {
  taskStatus: string | null;
  passed: number | null;
  failed: number | null;
  inconclusive: number | null;
  unchecked: number | null;
  failedItems: TaskFailedItem[];
}

export interface TaskStatus {
  traceId: string | null;
  status: string | null;
  deviceSerial: string | null;
  error: string | null;
  message: string | null;
  testSummary: TaskTestSummary | null;
  notesDir: string | null;
  stderrLog: string | null;
  stdoutLog: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
}

const TRACE_ID_PATTERN = /trace[_ -]?id["'\s:=]+([0-9a-fA-F-]{8,})/;

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMs(value: unknown): number | null {
  const seconds = asNumber(value);
  return seconds === null ? null : seconds * 1000;
}

function failedItemsOf(value: unknown): TaskFailedItem[] {
  if (!Array.isArray(value)) return [];
  const items: TaskFailedItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    items.push({
      itemText: asString(record.item_text) ?? asString(record.itemText),
      kind: asString(record.kind),
      evidence: asString(record.evidence)
    });
  }
  return items;
}

function testSummaryOf(value: unknown): TaskTestSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    taskStatus: asString(record.task_status),
    passed: asNumber(record.passed),
    failed: asNumber(record.failed),
    inconclusive: asNumber(record.inconclusive),
    unchecked: asNumber(record.unchecked),
    failedItems: failedItemsOf(record.failed_items)
  };
}

export function resultText(result: CallToolResult): string {
  let text = "";
  for (const item of result.content ?? []) {
    if (item.type === "text") text += `${item.text}\n`;
  }
  return text;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function resultPayload(result: CallToolResult): Record<string, unknown> | null {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      const parsed = parseJsonObject(item.text);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function traceIdOf(result: CallToolResult): string | null {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const candidates: unknown[] = [structured];
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      const parsed = parseJsonObject(item.text);
      if (parsed) {
        candidates.push(parsed);
      } else {
        const match = TRACE_ID_PATTERN.exec(item.text);
        if (match) return match[1]!;
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const value = (candidate as { trace_id?: unknown }).trace_id;
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

export function taskStatusOf(
  payload: Record<string, unknown> | null | undefined
): TaskStatus | null {
  if (!payload) return null;
  return {
    traceId: asString(payload.trace_id),
    status: asString(payload.status),
    deviceSerial: asString(payload.device_serial),
    error: asString(payload.error),
    message: asString(payload.message),
    testSummary: testSummaryOf(payload.test_summary),
    notesDir: asString(payload.notes_dir),
    stderrLog: asString(payload.stderr_log),
    stdoutLog: asString(payload.stdout_log),
    startTimeMs: secondsToMs(payload.start_time),
    endTimeMs: secondsToMs(payload.end_time)
  };
}

export function taskStatusFromFile(filePath: string): TaskStatus | null {
  try {
    const parsed = parseJsonObject(fs.readFileSync(filePath, "utf-8"));
    return taskStatusOf(parsed);
  } catch {
    return null;
  }
}
