import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorMessage } from "../util.js";

export interface PenExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface PenExecOptions {
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
}

export type PenExecFn = (
  command: string,
  args: string[],
  options?: PenExecOptions
) => Promise<PenExecResult>;

export interface ResolvedPenCli {
  path: string;
  source: "env" | "managed" | "path";
}

export const PEN_CLI_HINT =
  "pen CLI 首次使用会自动安装到 ~/.aos/pen-cli（Node ≥ 22.19，需网络；AOS_PEN_NO_INSTALL=1 关闭，AOS_PEN_CLI_DIR 可换目录），也可 npm install -g @pen.dev/cli 后 pen login（或设置 PEN_CLI_KEY，见 pen.dev 组织设置 Developer Keys）。AOS_PEN_CLI_PATH 可指定二进制路径。";

export const PEN_ENV_PASSTHROUGH = [
  "PEN_CLI_KEY",
  "PEN_AGENT_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AOS_PEN_ANTHROPIC_BASE_URL",
  "AOS_PEN_CLI_PATH",
  "AOS_PEN_CLI_DIR",
  "AOS_PEN_VERSION",
  "AOS_PEN_TIMEOUT_MS",
  "AOS_PEN_INSTALL_TIMEOUT_MS",
  "AOS_PEN_NO_INSTALL"
] as const;

/** pen 子进程 env：项目 .env 白名单键，进程 env 优先，extra（如 agent 派生凭证）最后覆盖。 */
export function penEnvFrom(
  dotenv: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PEN_ENV_PASSTHROUGH) {
    const value = dotenv[key]?.trim();
    if (value) env[key] = value;
  }
  for (const key of PEN_ENV_PASSTHROUGH) {
    const value = base[key]?.trim();
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

export function penCliDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.AOS_PEN_CLI_DIR?.trim() || path.join(os.homedir(), ".aos", "pen-cli"));
}

export function managedPenBinPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(dir, "node_modules", ".bin", platform === "win32" ? "pen.cmd" : "pen");
}

export interface ResolvePenCliOptions {
  managedDir?: string;
  exists?: (candidate: string) => boolean;
}

export function resolvePenCliPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: ResolvePenCliOptions = {}
): ResolvedPenCli {
  const explicit = env.AOS_PEN_CLI_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };
  const managed = managedPenBinPath(options.managedDir ?? penCliDir(env), platform);
  const exists = options.exists ?? fs.existsSync;
  if (exists(managed)) return { path: managed, source: "managed" };
  return { path: platform === "win32" ? "pen.cmd" : "pen", source: "path" };
}

export function penCommandFor(options: { cliPath?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.cliPath) return options.cliPath;
  return resolvePenCliPath(options.env ?? process.env).path;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const STATUS_TIMEOUT_MS = 20_000;

export function resolvePenTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AOS_PEN_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function stripAnsi(text: string): string {
  const escape = String.fromCharCode(27);
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === escape && text[index + 1] === "[") {
      index += 2;
      while (index < text.length && !/[A-Za-z]/.test(text[index]!)) index += 1;
      continue;
    }
    out += text[index];
  }
  return out;
}

export const penExec: PenExecFn = (command, args, options = {}) =>
  new Promise((resolve) => {
    const childEnv = options.env ? { ...process.env, ...options.env } : process.env;
    let child: ReturnType<typeof spawn>;
    try {
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
        child = spawn("cmd.exe", ["/c", command, ...args], { windowsHide: true, env: childEnv });
      } else {
        child = spawn(command, args, { windowsHide: true, env: childEnv });
      }
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: errorMessage(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: PenExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill("SIGKILL");
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
    child.stdin?.on("error", () => {
      /* child exited before reading stdin */
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, error: errorMessage(error) });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
    child.stdin?.end(options.input ?? "");
  });

export interface PenCliStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  email: string | null;
  workspace: string | null;
  error?: string;
}

