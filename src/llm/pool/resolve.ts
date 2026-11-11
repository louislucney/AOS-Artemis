import type {
  LlmPoolMode,
  LlmPoolTokenRecord,
  ProjectLlmRecord,
  ProjectStore
} from "../../db/types.js";
import { loadProject } from "../../config/loader.js";
import { scanProjectEnv } from "../../projects/scan.js";

export interface PoolCandidate {
  entryName: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  poolTokenId: string | null;
  poolTokenName: string | null;
  poolMode: LlmPoolMode;
  supportsStreamUsage: boolean;
  maxConcurrency: number;
}

export interface CenterLlmResolution {
  entryName: string;
  provider: string;
  model: string;
  mode: "project" | "pinned" | "auto";
  candidates: PoolCandidate[];
  error: "no-token" | "token-disabled" | "model-not-allowed" | null;
}

type ScannedLlm = ReturnType<typeof scanProjectEnv>["llm"];

function scanEnvLlm(env: NodeJS.ProcessEnv, rootPath: string): ScannedLlm {
  try {
    const loaded = loadProject({
      env: { ...env, AOS_PROJECT_DIR: rootPath, AOS_CONFIG: "" }
    });
    return scanProjectEnv(loaded.resolver).llm;
  } catch {
    return null;
  }
}

function selectEntry(entries: ProjectLlmRecord[]): ProjectLlmRecord | null {
  return (
    entries.find((entry) => entry.isActive && entry.apiKey) ??
    entries.find((entry) => entry.isActive) ??
    entries.find((entry) => entry.apiKey) ??
    entries[0] ??
    null
  );
}

export function resolvePoolTokenKey(
  token: Pick<LlmPoolTokenRecord, "apiKey" | "keyEnv">,
  env: NodeJS.ProcessEnv
): string | null {
  const direct = (token.apiKey ?? "").trim();
  if (direct !== "") return token.apiKey;
  const envName = (token.keyEnv ?? "").trim();
  if (envName === "") return null;
  const value = env[envName];
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

function modelAllowed(token: LlmPoolTokenRecord, model: string): boolean {
  return token.modelAllowlist.length === 0 || token.modelAllowlist.includes(model);
}

function tokenCandidate(
  entryName: string,
  token: LlmPoolTokenRecord,
  model: string,
  apiKey: string,
  mode: LlmPoolMode
): PoolCandidate {
  return {
    entryName,
    provider: token.provider,
    model,
    baseUrl: token.baseUrl,
    apiKey,
    poolTokenId: token.id,
    poolTokenName: token.name,
    poolMode: mode,
    supportsStreamUsage: token.supportsStreamUsage,
    maxConcurrency: token.maxConcurrency
  };
}

function projectCandidate(
  entryName: string,
  provider: string,
  model: string,
  baseUrl: string | null,
  apiKey: string | null,
  scanLlm: ScannedLlm
): PoolCandidate {
  return {
    entryName,
    provider,
    model,
    baseUrl: baseUrl ?? scanLlm?.baseUrl ?? "",
    apiKey: apiKey ?? scanLlm?.apiKey ?? "",
    poolTokenId: null,
    poolTokenName: null,
    poolMode: "pinned",
    supportsStreamUsage: false,
    maxConcurrency: 0
  };
}

async function poolResolution(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  entry: ProjectLlmRecord,
  tokenId: string
): Promise<CenterLlmResolution> {
  const mode = entry.poolMode ?? "pinned";
  const model = entry.poolModel ?? entry.model;
  const bound = await store.getLlmPoolToken(tokenId);
  const base = {
    entryName: entry.name,
    provider: bound?.provider ?? entry.provider,
    model,
    mode
  } as const;
  if (bound === null) {
    return { ...base, candidates: [], error: "token-disabled" };
  }
  const key = resolvePoolTokenKey(bound, env);
  if (bound.status !== "active" || key === null) {
    return { ...base, candidates: [], error: "token-disabled" };
  }
  if (!modelAllowed(bound, model)) {
    return { ...base, candidates: [], error: "model-not-allowed" };
  }
  if (mode === "pinned") {
    return {
      ...base,
      candidates: [tokenCandidate(entry.name, bound, model, key, mode)],
      error: null
    };
  }

  const tokens = (await store.listLlmPoolTokens())
    .filter((token) => token.status === "active" && modelAllowed(token, model))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (b.lastValidatedAt ?? "").localeCompare(a.lastValidatedAt ?? "") ||
        a.name.localeCompare(b.name)
    );
  const candidates: PoolCandidate[] = [];
  for (const token of tokens) {
    const tokenKey = resolvePoolTokenKey(token, env);
    if (tokenKey === null) continue;
    candidates.push(tokenCandidate(entry.name, token, model, tokenKey, mode));
  }
  return { ...base, candidates, error: candidates.length === 0 ? "no-token" : null };
}

export async function resolveCenterLlmCandidates(
  store: ProjectStore,
  env: NodeJS.ProcessEnv,
  rootPath: string
): Promise<CenterLlmResolution | null> {
  const scanLlm = scanEnvLlm(env, rootPath);
  const entries = await store.listLlms(rootPath);
  const entry = selectEntry(entries);
  if (entry !== null) {
    if (entry.poolTokenId !== null) {
      return poolResolution(store, env, entry, entry.poolTokenId);
    }
    return {
      entryName: entry.name,
      provider: entry.provider,
      model: entry.model,
      mode: "project",
      candidates: [
        projectCandidate(
          entry.name,
          entry.provider,
          entry.model,
          entry.baseUrl,
          entry.apiKey,
          scanLlm
        )
      ],
      error: null
    };
  }
  if (scanLlm?.complete === true && scanLlm.model) {
    return {
      entryName: scanLlm.name,
      provider: "custom",
      model: scanLlm.model,
      mode: "project",
      candidates: [
        projectCandidate(
          scanLlm.name,
          "custom",
          scanLlm.model,
          scanLlm.baseUrl,
          scanLlm.apiKey,
          scanLlm
        )
      ],
      error: null
    };
  }
  return null;
}
