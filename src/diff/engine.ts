import { decode as decodeJpeg } from "jpeg-js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SEVERITY_ORDER = ["blocker", "major", "minor", "info"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

export const CATEGORY_ORDER = ["missing", "extra", "text", "asset", "position-size", "color", "pixel"] as const;

export type DiffCategory = (typeof CATEGORY_ORDER)[number];

export interface DesignNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  parentFill?: string;
}

export interface DiffRegion {
  bbox: Bbox;
  category: DiffCategory;
  severity: Severity;
  pixelDiffRatio: number;
  designNode?: { id: string; name: string };
  suspected?: "system-area";
}

export interface DiffAlignment {
  scale: number;
  offset: { x: number; y: number };
  insets: Insets;
  downsampledTo?: number;
}

export interface DiffSummary {
  regions: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface DiffThresholds {
  pixelThreshold: number;
  minAreaRatio: number;
  clusterGap: number;
  maxRegions: number;
  maxEdge: number;
  nodeProximity: number;
  colorTolerance: number;
  systemBandRatio: number;
}

export interface DiffResult {
  alignment: DiffAlignment;
  ignoredRegions: Bbox[];
  regions: DiffRegion[];
  summary: DiffSummary;
  thresholds: DiffThresholds;
}

export interface DiffOptions {
  pixelThreshold?: number;
  minAreaRatio?: number;
  clusterGap?: number;
  maxRegions?: number;
  maxEdge?: number;
  insets?: Partial<Insets>;
  ignoreRegions?: Bbox[];
  designNodes?: DesignNode[];
  nodeProximity?: number;
  colorTolerance?: number;
  systemBandRatio?: number;
}

const DEFAULTS = {
  pixelThreshold: 0.1,
  minAreaRatio: 0.005,
  clusterGap: 8,
  maxRegions: 20,
  maxEdge: 1440,
  nodeProximity: 24,
  colorTolerance: 24,
  systemBandRatio: 0.05
};

export function decodeImage(bytes: Uint8Array): RgbaImage {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const png = PNG.sync.read(Buffer.from(bytes));
    return {
      width: png.width,
      height: png.height,
      data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength)
    };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: raw.width, height: raw.height, data: raw.data };
  }
  throw new Error("不支持的图片格式（仅 PNG/JPEG）");
}

export function resize(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width === image.width && height === image.height) return image;
  const out = new Uint8Array(width * height * 4);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const srcY = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(srcY);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = srcY - y0;
    for (let x = 0; x < width; x += 1) {
      const srcX = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(srcX);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = srcX - x0;
      const pos = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = image.data[(y0 * image.width + x0) * 4 + channel]! * (1 - wx) + image.data[(y0 * image.width + x1) * 4 + channel]! * wx;
        const bottom = image.data[(y1 * image.width + x0) * 4 + channel]! * (1 - wx) + image.data[(y1 * image.width + x1) * 4 + channel]! * wx;
        out[pos + channel] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width, height, data: out };
}

function normalizeInsets(insets: Partial<Insets> | undefined, image: RgbaImage): Insets {
  const clamp = (value: number | undefined, limit: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value!), 0), limit) : 0;
  return {
    top: clamp(insets?.top, image.height - 1),
    right: clamp(insets?.right, image.width - 1),
    bottom: clamp(insets?.bottom, image.height - 1),
    left: clamp(insets?.left, image.width - 1)
  };
}

function cropInsets(image: RgbaImage, insets: Insets): RgbaImage {
  const width = image.width - insets.left - insets.right;
  const height = image.height - insets.top - insets.bottom;
  if (width <= 0 || height <= 0) throw new Error("insets 过大：裁剪后设备截图为空");
  if (insets.top === 0 && insets.right === 0 && insets.bottom === 0 && insets.left === 0) return image;
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = ((row + insets.top) * image.width + insets.left) * 4;
    out.set(image.data.subarray(source, source + width * 4), row * width * 4);
  }
  return { width, height, data: out };
}

function sliceRows(image: RgbaImage, rows: number): RgbaImage {
  if (rows >= image.height) return image;
  const out = new Uint8Array(image.width * rows * 4);
  out.set(image.data.subarray(0, image.width * rows * 4));
  return { width: image.width, height: rows, data: out };
}

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

function findComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const components: Component[] = [];
  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    const component: Component = { minX: width, minY: height, maxX: -1, maxY: -1, count: 0 };
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index / width) | 0;
      component.count += 1;
      if (x < component.minX) component.minX = x;
      if (y < component.minY) component.minY = y;
      if (x > component.maxX) component.maxX = x;
      if (y > component.maxY) component.maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] === 1 && visited[next] === 0) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

function mergeComponents(components: Component[], gap: number): Component[] {
  if (components.length <= 1) return components;
  const parent = components.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const order = components
    .map((_, index) => index)
    .sort((a, b) => components[a]!.minX - components[b]!.minX || components[a]!.minY - components[b]!.minY || a - b);
  for (let i = 0; i < order.length; i += 1) {
    const a = components[order[i]!]!;
    for (let j = i + 1; j < order.length; j += 1) {
      const b = components[order[j]!]!;
      if (b.minX - gap > a.maxX) break;
      if (a.minY - gap <= b.maxY && b.minY - gap <= a.maxY) {
        union(order[i]!, order[j]!);
      }
    }
  }
  const merged = new Map<number, Component>();
  for (let index = 0; index < components.length; index += 1) {
    const root = find(index);
    const component = components[index]!;
    const current = merged.get(root);
    if (!current) {
      merged.set(root, { ...component });
    } else {
      current.minX = Math.min(current.minX, component.minX);
      current.minY = Math.min(current.minY, component.minY);
      current.maxX = Math.max(current.maxX, component.maxX);
      current.maxY = Math.max(current.maxY, component.maxY);
      current.count += component.count;
    }
  }
  return [...merged.values()];
}

function severityForRatio(ratio: number): Severity {
  if (ratio >= 0.1) return "blocker";
  if (ratio >= 0.03) return "major";
  if (ratio >= 0.005) return "minor";
  return "info";
}

const CATEGORY_FLOOR: Partial<Record<DiffCategory, Severity>> = {
  missing: "major",
  extra: "major",
  text: "major"
};

function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b;
}

const ASSET_TYPES = new Set([
  "image",
  "vector",
  "path",
  "ellipse",
  "polygon",
  "star",
  "line",
  "boolean_operation"
]);

const NODE_COVERAGE = 0.6;

function hexToRgb(value: string | undefined): { rgb: [number, number, number]; alpha: number } | null {
  if (!value) return null;
  const raw = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6,8}$/.test(raw)) return null;
  return {
    rgb: [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)],
    alpha: raw.length === 8 ? parseInt(raw.slice(6, 8), 16) : 255
  };
}

function colorMatches(a: [number, number, number], b: [number, number, number], tolerance: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance
  );
}

function meanColor(image: RgbaImage, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const left = Math.max(0, Math.min(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const right = Math.min(image.width, Math.max(x0, x1));
  const bottom = Math.min(image.height, Math.max(y0, y1));
  if (right <= left || bottom <= top) return [0, 0, 0];
  const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 1024)));
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const position = (y * image.width + x) * 4;
      red += image.data[position]!;
      green += image.data[position + 1]!;
      blue += image.data[position + 2]!;
      count += 1;
    }
  }
  return count > 0
    ? [Math.round(red / count), Math.round(green / count), Math.round(blue / count)]
    : [0, 0, 0];
}

interface WorkingNode extends DesignNode {
  wx: number;
  wy: number;
  ww: number;
  wh: number;
}

