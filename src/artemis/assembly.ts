import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import type { AosConfig, ArtemisConfig, LlmProfile } from "../config/types.js";
import { ARTEMIS_KEY_ENV, GOOGLE_KEY_ENV_CANDIDATES } from "../config/types.js";
import { apiKeyEnvFor, type ValueResolver } from "../config/validate.js";
import { normalizeAdbSocket } from "../device/device-hosts.js";

export interface ResolvedPython {
  python: string | null;
  hint: string | null;
}

export function resolveArtemisPython(config: ArtemisConfig): ResolvedPython {
  const explicit = config.python?.trim();
  if (explicit) {
    const resolved = path.resolve(config.repo, explicit);
    if (fs.existsSync(resolved)) return { python: resolved, hint: null };
    return { python: null, hint: `artemis.python 指向的路径不存在: ${resolved}` };
  }

  const candidates =
    process.platform === "win32"
      ? [path.join(config.repo, ".venv", "Scripts", "python.exe")]
      : [
          path.join(config.repo, ".venv", "bin", "python"),
          path.join(config.repo, ".venv", "bin", "python3")
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { python: candidate, hint: null };
  }
  return {
    python: null,
    hint: `未找到 artemis 虚拟环境（${candidates[0]}）。\nRun: cd ${config.repo} && uv sync`
  };
}

export interface ProfileKey {
  envName: string;
  value: string;
  source: "env" | "dotenv";
}

export function resolveProfileKey(profile: LlmProfile, resolver: ValueResolver): ProfileKey | null {
  const primary = apiKeyEnvFor(profile);
  const candidates =
    profile.provider === "google"
      ? Array.from(new Set([primary, ...GOOGLE_KEY_ENV_CANDIDATES]))
      : profile.provider === "custom"
        ? Array.from(new Set([primary, "DEEPSEEK_API_KEY"]))
        : [primary];
  for (const name of candidates) {
    const hit = resolver.getValue(name);
    if (hit.value !== null && hit.source !== null) {
      return { envName: name, value: hit.value, source: hit.source };
    }
  }
  return null;
}

export interface ChildEnvResult {
  env: Record<string, string>;
  fingerprint: string;
  keyEnvName: string | null;
}

export interface BuildChildEnvArgs {
  config: AosConfig;
  rootDir: string;
  profile: LlmProfile;
  resolver: ValueResolver;
  baseEnv?: NodeJS.ProcessEnv;
}

export function configDirAbs(config: AosConfig, rootDir: string): string {
  return path.resolve(rootDir, config.artemis.configDir ?? ".artemis");
}

/** Per-project artemis traces directory: `<configDir>/traces` by default so
 * task artifacts (step screenshots, notes, stdout/stderr, data_engine.db) live
 * inside the onboarded project. An explicit ARTEMIS_TRACES_DIR wins; relative
 * overrides resolve against the project root so the child process and the
 * crash scanner always agree on one absolute path. */
export function projectTracesDir(config: AosConfig, rootDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.ARTEMIS_TRACES_DIR?.trim();
  if (override) return path.resolve(rootDir, override);
  return path.join(configDirAbs(config, rootDir), "traces");
}

/** Project mirror of upstream live screenshots (`mobile_get_device_state` still
 * writes its own copy under the artemis repo root). */
export function liveScreenshotsDir(config: AosConfig, rootDir: string): string {
  return path.join(configDirAbs(config, rootDir), "traces", "live_screenshots");
}

function resolveBaseUrl(profile: LlmProfile, resolver: ValueResolver): string | null {
  if (profile.baseUrl && profile.baseUrl.trim() !== "") return profile.baseUrl.trim();
  if (profile.baseUrlEnv) {
    const hit = resolver.getValue(profile.baseUrlEnv);
    if (hit.value) return hit.value;
  }
  if (profile.provider === "openai" || profile.provider === "custom") {
    const conventional = resolver.getValue("OPENAI_BASE_URL");
    if (conventional.value) return conventional.value;
  }
  return null;
}

