import fs from "node:fs";

import { errorMessage } from "../util.js";
import {
  classifyAdbFailure,
  defaultExec,
  resolveAdbPath,
  type ExecFn,
  type ExecResult
} from "../device/adb.js";
import {
  boundLogText,
  formatLogcatTime,
  listAdbDevices,
  probeDeviceClock,
  type DeviceListResult
} from "../device/logcat.js";
import type {
  CrashCollectorLike,
  CrashCollectOutcome,
  CrashCollectRequest
} from "./types.js";

export { resolveAdbPath } from "../device/adb.js";
export type { DeviceListResult } from "../device/logcat.js";
export type { ExecFn, ExecResult, ResolvedAdb } from "../device/adb.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_CRASH_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
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
    return listAdbDevices(this.exec, adbPath);
  }

  private async probeClock(
    adbPath: string,
    serial: string
  ): Promise<{ ok: boolean; offsetMs: number }> {
    return probeDeviceClock(this.exec, adbPath, serial, this.now);
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
        text: boundLogText(crashText),
        clockOffsetMs,
        clockWarning: !clock.ok,
        serial
      };
    }

    const since = formatLogcatTime(request.windowStartMs + clockOffsetMs - 5000);
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
        text: boundLogText(mainBuffer.stdout.trim()),
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
