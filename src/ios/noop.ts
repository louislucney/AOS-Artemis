import { createHash } from "node:crypto";

import { PNG } from "pngjs";

import type { IosUiNode } from "../device/ios.js";

const SYSTEM_TOP_BAND_RATIO = 0.06;

function isSystemNode(node: IosUiNode, screenHeight: number | null): boolean {
  if (/status/i.test(node.type) || /status/i.test(node.id)) return true;
  if (screenHeight === null || screenHeight <= 0) return false;
  const bottom = node.rect.y + node.rect.height;
  return bottom <= screenHeight * SYSTEM_TOP_BAND_RATIO;
}

/** Deterministic screen fingerprint for no-op detection: text-bearing nodes
 * only, system status-bar band excluded (real-device clocks break equality). */
export function screenSignature(
  nodes: IosUiNode[],
  screenHeight: number | null = null
): string {
  const parts: string[] = [];
  for (const node of nodes) {
    const label = node.label.trim();
    const value = node.value.trim();
    if (!label && !value) continue;
    if (isSystemNode(node, screenHeight)) continue;
    parts.push(
      [
        node.type,
        label,
        value,
        Math.round(node.rect.x),
        Math.round(node.rect.y),
        Math.round(node.rect.width),
        Math.round(node.rect.height)
      ].join("|")
    );
  }
  parts.sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** PNG hash with the top/bottom system bands cropped (status bar clock, home
 * indicator). Returns null when the buffer is not decodable PNG. */
export function croppedScreenshotHash(
  bytes: Buffer,
  topRatio = 0.05,
  bottomRatio = 0.05
): string | null {
  try {
    const png = PNG.sync.read(bytes);
    const startRow = Math.floor(png.height * topRatio);
    const endRow = Math.max(startRow, png.height - Math.floor(png.height * bottomRatio));
    const rowBytes = png.width * 4;
    const start = startRow * rowBytes;
    const end = Math.min(png.data.length, endRow * rowBytes);
    return createHash("sha256").update(png.data.subarray(start, end)).digest("hex");
  } catch {
    return null;
  }
}

export function thoughtFirstSentence(thought: string, max = 40): string {
  const first = thought.split(/[。！？!?\n]/)[0]?.trim() ?? "";
  return first.length > max ? first.slice(0, max) : first;
}

export function digestLineForStep(
  step: { thought: string; action: string; params: Record<string, unknown>; outcome: string }
): string {
  const thought = thoughtFirstSentence(step.thought);
  const params =
    Object.keys(step.params).length > 0
      ? ` ${JSON.stringify(step.params).slice(0, 60)}`
      : "";
  return `${thought ? `${thought} ` : ""}${step.action}${params} → ${step.outcome}`;
}
