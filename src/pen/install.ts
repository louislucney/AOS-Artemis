import fs from "node:fs";
import path from "node:path";

import { log as defaultLog } from "../util.js";
import {
  managedPenBinPath,
  penCliDir,
  penExec,
  PEN_CLI_HINT,
  resolvePenCliPath,
  type PenExecFn
} from "./cli.js";

const INSTALL_PACKAGE = "@pen.dev/cli";
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
const MIN_INSTALL_TIMEOUT_MS = 60_000;
const MAX_INSTALL_TIMEOUT_MS = 1_800_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const INSTALL_FAILURE_COOLDOWN_MS = 5 * 60_000;
const NODE_MIN_MAJOR = 22;
const NODE_MIN_MINOR = 19;

export type PenEnsureSource = "env" | "managed" | "path" | "installed";

export interface PenEnsureOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cliDir?: string;
  exec?: PenExecFn;
  log?: (line: string) => void;
  allowInstall?: boolean;
  nodeVersion?: string;
  probeTimeoutMs?: number;
  installTimeoutMs?: number;
  exists?: (candidate: string) => boolean;
  now?: () => number;
}

export interface PenEnsureResult {
  ok: boolean;
  source: PenEnsureSource | null;
  path: string | null;
  installed: boolean;
  error?: string;
  hint?: string;
}

export type PenEnsureFn = (options?: PenEnsureOptions) => Promise<PenEnsureResult>;

let lastInstallFailure: { at: number; dir: string; message: string } | null = null;
const inflightInstalls = new Map<string, Promise<PenEnsureResult>>();

export function penNodeTooOld(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major < NODE_MIN_MAJOR || (major === NODE_MIN_MAJOR && minor < NODE_MIN_MINOR);
}

function resolveInstallTimeout(env: NodeJS.ProcessEnv, explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return Math.min(Math.max(Math.trunc(explicit), MIN_INSTALL_TIMEOUT_MS), MAX_INSTALL_TIMEOUT_MS);
  }
  const raw = Number(env.AOS_PEN_INSTALL_TIMEOUT_MS ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INSTALL_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(raw), MIN_INSTALL_TIMEOUT_MS), MAX_INSTALL_TIMEOUT_MS);
}

function missingResult(error: string, extra?: string): PenEnsureResult {
  return { ok: false, source: null, path: null, installed: false, error, hint: extra ?? PEN_CLI_HINT };
}

async function installPenCli(options: {
  dir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exec: PenExecFn;
  log: (line: string) => void;
  timeoutMs: number;
  exists: (candidate: string) => boolean;
}): Promise<PenEnsureResult> {
  const managed = managedPenBinPath(options.dir, options.platform);
  const version = options.env.AOS_PEN_VERSION?.trim();
  const spec = version ? `${INSTALL_PACKAGE}@${version}` : INSTALL_PACKAGE;
  fs.mkdirSync(options.dir, { recursive: true });
  const npm = options.platform === "win32" ? "npm.cmd" : "npm";
  options.log(`pen CLI 未安装：自动安装 ${spec} → ${options.dir}（AOS_PEN_NO_INSTALL=1 可关闭）`);
  const result = await options.exec(
    npm,
    ["install", spec, "--prefix", options.dir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error"],
    { timeoutMs: options.timeoutMs }
  );
  if (result.code === 0 && options.exists(managed)) {
    options.log(`pen CLI 安装完成: ${managed}`);
    return { ok: true, source: "installed", path: managed, installed: true };
  }
  const detail = (result.stderr.trim() || result.error || `exit ${result.code}`).slice(-500);
  return missingResult(
    `pen CLI 自动安装失败：${detail || "未知错误"}`,
    "可手动 npm install -g @pen.dev/cli 并 pen login，或设置 AOS_PEN_CLI_PATH 指向已有二进制。"
  );
}

/** 解析可用的 pen CLI；缺失时按需自动安装到托管目录（默认 ~/.aos/pen-cli）。
 *
 * 解析顺序：AOS_PEN_CLI_PATH → 托管目录（AOS_PEN_CLI_DIR）→ PATH。
 * 自动安装仅在托管目录缺失且允许时执行，受 AOS_PEN_NO_INSTALL / AOS_DEPS_NO_ONLINE 与
 * Node ≥ 22.19 门槛约束，并做失败冷却与并发去重。 */
export async function ensurePenCli(options: PenEnsureOptions = {}): Promise<PenEnsureResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? penExec;
  const exists = options.exists ?? fs.existsSync;
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const dir = path.resolve(options.cliDir ?? penCliDir(env));

  const resolved = resolvePenCliPath(env, platform, { managedDir: dir, exists });
  if (resolved.source === "env") {
    return { ok: true, source: "env", path: resolved.path, installed: false };
  }
  if (resolved.source === "managed") {
    return { ok: true, source: "managed", path: resolved.path, installed: false };
  }
  const probe = await exec(resolved.path, ["version"], {
    timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  });
  if (probe.code === 0 && probe.stdout.trim() !== "") {
    return { ok: true, source: "path", path: resolved.path, installed: false };
  }

  const allowInstall =
    options.allowInstall ?? (env.AOS_PEN_NO_INSTALL !== "1" && env.AOS_DEPS_NO_ONLINE !== "1");
  if (!allowInstall) {
    return missingResult(
      "pen CLI 未安装",
      env.AOS_PEN_NO_INSTALL === "1" || env.AOS_DEPS_NO_ONLINE === "1"
        ? `${PEN_CLI_HINT}（自动安装已关闭：AOS_PEN_NO_INSTALL/AOS_DEPS_NO_ONLINE）`
        : PEN_CLI_HINT
    );
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (penNodeTooOld(nodeVersion)) {
    return missingResult(
      `pen CLI 需要 Node >= ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}（当前 ${nodeVersion}）`,
      "升级 Node 后重试，或设置 AOS_PEN_CLI_PATH 指向兼容环境中的 pen 二进制。"
    );
  }

  if (lastInstallFailure && lastInstallFailure.dir === dir && now() - lastInstallFailure.at < INSTALL_FAILURE_COOLDOWN_MS) {
    const waited = Math.ceil((INSTALL_FAILURE_COOLDOWN_MS - (now() - lastInstallFailure.at)) / 1000);
    return missingResult(
      `pen CLI 自动安装近期失败，${waited}s 后才会重试：${lastInstallFailure.message}`,
      "可手动 npm install -g @pen.dev/cli，或设置 AOS_PEN_CLI_PATH。"
    );
  }

  const inflight = inflightInstalls.get(dir);
  if (inflight) return inflight;

  const task = installPenCli({
    dir,
    env,
    platform,
    exec,
    log,
    timeoutMs: resolveInstallTimeout(env, options.installTimeoutMs),
    exists
  }).then((result) => {
    if (result.ok) {
      lastInstallFailure = null;
    } else {
      lastInstallFailure = { at: now(), dir, message: result.error ?? "自动安装失败" };
    }
    return result;
  });
  inflightInstalls.set(dir, task);
  try {
    return await task;
  } finally {
    inflightInstalls.delete(dir);
  }
}
