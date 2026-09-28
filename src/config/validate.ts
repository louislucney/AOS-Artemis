import type { AosConfig, LlmProfile, ProviderId } from "./types.js";
import {
  DEFAULT_API_KEY_ENV,
  GOOGLE_KEY_ENV_CANDIDATES,
  PINNED_GOOGLE_NODES,
  PROVIDER_IDS
} from "./types.js";

export interface ResolvedValue {
  value: string | null;
  source: "env" | "dotenv" | null;
}

export interface ValueResolver {
  getValue(name: string): ResolvedValue;
  getDotenv(): Record<string, string>;
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function makeResolver(
  dotenvValues: Record<string, string>,
  processEnv: NodeJS.ProcessEnv
): ValueResolver {
  return {
    getValue(name: string): ResolvedValue {
      const fromEnv = processEnv[name];
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return { value: fromEnv.trim(), source: "env" };
      }
      const fromDotenv = dotenvValues[name];
      if (typeof fromDotenv === "string" && fromDotenv.trim() !== "") {
        return { value: fromDotenv.trim(), source: "dotenv" };
      }
      return { value: null, source: null };
    },
    getDotenv(): Record<string, string> {
      return dotenvValues;
    }
  };
}

export function apiKeyEnvFor(profile: LlmProfile): string {
  return profile.apiKeyEnv ?? DEFAULT_API_KEY_ENV[profile.provider as ProviderId] ?? "GEMINI_API_KEY";
}

export function hasGoogleKey(resolver: ValueResolver): boolean {
  return GOOGLE_KEY_ENV_CANDIDATES.some((name) => resolver.getValue(name).value !== null);
}

/** True when a non-Google profile explicitly handles every Google-pinned node
 * (either overridden to another provider, or null-disabled). */
export function pinnedNodesCovered(profile: LlmProfile): boolean {
  const overrides = profile.nodeOverrides ?? {};
  return PINNED_GOOGLE_NODES.every((node) => {
    const value = overrides[node];
    if (value === null) return true;
    if (typeof value === "object" && value !== null) {
      const provider = (value as Record<string, unknown>).provider;
      return typeof provider === "string" && provider !== "google";
    }
    return false;
  });
}

export function pinnedNodesBlockMessage(profileName: string, profile: LlmProfile): string {
  return [
    `档案 "${profileName}" 使用非 Google provider（${profile.provider}）：`,
    `激活时 object_detector/hopper 会被自动重指到该 provider（失去 Gemini ER 亚像素定位精度）。`,
    `如需显式控制（例如保留 Google 节点或禁用某节点），请在 nodeOverrides 中配置：${PINNED_GOOGLE_NODES.join(", ")}。`
  ].join("\n");
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function validateConfig(config: AosConfig, resolver: ValueResolver): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const names = Object.keys(config.llm.profiles);
  if (names.length === 0) {
    errors.push({ level: "error", code: "llm.profiles.empty", message: "llm.profiles 为空：至少配置一个 LLM 档案。" });
  }
  if (config.llm.defaultProfile && !names.includes(config.llm.defaultProfile)) {
    errors.push({
      level: "error",
      code: "llm.defaultProfile.unknown",
      message: `llm.defaultProfile "${config.llm.defaultProfile}" 不在 profiles 中。可选：${names.join(", ") || "(空)"}`
    });
  }

  for (const [name, profile] of Object.entries(config.llm.profiles)) {
    if (!isProviderId(profile?.provider)) {
      errors.push({
        level: "error",
        code: "llm.provider.invalid",
        message: `档案 "${name}" 的 provider 非法（应为 ${PROVIDER_IDS.join(" | ")}）。`
      });
    }
    if (typeof profile?.model !== "string" || profile.model.trim() === "") {
      errors.push({ level: "error", code: "llm.model.empty", message: `档案 "${name}" 缺少 model。` });
    }
    const fallback = profile?.fallback;
    if (fallback) {
      if (!isProviderId(fallback.provider) || typeof fallback.model !== "string" || fallback.model.trim() === "") {
        errors.push({
          level: "error",
          code: "llm.fallback.invalid",
          message: `档案 "${name}" 的 fallback 非法（需要 provider + model）。`
        });
      }
    }
  }

  const activeName =
    config.llm.defaultProfile ?? (names.length > 0 ? names[0]! : undefined);
  const active = activeName ? config.llm.profiles[activeName] : undefined;
  if (activeName && active) {
    const keyEnv = apiKeyEnvFor(active);
    if (!resolver.getValue(keyEnv).value) {
      warnings.push({
        level: "warning",
        code: "llm.key.missing",
        message: `档案 "${activeName}" 需要 ${keyEnv}，当前进程环境变量与项目 .env 中均缺失。`
      });
    }
    if (active.provider !== "google" && !hasGoogleKey(resolver) && !pinnedNodesCovered(active)) {
      warnings.push({
        level: "warning",
        code: "llm.pinnedNodes",
        message: pinnedNodesBlockMessage(activeName, active)
      });
    }
  }

  return { errors, warnings };
}
