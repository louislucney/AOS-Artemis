import os from "node:os";

import type { HostAddressInput, UpsertHostInput } from "../db/types.js";
import { defaultExec, type ExecFn } from "../device/adb.js";
import { detectHostEnvironment, deriveCapabilities, type HostEnvSnapshot } from "../host/env.js";
import { resolveHostIdentity, type HostIdentity } from "../host/identity.js";

export interface HostSnapshot {
  identity: HostIdentity;
  env: HostEnvSnapshot;
  capabilities: string[];
  ipPrimary: string | null;
  addresses: HostAddressInput[];
}

export interface CollectHostSnapshotInput {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
}

/** 启动时全量采集：身份 + 环境 + 能力 + 自报地址；`ipPrimary` 取首个非链路本地 IPv4，否则 IPv6。 */
export async function collectHostSnapshot(input: CollectHostSnapshotInput): Promise<HostSnapshot> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const exec = input.exec ?? defaultExec;
  const identity = await resolveHostIdentity({ env, platform, exec });
  const hostEnv = await detectHostEnvironment({
    projectRoot: input.projectRoot,
    env,
    platform,
    exec
  });
  const addresses = selfReportedAddresses();
  return {
    identity,
    env: hostEnv,
    capabilities: deriveCapabilities(platform, hostEnv.tools),
    ipPrimary: primaryIp(addresses),
    addresses
  };
}

export function upsertHostInputFromSnapshot(
  snapshot: HostSnapshot,
  hostId: string,
  runnerSeenAt: string
): UpsertHostInput {
  const identity = snapshot.identity;
  return {
    id: hostId,
    hardwareId: identity.hardwareId,
    hostname: identity.hostname,
    username: identity.username,
    osPlatform: identity.osPlatform,
    osVersion: identity.osVersion,
    arch: identity.arch,
    identitySource: identity.identitySource,
    kind: identity.kind,
    capabilities: snapshot.capabilities,
    env: { ...snapshot.env },
    envAt: snapshot.env.collectedAt,
    ipPrimary: snapshot.ipPrimary,
    runnerSeenAt
  };
}

function selfReportedAddresses(): HostAddressInput[] {
  const interfaces = os.networkInterfaces();
  const addresses: HostAddressInput[] = [];
  for (const [iface, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const family = familyOf(entry);
      if (family === null) continue;
      if (isLinkLocal(entry.address, family)) continue;
      if (isLoopback(entry.address, family)) continue;
      addresses.push({ source: "self", iface, family, address: entry.address });
    }
  }
  return addresses;
}

function familyOf(entry: os.NetworkInterfaceInfo): HostAddressInput["family"] | null {
  const family = String(entry.family).toLowerCase();
  if (family === "ipv4" || family === "4") return "ipv4";
  if (family === "ipv6" || family === "6") return "ipv6";
  return entry.address.includes(":") ? "ipv6" : "ipv4";
}

function isLinkLocal(address: string, family: HostAddressInput["family"]): boolean {
  if (family === "ipv4") return address.startsWith("169.254.");
  return /^fe80:/i.test(address);
}

function isLoopback(address: string, family: HostAddressInput["family"]): boolean {
  if (family === "ipv4") return address.startsWith("127.");
  return address === "::1";
}

function primaryIp(addresses: HostAddressInput[]): string | null {
  return (
    addresses.find((entry) => entry.family === "ipv4")?.address ??
    addresses.find((entry) => entry.family === "ipv6")?.address ??
    null
  );
}
