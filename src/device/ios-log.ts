import { spawn, type ChildProcess } from "node:child_process";

import { errorMessage } from "../util.js";
import { defaultExec, type ExecFn, type ExecResult } from "./adb.js";
import { classifyIosSerial, resolveXcrunPath } from "./ios.js";
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

const DEVICE_LOG_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
};

/** idevicesyslog 行时间戳（`Oct  8 14:30:19.684 ...`）→ epoch ms；解析失败返回 null。 */
export function parseDeviceLogTime(line: string, referenceMs: number): number | null {
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/.exec(
    line.trim()
  );
  if (!match) return null;
  const month = DEVICE_LOG_MONTHS[match[1]!];
  if (month === undefined) return null;
  const reference = new Date(referenceMs);
  let year = reference.getFullYear();
  if (month > reference.getMonth() + 1) year -= 1; // 跨年回退（如 1 月采到 12 月行）
  const millis = Number((match[6] ?? "0").padEnd(3, "0").slice(0, 3));
  return new Date(
    year,
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    millis
  ).getTime();
}

export interface DeviceLogFilterOptions {
  windowStartMs: number;
  windowEndMs: number | null;
  processName: string | null;
  nowMs: number;
  slackMs?: number;
}

export interface DeviceLogFilterResult {
  lines: string[];
  /** 实时尾采样发生在窗口结束后：晚于窗口的行被近似保留（调用方应标 clockWarning）。 */
  approximateEnd: boolean;
  /** 窗口已过且未采到可用行。 */
  windowElapsed: boolean;
}

/** 真机日志窗口过滤（纯函数）：无历史 syslog 可用，实时尾采样按 [start-slack, ∞) 保留。 */
export function filterDeviceLogLines(
  lines: string[],
  options: DeviceLogFilterOptions
): DeviceLogFilterResult {
  const slack = options.slackMs ?? WINDOW_SLACK_MS;
  const start = options.windowStartMs - slack;
  const windowEnd = (options.windowEndMs ?? options.nowMs) + slack;
  const kept: string[] = [];
  let parsedAny = false;
  let approximateEnd = options.nowMs > windowEnd;
  for (const line of lines) {
    if (options.processName && !deviceLineMatchesProcess(line, options.processName)) continue;
    const timestamp = parseDeviceLogTime(line, options.nowMs);
    if (timestamp === null) {
      if (!options.processName) continue;
      kept.push(line);
      continue;
    }
    parsedAny = true;
    if (timestamp < start) continue;
    if (timestamp > windowEnd) approximateEnd = true;
    kept.push(line);
  }
  return {
    lines: kept,
    approximateEnd: parsedAny ? approximateEnd : true,
    windowElapsed: options.nowMs > windowEnd && kept.length === 0
  };
}

function deviceLineMatchesProcess(line: string, processName: string): boolean {
  return line.includes(`${processName}[`);
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((chunk, index) => (index === 0 ? chunk : chunk.slice(chunk.indexOf("m") + 1)))
    .join("");
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

    if (classifyIosSerial(serial) === "device") {
      return await this.collectDeviceLogs(request, serial, processName);
    }

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

  /** 真机日志：`idevicesyslog` 实时尾采样（有界超时即停）；无历史窗口拉取能力。 */
  private async collectDeviceLogs(
    request: IosLogWindowRequest,
    serial: string,
    processName: string
  ): Promise<LogcatWindowResult> {
    const binary = this.env.AOS_IDEVICESYSLOG_PATH?.trim() || "idevicesyslog";
    let result: ExecResult;
    try {
      result = await this.exec(binary, ["-u", serial], { timeoutMs: this.timeoutMs });
    } catch (error) {
      return { status: "skipped", reason: `collector-error: ${errorMessage(error)}`, text: "", serial };
    }
    const timedOut = /timeout/i.test(result.error ?? "");
    if (result.error && !timedOut) {
      return {
        status: "skipped",
        reason: /ENOENT|not found/i.test(result.error) ? "ios-log-tool-missing" : "exec-failed",
        text: "",
        serial
      };
    }
    if (!timedOut && result.code !== 0) {
      return { status: "skipped", reason: "idevicesyslog-failed", text: "", serial };
    }
    const lines = stripAnsi(result.stdout)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    const filtered = filterDeviceLogLines(lines, {
      windowStartMs: request.windowStartMs,
      windowEndMs: request.windowEndMs ?? null,
      processName,
      nowMs: Date.now()
    });
    if (filtered.lines.length === 0) {
      return {
        status: "skipped",
        reason: filtered.windowElapsed ? "window-elapsed-live-tail" : "log-empty",
        text: "",
        serial
      };
    }
    if (filtered.lines.length > this.maxLines) {
      return { status: "skipped", reason: "log-over-limit", text: "", serial };
    }
    return {
      status: "ok",
      text: boundLogText(filtered.lines.join("\n")),
      serial,
      ...(filtered.approximateEnd ? { clockWarning: true } : {})
    };
  }
}

const DEFAULT_TAIL_LINES = 200;

export interface IosDeviceLogTailOptions {
  serial: string;
  env?: NodeJS.ProcessEnv;
  maxLines?: number;
  spawnFn?: typeof spawn;
}

/** 真机日志环形缓冲：任务启动即挂 `idevicesyslog`，内存保留最后 N 行，
 * 失败终态取快照（DESIGN §13.47 增补；`AOS_IOS_LOG_FEEDBACK=0` 可关）。 */
export class IosDeviceLogTail {
  private readonly serial: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxLines: number;
  private readonly spawnFn: typeof spawn;
  private buffer: string[] = [];
  private child: ChildProcess | null = null;

  constructor(options: IosDeviceLogTailOptions) {
    this.serial = options.serial;
    this.env = options.env ?? process.env;
    this.maxLines = options.maxLines ?? DEFAULT_TAIL_LINES;
    this.spawnFn = options.spawnFn ?? spawn;
  }

  start(): boolean {
    if (this.child) return true;
    const binary = this.env.AOS_IDEVICESYSLOG_PATH?.trim() || "idevicesyslog";
    try {
      this.child = this.spawnFn(binary, ["-u", this.serial], {
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      this.child = null;
      return false;
    }
    const child = this.child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.push(String(chunk)));
    child.on("error", () => {
      this.child = null;
    });
    child.on("exit", () => {
      this.child = null;
    });
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  snapshot(): string[] {
    return [...this.buffer];
  }

  private push(chunk: string): void {
    const lines = stripAnsi(chunk)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    if (lines.length === 0) return;
    this.buffer.push(...lines);
    if (this.buffer.length > this.maxLines) {
      this.buffer = this.buffer.slice(this.buffer.length - this.maxLines);
    }
  }
}
