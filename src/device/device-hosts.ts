import net from "node:net";

import type { AosConfig, DeviceHostsConfig } from "../config/types.js";
import type { ValueResolver } from "../config/validate.js";

/** ADR-0011: `deviceHosts` 高级层 → 既有 env 键的映射与宿主探针。 */

const IOS_HOST_ENV_KEYS = {
  appiumUrl: "AOS_APPIUM_URL",
  wdaBundleId: "AOS_IOS_WDA_BUNDLE_ID",
  xcodeOrgId: "AOS_IOS_XCODE_ORG_ID",
  xcodeSigningId: "AOS_IOS_XCODE_SIGNING_ID"
} as const;

/** Config-layer defaults for the per-project iOS env (dotenv / process env
 * 覆盖；调用方按 `{...defaults, ...dotenv, ...process.env}` 铺开）。 */
export function deviceHostEnvFromConfig(config: AosConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const ios = config.deviceHosts?.ios;
  if (!ios) return env;
  for (const [field, key] of Object.entries(IOS_HOST_ENV_KEYS) as Array<
    [keyof typeof IOS_HOST_ENV_KEYS, string]
  >) {
    const value = ios[field];
    if (typeof value === "string" && value.trim() !== "") env[key] = value.trim();
  }
  return env;
}

/** Accepts `host:port`, `tcp:host:port` or empty; returns `tcp:host:port`. */
export function normalizeAdbSocket(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return null;
  const withScheme = /^tcp:/i.test(trimmed) ? trimmed.replace(/^tcp:/i, "") : trimmed;
  const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(withScheme);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `tcp:${match[1]}:${port}`;
}

export interface ResolvedAndroidHost {
  socket: string;
  source: "env" | "dotenv" | "config";
}

/** Priority: process env > project .env > config `deviceHosts.android.adbHost`. */
export function resolveAndroidAdbSocket(
  config: AosConfig,
  resolver: ValueResolver
): ResolvedAndroidHost | null {
  const resolved = resolver.getValue("ADB_SERVER_SOCKET");
  const direct = normalizeAdbSocket(resolved.value);
  if (direct) return { socket: direct, source: resolved.source ?? "env" };
  const fromConfig = normalizeAdbSocket(config.deviceHosts?.android?.adbHost);
  return fromConfig ? { socket: fromConfig, source: "config" } : null;
}

export interface ResolvedIosHost {
  appiumUrl: string | null;
  wdaBundleId: string | null;
  xcodeOrgId: string | null;
  xcodeSigningId: string | null;
  source: "env" | "dotenv" | "config" | null;
}

/** Priority: process env > project .env > config `deviceHosts.ios.*`. */
export function resolveIosHost(config: AosConfig, resolver: ValueResolver): ResolvedIosHost {
  const fromConfig = deviceHostEnvFromConfig(config);
  const pick = (key: string): { value: string | null; source: ResolvedIosHost["source"] } => {
    const resolved = resolver.getValue(key);
    if (resolved.value) return { value: resolved.value, source: resolved.source ?? "env" };
    const fallback = fromConfig[key] ?? null;
    return { value: fallback, source: fallback ? "config" : null };
  };
  const appium = pick(IOS_HOST_ENV_KEYS.appiumUrl);
  return {
    appiumUrl: appium.value,
    wdaBundleId: pick(IOS_HOST_ENV_KEYS.wdaBundleId).value,
    xcodeOrgId: pick(IOS_HOST_ENV_KEYS.xcodeOrgId).value,
    xcodeSigningId: pick(IOS_HOST_ENV_KEYS.xcodeSigningId).value,
    source: appium.source
  };
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Best-effort Appium `/status` probe (direct URL only; never spawns a server). */
export async function probeAppiumStatus(
  appiumUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const base = appiumUrl.replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${base}/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, detail: `/status 返回 HTTP ${response.status}` };
    return { ok: true, detail: `${base}/status 可达` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `不可达（${message}）` };
  }
}

function parseSocket(socket: string): { host: string; port: number } | null {
  const match = /^tcp:([A-Za-z0-9._-]+):(\d{1,5})$/.exec(socket);
  if (!match) return null;
  return { host: match[1]!, port: Number(match[2]) };
}

/** Best-effort adb server probe: TCP + `host:version` handshake, expects OKAY. */
export function probeAdbSocket(
  socket: string,
  options: { timeoutMs?: number; connectImpl?: (options: net.NetConnectOpts) => net.Socket } = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 1_500;
  const connect = options.connectImpl ?? ((opts: net.NetConnectOpts) => net.createConnection(opts));
  const target = parseSocket(socket);
  if (!target) return Promise.resolve({ ok: false, detail: `非法 ADB_SERVER_SOCKET：${socket}` });
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let socketRef: net.Socket | null = null;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socketRef?.destroy();
      } catch {
        /* best effort */
      }
      resolve(result);
    };
    socketRef = connect({ host: target.host, port: target.port });
    socketRef.setTimeout(timeoutMs, () => finish({ ok: false, detail: "连接超时" }));
    socketRef.on("error", (error) =>
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    );
    socketRef.on("connect", () => {
      socketRef.write("000Chost:version");
    });
    socketRef.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (text.startsWith("OKAY")) {
        finish({ ok: true, detail: `${target.host}:${target.port} adb server 可应答` });
      } else if (text.length >= 4) {
        finish({ ok: false, detail: `非 adb server 应答：${text.slice(0, 40)}` });
      }
    });
  });
}

export function describeDeviceHosts(hosts: DeviceHostsConfig | undefined): {
  ios: string | null;
  android: string | null;
} {
  return {
    ios: hosts?.ios?.appiumUrl?.trim() || null,
    android: hosts?.android?.adbHost?.trim() || null
  };
}
