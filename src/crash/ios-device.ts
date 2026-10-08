import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultExec, type ExecFn } from "../device/adb.js";
import { parseIps, type IosCrashCollectResult } from "./ios.js";
import type { ParsedCrash } from "./types.js";

const WINDOW_SLACK_BEFORE_MS = 2_000;
const WINDOW_SLACK_AFTER_MS = 5_000;

export const IOS_DEVICE_CRASH_SOURCE = "devicectl-systemCrashLogs";

export interface IosDeviceCrashDeps {
  exec?: ExecFn;
  copy?: (udid: string, destination: string) => Promise<{ ok: boolean; error?: string }>;
  listFiles?: (root: string) => string[];
  readFile?: (file: string) => string;
  makeTempDir?: () => string;
  removeDir?: (dir: string) => void;
  timeoutMs?: number;
}

function defaultListIpsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".ips")) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

function processMatches(record: ParsedCrash, processName: string | null): boolean {
  if (!processName) return true;
  const wanted = processName.trim().toLowerCase();
  if (wanted === "") return true;
  return record.package.toLowerCase() === wanted;
}

function withinWindow(
  record: ParsedCrash,
  window: { startMs: number | null; endMs: number | null }
): boolean {
  const ms = record.occurredAtMs;
  if (ms === null || ms === undefined) return true;
  if (window.startMs !== null && ms < window.startMs - WINDOW_SLACK_BEFORE_MS) return false;
  if (window.endMs !== null && ms > window.endMs + WINDOW_SLACK_AFTER_MS) return false;
  return true;
}

/** Physical-device crash capture: pull `.ips` reports from the device crash
 * domain via `xcrun devicectl` (Apple-native) and filter by window/process. */
export async function collectIosDeviceCrashes(
  window: { udid: string; startMs: number | null; endMs: number | null; processName?: string | null },
  deps: IosDeviceCrashDeps = {}
): Promise<IosCrashCollectResult> {
  const exec = deps.exec ?? defaultExec;
  const copy =
    deps.copy ??
    (async (udid: string, destination: string) => {
      const result = await exec(
        "xcrun",
        [
          "devicectl",
          "device",
          "copy",
          "from",
          "--device",
          udid,
          "--domain-type",
          "systemCrashLogs",
          "--source",
          ".",
          "--destination",
          destination,
          "--timeout",
          "60"
        ],
        { timeoutMs: deps.timeoutMs ?? 90_000 }
      );
      if (result.error) return { ok: false, error: result.error };
      if (result.code !== 0) {
        return { ok: false, error: (result.stderr || "devicectl copy failed").trim().slice(0, 300) };
      }
      return { ok: true };
    });
  const dir = (deps.makeTempDir ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), "aos-ios-crash-"))))();
  const removeDir = deps.removeDir ?? ((target: string) => fs.rmSync(target, { recursive: true, force: true }));
  try {
    const copied = await copy(window.udid, dir);
    if (!copied.ok) {
      return { records: [], scanned: 0, skipped: `copy-failed: ${copied.error ?? "unknown"}` };
    }
    const listFiles = deps.listFiles ?? defaultListIpsFiles;
    const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));
    const files = listFiles(dir);
    const records: ParsedCrash[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = readFile(file);
      } catch {
        continue;
      }
      const record = parseIps(content);
      if (record === null) continue;
      if (!withinWindow(record, window)) continue;
      if (!processMatches(record, window.processName ?? null)) continue;
      records.push(record);
    }
    return { records, scanned: files.length, skipped: null };
  } finally {
    try {
      removeDir(dir);
    } catch {
      /* best effort */
    }
  }
}
