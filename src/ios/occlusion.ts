import type { IosUiNode } from "../device/ios.js";

export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcclusionItem {
  rect: OcclusionRect;
  type: string;
  hasText: boolean;
  lineIndex: number | null;
}

export interface OcclusionResult {
  globalLine: string | null;
  perLine: Map<number, string>;
}

const MIN_OVERLAP_RATIO = 0.5;
const DOMINANT_MIN_COVERED = 3;
const DOMINANT_MIN_SCREEN_RATIO = 0.4;
const DOMINANT_MAX_SCREEN_RATIO = 0.9;
const MAX_PAIR_WARNINGS = 5;
const MAX_OVERLAP_REFS = 2;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxOf(item: OcclusionItem): Box {
  return {
    left: item.rect.x,
    top: item.rect.y,
    right: item.rect.x + item.rect.width,
    bottom: item.rect.y + item.rect.height
  };
}

function boxArea(box: Box): number {
  return Math.max(1, (box.right - box.left) * (box.bottom - box.top));
}

function intersectionArea(a: Box, b: Box): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (left >= right || top >= bottom) return 0;
  return (right - left) * (bottom - top);
}

function isConcentricContainment(
  a: Box,
  b: Box,
  areaA: number,
  areaB: number
): boolean {
  const aInsideB =
    a.left >= b.left && a.top >= b.top && a.right <= b.right && a.bottom <= b.bottom;
  const bInsideA =
    b.left >= a.left && b.top >= a.top && b.right <= a.right && b.bottom <= a.bottom;
  if (!aInsideB && !bInsideA) return false;
  if (!(areaB > areaA * 2 && aInsideB) && !(areaA > areaB * 2 && bInsideA)) return false;
  const centerAx = (a.left + a.right) / 2;
  const centerAy = (a.top + a.bottom) / 2;
  const centerBx = (b.left + b.right) / 2;
  const centerBy = (b.top + b.bottom) / 2;
  const distance = Math.hypot(centerAx - centerBx, centerAy - centerBy);
  const maxDim = Math.max(
    a.right - a.left,
    b.right - b.left,
    a.bottom - a.top,
    b.bottom - b.top
  );
  return distance < maxDim * 0.2;
}

/** Port of the Android observer's mutual-occlusion detector (visualization.py):
 * pair warnings for >=50% overlap, excluding concentric parent-child nesting.
 * Adds the iOS-specific consolidation: one dominant large overlay (keyboard /
 * alert covering >=3 text elements and >=40% of the screen) becomes a single
 * global line, and pair warnings are capped to keep prompts small. */
