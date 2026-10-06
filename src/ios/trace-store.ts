import fs from "node:fs";
import path from "node:path";

import { isProcessAlive, writeFileAtomic } from "../util.js";
import type { IosTaskRecord, IosTaskStep } from "./task-runner.js";

const DEFAULT_IOS_STALE_MS = 30 * 60_000;
const IOS_STALE_ENV = "AOS_IOS_STALE_MS";

export interface IosTraceDeps {
  clock?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  staleMs?: number;
}

export type IosTraceStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";

export interface DiskIosTrace {
  traceId: string;
  status: IosTraceStatus;
  rawStatus: string | null;
  udid: string | null;
  taskDesc: string | null;
  model: string | null;
  steps: IosTaskStep[];
  result: { success: boolean; summary: string } | null;
  error: string | null;
  testSummary: Record<string, unknown> | null;
  vision: IosTaskRecord["vision"];
  visionDegraded: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  runDir: string;
  pid: number | null;
  alive: boolean | null;
  stale: boolean;
  note: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function statMtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function parseIsoMs(value: unknown): number | null {
  const text = asString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function secondsToMs(value: unknown): number | null {
  const seconds = asNumber(value);
  return seconds === null ? null : seconds * 1000;
}

function parseResult(value: unknown): { success: boolean; summary: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string") return null;
  return { success: record.success !== false, summary: record.summary };
}

function parseVision(value: unknown): IosTaskRecord["vision"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { model?: unknown; source?: unknown };
  if (typeof record.model !== "string" || typeof record.source !== "string") return null;
  return { model: record.model, source: record.source } as IosTaskRecord["vision"];
}

function parseSteps(value: unknown): IosTaskStep[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is IosTaskStep =>
      entry !== null && typeof entry === "object" && typeof (entry as IosTaskStep).step === "number"
  );
}

function resolveIosStaleMs(env: NodeJS.ProcessEnv, override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) return override;
  const raw = Number.parseInt(env[IOS_STALE_ENV] ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_IOS_STALE_MS;
  return raw;
}

function isIosTraceRecord(
  status: Record<string, unknown> | null,
  run: Record<string, unknown> | null,
  traceId: string
): boolean {
  const platform = asString(status?.platform) ?? asString(run?.platform);
  if (platform !== null) return platform === "ios";
  return traceId.startsWith("ios-");
}

export function isIosTraceDir(traceDir: string, traceId: string): boolean {
  const status = readJsonObject(path.join(traceDir, "status.json"));
  const run = readJsonObject(path.join(traceDir, "run.json"));
  return isIosTraceRecord(status, run, traceId);
}

export function readIosTrace(
  traceDir: string,
  traceId: string,
  deps: IosTraceDeps = {}
): DiskIosTrace | null {
  const statusFile = path.join(traceDir, "status.json");
  const runFile = path.join(traceDir, "run.json");
  const status = readJsonObject(statusFile);
  const run = readJsonObject(runFile);
  if (!status && !run) return null;
  if (!isIosTraceRecord(status, run, traceId)) return null;

  const rawStatus = asString(status?.status) ?? asString(run?.status);
  const pid = asNumber(status?.pid) ?? asNumber(run?.pid);
  const staleMs = resolveIosStaleMs(process.env, deps.staleMs);
  const now = (deps.clock ?? Date.now)();
  const lastWriteMs = statMtimeMs(statusFile) ?? statMtimeMs(runFile) ?? now;
  const stale = now - lastWriteMs > staleMs;
  const liveness = deps.isProcessAlive ?? isProcessAlive;

  let statusValue: IosTraceStatus = rawStatus === null ? "running" : (rawStatus as IosTraceStatus);
  let alive: boolean | null = null;
  let note: string | null = null;

  if (rawStatus === null || rawStatus === "running") {
    if (pid !== null) {
      alive = liveness(pid);
      if (alive) {
        statusValue = "running";
        note = stale
          ? `任务可能仍由进程 ${pid} 执行（已超过 ${Math.round(staleMs / 60_000)} 分钟未更新）。`
          : `任务可能仍由进程 ${pid} 执行。`;
      } else {
        statusValue = "orphaned";
        note = `执行进程（pid ${pid}）已退出，任务被中断。`;
      }
    } else if (stale) {
      statusValue = "orphaned";
      note = `无进程记录且超过 ${Math.round(staleMs / 60_000)} 分钟未更新，任务被中断。`;
    } else {
      statusValue = "running";
      note = "无进程记录，无法确认任务是否仍在执行。";
    }
  } else if (statusValue === "orphaned" && note === null) {
    note = asString(status?.message) ?? asString(run?.error);
  }

  return {
    traceId,
    status: statusValue,
    rawStatus,
    udid: asString(status?.device_serial) ?? asString(run?.device_serial),
    taskDesc: asString(status?.task_desc) ?? asString(run?.task_desc),
    model: asString(status?.model) ?? asString(run?.model),
    steps: parseSteps(run?.steps),
    result: parseResult(run?.result),
    error: asString(status?.error) ?? asString(run?.error),
    testSummary:
      status?.test_summary && typeof status.test_summary === "object"
        ? (status.test_summary as Record<string, unknown>)
        : null,
    vision: parseVision(run?.vision),
    visionDegraded: asString(run?.vision_degraded),
    startedAtMs: secondsToMs(status?.start_time) ?? parseIsoMs(run?.started_at),
    finishedAtMs: secondsToMs(status?.end_time) ?? parseIsoMs(run?.finished_at),
    runDir: traceDir,
    pid,
    alive,
    stale,
    note
  };
}

export function reconcileIosTrace(
  traceDir: string,
  traceId: string,
  deps: IosTraceDeps = {}
): DiskIosTrace | null {
  const trace = readIosTrace(traceDir, traceId, deps);
  if (!trace) return null;
  if (trace.status === "orphaned" && trace.rawStatus === "running") {
    persistOrphaned(traceDir, trace, deps);
    const after = readIosTrace(traceDir, traceId, deps);
    if (after) {
      return {
        ...after,
        rawStatus: trace.rawStatus,
        alive: trace.alive,
        stale: trace.stale,
        note: trace.note ?? after.note
      };
    }
  }
  return trace;
}

function persistOrphaned(traceDir: string, trace: DiskIosTrace, deps: IosTraceDeps): void {
  const now = (deps.clock ?? Date.now)();
  const note = trace.note ?? "任务被中断（执行进程已退出）。";
  try {
    const statusFile = path.join(traceDir, "status.json");
    const status = readJsonObject(statusFile) ?? {};
    status.trace_id = trace.traceId;
    status.status = "orphaned";
    status.platform = "ios";
    status.end_time = now / 1000;
    status.message = note;
    writeFileAtomic(statusFile, `${JSON.stringify(status, null, 2)}\n`);
    const runFile = path.join(traceDir, "run.json");
    const run = readJsonObject(runFile);
    if (run) {
      run.status = "orphaned";
      run.finished_at = new Date(now).toISOString();
      if (run.error === undefined || run.error === null) run.error = note;
      writeFileAtomic(runFile, `${JSON.stringify(run, null, 2)}\n`);
    }
  } catch {
    return;
  }
}
