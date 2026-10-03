import fs from "node:fs";

import { errorMessage } from "../util.js";
import {
  classifyAdbFailure,
  defaultExec,
  resolveAdbPath,
  type ExecFn,
  type ExecResult,
  type ResolvedAdb
} from "./adb.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type AppResetReason =
  | "invalid-package"
  | "adb-not-found"
  | "device-offline"
  | "timeout"
  | "force-stop-failed"
  | "launch-failed";

export interface AppResetRequest {
  packageName: string;
  serial?: string | null;
}

export interface AppResetOutcome {
  ok: boolean;
  reason?: AppResetReason;
  message?: string;
  serial: string | null;
  adb: ResolvedAdb;
  commands: string[][];
}

export interface AppResetOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_RESET_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function messageOf(result: ExecResult): string {
  const text = result.stderr.trim() || result.error || "";
  return text !== "" ? text : `exit ${String(result.code)}`;
}

function failureReason(result: ExecResult, fallback: AppResetReason): AppResetReason {
  if (result.error === "timeout") return "timeout";
  const classified = classifyAdbFailure(result.error ?? result.stderr);
  if (classified === "adb-not-found" || classified === "device-offline") return classified;
  return fallback;
}

async function run(
  exec: ExecFn,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<ExecResult> {
  try {
    return await exec(command, args, { timeoutMs });
  } catch (error) {
    return { code: null, stdout: "", stderr: "", error: errorMessage(error) };
  }
}

export async function resetApp(
  request: AppResetRequest,
  options: AppResetOptions = {}
): Promise<AppResetOutcome> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? fs.existsSync;
  const adb = resolveAdbPath(env, platform, pathExists);
  const serial = request.serial ?? null;
  const base = serial ? ["-s", serial] : [];
  const packageName = request.packageName?.trim() ?? "";
  const commands: string[][] = [];

  if (!PACKAGE_PATTERN.test(packageName)) {
    return {
      ok: false,
      reason: "invalid-package",
      message: `非法应用包名：${request.packageName}`,
      serial,
      adb,
      commands
    };
  }
  if (!adb.path) {
    return { ok: false, reason: "adb-not-found", message: "未找到 adb", serial, adb, commands };
  }

  const timeoutMs = resolveTimeoutMs(env);
  const forceStop = [...base, "shell", "am", "force-stop", packageName];
  commands.push(forceStop);
  const stopResult = await run(exec, adb.path, forceStop, timeoutMs);
  if (stopResult.error || stopResult.code !== 0) {
    return {
      ok: false,
      reason: failureReason(stopResult, "force-stop-failed"),
      message: messageOf(stopResult),
      serial,
      adb,
      commands
    };
  }

  const launch = [
    ...base,
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ];
  commands.push(launch);
  const launchResult = await run(exec, adb.path, launch, timeoutMs);
  if (launchResult.error || launchResult.code !== 0) {
    return {
      ok: false,
      reason: failureReason(launchResult, "launch-failed"),
      message: messageOf(launchResult),
      serial,
      adb,
      commands
    };
  }

  return { ok: true, serial, adb, commands };
}