export function computeOcclusions(items: OcclusionItem[], screenArea: number): OcclusionResult {
  const perLine = new Map<number, string>();
  const boxes = items.map(boxOf);
  const areas = boxes.map(boxArea);

  const dominant: number[] = [];
  if (screenArea > 0) {
    items.forEach((item, index) => {
      const ratioOfScreen = areas[index]! / screenArea;
      if (ratioOfScreen < DOMINANT_MIN_SCREEN_RATIO || ratioOfScreen > DOMINANT_MAX_SCREEN_RATIO) return;
      let covered = 0;
      items.forEach((other, otherIndex) => {
        if (otherIndex === index || other.lineIndex === null) return;
        const overlap = intersectionArea(boxes[otherIndex]!, boxes[index]!);
        if (overlap / areas[otherIndex]! >= MIN_OVERLAP_RATIO) covered += 1;
      });
      if (covered >= DOMINANT_MIN_COVERED) dominant.push(index);
    });
  }

  const suppressed = new Set<number>();
  for (const overlay of dominant) {
    items.forEach((item, index) => {
      if (item.lineIndex === null || index === overlay) return;
      const overlap = intersectionArea(boxes[index]!, boxes[overlay]!);
      if (overlap / areas[index]! >= MIN_OVERLAP_RATIO) suppressed.add(index);
    });
  }

  interface Pair {
    i: number;
    j: number;
    weight: number;
  }
  const structural = (index: number): boolean =>
    screenArea > 0 && areas[index]! / screenArea > DOMINANT_MAX_SCREEN_RATIO;
  const pairs: Pair[] = [];
  if (items.length >= 2) {
    for (let i = 0; i < items.length; i += 1) {
      const itemI = items[i]!;
      if (itemI.lineIndex === null || suppressed.has(i) || structural(i)) continue;
      for (let j = i + 1; j < items.length; j += 1) {
        const itemJ = items[j]!;
        if (itemJ.lineIndex === null || suppressed.has(j) || structural(j)) continue;
        if (dominant.includes(i) || dominant.includes(j)) continue;
        const overlap = intersectionArea(boxes[i]!, boxes[j]!);
        if (overlap === 0) continue;
        if (isConcentricContainment(boxes[i]!, boxes[j]!, areas[i]!, areas[j]!)) continue;
        const ratioI = overlap / areas[i]!;
        const ratioJ = overlap / areas[j]!;
        const weight = Math.max(ratioI, ratioJ);
        if (weight >= MIN_OVERLAP_RATIO) pairs.push({ i, j, weight });
      }
    }
  }

  pairs.sort((a, b) => b.weight - a.weight);
  const warningMap = new Map<number, number[]>();
  for (const pair of pairs.slice(0, MAX_PAIR_WARNINGS)) {
    const lineI = items[pair.i]!.lineIndex!;
    const lineJ = items[pair.j]!.lineIndex!;
    warningMap.set(lineI, [...(warningMap.get(lineI) ?? []), lineJ]);
    warningMap.set(lineJ, [...(warningMap.get(lineJ) ?? []), lineI]);
  }
  for (const [line, refs] of warningMap) {
    const unique = [...new Set(refs)].sort((a, b) => a - b);
    const shown = unique.slice(0, MAX_OVERLAP_REFS).map((ref) => `[${ref}]`).join(" and ");
    const extra = unique.length > MAX_OVERLAP_REFS ? ` (+${unique.length - MAX_OVERLAP_REFS} more)` : "";
    perLine.set(line, ` (WARNING: may overlap with ${shown}, possible occlusion)${extra}`);
  }

  let globalLine: string | null = null;
  if (dominant.length > 0) {
    const overlay = items[dominant[0]!]!;
    const label = overlay.type.trim() || "未知元素";
    globalLine = `检测到疑似大面积遮挡层（${label}，覆盖多个元素）；建议先用 alerts/关闭操作处理再继续。`;
  }
  return { globalLine, perLine };
}

export function annotateOcclusionWarnings(lines: string[], result: OcclusionResult): string[] {
  const annotated = lines.map((line) => {
    const match = /^\[(\d+)\]/.exec(line);
    if (!match) return line;
    const index = Number(match[1]);
    const suffix = result.perLine.get(index);
    return suffix ? `${line}${suffix}` : line;
  });
  if (result.globalLine) annotated.push(result.globalLine);
  return annotated;
}

export function occlusionItemsFromNodes(
  nodes: IosUiNode[],
  renderedIndex: (node: IosUiNode) => number | null
): OcclusionItem[] {
  return nodes.map((node) => ({
    rect: node.rect,
    type: node.type,
    hasText: Boolean(node.label.trim() || node.value.trim()),
    lineIndex: renderedIndex(node)
  }));
}

export function screenAreaOf(
  nodes: IosUiNode[],
  size: { width: number; height: number } | null
): number {
  if (size && size.width > 0 && size.height > 0) return size.width * size.height;
  const application = nodes.find((node) => node.type === "Application" && node.rect.width > 200);
  if (application) return application.rect.width * application.rect.height;
  let maxRight = 0;
  let maxBottom = 0;
  for (const node of nodes) {
    maxRight = Math.max(maxRight, node.rect.x + node.rect.width);
    maxBottom = Math.max(maxBottom, node.rect.y + node.rect.height);
  }
  return maxRight * maxBottom;
}