export function buildChildEnv(args: BuildChildEnvArgs): ChildEnvResult {
  const { config, rootDir, profile, resolver } = args;
  const baseEnv = args.baseEnv ?? process.env;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  env.PYTHONUNBUFFERED = "1";
  env.PYTHONUTF8 = "1";
  env.ARTEMIS_STANDALONE = "1";
  const configDir = configDirAbs(config, rootDir);
  env.ARTEMIS_CONFIG_DIR = configDir;
  env.ARTEMIS_TRACES_DIR = projectTracesDir(config, rootDir, baseEnv);
  if (!env.PYTHONPATH) env.PYTHONPATH = config.artemis.repo;

  const key = resolveProfileKey(profile, resolver);
  if (key) env[ARTEMIS_KEY_ENV[profile.provider]] = key.value;

  const baseUrl = resolveBaseUrl(profile, resolver);
  if ((profile.provider === "openai" || profile.provider === "custom") && baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
  }

  if (config.artemis.deviceSerial) env.ADB_DEVICE_SERIAL = config.artemis.deviceSerial;

  // ADR-0011 远程 Android 设备宿主：进程 env / 项目 .env / config.deviceHosts
  // （优先级同上）→ ADB_SERVER_SOCKET；未声明时保持设备侧 adb（USB/无线调试）。
  if (!env.ADB_SERVER_SOCKET) {
    const androidHost =
      resolver.getValue("ADB_SERVER_SOCKET").value ?? config.deviceHosts?.android?.adbHost ?? null;
    const socket = normalizeAdbSocket(androidHost);
    if (socket) env.ADB_SERVER_SOCKET = socket;
  }

  // Defensive: never let the child attach to a global artemis daemon.
  delete env.ARTEMIS_DAEMON_PORT;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        provider: profile.provider,
        keyEnvName: key?.envName ?? null,
        keyValueHash: key ? createHash("sha256").update(key.value).digest("hex") : null,
        baseUrl: baseUrl ?? null,
        configDir,
        tracesDir: env.ARTEMIS_TRACES_DIR,
        deviceSerial: config.artemis.deviceSerial ?? null
      })
    )
    .digest("hex")
    .slice(0, 16);

  return { env, fingerprint, keyEnvName: key?.envName ?? null };
}

export interface ChildSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fingerprint: string;
}

export function buildChildSpec(args: BuildChildEnvArgs): ChildSpec {
  const { config } = args;
  const { python, hint } = resolveArtemisPython(config.artemis);
  if (!python) throw new Error(hint ?? `无法解析 artemis Python 解释器（repo: ${config.artemis.repo}）`);
  const { env, fingerprint } = buildChildEnv(args);
  return {
    command: python,
    args: ["-m", "mcp_server"],
    cwd: config.artemis.repo,
    env,
    fingerprint
  };
}

// ---------------------------------------------------------------------------
// Entry-based assembly (v0.3: unified OpenAI-compatible providers)
// ---------------------------------------------------------------------------

export interface EntryLike {
  provider: import("../config/types.js").ProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  fallback?: { provider: import("../config/types.js").ProviderId; model: string } | null;
  nodeOverrides?: Record<string, unknown> | null;
}

/** Auto-repoint artemis' Google-pinned nodes to the entry provider (v0.3 H2 evolution). */
export function autoPinnedNodes(entry: EntryLike): Record<string, unknown> | null {
  if (entry.provider === "google") return null;
  const pinned = { provider: entry.provider, model: entry.model };
  return {
    object_detector: { ...pinned, fallback: pinned },
    hopper: { ...pinned, fallback: pinned },
    explorer: { ...pinned, fallback: pinned }
  };
}

function entryNodes(entry: EntryLike): Record<string, unknown> {
  const explicit = entry.nodeOverrides;
  if (explicit && Object.keys(explicit).length > 0) return explicit;
  return autoPinnedNodes(entry) ?? {};
}

/** Render the project-level artemis config (`<project>/.artemis/artemis.jsonc`,
 * unified `default` + `nodes` format), injected via ARTEMIS_ARTEMIS_JSONC.
 *
 * The artemis base config is merged in first so its agent/memory/video sections
 * are preserved; only the LLM `default` (provider/model/fallback) and the
 * pinned nodes are project-scoped.
 *
 * Note: artemis' `llm-config.override.jsonc` loader deep-merges onto the
 * already-expanded config and silently ignores `default`/`nodes` keys, which is
 * why the unified file is used instead. */
