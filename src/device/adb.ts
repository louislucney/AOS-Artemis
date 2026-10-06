import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util.js";

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

export const defaultExec: ExecFn = (command, args, options = {}) =>
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

export function classifyAdbFailure(error: string | undefined): string {
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

export interface ExecBufferResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  error?: string;
}

export type ExecBufferFn = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number }
) => Promise<ExecBufferResult>;

export const defaultExecBuffer: ExecBufferFn = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", error: errorMessage(error) });
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (result: ExecBufferResult): void => {
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
          finish({ code: null, stdout: Buffer.concat(chunks), stderr, error: "timeout" });
        }, options.timeoutMs)
      : null;
    timer?.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      finish({ code: null, stdout: Buffer.concat(chunks), stderr, error: errorMessage(error) });
    });
    child.on("close", (code) => {
      finish({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
