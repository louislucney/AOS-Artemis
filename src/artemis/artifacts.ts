import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AosConfig } from "../config/types.js";
import { errorMessage } from "../util.js";
import { liveScreenshotsDir } from "./assembly.js";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const PATH_CANDIDATE = /(file:\/\/[^\s"'`]+|[A-Za-z]:[\\/][^\s"'`]+|\/[^\s"'`]+)/g;

/** Absolute local image paths referenced by a tool result. Inline image blocks
 * are skipped: they carry data, not a file location. */
export function collectLocalImagePaths(result: CallToolResult, depth = 0): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    const raw = candidate.startsWith("file://") ? decodeURIComponent(candidate.slice(7)) : candidate;
    if (!IMAGE_EXT.test(raw)) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    found.push(raw);
  };

  const walk = (value: unknown, level: number): void => {
    if (level > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, level + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, level + 1);
    }
  };

  for (const item of result.content ?? []) {
    if (item.type !== "text") continue;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(item.text) as unknown;
    } catch {
      parsed = null;
    }
    if (parsed !== null) {
      walk(parsed, depth);
      continue;
    }
    for (const match of item.text.matchAll(PATH_CANDIDATE)) push(match[1]!);
  }
  return found;
}

export interface MirrorReport {
  copied: string[];
  errors: string[];
}

/** Mirror upstream live screenshots (mobile_get_device_state writes them under
 * the artemis repo root) into `<project>/.artemis/traces/live_screenshots/`.
 * Copies only; the original file and the tool result stay untouched. */
export function mirrorDeviceScreenshots(
  config: AosConfig,
  rootDir: string,
  result: CallToolResult
): MirrorReport {
  const destDir = liveScreenshotsDir(config, rootDir);
  const copied: string[] = [];
  const errors: string[] = [];
  for (const filePath of collectLocalImagePaths(result)) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const target = path.join(destDir, path.basename(filePath));
      if (path.resolve(filePath) === path.resolve(target)) continue;
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(filePath, target);
      copied.push(target);
    } catch (error) {
      errors.push(`${filePath}: ${errorMessage(error)}`);
    }
  }
  return { copied, errors };
}
