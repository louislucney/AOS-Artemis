import fs from "node:fs/promises";
import os from "node:os";

import { defaultExec, type ExecFn, type ExecResult } from "../device/adb.js";
import { AOS_MCP_VERSION, errorMessage } from "../util.js";

export interface ToolProbe {
  present: boolean;
  version: string | null;
  path: string | null;
  note?: string | null;
  configured?: boolean;
  reachable?: boolean;
}

export interface HostEnvSnapshot {
  collectedAt: string;
  node: string;
  aos: string;
  cpu: { model: string; count: number };
  memory: { totalBytes: number };
  disk: { path: string; freeBytes: number | null; totalBytes: number | null };
  tools: {
    adb: ToolProbe;
    xcodebuild: ToolProbe;
    simctl: ToolProbe;
    idb: ToolProbe;
    ideviceId: ToolProbe;
    idevicesyslog: ToolProbe;
    appium: ToolProbe;
    uv: ToolProbe;
  };
}

export interface DetectHostEnvironmentInput {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  now?: () => number;
  statfs?: (p: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  appiumStatus?: (url: string) => Promise<{ version: string | null } | null>;
}

const PROBE_TIMEOUT_MS = 5_000;

interface ProbeSpec {
  command: string;
  args: string[];
  versionPattern?: RegExp;
  pathFromStdout?: boolean;
}

const ADB_PROBE: ProbeSpec = {
  command: "adb",
  args: ["version"],
  versionPattern: /Android Debug Bridge version ([\w.]+)/
};
const XCODEBUILD_PROBE: ProbeSpec = {
  command: "xcodebuild",
  args: ["-version"],
  versionPattern: /^Xcode ([\w.]+)/m
};
const SIMCTL_PROBE: ProbeSpec = { command: "xcrun", args: ["simctl", "help"] };
const IDB_PROBE: ProbeSpec = { command: "idb", args: ["--version"], versionPattern: /idb ([\w.]+)/ };
const UV_PROBE: ProbeSpec = { command: "uv", args: ["--version"], versionPattern: /uv ([\w.]+)/ };

export function deriveCapabilities(
  platform: NodeJS.Platform,
  tools: HostEnvSnapshot["tools"]
): string[] {
  const capabilities: string[] = [];
  if (platform === "darwin") {
    if (tools.simctl.present) capabilities.push("ios-simulator");
    const appiumReachable = tools.appium.reachable ?? tools.appium.present;
    if (appiumReachable || (tools.ideviceId.present && tools.idb.present)) {
      capabilities.push("ios-real");
    }
  }
  if (tools.adb.present) capabilities.push("android");
  return capabilities;
}

export async function detectHostEnvironment(
  input: DetectHostEnvironmentInput
): Promise<HostEnvSnapshot> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const exec = input.exec ?? defaultExec;
  const now = input.now ?? Date.now;
  const statfs = input.statfs ?? defaultStatfs;

  const pathLookupCommand = platform === "win32" ? "where" : "which";
  const probeIdeviceTools = platform === "darwin";
  const probeLibimobiledevice = platform === "darwin" || platform === "linux";
  const [adb, xcodebuild, simctl, idb, ideviceId, idevicesyslog, uv, disk] = await Promise.all([
    probeTool(exec, ADB_PROBE),
    probeIdeviceTools ? probeTool(exec, XCODEBUILD_PROBE) : missingTool(),
    probeIdeviceTools ? probeTool(exec, SIMCTL_PROBE) : missingTool(),
    probeIdeviceTools ? probeTool(exec, IDB_PROBE) : missingTool(),
    probeIdeviceTools
      ? probeTool(exec, { command: pathLookupCommand, args: ["idevice_id"], pathFromStdout: true })
      : missingTool(),
    probeLibimobiledevice
      ? probeTool(exec, {
          command: pathLookupCommand,
          args: ["idevicesyslog"],
          pathFromStdout: true
        })
      : missingTool(),
    probeTool(exec, UV_PROBE),
    probeDisk(statfs, input.projectRoot)
  ]);

  const appium = await probeAppium(env, input.appiumStatus);
  const cpus = os.cpus();

  return {
    collectedAt: new Date(now()).toISOString(),
    node: process.version,
    aos: AOS_MCP_VERSION,
    cpu: { model: cpus[0]?.model?.trim() || "unknown", count: cpus.length },
    memory: { totalBytes: os.totalmem() },
    disk,
    tools: { adb, xcodebuild, simctl, idb, ideviceId, idevicesyslog, appium, uv }
  };
}

function missingTool(): Promise<ToolProbe> {
  return Promise.resolve({ present: false, version: null, path: null });
}

async function probeTool(exec: ExecFn, spec: ProbeSpec): Promise<ToolProbe> {
  const result = await runProbe(exec, spec.command, spec.args);
  if (result === null || result.error !== undefined || result.code !== 0) {
    return {
      present: false,
      version: null,
      path: null,
      note: result === null ? null : (result.error?.trim() || firstLine(result.stderr))
    };
  }
  const stdout = result.stdout ?? "";
  return {
    present: true,
    version: spec.versionPattern ? (stdout.match(spec.versionPattern)?.[1] ?? null) : null,
    path: spec.pathFromStdout ? firstLine(stdout) : null,
    note: null
  };
}

async function runProbe(exec: ExecFn, command: string, args: string[]): Promise<ExecResult | null> {
  try {
    return await exec(command, args, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function firstLine(value: string): string | null {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find((item) => item !== "");
  return line ?? null;
}

async function probeAppium(
  env: NodeJS.ProcessEnv,
  appiumStatus: DetectHostEnvironmentInput["appiumStatus"]
): Promise<ToolProbe> {
  const url = (env.AOS_APPIUM_URL ?? "").trim();
  if (url === "") {
    return {
      present: false,
      version: null,
      path: null,
      note: null,
      configured: false,
      reachable: false
    };
  }
  const status = appiumStatus ?? fetchAppiumStatus;
  try {
    const result = await status(url);
    if (result === null) {
      return {
        present: false,
        version: null,
        path: url,
        note: "status 探测失败",
        configured: true,
        reachable: false
      };
    }
    return {
      present: true,
      version: result.version ?? null,
      path: url,
      note: null,
      configured: true,
      reachable: true
    };
  } catch (error) {
    return {
      present: false,
      version: null,
      path: url,
      note: errorMessage(error),
      configured: true,
      reachable: false
    };
  }
}

async function fetchAppiumStatus(url: string): Promise<{ version: string | null } | null> {
  const endpoint = `${url.replace(/\/+$/, "")}/status`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { value?: { version?: unknown } };
    const version = body?.value?.version;
    return { version: typeof version === "string" && version !== "" ? version : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDisk(
  statfs: NonNullable<DetectHostEnvironmentInput["statfs"]>,
  target: string
): Promise<HostEnvSnapshot["disk"]> {
  try {
    const usage = await statfs(target);
    return { path: target, freeBytes: usage.freeBytes, totalBytes: usage.totalBytes };
  } catch {
    return { path: target, freeBytes: null, totalBytes: null };
  }
}

async function defaultStatfs(target: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const stats = await fs.statfs(target);
  const blockSize = Number(stats.bsize);
  return { freeBytes: Number(stats.bavail) * blockSize, totalBytes: Number(stats.blocks) * blockSize };
}
