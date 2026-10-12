import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../util.js";

export const APP_DOWNLOAD_TIMEOUT_MS_DEFAULT = 600_000;

/** `AOS_APP_DOWNLOAD_TIMEOUT_MS`（默认 10min）。 */
export function resolveAppDownloadTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_APP_DOWNLOAD_TIMEOUT_MS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return APP_DOWNLOAD_TIMEOUT_MS_DEFAULT;
  return raw;
}

export interface MaterializedApp {
  ok: true;
  path: string;
  cached: boolean;
}

export interface MaterializeAppFailure {
  ok: false;
  error: string;
}

/** ADR-0011: materialize an `app_path` http(s) URL into the project cache so
 * local installers (adb on this host) can read it. Cache key = URL hash;
 * repeat runs reuse the file. iOS never uses this (the Appium host fetches). */
export async function materializeAppPathUrl(input: {
  appPath: string;
  cacheDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MaterializedApp | MaterializeAppFailure> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? APP_DOWNLOAD_TIMEOUT_MS_DEFAULT;
  let url: URL;
  try {
    url = new URL(input.appPath);
  } catch {
    return { ok: false, error: `app_path 不是合法 URL：${input.appPath}` };
  }
  const hash = createHash("sha256").update(input.appPath).digest("hex").slice(0, 16);
  const ext = path.extname(url.pathname).toLowerCase();
  const suffix = /^\.(apk|aab|apks|zip)$/.test(ext) ? ext : ".apk";
  const target = path.join(input.cacheDir, `${hash}${suffix}`);
  if (fs.existsSync(target)) return { ok: true, path: target, cached: true };
  fs.mkdirSync(input.cacheDir, { recursive: true });
  const tmp = `${target}.part-${process.pid}`;
  try {
    const response = await fetchImpl(input.appPath, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}（${input.appPath}）` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) return { ok: false, error: `产物为空（${input.appPath}）` };
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
    return { ok: true, path: target, cached: false };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}
