import fs from "node:fs";

import {
  defaultExec,
  defaultExecBuffer,
  resolveAdbPath,
  type ExecBufferFn,
  type ExecFn,
  type ResolvedAdb
} from "./adb.js";
import { listAdbDevices } from "./logcat.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export type AdbPngCaptureError =
  | "adb-not-found"
  | "no-serial"
  | "device-offline"
  | "timeout"
  | "command-failed"
  | "not-png"
  | string;

export interface AdbPngCapture {
  ok: boolean;
  bytes?: Buffer;
  serial: string | null;
  adb: ResolvedAdb;
  error?: AdbPngCaptureError;
}

export interface AdbPngCaptureOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  execBuffer?: ExecBufferFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  serial?: string | null;
  timeoutMs?: number;
}

/** Lossless device screenshot straight from adb (`exec-out screencap -p` → PNG),
 * bypassing ARTEMIS's JPEG live_screenshot used for LLM perception. */
export async function captureAdbPng(options: AdbPngCaptureOptions = {}): Promise<AdbPngCapture> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const execBuffer = options.execBuffer ?? defaultExecBuffer;
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? fs.existsSync;
  const adb = resolveAdbPath(env, platform, pathExists);
  if (!adb.path) {
    return { ok: false, serial: options.serial?.trim() || null, adb, error: "adb-not-found" };
  }

  let serial = options.serial?.trim() || null;
  if (!serial) {
    const devices = await listAdbDevices(exec, adb.path);
    if (!devices.ok) {
      return { ok: false, serial: null, adb, error: devices.error ?? "device-offline" };
    }
    if (devices.devices.length === 0) {
      return { ok: false, serial: null, adb, error: "device-offline" };
    }
    if (devices.devices.length > 1) {
      return { ok: false, serial: null, adb, error: "no-serial" };
    }
    serial = devices.devices[0]!;
  }

  const result = await execBuffer(adb.path, ["-s", serial, "exec-out", "screencap", "-p"], {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
  if (result.error === "timeout") return { ok: false, serial, adb, error: "timeout" };
  if (result.error) return { ok: false, serial, adb, error: result.error };
  if (result.code !== 0) return { ok: false, serial, adb, error: "command-failed" };
  const bytes = result.stdout;
  if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG")) {
    return { ok: false, serial, adb, error: "not-png" };
  }
  return { ok: true, bytes, serial, adb };
}
