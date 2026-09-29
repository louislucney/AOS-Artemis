// PATCH (aos-mcp): rate-limit hardening — bounded Retry-After, per-token cooldown
// memory with fail-fast, tier-aware error, configurable response cache TTL.
import { createHash } from 'node:crypto';

const FIGMA_API = 'https://api.figma.com/v1';

function getToken(): string {
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      'FIGMA_ACCESS_TOKEN is not set. Add it to the project .env (FIGMA_ACCESS_TOKEN=figd_...), ' +
        'or call the aos_configure tool with figmaToken to store it for this project.'
    );
  }
  return token;
}

// PATCH (aos-mcp): cache TTL is configurable (AOS_FIGMA_CACHE_TTL_MS, 0 disables);
// default raised 30s -> 10min so one pipeline run reuses a single file fetch.
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

function cacheTtlMs(): number {
  const raw = process.env.AOS_FIGMA_CACHE_TTL_MS;
  if (raw === undefined) return DEFAULT_CACHE_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CACHE_TTL_MS;
}

const cache = new Map<string, { data: unknown; expiresAt: number }>();

// PATCH (aos-mcp): typed rate-limit error with tier + retry-after, thrown fast on
// long cooldowns instead of sleeping (Figma low-tier lockouts can be days long).
export class FigmaRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly tier: string;

  constructor(retryAfterSeconds: number, tier: string) {
    super(
      `Figma API rate limit exceeded (tier=${tier}, retry-after=${retryAfterSeconds}s ≈ ${(retryAfterSeconds / 3600).toFixed(1)}h)。` +
        '该 token/席位在此文件的 API 配额已用尽：等待冷却结束，或改用更高配额的席位/token（访客席位为 low 档）。'
    );
    this.name = 'FigmaRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.tier = tier;
  }
}

// PATCH (aos-mcp): cooldown memory per token fingerprint; while active, calls fail
// fast without touching the API (avoids escalating penalties).
const cooldowns = new Map<string, { until: number; tier: string; retryAfterSeconds: number }>();

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function retryMaxWaitMs(): number {
  const value = Number(process.env.AOS_FIGMA_RETRY_MAX_WAIT_MS ?? 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

function parseRetryAfter(res: Response): number | null {
  const header = res.headers.get('Retry-After');
  if (header === null) return null;
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function figmaFetch(path: string, attempt = 0): Promise<unknown> {
  const ttl = cacheTtlMs();
  if (ttl > 0) {
    const cached = cache.get(path);
    if (cached && Date.now() < cached.expiresAt) return cached.data;
  }
  const token = getToken();
  const fingerprint = tokenFingerprint(token);
  const cooldown = cooldowns.get(fingerprint);
  if (cooldown && Date.now() < cooldown.until) {
    const remaining = Math.ceil((cooldown.until - Date.now()) / 1000);
    throw new FigmaRateLimitError(remaining, cooldown.tier);
  }
  const res = await fetch(`${FIGMA_API}${path}`, {
    headers: { 'X-Figma-Token': token },
  });
  if (res.status === 429) {
    const tier = res.headers.get('x-figma-rate-limit-type') ?? 'unknown';
    const seconds = parseRetryAfter(res) ?? 60;
    if (seconds * 1000 <= retryMaxWaitMs() && attempt < 1) {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return figmaFetch(path, attempt + 1);
    }
    cooldowns.set(fingerprint, { until: Date.now() + seconds * 1000, tier, retryAfterSeconds: seconds });
    throw new FigmaRateLimitError(seconds, tier);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (ttl > 0) {
    for (const [key, entry] of cache) {
      if (Date.now() >= entry.expiresAt) cache.delete(key);
    }
    cache.set(path, { data, expiresAt: Date.now() + ttl });
  }
  return data;
}

export function parseFigmaUrl(url: string): { fileKey: string; nodeId?: string } {
  const keyMatch = url.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
  if (!keyMatch) throw new Error(`Cannot parse Figma file key from URL: ${url}`);
  const fileKey = keyMatch[1];
  const nodeMatch = url.match(/node-id=([^&#]+)/);
  const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]).replace(/-/g, ':') : undefined;
  return { fileKey, nodeId };
}

/**
 * Fetch a whole file. `depth` limits how many levels of the tree are returned;
 * omit it to get the full tree (needed for scanning and analysis).
 */
export async function fetchFile(fileKey: string, depth?: number): Promise<unknown> {
  const query = typeof depth === 'number' ? `?depth=${depth}` : '';
  return figmaFetch(`/files/${fileKey}${query}`);
}

export async function fetchNodes(fileKey: string, nodeIds: string[]): Promise<unknown> {
  const ids = nodeIds.map((id) => encodeURIComponent(id)).join(',');
  return figmaFetch(`/files/${fileKey}/nodes?ids=${ids}`);
}

/** Local variables (design tokens). Enterprise-plan only — callers must handle 403. */
export async function fetchLocalVariables(fileKey: string): Promise<unknown> {
  return figmaFetch(`/files/${fileKey}/variables/local`);
}

/**
 * Render URLs for one or more nodes in a given format.
 * Returns Figma's { images: { [nodeId]: url } } payload.
 */
export async function fetchImages(
  fileKey: string,
  nodeIds: string[],
  format: 'svg' | 'png' | 'jpg' = 'svg',
  scale = 1,
): Promise<{ images: Record<string, string | null>; err?: string }> {
  const ids = nodeIds.map((id) => encodeURIComponent(id)).join(',');
  const scaleQuery = format === 'svg' ? '' : `&scale=${scale}`;
  return figmaFetch(`/images/${fileKey}?ids=${ids}&format=${format}${scaleQuery}`) as Promise<{
    images: Record<string, string | null>;
    err?: string;
  }>;
}

/** Download the raw text body of a render URL (used to inline SVG source). */
export async function downloadText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Asset download failed (${res.status}) for ${url}`);
  return res.text();
}
