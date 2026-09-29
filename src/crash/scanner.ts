import fs from "node:fs";
import path from "node:path";

import { AdbCrashCollector } from "./collect.js";
import { parseLogcatCrashes } from "./parse.js";
import type { CrashIndexStore } from "./store.js";
import type { CrashCollectorLike, CrashScanInput, CrashScanResult } from "./types.js";
import { logWarn } from "../util.js";

const DEFAULT_SCAN_WINDOW_MS = 15 * 60_000;

export interface TraceStatusInfo {
  status: string;
  deviceSerial: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
  error: string | null;
}

export function readTraceStatusInfo(tracesDir: string, traceId: string): TraceStatusInfo | null {
  const toMs = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
  try {
    const raw = fs.readFileSync(path.join(tracesDir, traceId, "status.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      status: typeof parsed.status === "string" ? parsed.status : "unknown",
      deviceSerial:
        typeof parsed.device_serial === "string" && parsed.device_serial !== ""
          ? parsed.device_serial
          : null,
      startTimeMs: toMs(parsed.start_time),
      endTimeMs: toMs(parsed.end_time),
      error: typeof parsed.error === "string" ? parsed.error : null
    };
  } catch {
    return null;
  }
}

export interface CrashScannerOptions {
  tracesDir: string;
  store: CrashIndexStore;
  env?: NodeJS.ProcessEnv;
  collector?: CrashCollectorLike;
}

export class CrashScanner {
  readonly store: CrashIndexStore;
  private readonly tracesDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly collector: CrashCollectorLike;

  constructor(options: CrashScannerOptions) {
    this.tracesDir = options.tracesDir;
    this.store = options.store;
    this.env = options.env ?? process.env;
    this.collector = options.collector ?? new AdbCrashCollector({ env: this.env });
  }

  enabled(): boolean {
    return this.env.AOS_CRASH_CAPTURE !== "0";
  }

  async scanTrace(input: CrashScanInput): Promise<CrashScanResult> {
    const { traceId } = input;
    const at = (): string => new Date().toISOString();

    if (!this.enabled()) {
      return { traceId, status: "skipped", reason: "disabled", found: 0 };
    }
    if (!input.force && this.store.isScanned(traceId)) {
      return { traceId, status: "skipped", reason: "already-scanned", found: 0 };
    }

    const info = readTraceStatusInfo(this.tracesDir, traceId);
    const startMs = info?.startTimeMs ?? input.fallbackStartMs ?? null;
    if (startMs === null) {
      this.store.recordScan(traceId, { at: at(), found: 0, skipped: "no-window" });
      return { traceId, status: "skipped", reason: "no-window", found: 0 };
    }
    const endMs = info?.endTimeMs ?? input.fallbackEndMs ?? startMs + DEFAULT_SCAN_WINDOW_MS;
    const taskOutcome = input.taskOutcome ?? info?.status ?? "unknown";
    const targetPackage = input.targetPackage ?? null;

    const collected = await this.collector.collect({
      serial: info?.deviceSerial ?? null,
      windowStartMs: startMs,
      windowEndMs: endMs,
      targetPackage
    });
    if (collected.clockWarning) {
      logWarn(`崩溃取证：设备时钟探测失败（trace=${traceId}），按零偏差处理`);
    }
    if (collected.status === "skipped") {
      this.store.recordScan(traceId, { at: at(), found: 0, skipped: collected.reason });
      return { traceId, status: "skipped", reason: collected.reason, found: 0 };
    }

    const crashes = parseLogcatCrashes(collected.text ?? "", {
      windowStartMs: startMs,
      windowEndMs: endMs,
      clockOffsetMs: collected.clockOffsetMs ?? 0,
      packageFilter: targetPackage
    });
    const capturedAt = at();
    const upsert =
      crashes.length > 0
        ? this.store.upsert(crashes, {
            traceId,
            taskOutcome,
            deviceSerial: collected.serial ?? info?.deviceSerial ?? null,
            capturedAt,
            source: collected.source ?? "crash-buffer"
          })
        : { newIds: [], updatedIds: [] };
    this.store.recordScan(traceId, { at: capturedAt, found: crashes.length });

    return {
      traceId,
      status: crashes.length > 0 ? "captured" : "empty",
      found: crashes.length,
      newIds: upsert.newIds,
      updatedIds: upsert.updatedIds,
      source: collected.source
    };
  }
}
