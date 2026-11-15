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
const DEFAULT_INTERNAL_RESET_WAIT_MS = 1_000;
export const APP_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export type AppResetReason =
  | "invalid-package"
  | "adb-not-found"
  | "device-offline"
  | "timeout"
  | "force-stop-failed"
  | "launch-failed"
  | "app-internal-reset-failed"
  | "ios-unsupported";

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

function internalResetWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_ANDROID_RESET_WAIT_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return DEFAULT_INTERNAL_RESET_WAIT_MS;
  return Math.min(raw, 30_000);
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

  if (!APP_PACKAGE_PATTERN.test(packageName)) {
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

  const resetUrl = (env.AOS_ANDROID_RESET_URL ?? "").trim();
  if (resetUrl !== "") {
    const open = [
      ...base,
      "shell",
      "am",
      "start",
      "-W",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      resetUrl
    ];
    commands.push(open);
    const openResult = await run(exec, adb.path, open, timeoutMs);
    if (openResult.error || openResult.code !== 0) {
      return {
        ok: false,
        reason: "app-internal-reset-failed",
        message: `应用内建复位入口打开失败：${messageOf(openResult)}`,
        serial,
        adb,
        commands
      };
    }
    await new Promise((resolve) => setTimeout(resolve, internalResetWaitMs(env)));
    commands.push(launch);
    const relaunchResult = await run(exec, adb.path, launch, timeoutMs);
    if (relaunchResult.error || relaunchResult.code !== 0) {
      return {
        ok: false,
        reason: "app-internal-reset-failed",
        message: `应用内建复位后重新启动失败：${messageOf(relaunchResult)}`,
        serial,
        adb,
        commands
      };
    }
  }

  return { ok: true, serial, adb, commands };
}
