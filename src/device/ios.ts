import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultExec, type ExecFn } from "./adb.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface ResolvedIdb {
  path: string;
  source: "env" | "brew" | "path";
}

export interface ResolvedXcrun {
  path: string;
  source: "env" | "system" | "path";
}

export type IosCaptureError =
  | "ios-unsupported"
  | "not-found"
  | "no-device"
  | "no-serial"
  | "timeout"
  | "command-failed"
  | "screenshot-missing"
  | "not-png"
  | string;

export interface IosPngCapture {
  ok: boolean;
  bytes?: Buffer;
  serial: string | null;
  tool?: "idb" | "simctl";
  error?: IosCaptureError;
}

export interface IosPngCaptureOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  serial?: string | null;
  tmpDir?: string;
  timeoutMs?: number;
}

export function resolveIdbPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync
): ResolvedIdb {
  const explicit = env.AOS_IDB_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };
  for (const candidate of ["/opt/homebrew/bin/idb", "/usr/local/bin/idb"]) {
    if (exists(candidate)) return { path: candidate, source: "brew" };
  }
  return { path: "idb", source: "path" };
}

export function resolveXcrunPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync
): ResolvedXcrun {
  const explicit = env.AOS_XCRUN_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };
  if (exists("/usr/bin/xcrun")) return { path: "/usr/bin/xcrun", source: "system" };
  return { path: "xcrun", source: "path" };
}

export function parseBootedUdids(stdout: string): string[] | null {  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const devices = (data as { devices?: unknown })?.devices;
  if (!devices || typeof devices !== "object") return null;
  const udids: string[] = [];
  for (const list of Object.values(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (!device || typeof device !== "object") continue;
      const entry = device as { udid?: unknown; state?: unknown; isAvailable?: unknown };
      if (entry.state !== "Booted") continue;
      if (entry.isAvailable === false) continue;
      if (typeof entry.udid === "string" && entry.udid) udids.push(entry.udid);
    }
  }
  return [...new Set(udids)];
}

function classifyExecError(error: string): IosCaptureError {
  return error.toLowerCase().includes("enoent") ? "not-found" : "command-failed";
}

function readPng(file: string): Buffer | null {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") {
      return bytes;
    }
  } catch {
    return null;
  }
  return null;
}

interface ToolAttempt {
  ok: boolean;
  bytes?: Buffer;
  error?: IosCaptureError;
}

async function attemptScreenshot(
  exec: ExecFn,
  command: string,
  args: string[],
  file: string,
  timeoutMs: number
): Promise<ToolAttempt> {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
  const result = await exec(command, args, { timeoutMs });
  if (result.error === "timeout") return { ok: false, error: "timeout" };
  if (result.error) return { ok: false, error: classifyExecError(result.error) };
  if (result.code !== 0) return { ok: false, error: "command-failed" };
  const bytes = readPng(file);
  if (!bytes) {
    return { ok: false, error: fs.existsSync(file) ? "not-png" : "screenshot-missing" };
  }
  return { ok: true, bytes };
}

async function listBootedUdids(
  exec: ExecFn,
  xcrun: string,
  timeoutMs: number
): Promise<{ ok: true; udids: string[] } | { ok: false; error: IosCaptureError }> {
  const result = await exec(xcrun, ["simctl", "list", "devices", "booted", "--json"], { timeoutMs });
  if (result.error === "timeout") return { ok: false, error: "timeout" };
  if (result.error) return { ok: false, error: classifyExecError(result.error) };
  if (result.code !== 0) return { ok: false, error: "command-failed" };
  const udids = parseBootedUdids(result.stdout);
  if (udids === null) return { ok: false, error: "command-failed" };
  return { ok: true, udids };
}

/** iOS simulator screenshot: idb first, simctl as fallback. macOS only. */export async function captureIosPng(options: IosPngCaptureOptions = {}): Promise<IosPngCapture> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const exists = options.pathExists ?? fs.existsSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const explicitSerial = options.serial?.trim() || null;

  if (platform !== "darwin") {
    return { ok: false, serial: explicitSerial, error: "ios-unsupported" };
  }

  const xcrun = resolveXcrunPath(env, exists);
  let serial = explicitSerial;
  if (!serial) {
    const listed = await listBootedUdids(exec, xcrun.path, timeoutMs);
    if (!listed.ok) return { ok: false, serial: null, error: listed.error };
    if (listed.udids.length === 0) return { ok: false, serial: null, error: "no-device" };
    if (listed.udids.length > 1) return { ok: false, serial: null, error: "no-serial" };
    serial = listed.udids[0]!;
  }

  const idb = resolveIdbPath(env, exists);
  const file = path.join(
    options.tmpDir ?? os.tmpdir(),
    `aos-ios-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`
  );

  try {
    const viaIdb = await attemptScreenshot(
      exec,
      idb.path,
      ["screenshot", "--udid", serial, file],
      file,
      timeoutMs
    );
    if (viaIdb.ok && viaIdb.bytes) {
      return { ok: true, bytes: viaIdb.bytes, serial, tool: "idb" };
    }
    const viaSimctl = await attemptScreenshot(
      exec,
      xcrun.path,
      ["simctl", "io", serial, "screenshot", file],
      file,
      timeoutMs
    );
    if (viaSimctl.ok && viaSimctl.bytes) {
      return { ok: true, bytes: viaSimctl.bytes, serial, tool: "simctl" };
    }
    let error: IosCaptureError;
    if (viaIdb.error === "not-found" && viaSimctl.error === "not-found") {
      error = "not-found";
    } else if (viaSimctl.error && viaSimctl.error !== "not-found") {
      error = viaSimctl.error;
    } else if (viaIdb.error && viaIdb.error !== "not-found") {
      error = viaIdb.error;
    } else {
      error = "command-failed";
    }
    return { ok: false, serial, error };
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

export const SIMULATOR_UDID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSimulatorUdid(value: string): boolean {
  return SIMULATOR_UDID_PATTERN.test(value.trim());
}

export type IosSerialKind = "simulator" | "device";

const DEVICE_UDID_PATTERNS = [
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/,
  /^[0-9A-Fa-f]{40}$/
];

/** Simulator UUID or physical-device UDID (modern 8-16 / legacy 40-hex). */
export function classifyIosSerial(value: string): IosSerialKind | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SIMULATOR_UDID_PATTERN.test(trimmed)) return "simulator";
  if (DEVICE_UDID_PATTERNS.some((pattern) => pattern.test(trimmed))) return "device";
  return null;
}

