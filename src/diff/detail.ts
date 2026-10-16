import type { Bbox, DesignNode } from "./engine.js";

export type DetailRegionSource = "node" | "diff" | "tile" | "manual";

export interface DetailRegion {
  idx: number;
  source: DetailRegionSource;
  bbox: Bbox;
  name?: string;
}

export interface ProposeRegionsInput {
  designWidth: number;
  designHeight: number;
  nodes: DesignNode[];
  screenRegionBboxes: Bbox[];
  mode: "auto" | "nodes" | "tiles" | "none" | Bbox[];
  maxRegions: number;
  padding?: number;
  mergeGap?: number;
  tileSize?: number;
  tileOverlap?: number;
}

export interface ProposeRegionsResult {
  regions: DetailRegion[];
  truncated: boolean;
  tilesUsed: boolean;
}

const DEFAULT_PADDING = 16;
const DEFAULT_MERGE_GAP = 12;
const DEFAULT_TILE_SIZE = 768;
const DEFAULT_TILE_OVERLAP = 128;

const areaOf = (box: { width: number; height: number }): number => Math.max(0, box.width) * Math.max(0, box.height);

function overlapArea(a: Bbox, b: Bbox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** A node counts as a container when deeper nodes contained in it (>=90% of
 * their own area inside) cover >=90% of the node's area. Keeps dividers and
 * other small filled shapes; drops cards/screens whose children take over. */
function isContainer(node: DesignNode, all: DesignNode[]): boolean {
  const own = areaOf(node);
  if (own <= 0) return true;
  const self: Bbox = node;
  const depth = node.depth ?? 0;
  let covered = 0;
  for (const other of all) {
    if (other === node) continue;
    if ((other.depth ?? 0) <= depth) continue;
    if (overlapArea(self, other) >= 0.9 * areaOf(other)) covered += areaOf(other);
  }
  return covered >= 0.9 * own;
}

function padClamp(node: DesignNode, padding: number, designWidth: number, designHeight: number): Bbox {
  const x0 = Math.max(0, Math.floor(node.x - padding));
  const y0 = Math.max(0, Math.floor(node.y - padding));
  const x1 = Math.min(designWidth, Math.ceil(node.x + node.width + padding));
  const y1 = Math.min(designHeight, Math.ceil(node.y + node.height + padding));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function union(a: Bbox, b: Bbox): Bbox {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

interface NamedBox {
  bbox: Bbox;
  name?: string;
}

function mergeBoxes(boxes: NamedBox[], gap: number): NamedBox[] {
  const sorted = [...boxes].sort(
    (a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x || a.bbox.width - b.bbox.width || a.bbox.height - b.bbox.height
  );
  const merged: NamedBox[] = [];
  for (const box of sorted) {
    const last = merged[merged.length - 1];
    if (last) {
      const inflated: Bbox = {
        x: last.bbox.x - gap,
        y: last.bbox.y - gap,
        width: last.bbox.width + gap * 2,
        height: last.bbox.height + gap * 2
      };
      if (overlapArea(inflated, box.bbox) > 0) {
        merged[merged.length - 1] = { bbox: union(last.bbox, box.bbox) };
        continue;
      }
    }
    merged.push({ ...box, bbox: { ...box.bbox } });
  }
  return merged;
}

function tileBoxes(width: number, height: number, size: number, overlap: number): Bbox[] {
  const step = Math.max(1, size - overlap);
  const axis = (limit: number): number[] => {
    if (limit <= size) return [0];
    const positions: number[] = [];
    for (let position = 0; position + size < limit; position += step) positions.push(position);
    positions.push(limit - size);
    return positions;
  };
  const xs = axis(width);
  const ys = axis(height);
  const tiles: Bbox[] = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
    }
  }
  return tiles;
}

function sortByPosition(a: Bbox, b: Bbox): number {
  return a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height;
}

function finalize(regions: Array<Omit<DetailRegion, "idx">>, maxRegions: number): { regions: DetailRegion[]; truncated: boolean } {
  const truncated = regions.length > maxRegions;
  const kept = regions.slice(0, maxRegions).sort((a, b) => sortByPosition(a.bbox, b.bbox));
  return { regions: kept.map((region, index) => ({ ...region, idx: index + 1 })), truncated };
}

export function proposeDetailRegions(input: ProposeRegionsInput): ProposeRegionsResult {
  const mode = input.mode;
  if (mode === "none") {
    return { regions: [], truncated: false, tilesUsed: false };
  }
  const designWidth = input.designWidth;
  const designHeight = input.designHeight;
  const designArea = areaOf({ width: designWidth, height: designHeight });
  const padding = input.padding ?? DEFAULT_PADDING;
  const mergeGap = input.mergeGap ?? DEFAULT_MERGE_GAP;

  if (Array.isArray(mode)) {
    const boxes = mode.map((bbox) => ({ source: "manual" as const, bbox: { ...bbox } }));
    const sorted = boxes.sort((a, b) => sortByPosition(a.bbox, b.bbox));
    const result = finalize(sorted, input.maxRegions);
    return { ...result, tilesUsed: false };
  }

  const usableNodes = input.nodes.filter(
    (node) => areaOf(node) > 0 && areaOf(node) < 0.95 * designArea && !isContainer(node, input.nodes)
  );
  const nodeRegions = mergeBoxes(
    usableNodes.map((node) => ({
      bbox: padClamp(node, padding, designWidth, designHeight),
      ...(typeof node.name === "string" && node.name !== "" ? { name: node.name } : {})
    })),
    mergeGap
  );

  const diffRegions: NamedBox[] = input.screenRegionBboxes.map((bbox) => ({ bbox: { ...bbox } }));
  const hasNodes = usableNodes.length > 0;

  let candidates: Array<{ source: DetailRegionSource; bbox: Bbox; name?: string }>;
  let tilesUsed = false;
  if (mode === "nodes") {
    candidates = nodeRegions.map((box) => ({ source: "node" as const, ...box }));
  } else if (mode === "tiles") {
    tilesUsed = true;
    candidates = tileBoxes(designWidth, designHeight, input.tileSize ?? DEFAULT_TILE_SIZE, input.tileOverlap ?? DEFAULT_TILE_OVERLAP).map(
      (bbox) => ({ source: "tile" as const, bbox })
    );
  } else {
    const diffs = diffRegions
      .sort((a, b) => sortByPosition(a.bbox, b.bbox))
      .map((box) => ({ source: "diff" as const, ...box }));
    if (hasNodes) {
      const nodes = nodeRegions
        .map((box) => ({ source: "node" as const, ...box }))
        .sort((a, b) => areaOf(a.bbox) - areaOf(b.bbox) || sortByPosition(a.bbox, b.bbox));
      candidates = [...diffs, ...nodes];
    } else {
      tilesUsed = true;
      const tiles = tileBoxes(designWidth, designHeight, input.tileSize ?? DEFAULT_TILE_SIZE, input.tileOverlap ?? DEFAULT_TILE_OVERLAP)
        .map((bbox) => ({ source: "tile" as const, bbox }))
        .sort((a, b) => areaOf(a.bbox) - areaOf(b.bbox) || sortByPosition(a.bbox, b.bbox));
      candidates = [...diffs, ...tiles];
    }
  }

  const result = finalize(candidates, input.maxRegions);
  return { ...result, tilesUsed };
}

export function scaleDetailNodes(nodes: DesignNode[], factor: number): DesignNode[] {
  return nodes.map((node) => ({
    ...node,
    x: node.x * factor,
    y: node.y * factor,
    width: node.width * factor,
    height: node.height * factor
  }));
}
