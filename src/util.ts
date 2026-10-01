import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const AOS_MCP_VERSION = "0.1.0";

/** stderr + file logger (see src/log.ts) — stdout is reserved for the MCP protocol. */
export { log, logDebug, logError, logWarn } from "./log.js";

export function writeFileAtomic(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `****${value.slice(-4)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** POSIX cmdline check used before killing a stale child (avoids PID reuse mistakes). */
export function processCmdline(pid: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 3000
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const cmdline = result.stdout.trim();
    return cmdline === "" ? null : cmdline;
  } catch {
    return null;
  }
}

/** Terminate a single process (never a process group — detached task runners must survive). */
export async function terminateProcess(pid: number, termTimeoutMs = 2000): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + termTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(50);
    if (!isProcessAlive(pid)) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export function terminateProcessSync(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