function classifyRegion(
  bbox: Bbox,
  nodes: WorkingNode[],
  deviceWork: RgbaImage,
  options: { proximity: number; tolerance: number }
): { category: DiffCategory; designNode?: { id: string; name: string } } {
  let dominant: WorkingNode | null = null;
  let bestArea = 0;
  for (const node of nodes) {
    const overlapWidth = Math.max(
      0,
      Math.min(bbox.x + bbox.width, node.wx + node.ww) - Math.max(bbox.x, node.wx)
    );
    const overlapHeight = Math.max(
      0,
      Math.min(bbox.y + bbox.height, node.wy + node.wh) - Math.max(bbox.y, node.wy)
    );
    const area = overlapWidth * overlapHeight;
    if (area > bestArea) {
      bestArea = area;
      dominant = node;
    }
  }

  if (dominant && bestArea > 0) {
    const reference = { id: dominant.id, name: dominant.name };
    const coveredByNode = bestArea / (bbox.width * bbox.height);
    const nodeCovered = bestArea / (dominant.ww * dominant.wh);
    if (coveredByNode >= NODE_COVERAGE) {
      const type = dominant.type.toLowerCase();
      if (type === "text" || (dominant.text && dominant.text.length > 0)) {
        return { category: "text", designNode: reference };
      }
      if (ASSET_TYPES.has(type)) return { category: "asset", designNode: reference };
      if (nodeCovered >= NODE_COVERAGE) {
        const parentFill = hexToRgb(dominant.parentFill);
        if (parentFill && parentFill.alpha >= 250) {
          const mean = meanColor(deviceWork, dominant.wx, dominant.wy, dominant.wx + dominant.ww, dominant.wy + dominant.wh);
          if (colorMatches(mean, parentFill.rgb, options.tolerance)) return { category: "missing", designNode: reference };
        }
        return { category: "color", designNode: reference };
      }
      return { category: "position-size", designNode: reference };
    }
    return { category: "position-size", designNode: reference };
  }

  let nearest = Number.POSITIVE_INFINITY;
  let nearestNode: WorkingNode | null = null;
  for (const node of nodes) {
    const dx = Math.max(node.wx - (bbox.x + bbox.width), bbox.x - (node.wx + node.ww), 0);
    const dy = Math.max(node.wy - (bbox.y + bbox.height), bbox.y - (node.wy + node.wh), 0);
    const distance = Math.hypot(dx, dy);
    if (distance < nearest) {
      nearest = distance;
      nearestNode = node;
    }
  }
  if (nearest <= options.proximity && nearestNode) {
    return { category: "position-size", designNode: { id: nearestNode.id, name: nearestNode.name } };
  }
  return { category: "extra" };
}

