import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FigmaDocumentContext } from '../core/types.js';

// PATCH (aos-mcp): namespaced temp files so a stock design-context-bridge
// installation on the same machine never shares state with this service.
const STORE_FILE_PREFIX = 'aos-mcp-figma';
const STORE_PATH = join(tmpdir(), `${STORE_FILE_PREFIX}-selection.json`);
const REQ_PATH = join(tmpdir(), `${STORE_FILE_PREFIX}-requests.json`);
const RES_PATH = join(tmpdir(), `${STORE_FILE_PREFIX}-responses.json`);

export interface PluginRequest {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export const store = {
  setContext(incoming: Partial<FigmaDocumentContext>): void {
    // The plugin sends page/components only on the first update and omits them
    // afterwards. Merge so selection updates don't wipe the full-document data.
    const existing = store.getContext();
    const merged = { ...(existing ?? {}), ...incoming } as FigmaDocumentContext;
    writeFileSync(STORE_PATH, JSON.stringify(merged), 'utf8');
  },
  getContext(): FigmaDocumentContext | null {
    return readJson<FigmaDocumentContext | null>(STORE_PATH, null);
  },

  // ── on-demand request/response queue ──────────────────────────────────────
  addRequest(req: PluginRequest): void {
    const reqs = readJson<PluginRequest[]>(REQ_PATH, []);
    reqs.push(req);
    writeFileSync(REQ_PATH, JSON.stringify(reqs), 'utf8');
  },
  // Plugin pulls pending requests (and clears the queue).
  takeRequests(): PluginRequest[] {
    const reqs = readJson<PluginRequest[]>(REQ_PATH, []);
    if (reqs.length > 0) writeFileSync(REQ_PATH, '[]', 'utf8');
    return reqs;
  },
  setResponse(id: string, result: unknown): void {
    const map = readJson<Record<string, unknown>>(RES_PATH, {});
    map[id] = result;
    writeFileSync(RES_PATH, JSON.stringify(map), 'utf8');
  },
  takeResponse(id: string): unknown {
    const map = readJson<Record<string, unknown>>(RES_PATH, {});
    if (!(id in map)) return undefined;
    const result = map[id];
    delete map[id];
    writeFileSync(RES_PATH, JSON.stringify(map), 'utf8');
    return result;
  },
};

// Helper used by on-demand tools: enqueue a request and wait for the plugin's reply.
export async function requestFromPlugin(
  type: string,
  params: Record<string, unknown>,
  timeoutMs = 12000,
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  store.addRequest({ id, type, params });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = store.takeResponse(id);
    if (res !== undefined) return res;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timeout waiting for the Figma plugin. Make sure it is open and connected (green dot).');
}
