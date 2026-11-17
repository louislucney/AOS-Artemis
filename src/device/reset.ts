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
import { resolveResetPolicy } from "./reset-policy.js";

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
  | "fresh-failed"
  | "ios-unsupported";

export interface AppResetRequest {
  packageName: string;
  serial?: string | null;
}

export type AppResetMode = "fresh" | "app-internal-reset" | "reuse" | "none";
export type AppResetCapability =
  | "debug-menu"
  | "deep-link"
  | "test-api"
  | "full-reset"
  | "unsupported";

export interface AppResetOutcome {
  ok: boolean;
  reason?: AppResetReason;
  message?: string;
  serial: string | null;
  adb: ResolvedAdb;
  commands: string[][];
  /** 复位语义：当前实现产出 reuse / app-internal-reset；fresh/none 保留给后续策略。 */
  mode?: AppResetMode;
  capability?: AppResetCapability;
  supported?: boolean;
  degraded?: boolean;
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
  const resetUrl = (env.AOS_ANDROID_RESET_URL ?? "").trim();
  const policy = resolveResetPolicy(env);
  const effective = policy ?? (resetUrl === "" ? "reuse" : "app-internal-reset");
  const meta = {
    mode: effective,
    capability:
      effective === "fresh"
        ? ("full-reset" as const)
        : effective === "app-internal-reset"
          ? ("deep-link" as const)
          : ("unsupported" as const),
    supported: effective === "app-internal-reset" ? resetUrl !== "" : true,
    degraded: false
  };

  if (!APP_PACKAGE_PATTERN.test(packageName)) {
    return {
      ...meta,
      ok: false,
      reason: "invalid-package",
      message: `非法应用包名：${request.packageName}`,
      serial,
      adb,
      commands
    };
  }
  if (effective === "none") {
    return { ...meta, ok: true, serial, adb, commands };
  }
  if (effective === "app-internal-reset" && resetUrl === "") {
    return {
      ...meta,
      ok: false,
      reason: "app-internal-reset-failed",
      message: "AOS_RESET_POLICY=app-internal-reset 需要 AOS_ANDROID_RESET_URL",
      serial,
      adb,
      commands
    };
  }
  if (!adb.path) {
    return { ...meta, ok: false, reason: "adb-not-found", message: "未找到 adb", serial, adb, commands };
  }

  const timeoutMs = resolveTimeoutMs(env);
  if (effective === "fresh") {
    const clear = [...base, "shell", "pm", "clear", packageName];
    commands.push(clear);
    const clearResult = await run(exec, adb.path, clear, timeoutMs);
    if (clearResult.error || clearResult.code !== 0) {
      return {
        ...meta,
        ok: false,
        reason: "fresh-failed",
        message: `pm clear 失败：${messageOf(clearResult)}`,
        serial,
        adb,
        commands
      };
    }
  }
  const forceStop = [...base, "shell", "am", "force-stop", packageName];
  commands.push(forceStop);
  const stopResult = await run(exec, adb.path, forceStop, timeoutMs);
  if (stopResult.error || stopResult.code !== 0) {
    return {
      ...meta,
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
      ...meta,
      ok: false,
      reason: failureReason(launchResult, "launch-failed"),
      message: messageOf(launchResult),
      serial,
      adb,
      commands
    };
  }

  if ((env.AOS_ANDROID_RESET_BACKGROUND ?? "").trim() === "1") {
    const killAll = [...base, "shell", "am", "kill-all"];
    commands.push(killAll);
    await run(exec, adb.path, killAll, timeoutMs).catch(() => undefined);
  }

  if ((env.AOS_ANDROID_RESET_ALERTS ?? "").trim() === "1") {
    const closeDialogs = [
      ...base,
      "shell",
      "am",
      "broadcast",
      "-a",
      "android.intent.action.CLOSE_SYSTEM_DIALOGS"
    ];
    commands.push(closeDialogs);
    await run(exec, adb.path, closeDialogs, timeoutMs).catch(() => undefined);
  }

  if (effective === "app-internal-reset") {
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
        ...meta,
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
        ...meta,
        ok: false,
        reason: "app-internal-reset-failed",
        message: `应用内建复位后重新启动失败：${messageOf(relaunchResult)}`,
        serial,
        adb,
        commands
      };
    }
  }

  return { ...meta, ok: true, serial, adb, commands };
}
