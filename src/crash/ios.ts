import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ParsedCrash } from "./types.js";

const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_FRAMES = 10;
const EXCERPT_CHARS = 2000;
const WINDOW_SLACK_BEFORE_MS = 2_000;
const WINDOW_SLACK_AFTER_MS = 5_000;

export interface IosCrashCollectDeps {
  reportsDir?: string;
  listDir?: (dir: string) => string[];
  readFile?: (file: string) => string;
  mtimeMs?: (file: string) => number;
}

export interface IosCrashCollectResult {
  records: ParsedCrash[];
  scanned: number;
  skipped: string | null;
}

export function defaultIosReportsDir(): string {
  return path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
}

interface IpsHeader {
  app_name?: unknown;
  process?: unknown;
  timestamp?: unknown;
}

interface IpsBody {
  exception?: { type?: unknown; subtype?: unknown; signal?: unknown };
  termination?: { reason?: unknown; namespace?: unknown };
  procName?: unknown;
  threads?: Array<{ frames?: Array<{ symbol?: unknown; imageIndex?: unknown; imageOffset?: unknown }> }>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Parse one Apple `.ips` crash report (line 1 = header JSON, rest = body JSON). */
export function parseIps(content: string): ParsedCrash | null {
  const lines = content.split("\n");
  if (lines.length < 2) return null;
  let header: IpsHeader;
  let body: IpsBody;
  try {
    header = JSON.parse(lines[0]!) as IpsHeader;
    body = JSON.parse(lines.slice(1).join("\n")) as IpsBody;
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || !body || typeof body !== "object") return null;

  const packageName = asText(header.app_name) || asText(body.procName) || "unknown";
  const exceptionClass =
    asText(body.exception?.type) ||
    (asText(body.termination?.namespace) ? `term:${asText(body.termination?.namespace)}` : "unknown");
  const message = asText(body.termination?.reason) || asText(body.exception?.subtype) || "";
  const frames = (body.threads?.[0]?.frames ?? [])
    .map((frame) => {
      const symbol = asText(frame.symbol);
      if (symbol) return symbol;
      const imageIndex = typeof frame.imageIndex === "number" ? frame.imageIndex : null;
      const offset = typeof frame.imageOffset === "number" ? frame.imageOffset : null;
      if (imageIndex === null || offset === null) return "";
      return `image[${imageIndex}]+${offset}`;
    })
    .filter((value) => value !== "")
    .slice(0, MAX_FRAMES);
  const topFrame = frames[0] ?? "";

  const occurredAtRaw = asText(header.timestamp);
  const occurredAtMs = occurredAtRaw ? Date.parse(occurredAtRaw) : Number.NaN;
  const occurredAt = Number.isFinite(occurredAtMs) ? new Date(occurredAtMs).toISOString() : null;
  const signature = `${packageName}|${exceptionClass}|${topFrame}`.toLowerCase();

  return {
    kind: "ios",
    package: packageName,
    attribution: "ips-header",
    exceptionClass,
    message,
    rootCauseClass: exceptionClass,
    topFrame,
    frames,
    causedBy: [],
    signature,
    signatureBasis: "app+exception+top-frame",
    occurredAt,
    occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : null,
    excerpt: content.slice(0, EXCERPT_CHARS)
  };
}

function processMatches(record: ParsedCrash, processName: string | null): boolean {
  if (!processName) return true;
  const wanted = processName.trim().toLowerCase();
  if (!wanted) return true;
  return record.package.toLowerCase() === wanted;
}

/** Collect `.ips` crash reports written within the task window (simulator
 * crashes land in the host DiagnosticReports directory). */
export function collectIosCrashes(
  window: { startMs: number | null; endMs: number | null; processName?: string | null },
  deps: IosCrashCollectDeps = {}
): IosCrashCollectResult {
  const dir = deps.reportsDir ?? defaultIosReportsDir();
  const listDir = deps.listDir ?? ((target: string) => fs.readdirSync(target));
  const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));
  const mtimeMs = deps.mtimeMs ?? ((file: string) => fs.statSync(file).mtimeMs);

  let files: string[];
  try {
    files = listDir(dir).filter((name) => name.endsWith(".ips"));
  } catch {
    return { records: [], scanned: 0, skipped: "reports-dir-missing" };
  }

  const start = window.startMs === null ? null : window.startMs - WINDOW_SLACK_BEFORE_MS;
  const end = window.endMs === null ? null : window.endMs + WINDOW_SLACK_AFTER_MS;
  const records: ParsedCrash[] = [];
  let scanned = 0;

  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const mtime = mtimeMs(file);
      if (start !== null && mtime < start) continue;
      if (end !== null && mtime > end) continue;
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
      if (size > MAX_REPORT_BYTES) continue;
      scanned += 1;
      const parsed = parseIps(readFile(file));
      if (!parsed) continue;
      if (!processMatches(parsed, window.processName ?? null)) continue;
      records.push(parsed);
    } catch {
      continue;
    }
  }

  records.sort((a, b) => (a.occurredAtMs ?? 0) - (b.occurredAtMs ?? 0));
  return { records, scanned, skipped: null };
}
