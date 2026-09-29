import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util.js";
import type {
  CrashCollectorLike,
  CrashCollectOutcome,
  CrashCollectRequest
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEVICES_TIMEOUT_MS = 8_000;
const CLOCK_TIMEOUT_MS = 5_000;
const MAX_LOG_CHARS = 512 * 1024;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<ExecResult>;

export interface ResolvedAdb {
  path: string | null;
  source: "env" | "sdk" | "path" | "missing";
}

const defaultExec: ExecFn = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: errorMessage(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish({ code: null, stdout, stderr, error: "timeout" });
        }, options.timeoutMs)
      : null;
    timer?.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, error: errorMessage(error) });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
  });

export function resolveAdbPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync
): ResolvedAdb {
  const explicit = env.AOS_ADB_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };

  const binary = platform === "win32" ? "adb.exe" : "adb";
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    const trimmed = root?.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, "platform-tools", binary);
    if (exists(candidate)) return { path: candidate, source: "sdk" };
  }
  return { path: "adb", source: "path" };
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_CRASH_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function boundText(text: string): string {
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
}

function formatLogTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function classifyAdbFailure(error: string | undefined): string {
  const text = (error ?? "").toLowerCase();
  if (text.includes("enoent")) return "adb-not-found";
  if (
    text.includes("device") &&
    (text.includes("not found") ||
      text.includes("offline") ||
      text.includes("no devices") ||
      text.includes("more than one"))
  ) {
    return "device-offline";
  }
  return "command-failed";
}

export interface DeviceListResult {
  ok: boolean;
  devices: string[];
  error?: string;
}

export interface AdbCrashCollectorOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  now?: () => number;
}

export class AdbCrashCollector implements CrashCollectorLike {
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: ExecFn;
  private readonly platform: NodeJS.Platform;
  private readonly pathExists: (candidate: string) => boolean;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: AdbCrashCollectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.exec = options.exec ?? defaultExec;
    this.platform = options.platform ?? process.platform;
    this.pathExists = options.pathExists ?? fs.existsSync;
    this.now = options.now ?? Date.now;
    this.timeoutMs = resolveTimeoutMs(this.env);
  }

  async listDevices(adbPath: string): Promise<DeviceListResult> {
    const result = await this.run(adbPath, ["devices"], DEVICES_TIMEOUT_MS);
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

  private async probeClock(
    adbPath: string,
    serial: string
  ): Promise<{ ok: boolean; offsetMs: number }> {
    const result = await this.run(adbPath, ["-s", serial, "shell", "date", "+%s"], CLOCK_TIMEOUT_MS);
    if (result.error || result.code !== 0) return { ok: false, offsetMs: 0 };
    const match = /(\d{9,})/.exec(result.stdout);
    if (!match) return { ok: false, offsetMs: 0 };
    const offsetMs = Number(match[1]) * 1000 - this.now();
    if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 86_400_000) {
      return { ok: false, offsetMs: 0 };
    }
    return { ok: true, offsetMs };
  }

  private async run(
    adbPath: string,
    args: string[],
    timeoutMs: number = this.timeoutMs
  ): Promise<ExecResult> {
    try {
      return await this.exec(adbPath, args, { timeoutMs });
    } catch (error) {
      return { code: null, stdout: "", stderr: "", error: errorMessage(error) };
    }
  }

  async collect(request: CrashCollectRequest): Promise<CrashCollectOutcome> {
    const adb = resolveAdbPath(this.env, this.platform, this.pathExists);
    if (!adb.path) return { status: "skipped", reason: "adb-not-found" };

    const devices = await this.listDevices(adb.path);
    if (!devices.ok) {
      return { status: "skipped", reason: classifyAdbFailure(devices.error) };
    }
    const serial = request.serial ?? (devices.devices.length === 1 ? devices.devices[0]! : null);
    if (!serial) return { status: "skipped", reason: "no-serial" };
    if (request.serial && !devices.devices.includes(request.serial)) {
      return { status: "skipped", reason: "device-offline", serial };
    }

    const clock = await this.probeClock(adb.path, serial);
    const clockOffsetMs = clock.ok ? clock.offsetMs : 0;

    const crashBuffer = await this.run(adb.path, [
      "-s",
      serial,
      "logcat",
      "-b",
      "crash",
      "-v",
      "threadtime",
      "-d"
    ]);
    const crashText = crashBuffer.code === 0 || crashBuffer.stdout.trim() !== ""
      ? crashBuffer.stdout.trim()
      : "";
    if (crashText !== "") {
      return {
        status: "ok",
        source: "crash-buffer",
        text: boundText(crashText),
        clockOffsetMs,
        clockWarning: !clock.ok,
        serial
      };
    }

    const since = formatLogTime(request.windowStartMs + clockOffsetMs - 5000);
    const mainBuffer = await this.run(adb.path, [
      "-s",
      serial,
      "logcat",
      "-v",
      "threadtime",
      "-d",
      "-T",
      since
    ]);
    if (mainBuffer.code === 0) {
      return {
        status: "ok",
        source: "main-buffer",
        text: boundText(mainBuffer.stdout.trim()),
        clockOffsetMs,
        clockWarning: !clock.ok,
        serial
      };
    }

    const failure =
      [crashBuffer.error, crashBuffer.stderr, mainBuffer.error, mainBuffer.stderr].find(
        (value) => value !== undefined && value.trim() !== ""
      ) ?? "";
    return { status: "skipped", reason: classifyAdbFailure(failure), serial };
  }
}
