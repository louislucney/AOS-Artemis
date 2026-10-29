import { createHash } from "node:crypto";

import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";

/** 对整棵子树做内容指纹：bbox 相对画板原点、键排序、数字保留 2 位；
 * 画板在画布上移动不改哈希，节点内容/层级/名称/子层变化会改哈希。 */
export function nodeContentHash(root: FigmaNode): string {
  const rootBox = root.absoluteBoundingBox as { x?: number; y?: number } | undefined;
  const originX = typeof rootBox?.x === "number" ? rootBox.x : 0;
  const originY = typeof rootBox?.y === "number" ? rootBox.y : 0;
  const round = (value: number): number => Math.round(value * 100) / 100;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (
        typeof record.x === "number" &&
        typeof record.y === "number" &&
        typeof record.width === "number" &&
        typeof record.height === "number"
      ) {
        return {
          x: round(record.x - originX),
          y: round(record.y - originY),
          width: round(record.width),
          height: round(record.height)
        };
      }
      const out: Record<string, unknown> = {};
      for (const childKey of Object.keys(record).sort()) {
        if (childKey === "absoluteRenderBounds") continue;
        out[childKey] = normalize(record[childKey]);
      }
      return out;
    }
    if (typeof value === "number" && Number.isFinite(value)) return round(value);
    return value;
  };
  return createHash("sha1")
    .update(JSON.stringify(normalize(root)))
    .digest("hex");
}
