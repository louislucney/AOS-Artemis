import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import type { AosConfig, ArtemisConfig, LlmProfile } from "../config/types.js";
import { ARTEMIS_KEY_ENV, GOOGLE_KEY_ENV_CANDIDATES } from "../config/types.js";
import { apiKeyEnvFor, type ValueResolver } from "../config/validate.js";

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
  if (!env.PYTHONPATH) env.PYTHONPATH = config.artemis.repo;

  const key = resolveProfileKey(profile, resolver);
  if (key) env[ARTEMIS_KEY_ENV[profile.provider]] = key.value;

  const baseUrl = resolveBaseUrl(profile, resolver);
  if ((profile.provider === "openai" || profile.provider === "custom") && baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
  }

  if (config.artemis.deviceSerial) env.ADB_DEVICE_SERIAL = config.artemis.deviceSerial;

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
  return {
    object_detector: { provider: entry.provider, model: entry.model },
    hopper: { provider: entry.provider, model: entry.model }
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

  return JSON.stringify({ ...base, default: defaultBlock, nodes }, null, 2) + "\n";
}

export interface EntryChildEnvArgs {
  config: AosConfig;
  rootDir: string;
  entry: EntryLike;
  baseEnv?: NodeJS.ProcessEnv;
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
  if (!env.PYTHONPATH) env.PYTHONPATH = config.artemis.repo;

  const keyEnvName = entry.provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  if (entry.apiKey) env[keyEnvName] = entry.apiKey;
  if (entry.provider !== "google" && entry.baseUrl) env.OPENAI_BASE_URL = entry.baseUrl;

  if (config.artemis.deviceSerial) env.ADB_DEVICE_SERIAL = config.artemis.deviceSerial;
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
        deviceSerial: config.artemis.deviceSerial ?? null
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
}): ChildSpec {
  return buildChildSpecForEntry({
    ...args,
    entry: { provider: "custom", model: "", baseUrl: null, apiKey: null }
  });
}
