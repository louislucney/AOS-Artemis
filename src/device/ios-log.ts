import { errorMessage } from "../util.js";
import { defaultExec, type ExecFn, type ExecResult } from "./adb.js";
import { resolveXcrunPath } from "./ios.js";
import { boundLogText, type LogcatWindowRequest, type LogcatWindowResult } from "./logcat.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LINES = 2_000;
const WINDOW_SLACK_MS = 5_000;

export interface IosLogWindowRequest extends LogcatWindowRequest {
  processName?: string | null;
}

export interface IosLogCollectorOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  maxLines?: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatLogShowTime(ms: number): string {
  const date = new Date(ms);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AOS_IOS_LOG_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function resolveMaxLines(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_IOS_LOG_MAX_LINES ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_LINES;
  return Math.min(Math.max(raw, 10), 20_000);
}

export class IosLogCollector {
  private readonly env: NodeJS.ProcessEnv;
  private readonly exec: ExecFn;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly maxLines: number;

  constructor(options: IosLogCollectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.exec = options.exec ?? defaultExec;
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? resolveTimeoutMs(this.env);
    this.maxLines = options.maxLines ?? resolveMaxLines(this.env);
  }

  async collect(request: IosLogWindowRequest): Promise<LogcatWindowResult> {
    if (this.platform !== "darwin") {
      return { status: "skipped", reason: "ios-unsupported", text: "", serial: null };
    }
    const serial = request.serial?.trim() ?? "";
    if (!serial) return { status: "skipped", reason: "no-serial", text: "", serial: null };
    const processName = request.processName?.trim() ?? "";
    if (!processName) return { status: "skipped", reason: "no-process", text: "", serial };

    const xcrun = resolveXcrunPath(this.env);
    const start = formatLogShowTime(request.windowStartMs - WINDOW_SLACK_MS);
    const end = formatLogShowTime((request.windowEndMs ?? Date.now()) + WINDOW_SLACK_MS);
    const args = [
      "simctl",
      "spawn",
      serial,
      "log",
      "show",
      "--style",
      "compact",
      "--start",
      start,
      "--end",
      end,
      "--predicate",
      `process == "${processName.replace(/"/g, "")}"`
    ];
    let result: ExecResult;
    try {
      result = await this.exec(xcrun.path, args, { timeoutMs: this.timeoutMs });
    } catch (error) {
      return { status: "skipped", reason: `collector-error: ${errorMessage(error)}`, text: "", serial };
    }
    if (result.error) {
      return {
        status: "skipped",
        reason: /timeout/i.test(result.error) ? "timeout" : "exec-failed",
        text: "",
        serial
      };
    }
    if (result.code !== 0) {
      return { status: "skipped", reason: "log-show-failed", text: "", serial };
    }
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length === 0) return { status: "skipped", reason: "log-empty", text: "", serial };
    if (lines.length > this.maxLines) {
      return { status: "skipped", reason: "log-over-limit", text: "", serial };
    }
    return { status: "ok", text: boundLogText(lines.join("\n")), serial };
  }
}
