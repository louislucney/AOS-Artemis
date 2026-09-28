import type { ValueResolver } from "../config/validate.js";

export const ENV_LLM_MODEL = "AOS_LLM_MODEL";
export const ENV_LLM_BASE_URL = "AOS_LLM_BASE_URL";
export const ENV_LLM_API_KEY = "AOS_LLM_API_KEY";
export const ENV_LLM_NAME = "AOS_LLM_NAME";
export const ENV_FIGMA_TOKEN = "FIGMA_ACCESS_TOKEN";

const LEGACY_BASE_URL = ["OPENAI_BASE_URL"] as const;
const LEGACY_API_KEY = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"] as const;

export interface ScannedLlm {
  /** Entry name (AOS_LLM_NAME or derived from the model). */
  name: string;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  /** Resolved variable names, for display/audit. */
  modelVar: string | null;
  baseUrlVar: string | null;
  apiKeyVar: string | null;
  complete: boolean;
  missing: string[];
}

export interface EnvScanResult {
  llm: ScannedLlm | null;
  figmaToken: string | null;
  figmaTokenVar: string | null;
}

function firstOf(
  resolver: ValueResolver,
  names: readonly string[]
): { value: string | null; name: string | null } {
  for (const name of names) {
    const hit = resolver.getValue(name);
    if (hit.value !== null) return { value: hit.value, name };
  }
  return { value: null, name: null };
}

/** Scan the project .env-derived values: new AOS_LLM_* names first, legacy names as fallback. */
export function scanProjectEnv(resolver: ValueResolver): EnvScanResult {
  const model = firstOf(resolver, [ENV_LLM_MODEL]);
  const baseUrl = firstOf(resolver, [ENV_LLM_BASE_URL, ...LEGACY_BASE_URL]);
  const apiKey = firstOf(resolver, [ENV_LLM_API_KEY, ...LEGACY_API_KEY]);
  const name = firstOf(resolver, [ENV_LLM_NAME]);
  const figma = firstOf(resolver, [ENV_FIGMA_TOKEN]);

  const hasAnyLlm = model.value !== null || baseUrl.value !== null || apiKey.value !== null;
  let llm: ScannedLlm | null = null;
  if (hasAnyLlm) {
    const missing: string[] = [];
    if (model.value === null) missing.push(`${ENV_LLM_MODEL}`);
    if (baseUrl.value === null) missing.push(`${ENV_LLM_BASE_URL}（或 ${LEGACY_BASE_URL.join(" / ")}）`);
    if (apiKey.value === null) missing.push(`${ENV_LLM_API_KEY}（或 ${LEGACY_API_KEY.join(" / ")}）`);
    llm = {
      name: name.value ?? deriveName(model.value, baseUrl.value),
      model: model.value,
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
      modelVar: model.name,
      baseUrlVar: baseUrl.name,
      apiKeyVar: apiKey.name,
      complete: missing.length === 0,
      missing
    };
  }

  return {
    llm,
    figmaToken: figma.value,
    figmaTokenVar: figma.name
  };
}

function deriveName(model: string | null, baseUrl: string | null): string {
  if (model && model.trim() !== "") return model.trim();
  if (baseUrl) {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "default";
    }
  }
  return "default";
}