export async function penCliStatus(
  exec: PenExecFn = penExec,
  options: { timeoutMs?: number; cliPath?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<PenCliStatus> {
  const cli = penCommandFor(options);
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const versionResult = await exec(cli, ["version"], { timeoutMs });
  if (versionResult.error === "timeout") {
    return { installed: false, version: null, authenticated: false, email: null, workspace: null, error: "timeout" };
  }
  const versionText = versionResult.stdout.trim();
  if (versionResult.code !== 0 || versionText === "") {
    return {
      installed: false,
      version: null,
      authenticated: false,
      email: null,
      workspace: null,
      error: versionResult.error ?? (versionResult.stderr.trim() || `exit ${versionResult.code}`)
    };
  }
  const version = versionText.split(/\s+/).pop() ?? versionText;

  const statusResult = await exec(cli, ["status"], { timeoutMs });
  const log = stripAnsi(`${statusResult.stdout}\n${statusResult.stderr}`);
  const email = /Email\s+(\S+@\S+)/.exec(log)?.[1] ?? null;
  const workspaceRaw = /Workspace\s+(.+)$/m.exec(log)?.[1]?.trim() ?? null;
  const authenticated = statusResult.code === 0 && /Active/.test(log);
  return {
    installed: true,
    version,
    authenticated,
    email,
    workspace: workspaceRaw,
    ...(authenticated ? {} : { error: statusResult.error ?? "not-authenticated" })
  };
}

export function detectPenFailure(result: PenExecResult, log: string): string | null {
  if (result.error === "timeout") return "pen CLI 执行超时（AOS_PEN_TIMEOUT_MS 可调）";
  if (result.error) {
    if (/ENOENT|not found/i.test(result.error)) return `未找到 pen CLI（${PEN_CLI_HINT}）`;
    return `pen CLI 启动失败: ${result.error}`;
  }
  if (/Unknown model|--agent must be one of/i.test(log)) {
    return "pen agent 不支持该模型/agent（CLI 可选 claude/codex/gemini；pen.dev 订阅或其他厂商需在 pen.dev 应用内连接）";
  }
  if (/authentication_failed|Please run \/login|Not logged in/i.test(log)) {
    return "pen agent 凭证缺失或无效：需 PEN_AGENT_API_KEY（AOS 自动注入 active LLM key）或 ANTHROPIC_API_KEY，或 pen codex-login";
  }
  if (/Agent failed/i.test(log)) {
    return "pen agent 执行失败（见日志尾部）";
  }
  if (/not authenticated|not logged in|login required|unauthorized/i.test(log)) {
    return `pen CLI 未登录（${PEN_CLI_HINT}）`;
  }
  if (/(?:HTTP|status|code|error)[^\n]{0,16}\b401\b/i.test(log)) {
    return `pen CLI 未登录（${PEN_CLI_HINT}）`;
  }
  if (/Failed to execute|Failure during operation|\[ERROR\]/i.test(log)) {
    return "pen execute 操作失败（已回滚，未写盘）";
  }
  if (result.code !== 0) return `pen CLI 退出码 ${result.code ?? "null"}`;
  return null;
}

export interface PenCliRun {
  result: PenExecResult;
  log: string;
}

export function runPenCli(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; exec?: PenExecFn; input?: string; cliPath?: string } = {}
): Promise<PenCliRun> {
  const exec = options.exec ?? penExec;
  const cli = penCommandFor(options);
  return exec(cli, args, {
    timeoutMs: options.timeoutMs ?? resolvePenTimeoutMs(),
    env: options.env,
    input: options.input
  }).then((result) => ({ result, log: stripAnsi(`${result.stdout}\n${result.stderr}`) }));
}

export interface PenInteractiveRun {
  result: PenExecResult;
  log: string;
  saved: boolean;
}

export function runPenInteractive(options: {
  input: string;
  output: string;
  commands: string[];
  timeoutMs?: number;
  exec?: PenExecFn;
  cliPath?: string;
  env?: Record<string, string>;
}): Promise<PenInteractiveRun> {
  const exec = options.exec ?? penExec;
  const cli = penCommandFor(options);
  const input = [...options.commands, "save()", "exit()"].join("\n") + "\n";
  return exec(cli, ["interactive", "-i", options.input, "-o", options.output], {
    timeoutMs: options.timeoutMs ?? resolvePenTimeoutMs(),
    env: options.env,
    input
  }).then((result) => ({
    result,
    log: stripAnsi(`${result.stdout}\n${result.stderr}`),
    saved: fs.existsSync(options.output)
  }));
}

export function runPenExport(options: {
  input: string;
  output: string;
  format: "png" | "jpeg" | "webp" | "pdf";
  scale?: number;
  timeoutMs?: number;
  exec?: PenExecFn;
  cliPath?: string;
  env?: Record<string, string>;
}): Promise<PenInteractiveRun> {
  const exec = options.exec ?? penExec;
  const cli = penCommandFor(options);
  const args = ["--in", options.input, "--export", options.output];
  if (options.scale !== undefined) args.push("--export-scale", String(options.scale));
  if (options.format !== "png") args.push("--export-type", options.format);
  return exec(cli, args, { timeoutMs: options.timeoutMs ?? resolvePenTimeoutMs(), env: options.env }).then((result) => ({
    result,
    log: stripAnsi(`${result.stdout}\n${result.stderr}`),
    saved: fs.existsSync(options.output)
  }));
}
