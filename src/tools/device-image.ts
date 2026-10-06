import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseJsonObject } from "../artemis/task-result.js";

export interface DeviceImage {
  data: string;
  mimeType: string;
  note: string;
}

/** Extract a screenshot from a mobile_get_device_state tool result: either an
 * MCP image block, or a text payload referencing a local file path/URI. */
export function extractDeviceImage(result: CallToolResult): DeviceImage | null {
  const texts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "image") {
      return { data: item.data, mimeType: item.mimeType, note: "tool image block" };
    }
    if (item.type === "text") texts.push(item.text);
  }

  for (const text of texts) {
    const candidates: string[] = [];
    const parsed = parseJsonObject(text);
    if (parsed) collectPathStrings(parsed, candidates);
    const regex =
      /(file:\/\/[^\s"'`]+|[A-Za-z]:[\\/][^\s"'`]+\.(?:png|jpe?g|webp)|\/[^\s"'`]+\.(?:png|jpe?g|webp))/gi;
    for (const match of text.matchAll(regex)) candidates.push(match[1]!);

    for (const candidate of candidates) {
      const filePath = candidate.startsWith("file://") ? decodeURIComponent(candidate.slice(7)) : candidate;
      try {
        if (!fs.existsSync(filePath)) continue;
        const bytes = fs.readFileSync(filePath);
        return {
          data: bytes.toString("base64"),
          mimeType: mimeTypeFor(filePath),
          note: `local file ${filePath}`
        };
      } catch {
        /* try next candidate */
      }
    }
  }
  return null;
}

function collectPathStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (/^(file:\/\/|[A-Za-z]:[\\/]|\/)/.test(value) && /\.(png|jpe?g|webp)$/i.test(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPathStrings(item, out, depth + 1);
    }
  }
}

export function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export function mimeTypeOfBytes(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return "image/png";
  return "image/jpeg";
}
