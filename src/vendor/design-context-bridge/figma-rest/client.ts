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

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { data: unknown; expiresAt: number }>();

async function figmaFetch(path: string, attempt = 0): Promise<unknown> {
  const cached = cache.get(path);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  const res = await fetch(`${FIGMA_API}${path}`, {
    headers: { 'X-Figma-Token': getToken() },
  });
  if (res.status === 429 && attempt < 3) {
    const retryAfter = res.headers.get('Retry-After');
    const wait = retryAfter ? parseFloat(retryAfter) * 1000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
    return figmaFetch(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Figma API ${res.status}: ${body}`);
  }
  const data = await res.json();
  cache.set(path, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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
