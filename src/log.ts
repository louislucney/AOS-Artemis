import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogState {
  dir: string | null;
  fd: number | null;
  childFd: number | null;
  minLevel: LogLevel;
  echo: boolean;
  maxBytes: number;
}

const state: LogState = {
  dir: null,
  fd: null,
  childFd: null,
  minLevel: "info",
  echo: true,
  maxBytes: 5 * 1024 * 1024
};

export interface LoggingOptions {
  /** File sink directory; AOS_LOG_DIR / AOS_LOG_DISABLE_FILE env apply when omitted. */
  logDir?: string | null;
  level?: string | null;
  echo?: boolean;
  maxBytes?: number;
}

function normalizeLevel(value: string | null | undefined): LogLevel {
  const level = (value ?? "").trim().toLowerCase();
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}

/** Configure the logger: file sink (<dir>/aos-mcp.log + artemis-child.log), level,
 * stderr echo and size-based rotation (keep one .1 backup). Returns the log path. */
export function configureLogging(options: LoggingOptions = {}): string | null {
  state.minLevel = normalizeLevel(options.level ?? process.env.AOS_LOG_LEVEL);
  state.echo = options.echo ?? true;

  const maxMb = Number(process.env.AOS_LOG_MAX_MB ?? "");
  state.maxBytes =
    options.maxBytes ?? (Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1048576 : 5 * 1048576);

  const dir = options.logDir ?? process.env.AOS_LOG_DIR ?? null;
  if (!dir || process.env.AOS_LOG_DISABLE_FILE === "1") {
    state.dir = null;
    state.fd = null;
    state.childFd = null;
    return null;
  }

  try {
    const resolved = path.resolve(dir);
    mkdirSync(resolved, { recursive: true });
    const filePath = path.join(resolved, "aos-mcp.log");
    if (existsSync(filePath) && statSync(filePath).size > state.maxBytes) {
      const backup = `${filePath}.1`;
      try {
        rmSync(backup, { force: true });
      } catch {
        /* best effort */
      }
      renameSync(filePath, backup);
    }
    state.fd = openSync(filePath, "a");
    state.childFd = openSync(path.join(resolved, "artemis-child.log"), "a");
    state.dir = resolved;
    return filePath;
  } catch {
    state.dir = null;
    state.fd = null;
    state.childFd = null;
    return null;
  }
}

export function logDirPath(): string | null {
  return state.dir;
}

export function logFilePath(): string | null {
  return state.dir ? path.join(state.dir, "aos-mcp.log") : null;
}

export function childLogFilePath(): string | null {
  return state.dir ? path.join(state.dir, "artemis-child.log") : null;
}

function writeToFd(fd: number | null, line: string): void {
  if (fd === null) return;
  try {
    writeSync(fd, line);
  } catch {
    /* never fail the caller because of logging */
  }
}

export function logAt(level: LogLevel, message: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.minLevel]) return;
  const stamp = new Date().toISOString();
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [aos-mcp] ${message}\n`;
  if (state.echo) process.stderr.write(line);
  writeToFd(state.fd, line);
}

/** stderr + file logger — stdout is reserved for the stdio MCP protocol. */
export function log(message: string, level: LogLevel = "info"): void {
  logAt(level, message);
}

export function logDebug(message: string): void {
  logAt("debug", message);
}

export function logWarn(message: string): void {
  logAt("warn", message);
}

export function logError(message: string): void {
  logAt("error", message);
}

/** Persist a line of artemis child stderr (also echoed at debug level). */
export function appendChildLog(line: string): void {
  const stamped = `${new Date().toISOString()} [artemis] ${line}\n`;
  writeToFd(state.childFd, stamped);
  if (state.minLevel === "debug" && state.echo) process.stderr.write(stamped);
}

export function closeLogging(): void {
  try {
    if (state.fd !== null) closeSync(state.fd);
  } catch {
    /* best effort */
  }
  try {
    if (state.childFd !== null) closeSync(state.childFd);
  } catch {
    /* best effort */
  }
  state.fd = null;
  state.childFd = null;
}

/** Log fatal errors before the process dies so crashes are diagnosable. */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (error) => {
    logError(`uncaughtException: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    closeLogging();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError(
      `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    );
  });
}
