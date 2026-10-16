import { resize, type Bbox, type DesignNode, type RgbaImage } from "./engine.js";

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

export interface DetailGeometry {
  ratio: number;
  offset: { x: number; y: number };
}

export function resolveDetailGeometry(
  designSize: { width: number; height: number },
  deviceSize: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number }
): DetailGeometry {
  const croppedWidth = deviceSize.width - insets.left - insets.right;
  return {
    ratio: designSize.width > 0 ? croppedWidth / designSize.width : 1,
    offset: { x: insets.left, y: insets.top }
  };
}

export interface MappedDeviceRect {
  bbox: Bbox;
  clipped: boolean;
  visible: boolean;
}

export function mapRegionToDeviceRect(
  region: Bbox,
  geometry: DetailGeometry,
  deviceSize: { width: number; height: number },
  minVisiblePx = 4
): MappedDeviceRect {
  const x0 = geometry.offset.x + region.x * geometry.ratio;
  const y0 = geometry.offset.y + region.y * geometry.ratio;
  const x1 = geometry.offset.x + (region.x + region.width) * geometry.ratio;
  const y1 = geometry.offset.y + (region.y + region.height) * geometry.ratio;
  const clampedX0 = Math.max(0, Math.floor(x0));
  const clampedY0 = Math.max(0, Math.floor(y0));
  const clampedX1 = Math.min(deviceSize.width, Math.ceil(x1));
  const clampedY1 = Math.min(deviceSize.height, Math.ceil(y1));
  const bbox: Bbox = {
    x: clampedX0,
    y: clampedY0,
    width: Math.max(0, clampedX1 - clampedX0),
    height: Math.max(0, clampedY1 - clampedY0)
  };
  const clipped =
    clampedX0 !== Math.floor(x0) || clampedY0 !== Math.floor(y0) || clampedX1 !== Math.ceil(x1) || clampedY1 !== Math.ceil(y1);
  return { bbox, clipped, visible: bbox.width >= minVisiblePx && bbox.height >= minVisiblePx };
}

export interface DetailPairExtraction {
  design: RgbaImage;
  device: RgbaImage;
  upscaled: boolean;
  designDownscaled: boolean;
  clipped: boolean;
}

function clampBox(box: Bbox, width: number, height: number): Bbox | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function cropImage(image: RgbaImage, box: Bbox): RgbaImage {
  const out = { width: box.width, height: box.height, data: new Uint8Array(box.width * box.height * 4) };
  for (let row = 0; row < box.height; row += 1) {
    const source = ((box.y + row) * image.width + box.x) * 4;
    out.data.set(image.data.subarray(source, source + box.width * 4), row * box.width * 4);
  }
  return out;
}

/** Crops both sides of one design region onto the device-native grid. Design
 * pixels are upsampled when the render is below device scale (>2% area);
 * a design crop above device scale (>2% area) is flagged as an anomaly. */
export function extractDetailPair(input: {
  design: RgbaImage;
  device: RgbaImage;
  region: Bbox;
  geometry: DetailGeometry;
  minVisiblePx?: number;
}): DetailPairExtraction | null {
  const designBox = clampBox(input.region, input.design.width, input.design.height);
  if (!designBox) return null;
  const mapped = mapRegionToDeviceRect(input.region, input.geometry, input.device, input.minVisiblePx ?? 4);
  if (!mapped.visible) return null;
  const deviceCrop = cropImage(input.device, mapped.bbox);
  const designCrop = cropImage(input.design, designBox);
  const designClamped =
    designBox.x !== input.region.x ||
    designBox.y !== input.region.y ||
    designBox.width !== input.region.width ||
    designBox.height !== input.region.height;
  let design = designCrop;
  let upscaled = false;
  let designDownscaled = false;
  if (designCrop.width !== deviceCrop.width || designCrop.height !== deviceCrop.height) {
    const sourceArea = designCrop.width * designCrop.height;
    const targetArea = deviceCrop.width * deviceCrop.height;
    upscaled = sourceArea < targetArea * 0.98;
    designDownscaled = sourceArea > targetArea * 1.02;
    design = resize(designCrop, deviceCrop.width, deviceCrop.height);
  }
  return { design, device: deviceCrop, upscaled, designDownscaled, clipped: mapped.clipped || designClamped };
}
