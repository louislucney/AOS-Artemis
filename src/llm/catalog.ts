import { createHash } from "node:crypto";

import type { ProjectStore } from "../db/types.js";
import { providerPresetForBaseUrl, type ProviderPreset } from "./providers.js";

export const MODEL_REFRESH_HOURS_DEFAULT = 12;
export const MODEL_FETCH_TIMEOUT_MS = 10_000;
export const MODEL_SAMPLE_LIMIT = 50;

export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export interface CatalogEntryLike {
  name: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  provider: string;
}

export interface ModelCacheSnapshot {
  cacheKey: string;
  baseUrl: string;
  models: string[];
  fetchedAt: string | null;
  lastError: string | null;
}

export type ReplacementReason = "alias" | "equivalent";

export interface Replacement {
  model: string;
  reason: ReplacementReason;
}

export interface ModelReport {
  entry: string;
  baseUrl: string;
  model: string;
  known: boolean;
  fetchedAt: string | null;
  stale: boolean;
  count: number;
  available: boolean | null;
  deprecated: boolean;
  suggestedModel: string | null;
  replacementReason: ReplacementReason | null;
  error: string | null;
  sampleModels: string[];
}

export interface RefreshReport extends ModelReport {
  refreshed: boolean;
  repaired: { from: string; to: string; reason: ReplacementReason; sources: string[] } | null;
}

export function modelCacheKey(baseUrl: string, apiKey: string): string {
  return createHash("sha256")
    .update(`${baseUrl.trim().replace(/\/+$/, "")}\n${apiKey}`)
    .digest("hex")
    .slice(0, 24);
}

/** AOS_MODEL_REFRESH_HOURS: >0 refresh interval (0.05–720h), 0 disables the timer. */
export function resolveModelRefreshHours(env: NodeJS.ProcessEnv): number {
  const rawText = (env.AOS_MODEL_REFRESH_HOURS ?? "").trim();
  if (rawText === "") return MODEL_REFRESH_HOURS_DEFAULT;
  const raw = Number(rawText);
  if (!Number.isFinite(raw)) return MODEL_REFRESH_HOURS_DEFAULT;
  if (raw === 0) return 0;
  return Math.min(Math.max(raw, 0.05), 720);
}

export function autoRepairEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.AOS_LLM_AUTO_REPAIR ?? "").trim() !== "0";
}

export function isModelStale(
  fetchedAt: string | null,
  ttlHours: number,
  nowMs = Date.now()
): boolean {
  if (!fetchedAt) return true;
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return true;
  if (ttlHours <= 0) return false;
  return nowMs - fetchedMs > ttlHours * 3_600_000;
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

function parseModelIds(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item === "string" && item.trim() !== "") ids.push(item.trim());
    else if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.trim() !== "") ids.push(id.trim());
    }
  }
  return Array.from(new Set(ids));
}

export interface FetchModelsResult {
  ok: boolean;
  models: string[];
  error: string | null;
  status: number | null;
}

