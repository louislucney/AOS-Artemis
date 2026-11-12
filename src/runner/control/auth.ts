import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

import { runnerJobTokenFrom } from "../../env-tokens.js";

export interface RunnerAuthFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
}

export interface RunnerAuthSuccess {
  ok: true;
  hostId: string;
  source: "host-token" | "global-token";
}

export type RunnerAuthResult = RunnerAuthFailure | RunnerAuthSuccess;

export interface RunnerAuthOptions {
  /** 全局 token 模式下允许无 X-AOS-Host-Id（仅用于共享 LLM 代理路由）。 */
  allowHostless?: boolean;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  return value.trim();
}

function bearerToken(headers: Record<string, string | string[] | undefined>): string {
  const match = /^Bearer\s+(.+)$/i.exec(headerValue(headers, "authorization"));
  return match?.[1]?.trim() ?? "";
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(provided: string, expected: string): boolean {
  if (provided === "" || expected === "") return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

interface HostTokenEntry {
  hostId: string;
  token: string;
}

export function parseHostTokens(raw: string): HostTokenEntry[] | null {
  if (raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const entries: HostTokenEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) return null;
      const record = item as Record<string, unknown>;
      const hostId = typeof record.hostId === "string" ? record.hostId.trim() : "";
      const token = typeof record.token === "string" ? record.token.trim() : "";
      if (hostId === "" || token.length < 16) return null;
      entries.push({ hostId, token });
    }
    return entries;
  } catch {
    return null;
  }
}

interface FileTokenCache {
  path: string;
  mtimeMs: number;
  size: number;
  entries: HostTokenEntry[] | null;
}

let fileTokenCache: FileTokenCache | null = null;

function hostTokensFromFile(path: string): HostTokenEntry[] | null {
  try {
    const stat = fs.statSync(path);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      fileTokenCache = null;
      return null;
    }
    if (
      fileTokenCache !== null &&
      fileTokenCache.path === path &&
      fileTokenCache.mtimeMs === stat.mtimeMs &&
      fileTokenCache.size === stat.size
    ) {
      return fileTokenCache.entries;
    }
    const raw = fs.readFileSync(path, "utf8");
    const entries = parseHostTokens(raw);
    fileTokenCache = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries
    };
    return entries;
  } catch {
    fileTokenCache = null;
    return null;
  }
}

/** 每主机 token 优先从文件读取（支持 mtime 热更新），否则读 env JSON。 */
export function runnerHostTokenEntries(env: NodeJS.ProcessEnv): HostTokenEntry[] | null {
  const filePath = (env.AOS_RUNNER_HOST_TOKENS_FILE ?? "").trim();
  if (filePath !== "") return hostTokensFromFile(filePath);
  const raw = (env.AOS_RUNNER_HOST_TOKENS ?? "").trim();
  if (raw === "") return null;
  return parseHostTokens(raw);
}

export function runnerHostTokenFor(
  env: NodeJS.ProcessEnv,
  hostId: string
): string | null {
  return runnerHostTokenEntries(env)?.find((entry) => entry.hostId === hostId)?.token ?? null;
}

/**
 * runner 鉴权：优先每主机 token（AOS_RUNNER_HOST_TOKENS，JSON [{hostId,token}]），
 * 未配置时回退全局 MOBILE_TESTING_RUNNER_JOB_TOKEN + X-AOS-Host-Id 兼容模式。
 */
export function authenticateRunner(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
  options: RunnerAuthOptions = {}
): RunnerAuthResult {
  const hostHeader = headerValue(headers, "x-aos-host-id");
  const filePath = (env.AOS_RUNNER_HOST_TOKENS_FILE ?? "").trim();
  const rawHostTokens = (env.AOS_RUNNER_HOST_TOKENS ?? "").trim();
  if (filePath !== "" || rawHostTokens !== "") {
    const entries = runnerHostTokenEntries(env);
    if (entries === null) {
      return {
        ok: false,
        status: 503,
        code: "runner-host-tokens-invalid",
        error:
          "AOS_RUNNER_HOST_TOKENS/AOS_RUNNER_HOST_TOKENS_FILE 必须是 [{hostId,token}]（token ≥16）"
      };
    }
    const provided = bearerToken(headers);
    if (provided === "") {
      return { ok: false, status: 401, code: "unauthorized", error: "缺少 runner token" };
    }
    const matched = entries.find((entry) => tokenMatches(provided, entry.token));
    if (matched === undefined) {
      return { ok: false, status: 401, code: "unauthorized", error: "无效的 runner token" };
    }
    if (hostHeader === "") {
      // 每主机 token 本身已绑定 host；Artemis/OpenAI 客户端只带 Authorization，
      // 不能强制要求 X-AOS-Host-Id，否则 LLM 代理请求会被 403。
      return { ok: true, hostId: matched.hostId, source: "host-token" };
    }
    if (hostHeader !== matched.hostId) {
      return {
        ok: false,
        status: 403,
        code: "host-mismatch",
        error: `令牌属于主机 ${matched.hostId}，请求头为 ${hostHeader}`
      };
    }
    return { ok: true, hostId: matched.hostId, source: "host-token" };
  }

  const expected = runnerJobTokenFrom(env);
  if (expected === "") {
    return {
      ok: false,
      status: 503,
      code: "runner-token-unset",
      error: "中心未配置 MOBILE_TESTING_RUNNER_JOB_TOKEN（或 AOS_RUNNER_HOST_TOKENS）"
    };
  }
  if (expected.length < 16) {
    return {
      ok: false,
      status: 503,
      code: "runner-token-too-short",
      error: "MOBILE_TESTING_RUNNER_JOB_TOKEN 至少需要 16 个字符"
    };
  }
  if (!tokenMatches(bearerToken(headers), expected)) {
    return { ok: false, status: 401, code: "unauthorized", error: "缺少或无效的 runner token" };
  }
  if (hostHeader === "") {
    if (options.allowHostless === true) {
      return { ok: true, hostId: "", source: "global-token" };
    }
    return {
      ok: false,
      status: 403,
      code: "host-required",
      error: "控制面请求必须带 X-AOS-Host-Id"
    };
  }
  return { ok: true, hostId: hostHeader, source: "global-token" };
}
