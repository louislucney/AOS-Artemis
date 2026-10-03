import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFigmaRenderPng } from "../figma/render.js";
import { parseJsonObject } from "../artemis/task-result.js";
import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";

export interface CompareArgs {
  figmaUrl: string;
  nodeId?: string;
  deviceSerial?: string;
}

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

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function jsonError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true
  };
}

/** Composite tool: fetch the Figma frame render + the current device screenshot
 * and return both images so the calling multimodal agent can compare them
 * (layout/spacing/colors/copy) without extra round trips. */
export async function compareDesignAndDevice(
  runtime: Runtime,
  args: CompareArgs
): Promise<CallToolResult> {
  // 1) Figma render (PNG @2x) via the REST API.
  let figmaImage: { data: string; mimeType: string; source: string; nodeId: string };
  try {
    const render = await fetchFigmaRenderPng(args.figmaUrl, args.nodeId);
    figmaImage = {
      data: render.png.toString("base64"),
      mimeType: "image/png",
      source: render.renderUrl,
      nodeId: render.nodeId
    };
  } catch (error) {
    return jsonError(
      `Figma 渲染失败: ${errorMessage(error)}\n` +
        `提示：REST 模式需要 FIGMA_ACCESS_TOKEN（写入项目 .env 或调用 aos_configure 携带 figmaToken）。`
    );
  }

  // 2) Device screenshot via the artemis proxy.
  let deviceImage: DeviceImage;
  try {
    const result = await runtime.proxy.callTool("mobile_get_device_state", {
      view_type: "screenshot",
      ...(args.deviceSerial ? { device_serial: args.deviceSerial } : {})
    });
    const extracted = extractDeviceImage(result);
    if (!extracted) {
      throw new Error("无法从 mobile_get_device_state 结果中解析截图（image 块或本地文件路径）。");
    }
    deviceImage = extracted;
  } catch (error) {
    return jsonError(`真机截图失败: ${errorMessage(error)}`);
  }

  const meta = {
    ok: true,
    figma: { nodeId: figmaImage.nodeId, renderUrl: figmaImage.source },
    device: { source: deviceImage.note, serial: args.deviceSerial ?? "(auto)" },
    howTo: "对比两张图：布局、间距、颜色、字体与文案；列出可见差异与疑似问题。"
  };

  return {
    content: [
      { type: "text", text: JSON.stringify(meta, null, 2) },
      { type: "image", data: figmaImage.data, mimeType: figmaImage.mimeType },
      { type: "image", data: deviceImage.data, mimeType: deviceImage.mimeType }
    ]
  };
}
