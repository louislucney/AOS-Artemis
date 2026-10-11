import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util.js";

export const API_ERROR_CODES_FILE = "error-codes.json";
export const API_ERRORS_ARTIFACT = "api-errors.json";
const SAMPLE_MAX_CHARS = 400;

export type ApiErrorVerdict = "handled" | "unhandled" | "observed";

export interface ApiErrorRule {
  code: string;
  match: RegExp;
  handler: string | null;
  expect: string | null;
  handledPattern: RegExp | null;
}

export interface ApiErrorCatalog {
  file: string;
  rules: Map<string, ApiErrorRule>;
  errors: string[];
}

export interface ApiErrorObservation {
  code: string;
  handler: string | null;
  expect: string | null;
  handled: boolean | null;
  verdict: ApiErrorVerdict;
  count: number;
  firstAt: string | null;
  sample: string;
}

export interface ApiErrorArtifact {
  traceId: string;
  serial: string | null;
  window: { startMs: number; endMs: number } | null;
  source: "logcat" | "simctl-log" | "idevicesyslog" | "none";
  degraded: string | null;
  errors: ApiErrorObservation[];
}

const LOGCAT_LINE = /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+\d+\s+\d+\s+\w\s+[^:]+:\s?/;

function compileRule(code: string, value: unknown): { rule: ApiErrorRule | null; error: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { rule: null, error: "条目必须是对象" };
  }
  const record = value as Record<string, unknown>;
  const matchRaw = record.match;
  if (typeof matchRaw !== "string" || matchRaw.trim() === "") {
    return { rule: null, error: "缺少 match 正则" };
  }
  let match: RegExp;
  try {
    match = new RegExp(matchRaw);
  } catch (error) {
    return { rule: null, error: `match 正则非法: ${errorMessage(error)}` };
  }
  const optionalString = (key: string): { value: string | null; error: string | null } => {
    const raw = record[key];
    if (raw === undefined || raw === null) return { value: null, error: null };
    if (typeof raw !== "string") return { value: null, error: `${key} 必须是字符串` };
    return { value: raw, error: null };
  };
  const handler = optionalString("handler");
  if (handler.error) return { rule: null, error: handler.error };
  const expect = optionalString("expect");
  if (expect.error) return { rule: null, error: expect.error };

  let handledPattern: RegExp | null = null;
  if (record.handledPattern !== undefined && record.handledPattern !== null) {
    if (typeof record.handledPattern !== "string" || record.handledPattern === "") {
      return { rule: null, error: "handledPattern 必须是非空字符串" };
    }
    try {
      handledPattern = new RegExp(record.handledPattern);
    } catch (error) {
      return { rule: null, error: `handledPattern 正则非法: ${errorMessage(error)}` };
    }
  }
  return {
    rule: { code, match, handler: handler.value, expect: expect.value, handledPattern },
    error: null
  };
}

/** Load the project error-code registry: `.artemis/design/error-codes.json`.
 * Invalid entries are reported and ignored (never throw). */
export function loadApiErrorCatalog(configDirAbs: string): ApiErrorCatalog {
  const file = path.join(configDirAbs, "design", API_ERROR_CODES_FILE);
  const catalog: ApiErrorCatalog = { file, rules: new Map(), errors: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return catalog;
  }
  let parsed: { codes?: unknown };
  try {
    parsed = JSON.parse(raw) as { codes?: unknown };
  } catch (error) {
    catalog.errors.push(`${API_ERROR_CODES_FILE} 解析失败: ${errorMessage(error)}`);
    return catalog;
  }
  const codes = parsed.codes;
  if (!codes || typeof codes !== "object" || Array.isArray(codes)) {
    catalog.errors.push(`${API_ERROR_CODES_FILE} 缺少 codes 对象`);
    return catalog;
  }
  for (const [code, value] of Object.entries(codes)) {
    const compiled = compileRule(code, value);
    if (compiled.error || !compiled.rule) {
      catalog.errors.push(`「${code}」: ${compiled.error ?? "无效条目"}`);
      continue;
    }
    catalog.rules.set(code, compiled.rule);
  }
  return catalog;
}

/** Deterministic per-line matching over a logcat window: count occurrences,
 * capture the first sample/time, and judge the declared handled pattern. */
export function matchApiErrors(
  logText: string,
  rules: Map<string, ApiErrorRule>
): ApiErrorObservation[] {
  if (logText.trim() === "" || rules.size === 0) return [];
  const lines = logText.split(/\r?\n/);
  const observations: ApiErrorObservation[] = [];
  for (const rule of rules.values()) {
    let count = 0;
    let firstAt: string | null = null;
    let sample = "";
    let handledHit = false;
    for (const line of lines) {
      if (rule.handledPattern?.test(line)) handledHit = true;
      if (!rule.match.test(line)) continue;
      count += 1;
      if (sample === "") {
        sample = line.trim().slice(0, SAMPLE_MAX_CHARS);
        firstAt = LOGCAT_LINE.exec(line)?.[1] ?? null;
      }
    }
    if (count === 0) continue;
    const handled = rule.handledPattern ? handledHit : null;
    observations.push({
      code: rule.code,
      handler: rule.handler,
      expect: rule.expect,
      handled,
      verdict: handled === null ? "observed" : handled ? "handled" : "unhandled",
      count,
      firstAt,
      sample
    });
  }
  return observations.sort((a, b) => a.code.localeCompare(b.code));
}

export function readApiErrorsArtifact(traceDirAbs: string): ApiErrorArtifact | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(traceDirAbs, API_ERRORS_ARTIFACT), "utf-8")
    ) as ApiErrorArtifact;
    if (!Array.isArray(parsed.errors)) return null;
    return parsed;
  } catch {
    return null;
  }
}