export async function fetchModelIds(args: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<FetchModelsResult> {
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = args.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS;
  try {
    const response = await fetchImpl(modelsUrl(args.baseUrl), {
      method: "GET",
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? "鉴权失败：检查 api_key 是否属于该端点"
          : response.status === 404
            ? "端点未提供 /models（仅支持 OpenAI 风格模型列表的厂商）"
            : "厂商接口暂时不可用";
      return { ok: false, models: [], error: `HTTP ${response.status}（${hint}）`, status: response.status };
    }
    const payload = await response.json();
    const ids = parseModelIds(payload);
    if (ids === null) {
      return { ok: false, models: [], error: "响应不是 OpenAI 风格的模型列表（缺 data[]）", status: response.status };
    }
    return { ok: true, models: ids, error: null, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /abort|timeout/i.test(message) ? "请求超时" : message;
    return { ok: false, models: [], error: hint, status: null };
  }
}

const VERSION_TOKEN = /^v?\d+(?:[.-]\d+)*$/i;

/** Capability markers: alias substitution is skipped for these so a
 * reasoner/pro/vision/coder model is never silently downgraded to a plain alias. */
const CAPABILITY_TOKENS = new Set([
  "reasoner",
  "thinking",
  "think",
  "r1",
  "o1",
  "o3",
  "pro",
  "max",
  "ultra",
  "vision",
  "vl",
  "coder",
  "code"
]);

function coreTokens(modelId: string): string[] {
  return modelId
    .toLowerCase()
    .split(/[/\-_.:]+/)
    .filter((token) => token !== "" && !VERSION_TOKEN.test(token));
}

function sameCore(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** Choose a confident replacement for a retired model id.
 * 1) vendor alias present in the fresh list (DeepSeek-style stable names),
 *    unless the retired id carries an explicit capability marker;
 * 2) exact same token core (version/date tokens ignored), shortest name wins. */
export function pickReplacement(
  oldModel: string,
  models: readonly string[],
  preset: ProviderPreset | null
): Replacement | null {
  if (oldModel.trim() === "" || models.length === 0) return null;
  const oldCore = coreTokens(oldModel);
  const capability = oldCore.some((token) => CAPABILITY_TOKENS.has(token));
  if (preset && !capability) {
    for (const alias of preset.aliasModels) {
      const hit = models.find((model) => model.toLowerCase() === alias.toLowerCase());
      if (hit) return { model: hit, reason: "alias" };
    }
  }
  if (oldCore.length === 0) return null;
  const candidates = models.filter((model) => sameCore(coreTokens(model), oldCore));
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (a, b) => a.length - b.length || a.localeCompare(b)
  );
  return { model: sorted[0]!, reason: "equivalent" };
}

export interface ModelCatalogOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Reads/writes the per-project model cache and refreshes via `GET {base_url}/models`. */
export class ModelCatalog {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly now: () => number;

  constructor(options: ModelCatalogOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
  }

  ttlHours(): number {
    return resolveModelRefreshHours(this.env);
  }

  autoRepair(): boolean {
    return autoRepairEnabled(this.env);
  }

  cacheKey(baseUrl: string, apiKey: string): string {
    return modelCacheKey(baseUrl, apiKey);
  }

  /** One-shot fetch (no cache write) — used by aos_configure vendor presets. */
  async fetchIds(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
    return fetchModelIds({ baseUrl, apiKey, fetchImpl: this.fetchImpl });
  }

  appliesTo(entry: CatalogEntryLike): boolean {
    return (
      entry.provider !== "google" &&
      entry.provider !== "anthropic" &&
      entry.model.trim() !== "" &&
      entry.baseUrl !== null &&
      entry.baseUrl.trim() !== "" &&
      entry.apiKey !== null &&
      entry.apiKey !== ""
    );
  }

  async load(
    store: ProjectStore,
    rootPath: string,
    entry: CatalogEntryLike
  ): Promise<ModelCacheSnapshot | null> {
    const record = await store.getModelCache(rootPath, modelCacheKey(entry.baseUrl!, entry.apiKey!));
    if (!record) return null;
    return {
      cacheKey: record.cacheKey,
      baseUrl: record.baseUrl,
      models: record.models,
      fetchedAt: record.fetchedAt,
      lastError: record.lastError
    };
  }

  reportFrom(
    entry: CatalogEntryLike,
    snapshot: ModelCacheSnapshot | null
  ): ModelReport {
    const base: ModelReport = {
      entry: entry.name,
      baseUrl: entry.baseUrl ?? "",
      model: entry.model,
      known: false,
      fetchedAt: null,
      stale: true,
      count: 0,
      available: null,
      deprecated: false,
      suggestedModel: null,
      replacementReason: null,
      error: null,
      sampleModels: []
    };
    if (!snapshot || snapshot.models.length === 0) {
      return { ...base, fetchedAt: snapshot?.fetchedAt ?? null, error: snapshot?.lastError ?? null };
    }
    const stale = isModelStale(snapshot.fetchedAt, this.ttlHours(), this.now());
    const available = snapshot.models.some(
      (model) => model.toLowerCase() === entry.model.trim().toLowerCase()
    );
    const preset = providerPresetForBaseUrl(entry.baseUrl);
    const replacement = available ? null : pickReplacement(entry.model, snapshot.models, preset);
    const deprecated = !stale && !available;
    return {
      ...base,
      known: true,
      fetchedAt: snapshot.fetchedAt,
      stale,
      count: snapshot.models.length,
      available,
      deprecated,
      suggestedModel: deprecated ? (replacement?.model ?? null) : null,
      replacementReason: deprecated ? (replacement?.reason ?? null) : null,
      error: snapshot.lastError,
      sampleModels: snapshot.models.slice(0, MODEL_SAMPLE_LIMIT)
    };
  }

  async report(
    store: ProjectStore,
    rootPath: string,
    entry: CatalogEntryLike
  ): Promise<ModelReport> {
    const snapshot = await this.load(store, rootPath, entry);
    return this.reportFrom(entry, snapshot);
  }

  /** Refresh one entry when due (or forced). Returns the post-refresh report. */
  async refresh(
    store: ProjectStore,
    rootPath: string,
    entry: CatalogEntryLike,
    options: { force?: boolean } = {}
  ): Promise<RefreshReport> {
    const snapshot = await this.load(store, rootPath, entry);
    const ttl = this.ttlHours();
    const due = options.force === true || isModelStale(snapshot?.fetchedAt ?? null, ttl, this.now());
    if (!due) {
      const report = this.reportFrom(entry, snapshot);
      return { ...report, refreshed: false, repaired: null };
    }

    const cacheKey = modelCacheKey(entry.baseUrl!, entry.apiKey!);
    const result = await fetchModelIds({
      baseUrl: entry.baseUrl!,
      apiKey: entry.apiKey!,
      fetchImpl: this.fetchImpl
    });

    let next: ModelCacheSnapshot;
    if (result.ok) {
      const fetchedAt = new Date(this.now()).toISOString();
      await store.putModelCache(rootPath, {
        cacheKey,
        baseUrl: entry.baseUrl!,
        models: result.models,
        fetchedAt,
        lastError: null
      });
      next = { cacheKey, baseUrl: entry.baseUrl!, models: result.models, fetchedAt, lastError: null };
    } else {
      await store.putModelCache(rootPath, {
        cacheKey,
        baseUrl: entry.baseUrl!,
        lastError: result.error
      });
      next = {
        cacheKey,
        baseUrl: entry.baseUrl!,
        models: snapshot?.models ?? [],
        fetchedAt: snapshot?.fetchedAt ?? null,
        lastError: result.error
      };
    }
    const report = this.reportFrom(entry, next.models.length > 0 ? next : null);
    return {
      ...report,
      fetchedAt: next.fetchedAt,
      error: next.lastError,
      refreshed: result.ok,
      repaired: null
    };
  }
}
