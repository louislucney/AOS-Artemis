import type { AosConfig, LlmProfile, ProviderId } from "../config/types.js";
import { apiKeyEnvFor, type ValueResolver } from "../config/validate.js";
import type { ProjectLlmRecord } from "../db/types.js";
import type { EnvScanResult } from "../projects/scan.js";
import { resolveProfileKey } from "../artemis/assembly.js";

export interface LlmEntry {
  name: string;
  provider: ProviderId;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  /** Source env variable for config/env entries (display/audit only). */
  keyEnvName: string | null;
  fallback: { provider: ProviderId; model: string } | null;
  nodeOverrides: Record<string, unknown> | null;
  source: "store" | "config" | "env";
  isActive: boolean;
}

export function entriesFromConfig(config: AosConfig, resolver: ValueResolver): LlmEntry[] {
  return Object.entries(config.llm.profiles).map(([name, profile]) => {
    const key = resolveProfileKey(profile, resolver);
    const configuredBaseUrl =
      profile.baseUrl ??
      (profile.baseUrlEnv ? resolver.getValue(profile.baseUrlEnv).value : null) ??
      (profile.provider === "openai" || profile.provider === "custom"
        ? resolver.getValue("OPENAI_BASE_URL").value
        : null);
    return {
      name,
      provider: profile.provider,
      model: profile.model,
      baseUrl: configuredBaseUrl,
      apiKey: key?.value ?? null,
      keyEnvName: key?.envName ?? apiKeyEnvFor(profile),
      fallback: profile.fallback ?? null,
      nodeOverrides: profile.nodeOverrides ?? null,
      source: "config" as const,
      isActive: false
    };
  });
}

export function entryFromStore(record: ProjectLlmRecord): LlmEntry {
  return {
    name: record.name,
    provider: (record.provider as ProviderId) ?? "custom",
    model: record.model,
    baseUrl: record.baseUrl,
    apiKey: record.apiKey,
    keyEnvName: null,
    fallback: null,
    nodeOverrides: null,
    source: "store",
    isActive: record.isActive
  };
}

export function entryFromEnvScan(scan: EnvScanResult): LlmEntry | null {
  // Without a model the .env fragment cannot be named or used; setup guidance covers it.
  if (!scan.llm || !scan.llm.model) return null;
  return {
    name: scan.llm.name,
    provider: "custom",
    model: scan.llm.model ?? "",
    baseUrl: scan.llm.baseUrl,
    apiKey: scan.llm.apiKey,
    keyEnvName: scan.llm.apiKeyVar,
    fallback: null,
    nodeOverrides: null,
    source: "env",
    isActive: false
  };
}

/** Merge entry sources by name; earlier groups win (store > config > env). */
export function mergeEntries(...groups: LlmEntry[][]): LlmEntry[] {
  const byName = new Map<string, LlmEntry>();
  for (const group of groups) {
    for (const entry of group) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
  }
  return Array.from(byName.values());
}

export function entryIssues(entry: LlmEntry): string[] {
  const issues: string[] = [];
  if (!entry.model || entry.model.trim() === "") issues.push("缺少 model");
  if (!entry.apiKey) issues.push("缺少 api_key");
  if (entry.provider !== "google" && !entry.baseUrl) issues.push("缺少 base_url");
  return issues;
}

/** store 条目凭据为空（文件台账快照剥离 apiKey）时，按 provider 约定从项目 .env / 进程 env 回填。 */
export function withEnvKeyFallback(entry: LlmEntry, resolver: ValueResolver): LlmEntry {
  if (entry.apiKey || entry.source !== "store") return entry;
  const candidates: string[] = [];
  if (entry.provider !== "custom") {
    candidates.push(apiKeyEnvFor({ provider: entry.provider } as LlmProfile));
  }
  candidates.push("AOS_LLM_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY");
  for (const name of candidates) {
    const hit = resolver.getValue(name);
    if (hit.value) return { ...entry, apiKey: hit.value, keyEnvName: name };
  }
  return entry;
}
