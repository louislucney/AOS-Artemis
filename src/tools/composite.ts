import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFigmaRenderPng } from "../figma/render.js";
import { captureLiveScreenshot } from "../diff/device-source.js";
import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { mimeTypeOfBytes, type DeviceImage } from "./device-image.js";

export { extractDeviceImage } from "./device-image.js";

export interface CompareArgs {
  figmaUrl: string;
  nodeId?: string;
  deviceSerial?: string;
  platform?: "android" | "ios";
  lossless?: boolean;
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

  // 2) Device screenshot: ARTEMIS live JPEG, or lossless adb PNG on demand.
  let deviceImage: DeviceImage;
  try {
    const capture = await captureLiveScreenshot(runtime, args.deviceSerial, {
      platform: args.platform === "ios" ? "ios" : undefined,
      lossless: args.lossless === true
    });
    deviceImage = {
      data: capture.bytes.toString("base64"),
      mimeType: mimeTypeOfBytes(capture.bytes),
      note: capture.note
    };
  } catch (error) {
    return jsonError(`真机截图失败: ${errorMessage(error)}`);
  }

  const meta = {
    ok: true,
    figma: { nodeId: figmaImage.nodeId, renderUrl: figmaImage.source },
    device: {
      source: deviceImage.note,
      serial: args.deviceSerial ?? "(auto)",
      ...(args.platform === "ios" ? { platform: "ios" } : {})
    },
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
