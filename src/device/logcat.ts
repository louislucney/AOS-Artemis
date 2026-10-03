import fs from "node:fs";

import { errorMessage } from "../util.js";
import { classifyAdbFailure, defaultExec, resolveAdbPath, type ExecFn, type ExecResult } from "./adb.js";

const DEVICES_TIMEOUT_MS = 8_000;
const CLOCK_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_LOG_CHARS = 512 * 1024;
const WINDOW_SLACK_MS = 5_000;

export function boundLogText(text: string): string {
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
}

export function formatLogcatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

export interface DeviceListResult {
  ok: boolean;
  devices: string[];
  error?: string;
}

export async function listAdbDevices(exec: ExecFn, adbPath: string): Promise<DeviceListResult> {
  let result: ExecResult;
  try {
    result = await exec(adbPath, ["devices"], { timeoutMs: DEVICES_TIMEOUT_MS });
  } catch (error) {
    return { ok: false, devices: [], error: errorMessage(error) };
  }
  if (result.error) return { ok: false, devices: [], error: result.error };
  if (result.code !== 0) {
    return { ok: false, devices: [], error: result.stderr.trim() || `exit ${result.code}` };
  }
  const devices = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\S+\tdevice$/.test(line))
    .map((line) => line.split("\t")[0]!);
  return { ok: true, devices };
}

export async function probeDeviceClock(
  exec: ExecFn,
  adbPath: string,
  serial: string,
  now: () => number
): Promise<{ ok: boolean; offsetMs: number }> {
  let result: ExecResult;
  try {
    result = await exec(adbPath, ["-s", serial, "shell", "date", "+%s"], {
      timeoutMs: CLOCK_TIMEOUT_MS
    });
  } catch {
    return { ok: false, offsetMs: 0 };
  }
  if (result.error || result.code !== 0) return { ok: false, offsetMs: 0 };
  const match = /(\d{9,})/.exec(result.stdout);
  if (!match) return { ok: false, offsetMs: 0 };
  const offsetMs = Number(match[1]) * 1000 - now();
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 86_400_000) {
    return { ok: false, offsetMs: 0 };
  }
  return { ok: true, offsetMs };
}

export interface LogcatWindowRequest {
  serial?: string | null;
  windowStartMs: number;
  windowEndMs?: number | null;
}

export interface LogcatWindowResult {
  status: "ok" | "skipped";
  reason?: string;
  text: string;
  serial: string | null;
  clockWarning?: boolean;
}

export interface LogcatCollectorOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  now?: () => number;
  timeoutMs?: number;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_LOGCAT_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/** Deterministic device-log window reader: pulls the main logcat buffer since
 * `windowStartMs - 5s`, so a finished trace can be matched against project
 * error codes without running a live collector during the task. */
export class AdbLogcatCollector {
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: ExecFn;
  private readonly platform: NodeJS.Platform;
  private readonly pathExists: (candidate: string) => boolean;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: LogcatCollectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.exec = options.exec ?? defaultExec;
    this.platform = options.platform ?? process.platform;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? resolveTimeoutMs(this.env);
  }

  private async run(adbPath: string, args: string[]): Promise<ExecResult> {
    try {
      return await this.exec(adbPath, args, { timeoutMs: this.timeoutMs });
    } catch (error) {
      return { code: null, stdout: "", stderr: "", error: errorMessage(error) };
    }
  }

  async collect(request: LogcatWindowRequest): Promise<LogcatWindowResult> {
    const adb = resolveAdbPath(this.env, this.platform, this.pathExists);
    if (!adb.path) return { status: "skipped", reason: "adb-not-found", text: "", serial: null };

    const devices = await listAdbDevices(this.exec, adb.path);
    if (!devices.ok) {
      return { status: "skipped", reason: classifyAdbFailure(devices.error), text: "", serial: null };
    }
    const serial = request.serial?.trim() || (devices.devices.length === 1 ? devices.devices[0]! : null);
    if (!serial) return { status: "skipped", reason: "no-serial", text: "", serial: null };
    if (!devices.devices.includes(serial)) {
      return { status: "skipped", reason: "device-offline", text: "", serial };
    }

    const clock = await probeDeviceClock(this.exec, adb.path, serial, this.now);
    const since = formatLogcatTime(request.windowStartMs + clock.offsetMs - WINDOW_SLACK_MS);
    const result = await this.run(adb.path, [
      "-s",
      serial,
      "logcat",
      "-v",
      "threadtime",
      "-d",
      "-T",
      since
    ]);
    if (result.code !== 0) {
      return {
        status: "skipped",
        reason: classifyAdbFailure(result.error ?? result.stderr),
        text: "",
        serial,
        clockWarning: !clock.ok
      };
    }
    const text = boundLogText(result.stdout.trim());
    if (text === "") return { status: "skipped", reason: "log-empty", text: "", serial, clockWarning: !clock.ok };
    return { status: "ok", text, serial, clockWarning: !clock.ok };
  }
}