export function diffScreens(design: RgbaImage, device: RgbaImage, options: DiffOptions = {}): DiffResult {
  const pixelThreshold = options.pixelThreshold ?? DEFAULTS.pixelThreshold;
  const minAreaRatio = options.minAreaRatio ?? DEFAULTS.minAreaRatio;
  const clusterGap = Math.max(0, Math.trunc(options.clusterGap ?? DEFAULTS.clusterGap));
  const maxRegions = Math.max(1, Math.trunc(options.maxRegions ?? DEFAULTS.maxRegions));
  const maxEdge = Math.max(64, Math.trunc(options.maxEdge ?? DEFAULTS.maxEdge));
  const nodeProximity = Math.max(0, Math.trunc(options.nodeProximity ?? DEFAULTS.nodeProximity));
  const colorTolerance = Math.max(0, Math.trunc(options.colorTolerance ?? DEFAULTS.colorTolerance));
  const systemBandRatio = Math.min(0.25, Math.max(0, options.systemBandRatio ?? DEFAULTS.systemBandRatio));

  const insets = normalizeInsets(options.insets, device);
  const cropped = cropInsets(device, insets);

  const longest = Math.max(design.width, design.height, cropped.width, cropped.height);
  const factor = longest > maxEdge ? maxEdge / longest : 1;
  const designWork = factor < 1 ? resize(design, Math.max(1, Math.round(design.width * factor)), Math.max(1, Math.round(design.height * factor))) : design;
  const deviceWork = factor < 1 ? resize(cropped, Math.max(1, Math.round(cropped.width * factor)), Math.max(1, Math.round(cropped.height * factor))) : cropped;

  const scale = designWork.width / deviceWork.width;
  const deviceScaledHeight = Math.max(1, Math.round(deviceWork.height * scale));
  const deviceScaled = resize(deviceWork, designWork.width, deviceScaledHeight);

  const compareHeight = Math.min(designWork.height, deviceScaledHeight);
  const designPart = sliceRows(designWork, compareHeight);
  const devicePart = sliceRows(deviceScaled, compareHeight);
  const diffOutput = new Uint8Array(designWork.width * compareHeight * 4);
  pixelmatch(designPart.data, devicePart.data, diffOutput, designWork.width, compareHeight, {
    threshold: pixelThreshold,
    diffMask: true
  });

  const mask = new Uint8Array(designWork.width * designWork.height);
  for (let index = 0; index < designWork.width * compareHeight; index += 1) {
    if (diffOutput[index * 4 + 3] !== 0) mask[index] = 1;
  }
  if (designWork.height - compareHeight > clusterGap && compareHeight < designWork.height) {
    mask.fill(1, designWork.width * compareHeight);
  }

  const ignoredRegions: Bbox[] = [];
  for (const raw of options.ignoreRegions ?? []) {
    const scaled: Bbox = {
      x: Math.floor(raw.x * factor),
      y: Math.floor(raw.y * factor),
      width: Math.ceil(raw.width * factor),
      height: Math.ceil(raw.height * factor)
    };
    const x0 = Math.max(0, scaled.x);
    const y0 = Math.max(0, scaled.y);
    const x1 = Math.min(designWork.width, scaled.x + Math.max(0, scaled.width));
    const y1 = Math.min(designWork.height, scaled.y + Math.max(0, scaled.height));
    for (let y = y0; y < y1; y += 1) {
      mask.fill(0, y * designWork.width + x0, y * designWork.width + x1);
    }
    ignoredRegions.push({
      x: Math.max(0, Math.trunc(raw.x)),
      y: Math.max(0, Math.trunc(raw.y)),
      width: Math.max(0, Math.trunc(raw.width)),
      height: Math.max(0, Math.trunc(raw.height))
    });
  }

  const components = mergeComponents(findComponents(mask, designWork.width, designWork.height), clusterGap);
  const areaTotal = designWork.width * designWork.height;
  const minimumArea = Math.max(1, Math.round(minAreaRatio * areaTotal));
  const workingNodes: WorkingNode[] = (options.designNodes ?? []).map((node) => ({
    ...node,
    wx: node.x * factor,
    wy: node.y * factor,
    ww: Math.max(1, node.width * factor),
    wh: Math.max(1, node.height * factor)
  }));

  const workingRegions = components
    .filter((component) => component.count >= minimumArea)
    .sort((a, b) => b.count - a.count || a.minY - b.minY || a.minX - b.minX)
    .slice(0, maxRegions)
    .map((component) => {
      const width = component.maxX - component.minX + 1;
      const height = component.maxY - component.minY + 1;
      const ratio = component.count / areaTotal;
      const workingBox: Bbox = { x: component.minX, y: component.minY, width, height };
      const classified = workingNodes.length > 0
        ? classifyRegion(workingBox, workingNodes, deviceWork, { proximity: nodeProximity, tolerance: colorTolerance })
        : { category: "pixel" as DiffCategory };
      const band = Math.round(designWork.height * systemBandRatio);
      const suspected =
        !classified.designNode && band > 0 && (workingBox.y <= band || workingBox.y + workingBox.height >= designWork.height - band)
          ? ("system-area" as const)
          : undefined;
      const severity = suspected
        ? "info"
        : worseSeverity(severityForRatio(ratio), CATEGORY_FLOOR[classified.category] ?? "info");
      return {
        bbox: {
          x: Math.max(0, Math.round(component.minX / factor)),
          y: Math.max(0, Math.round(component.minY / factor)),
          width: Math.max(1, Math.round(width / factor)),
          height: Math.max(1, Math.round(height / factor))
        },
        category: classified.category,
        severity,
        pixelDiffRatio: Math.min(1, component.count / (width * height)),
        ...(classified.designNode ? { designNode: classified.designNode } : {}),
        ...(suspected ? { suspected } : {})
      } satisfies DiffRegion;
    });

  workingRegions.sort((a, b) => {
    const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severity !== 0) return severity;
    const areaA = a.bbox.width * a.bbox.height;
    const areaB = b.bbox.width * b.bbox.height;
    if (areaA !== areaB) return areaB - areaA;
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const region of workingRegions) {
    bySeverity[region.severity] = (bySeverity[region.severity] ?? 0) + 1;
    byCategory[region.category] = (byCategory[region.category] ?? 0) + 1;
  }

  return {
    alignment: {
      scale,
      offset: { x: 0, y: 0 },
      insets,
      ...(factor < 1 ? { downsampledTo: maxEdge } : {})
    },
    ignoredRegions,
    regions: workingRegions,
    summary: { regions: workingRegions.length, bySeverity, byCategory },
    thresholds: {
      pixelThreshold,
      minAreaRatio,
      clusterGap,
      maxRegions,
      maxEdge,
      nodeProximity,
      colorTolerance,
      systemBandRatio
    }
  };
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}