export interface IosSimulator {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

export function parseSimulators(stdout: string): IosSimulator[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  const devices = (data as { devices?: unknown })?.devices;
  if (!devices || typeof devices !== "object") return null;
  const simulators: IosSimulator[] = [];
  for (const list of Object.values(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const device of list) {
      if (!device || typeof device !== "object") continue;
      const entry = device as { udid?: unknown; name?: unknown; state?: unknown; isAvailable?: unknown };
      if (typeof entry.udid !== "string" || !entry.udid) continue;
      simulators.push({
        udid: entry.udid,
        name: typeof entry.name === "string" ? entry.name : "",
        state: typeof entry.state === "string" ? entry.state : "",
        isAvailable: entry.isAvailable !== false
      });
    }
  }
  return simulators;
}

export interface IosSimulatorListOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  timeoutMs?: number;
}

export async function listIosSimulators(
  options: IosSimulatorListOptions = {}
): Promise<{ ok: true; simulators: IosSimulator[] } | { ok: false; error: IosCaptureError }> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const exists = options.pathExists ?? fs.existsSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (platform !== "darwin") return { ok: false, error: "ios-unsupported" };
  const xcrun = resolveXcrunPath(env, exists);
  const result = await exec(xcrun.path, ["simctl", "list", "devices", "--json"], { timeoutMs });
  if (result.error === "timeout") return { ok: false, error: "timeout" };
  if (result.error) return { ok: false, error: classifyExecError(result.error) };
  if (result.code !== 0) return { ok: false, error: "command-failed" };
  const simulators = parseSimulators(result.stdout);
  if (simulators === null) return { ok: false, error: "command-failed" };
  return { ok: true, simulators };
}

export interface IosUiNode {
  type: string;
  label: string;
  value: string;
  id: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** 观测解析失败的重试次数（`AOS_IOS_OBSERVE_RETRY`，默认 1，范围 0-5）。 */
export function resolveObserveRetry(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_IOS_OBSERVE_RETRY ?? "", 10);
  if (!Number.isInteger(raw) || raw < 0) return 1;
  return Math.min(5, raw);
}

export function parseIdbNodes(stdout: string): IosUiNode[] | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const nodes: IosUiNode[] = [];
  for (const element of data) {
    if (!element || typeof element !== "object") continue;
    const entry = element as {
      type?: unknown;
      AXLabel?: unknown;
      AXValue?: unknown;
      AXUniqueId?: unknown;
      frame?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    };
    const frame = entry.frame;
    if (!frame || typeof frame.x !== "number" || typeof frame.y !== "number") continue;
    if (typeof frame.width !== "number" || typeof frame.height !== "number") continue;
    nodes.push({
      type: typeof entry.type === "string" ? entry.type : "",
      label: typeof entry.AXLabel === "string" ? entry.AXLabel : "",
      value: typeof entry.AXValue === "string" ? entry.AXValue : "",
      id: typeof entry.AXUniqueId === "string" ? entry.AXUniqueId : "",
      rect: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    });
  }
  return nodes;
}

export interface IosDescribeOptions {
  env?: NodeJS.ProcessEnv;
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  pathExists?: (candidate: string) => boolean;
  serial: string;
  timeoutMs?: number;
}

export async function describeIosUi(
  options: IosDescribeOptions
): Promise<{ ok: true; nodes: IosUiNode[]; serial: string } | { ok: false; error: IosCaptureError }> {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const exists = options.pathExists ?? fs.existsSync;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const serial = options.serial.trim();
  if (platform !== "darwin") return { ok: false, error: "ios-unsupported" };
  if (!serial) return { ok: false, error: "no-serial" };
  const idb = resolveIdbPath(env, exists);
  const result = await exec(idb.path, ["ui", "describe-all", "--udid", serial, "--json"], { timeoutMs });
  if (result.error === "timeout") return { ok: false, error: "timeout" };
  if (result.error) return { ok: false, error: classifyExecError(result.error) };
  if (result.code !== 0) return { ok: false, error: "command-failed" };
  const nodes = parseIdbNodes(result.stdout);
  if (nodes === null) return { ok: false, error: "command-failed" };
  return { ok: true, nodes, serial };
}
