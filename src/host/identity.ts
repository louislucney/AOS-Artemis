import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { defaultExec, type ExecFn } from "../device/adb.js";

export type HostKind = "mac" | "pc" | "linux" | "other";

export interface HostIdentity {
  id: string;
  hardwareId: string | null;
  hostname: string;
  username: string;
  osPlatform: NodeJS.Platform;
  osVersion: string;
  arch: string;
  kind: HostKind;
  identitySource: "env" | "file" | "derived";
}

export interface ResolveHostIdentityOptions {
  env?: NodeJS.ProcessEnv;
  hostDir?: string;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  hostname?: string;
  username?: string;
  osVersion?: string;
}

const PROBE_TIMEOUT_MS = 5_000;

export function hostKindOf(platform: NodeJS.Platform): HostKind {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "pc";
  if (platform === "linux") return "linux";
  return "other";
}

/** 身份解析顺序：`AOS_HOST_ID` → `AOS_HOST_DIR`/`host-id` 文件 → 派生 ID（目录不可写时，稳定但不可迁移）。 */
export async function resolveHostIdentity(
  options: ResolveHostIdentityOptions = {}
): Promise<HostIdentity> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const hostname = options.hostname ?? os.hostname();
  const username = options.username ?? resolveUsername(env);
  const hardwareId = await probeHardwareId(platform, exec);
  const osVersion = options.osVersion ?? (await probeOsVersion(platform, exec));

  const base = {
    hardwareId,
    hostname,
    username,
    osPlatform: platform,
    osVersion,
    arch: process.arch,
    kind: hostKindOf(platform)
  };

  const explicit = (env.AOS_HOST_ID ?? "").trim();
  if (explicit !== "") {
    return { id: explicit, ...base, identitySource: "env" };
  }

  const hostDir = resolveHostDir(env, options.hostDir);
  const fileId = await readOrCreateHostId(path.join(hostDir, "host-id"));
  if (fileId !== null) {
    return { id: fileId, ...base, identitySource: "file" };
  }

  return { id: derivedHostId(hardwareId, hostname, username), ...base, identitySource: "derived" };
}

function resolveHostDir(env: NodeJS.ProcessEnv, override?: string): string {
  const explicit = (override ?? "").trim();
  if (explicit !== "") return explicit;
  const configured = (env.AOS_HOST_DIR ?? "").trim();
  if (configured !== "") return configured;
  return path.join(os.homedir(), ".aos");
}

function resolveUsername(env: NodeJS.ProcessEnv): string {
  const fallback = (env.USER ?? env.USERNAME ?? "unknown").trim() || "unknown";
  try {
    return os.userInfo().username.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function readOrCreateHostId(filePath: string): Promise<string | null> {
  const existing = await readHostId(filePath);
  if (existing !== null) return existing;
  const generated = crypto.randomUUID();
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${generated}\n`, { mode: 0o600 });
    await fs.rename(tmp, filePath);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return null;
  }
  return (await readHostId(filePath)) ?? generated;
}

async function readHostId(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const value = raw.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function derivedHostId(
  hardwareId: string | null,
  hostname: string,
  username: string
): string {
  const seed = hardwareId || hostname || username;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

async function probeHardwareId(
  platform: NodeJS.Platform,
  exec: ExecFn
): Promise<string | null> {
  try {
    if (platform === "darwin") {
      const result = await exec("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        timeoutMs: PROBE_TIMEOUT_MS
      });
      if (result.error || result.code !== 0) return null;
      const match = result.stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match?.[1]?.trim() || null;
    }
    if (platform === "win32") {
      const result = await exec(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { timeoutMs: PROBE_TIMEOUT_MS }
      );
      if (result.error || result.code !== 0) return null;
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!/MachineGuid/i.test(line)) continue;
        const value = line.split(/\s+/).filter(Boolean).pop();
        if (value) return value.trim() || null;
      }
      return null;
    }
    if (platform === "linux") {
      const raw = await fs.readFile("/etc/machine-id", "utf8");
      return raw.trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

async function probeOsVersion(platform: NodeJS.Platform, exec: ExecFn): Promise<string> {
  if (platform === "darwin") {
    try {
      const result = await exec("sw_vers", ["-productVersion"], {
        timeoutMs: PROBE_TIMEOUT_MS
      });
      if (!result.error && result.code === 0) {
        const value = result.stdout.trim();
        if (value !== "") return value;
      }
      return os.release();
    } catch {
      return os.release();
    }
  }
  return os.release();
}