export function renderProjectArtemisConfig(args: {
  baseConfigText: string | null;
  entry: EntryLike;
}): string {
  let base: Record<string, unknown> = {};
  if (args.baseConfigText) {
    try {
      const parsed = parseJsonc(args.baseConfigText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }

  const defaultBlock: Record<string, unknown> = {
    ...((base.default as Record<string, unknown>) ?? {})
  };
  defaultBlock.provider = args.entry.provider;
  defaultBlock.model = args.entry.model;
  defaultBlock.fallback =
    args.entry.fallback ?? { provider: args.entry.provider, model: args.entry.model };

  const nodes: Record<string, unknown> = {
    ...((base.nodes as Record<string, unknown>) ?? {})
  };
  for (const [key, value] of Object.entries(entryNodes(args.entry))) {
    nodes[key] = value;
  }

  const output: Record<string, unknown> = { ...base, default: defaultBlock, nodes };

  if (args.entry.provider !== "google") {
    // Background helpers are hard-bound to Google lightweight models. The Flash
    // step summarizer is constructed eagerly (FlashRunner.__init__), so it must
    // be disabled for custom-only projects; the other Google-bound helpers
    // (memory chunk capsules, Pro lightweight judges) are lazy/degraded.
    const agent = { ...((output.agent as Record<string, unknown>) ?? {}) };
    const flash = { ...((agent.flash as Record<string, unknown>) ?? {}) };
    const stepSummarizer = { ...((flash.step_summarizer as Record<string, unknown>) ?? {}) };
    stepSummarizer.enabled = false;
    flash.step_summarizer = stepSummarizer;
    agent.flash = flash;
    const memory = { ...((agent.memory as Record<string, unknown>) ?? {}) };
    const chunking = { ...((memory.chunking as Record<string, unknown>) ?? {}) };
    chunking.model = args.entry.model;
    // Artemis 的 StepCapsuleLens 内部硬编码 get_google_llm；非 Google provider
    // 下拉高触发阈值，等价于关闭 chunk 压缩，避免 runner 无 Google key 时失败。
    chunking.max_steps = 100_000;
    chunking.target_source_tokens = 100_000_000;
    memory.chunking = chunking;
    agent.memory = memory;
    const videoAnalyzer = {
      ...((agent.video_analyzer as Record<string, unknown>) ?? {}),
      enabled: false
    };
    agent.video_analyzer = videoAnalyzer;
    const pro = { ...((agent.pro as Record<string, unknown>) ?? {}) };
    const proVideo = {
      ...((pro.video_analyzer as Record<string, unknown>) ?? {}),
      enabled: false
    };
    pro.video_analyzer = proVideo;
    agent.pro = pro;
    output.agent = agent;
  }

  return JSON.stringify(output, null, 2) + "\n";
}

export interface EntryChildEnvArgs {
  config: AosConfig;
  rootDir: string;
  entry: EntryLike;
  baseEnv?: NodeJS.ProcessEnv;
  /** Project `.env` getter (ADR-0011: config < dotenv < process env). */
  dotenv?: () => Record<string, string>;
}

export function buildChildEnvForEntry(args: EntryChildEnvArgs): ChildEnvResult {
  const { config, rootDir, entry } = args;
  const baseEnv = args.baseEnv ?? process.env;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  env.PYTHONUNBUFFERED = "1";
  env.PYTHONUTF8 = "1";
  env.ARTEMIS_STANDALONE = "1";
  const configDir = configDirAbs(config, rootDir);
  env.ARTEMIS_CONFIG_DIR = configDir;
  env.ARTEMIS_ARTEMIS_JSONC = path.join(configDir, "artemis.jsonc");
  env.ARTEMIS_TRACES_DIR = projectTracesDir(config, rootDir, baseEnv);
  if (!env.PYTHONPATH) env.PYTHONPATH = config.artemis.repo;

  // PATCH (aos-mcp): web LLM security hooks live inside the artemis repo;
  // the secret file is project-scoped and written by the center LLM worker.
  if (env.AOS_LLM_HOOKS === "1") {
    env.AOS_LLM_SECRET_FILE =
      env.AOS_LLM_SECRET_FILE ||
      path.join(rootDir, ".artemis", "web", "llm-secrets.json");
    env.AOS_LLM_HOOKS_STRICT = env.AOS_LLM_HOOKS_STRICT ?? "1";
  }

  const keyEnvName = entry.provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  if (entry.apiKey) env[keyEnvName] = entry.apiKey;
  if (entry.provider !== "google" && entry.baseUrl) env.OPENAI_BASE_URL = entry.baseUrl;
  env.AOS_LLM_PROVIDER = entry.provider;
  env.AOS_LLM_MODEL = entry.model;
  if (entry.provider !== "google") {
    // 非 Google provider 时，Artemis 上游仍有少量 get_google_llm/genai 直连路径。
    // 统一重定向到当前 LLM，并压掉 Google key，避免任何 Google 调用。
    env.AOS_LLM_REDIRECT_GOOGLE = "1";
    env.GOOGLE_API_KEY = "";
    env.GEMINI_API_KEY = "";
  } else {
    delete env.AOS_LLM_REDIRECT_GOOGLE;
  }

  // 公司代理（Zscaler 等）会把发往中心 LAN 的 Python 请求也代理掉。
  // runner 只访问中心/本机 adb：强制绕过所有代理，避免后台子进程继承系统代理后
  // 第二个 LLM 请求被代理吞掉；中心模式仍按 localhost + 中心 host 增量合并。
  const centerUrl =
    args.dotenv?.().MOBILE_TESTING_RUNNER_CONTROL_URL ??
    baseEnv.MOBILE_TESTING_RUNNER_CONTROL_URL ??
    "";
  if (centerUrl.trim() !== "") {
    try {
      const centerHost = new URL(centerUrl).hostname;
      if (centerHost !== "") {
        env.NO_PROXY = "*";
        env.no_proxy = "*";
        for (const name of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy"
        ]) {
          env[name] = "";
        }
        // runner 上 LLM 只走中心代理；禁用 SDK 自动重试，避免把真实异常
        // （401/404/连接错误）吞成重复的 Retrying request 日志。
        if (!env.OPENAI_MAX_RETRIES) env.OPENAI_MAX_RETRIES = "0";
        if (!env.OPENAI_LOG) env.OPENAI_LOG = "info";
        if (!env.HTTPX_LOG_LEVEL) env.HTTPX_LOG_LEVEL = "info";
      }
    } catch {
      /* 非 URL 的中心地址不阻断子进程 */
    }
  }

  if (config.artemis.deviceSerial) env.ADB_DEVICE_SERIAL = config.artemis.deviceSerial;

  // ADR-0011 远程 Android 设备宿主：进程 env / 项目 .env / config.deviceHosts → ADB_SERVER_SOCKET。
  if (!env.ADB_SERVER_SOCKET) {
    const fromDotenv = args.dotenv?.()["ADB_SERVER_SOCKET"]?.trim() ?? "";
    const androidHost =
      fromDotenv !== "" ? fromDotenv : config.deviceHosts?.android?.adbHost ?? null;
    const socket = normalizeAdbSocket(androidHost);
    if (socket) env.ADB_SERVER_SOCKET = socket;
  }

  delete env.ARTEMIS_DAEMON_PORT;

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        provider: entry.provider,
        keyValueHash: entry.apiKey
          ? createHash("sha256").update(entry.apiKey).digest("hex")
          : null,
        baseUrl: entry.baseUrl ?? null,
        configDir,
        tracesDir: env.ARTEMIS_TRACES_DIR,
        deviceSerial: config.artemis.deviceSerial ?? null,
        llmHooks: env.AOS_LLM_HOOKS ?? null,
        llmSecretFile: env.AOS_LLM_SECRET_FILE ?? null
      })
    )
    .digest("hex")
    .slice(0, 16);

  return { env, fingerprint, keyEnvName: entry.apiKey ? keyEnvName : null };
}

export function buildChildSpecForEntry(args: EntryChildEnvArgs): ChildSpec {
  const { config } = args;
  const { python, hint } = resolveArtemisPython(config.artemis);
  if (!python) throw new Error(hint ?? `无法解析 artemis Python 解释器（repo: ${config.artemis.repo}）`);
  const { env, fingerprint } = buildChildEnvForEntry(args);
  return {
    command: python,
    args: ["-m", "mcp_server"],
    cwd: config.artemis.repo,
    env,
    fingerprint
  };
}

/** Bare spec for setup_required projects: no LLM key/baseUrl, so read-only
 * tools (mobile_diagnose / device state) still work; task execution stays
 * gated at the server layer (mobile_run_task). */
export function buildBareChildSpec(args: {
  config: AosConfig;
  rootDir: string;
  baseEnv?: NodeJS.ProcessEnv;
  dotenv?: () => Record<string, string>;
}): ChildSpec {
  return buildChildSpecForEntry({
    ...args,
    entry: { provider: "custom", model: "", baseUrl: null, apiKey: null }
  });
}
