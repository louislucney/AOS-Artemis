import fs from "node:fs";
import path from "node:path";

import { PNG } from "pngjs";

import { readPenTextBounds, type PenTextBound } from "../../pen/bounds.js";
import { renderPenScreens } from "../../pen/render.js";
import { loadPenDocument } from "../../pen/paths.js";
import type { PenNode } from "../../pen/read.js";
import { splitPenScreens } from "../../pen/split.js";
import { pngDimensions } from "../screens.js";
import type { FlowWarning } from "../../figma/flows.js";
import {
  pairContainers,
  type InteractionFrame,
  type InteractionNode,
  type InteractionPairingStats,
  type InteractionViewport,
  type VisualSimilarity
} from "./interaction.js";

interface RawState {
  id?: unknown;
  label?: unknown;
  frameName?: unknown;
}

interface RawScreen {
  id?: unknown;
  name?: unknown;
  sourceFrameName?: unknown;
  sourceBoard?: unknown;
  states?: unknown;
}

interface RawFlows {
  source?: unknown;
  screens?: unknown;
}

export interface InteractionFrameBuildResult {
  frames: InteractionFrame[];
  imageById: Map<string, string>;
  viewport: InteractionViewport;
  warnings: FlowWarning[];
}

export interface InteractionReport {
  candidates: ReturnType<typeof pairContainers>["candidates"];
  questions: ReturnType<typeof pairContainers>["questions"];
  stats: InteractionPairingStats;
  frames: number;
  warnings: FlowWarning[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function findPen(designRoot: string, id: string): string | null {
  const candidates = [
    path.join(designRoot, "pen", "screens", `${id}.pen`),
    path.join(designRoot, "pen", "states", `${id}.pen`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function findImages(designRoot: string): Map<string, string> {
  const root = path.join(designRoot, "screens");
  const out = new Map<string, string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, entry.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const id = file.slice(0, -".png".length);
      if (!out.has(id)) out.set(id, path.join(root, entry.name, file));
    }
  }
  return out;
}

function resolvePenSource(flowsPath: string, projectRoot: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(flowsPath, "utf-8")) as RawFlows;
    const source = asString(raw.source);
    if (source === null || !source.startsWith("pen:")) return null;
    const value = source.slice("pen:".length).trim();
    if (value === "") return null;
    return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  } catch {
    return null;
  }
}

function ensurePenFiles(
  designRoot: string,
  flowsPath: string,
  projectRoot: string,
  ids: string[],
  outDir: "screens" | "states"
): FlowWarning[] {
  const missing = [...new Set(ids)].filter((id) => findPen(designRoot, id) === null);
  if (missing.length === 0) return [];
  const source = resolvePenSource(flowsPath, projectRoot);
  if (source === null || !fs.existsSync(source)) {
    return [
      {
        code: "interaction-pen-source-missing",
        message: "缺少可拆分的源 .pen，交互推断跳过部分屏幕",
        details: missing.slice(0, 10)
      }
    ];
  }
  try {
    splitPenScreens({
      sourceFile: source,
      screenIds: missing,
      outDir: path.join(designRoot, "pen", outDir)
    });
    return [];
  } catch (error) {
    return [
      {
        code: "interaction-pen-split-failed",
        message: `逐屏 .pen 拆分失败：${error instanceof Error ? error.message : String(error)}`
      }
    ];
  }
}

function toNodes(
  nodes: PenNode[],
  parentX: number | null,
  parentY: number | null,
  bounds: Map<string, PenTextBound> | undefined
): InteractionNode[] {
  const out: InteractionNode[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const x = numeric(node.x);
    const y = numeric(node.y);
    const width = numeric(node.width);
    const height = numeric(node.height);
    const absolute =
      parentX !== null &&
      parentY !== null &&
      x !== null &&
      y !== null &&
      width !== null &&
      height !== null;
    let box = absolute ? { x: parentX + x, y: parentY + y, width, height } : null;
    if (box === null && bounds !== undefined && typeof node.id === "string") {
      const bound = bounds.get(node.id);
      if (bound !== undefined) {
        box = { x: bound.x, y: bound.y, width: bound.width, height: bound.height };
      }
    }
    const children = toNodes(
      Array.isArray(node.children) ? node.children : [],
      box?.x ?? null,
      box?.y ?? null,
      bounds
    );
    out.push({
      id: typeof node.id === "string" ? node.id : "",
      name: typeof node.name === "string" ? node.name : "",
      text: typeof node.content === "string" ? node.content : null,
      geometry:
        box === null
          ? { kind: "missing", reason: "auto-layout" }
          : { kind: "exact", box, space: "design-px", absolute: true },
      children
    });
  }
  return out;
}

function penFrame(
  id: string,
  name: string,
  boardId: string,
  parentId: string | null,
  penFile: string,
  viewport: InteractionViewport,
  rendered: { width: number; height: number } | null,
  boundsFor: ((file: string) => PenTextBound[]) | undefined
): InteractionFrame | null {
  let root: PenNode;
  try {
    root = loadPenDocument(penFile);
  } catch {
    return null;
  }
  const dims =
    rendered ??
    (numeric(root.width) !== null && numeric(root.height) !== null
      ? { width: numeric(root.width)!, height: numeric(root.height)! }
      : null);
  if (dims === null) return null;
  return {
    id,
    name,
    boardId,
    parentId,
    rendered: dims,
    viewport,
    nodes: toNodes(
      Array.isArray(root.children?.[0]?.children) ? root.children[0]!.children! : [],
      0,
      0,
      boundsFor === undefined ? undefined : new Map(boundsFor(penFile).map((bound) => [bound.id, bound]))
    )
  };
}

function penFrameFromNode(
  id: string,
  name: string,
  boardId: string,
  parentId: string | null,
  node: PenNode,
  viewport: InteractionViewport,
  rendered: { width: number; height: number } | null,
  boundsFor: ((file: string) => PenTextBound[]) | undefined,
  penFile: string
): InteractionFrame | null {
  const dims =
    rendered ??
    (numeric(node.width) !== null && numeric(node.height) !== null
      ? { width: numeric(node.width)!, height: numeric(node.height)! }
      : null);
  if (dims === null) return null;
  return {
    id,
    name,
    boardId,
    parentId,
    rendered: dims,
    viewport,
    nodes: toNodes(
      Array.isArray(node.children) ? node.children : [],
      0,
      0,
      boundsFor === undefined ? undefined : new Map(boundsFor(penFile).map((bound) => [bound.id, bound]))
    )
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export async function buildInteractionFrames(input: {
  designRoot: string;
  flowsPath: string;
  projectRoot: string;
  viewport?: InteractionViewport;
  boundsFor?: (file: string) => PenTextBound[];
}): Promise<InteractionFrameBuildResult> {
  const raw = JSON.parse(fs.readFileSync(input.flowsPath, "utf-8")) as RawFlows;
  const screens = Array.isArray(raw.screens) ? (raw.screens as RawScreen[]) : [];
  const images = findImages(input.designRoot);
  const mainIds = screens.map((screen) => asString(screen.id)).filter((id): id is string => id !== null);
  const stateIds: string[] = [];
  for (const screen of screens) {
    const states = Array.isArray(screen.states) ? (screen.states as RawState[]) : [];
    for (const state of states) {
      const id = asString(state.id);
      if (id !== null) stateIds.push(id);
    }
  }
  const warnings = [
    ...ensurePenFiles(input.designRoot, input.flowsPath, input.projectRoot, mainIds, "screens"),
    ...ensurePenFiles(input.designRoot, input.flowsPath, input.projectRoot, stateIds, "states")
  ];

  const mainFrames: Array<{
    id: string;
    name: string;
    board: string;
    pen: string;
    image: string | null;
  }> = [];
  for (const screen of screens) {
    const id = asString(screen.id);
    const name = asString(screen.name);
    if (id === null || name === null) continue;
    const pen = findPen(input.designRoot, id);
    if (pen === null) continue;
    mainFrames.push({
      id,
      name,
      board: asString(screen.sourceBoard) ?? id,
      pen,
      image: images.get(id) ?? null
    });
  }

  const widths = mainFrames
    .map((frame) => (frame.image === null ? null : pngDimensions(fs.readFileSync(frame.image))))
    .filter((dims): dims is { width: number; height: number } => dims !== null)
    .filter((dims) => dims.width >= 300 && dims.width <= 600 && dims.height >= 500 && dims.height <= 1200)
    .map((dims) => dims.width);
  const heights = mainFrames
    .map((frame) => (frame.image === null ? null : pngDimensions(fs.readFileSync(frame.image))))
    .filter((dims): dims is { width: number; height: number } => dims !== null)
    .filter((dims) => dims.width >= 300 && dims.width <= 600 && dims.height >= 500 && dims.height <= 1200)
    .map((dims) => dims.height);
  const viewport = input.viewport ?? {
    width: median(widths) ?? 375,
    height: median(heights) ?? 855
  };

  const frames: InteractionFrame[] = [];
  const imageById = new Map<string, string>();
  for (const entry of mainFrames) {
    const image = entry.image;
    const rendered = image === null ? null : pngDimensions(fs.readFileSync(image));
    const frame = penFrame(
      entry.id,
      entry.name,
      entry.board,
      null,
      entry.pen,
      viewport,
      rendered,
      input.boundsFor
    );
    if (frame === null) {
      warnings.push({
        code: "interaction-frame-unavailable",
        message: `无法构建交互帧：${entry.id}`
      });
      continue;
    }
    frames.push(frame);
    if (image !== null) imageById.set(entry.id, image);
  }

  for (const screen of screens) {
    const parentId = asString(screen.id);
    const parentName = asString(screen.name);
    if (parentId === null || parentName === null) continue;
    const board = asString(screen.sourceBoard) ?? parentId;
    const states = Array.isArray(screen.states) ? (screen.states as RawState[]) : [];
    for (const state of states) {
      const id = asString(state.id);
      const label = asString(state.label) ?? asString(state.frameName) ?? id;
      if (id === null || label === null) continue;
      const pen = findPen(input.designRoot, id);
      if (pen === null) continue;
      const image = images.get(id) ?? null;
      const rendered = image === null ? null : pngDimensions(fs.readFileSync(image));
      const frame = penFrame(id, label, board, parentId, pen, viewport, rendered, input.boundsFor);
      if (frame === null) continue;
      frames.push(frame);
      if (image !== null) imageById.set(id, image);
    }
  }

  const contentDescriptors: Array<{
    id: string;
    name: string;
    board: string;
    parentId: string;
    node: PenNode;
    pen: string;
    rendered: { width: number; height: number } | null;
  }> = [];
  for (const frame of frames) {
    const pen = findPen(input.designRoot, frame.id);
    if (pen === null) continue;
    let root: PenNode;
    try {
      root = loadPenDocument(pen);
    } catch {
      continue;
    }
    const screenNode = root.children?.[0];
    for (const child of screenNode?.children ?? []) {
      if (child === null || typeof child !== "object" || child.type !== "frame") continue;
      const id = asString(child.id);
      const name = asString(child.name);
      if (id === null || name === null) continue;
      if (frames.some((entry) => entry.id === id) || contentDescriptors.some((entry) => entry.id === id)) {
        continue;
      }
      const width = numeric(child.width) ?? frame.rendered.width;
      const height = numeric(child.height);
      if (width === null || height === null || width < 300 || height < 100) continue;
      contentDescriptors.push({
        id,
        name,
        board: frame.boardId ?? frame.id,
        parentId: frame.id,
        node: child,
        pen,
        rendered: { width, height }
      });
    }
  }
  const source = resolvePenSource(input.flowsPath, input.projectRoot);
  if (source !== null && contentDescriptors.length > 0) {
    const renderDir = path.join(input.designRoot, "screens", "interaction");
    const allPresent = contentDescriptors.every((entry) =>
      fs.existsSync(path.join(renderDir, `${entry.id}.png`))
    );
    if (!allPresent) {
      try {
        await renderPenScreens({
          target: source,
          screenIds: contentDescriptors.map((entry) => entry.id),
          outDir: renderDir,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined
            )
          )
        });
      } catch {
        /* best effort */
      }
    }
    for (const entry of contentDescriptors) {
      const image = path.join(renderDir, `${entry.id}.png`);
      const rendered = fs.existsSync(image) ? pngDimensions(fs.readFileSync(image)) : null;
      const frame = penFrameFromNode(
        entry.id,
        entry.name,
        entry.board,
        entry.parentId,
        entry.node,
        viewport,
        rendered ?? entry.rendered,
        input.boundsFor,
        entry.pen
      );
      if (frame === null) continue;
      frames.push(frame);
      if (fs.existsSync(image)) imageById.set(entry.id, image);
    }
  }

  return { frames, imageById, viewport, warnings };
}

function grayscale(file: string): { width: number; height: number; data: Float64Array } | null {
  try {
    const png = PNG.sync.read(fs.readFileSync(file));
    const data = new Float64Array(png.width * png.height);
    for (let index = 0; index < data.length; index++) {
      const offset = index * 4;
      data[index] =
        0.299 * png.data[offset]! + 0.587 * png.data[offset + 1]! + 0.114 * png.data[offset + 2]!;
    }
    return { width: png.width, height: png.height, data };
  } catch {
    return null;
  }
}

export function createPngVisual(imageById: Map<string, string>): VisualSimilarity {
  const cache = new Map<string, ReturnType<typeof grayscale>>();
  return (aFrameId, bFrameId, offset) => {
    for (const id of [aFrameId, bFrameId]) {
      if (!cache.has(id)) {
        const file = imageById.get(id);
        cache.set(id, file === undefined ? null : grayscale(file));
      }
    }
    const a = cache.get(aFrameId) ?? null;
    const b = cache.get(bFrameId) ?? null;
    if (a === null || b === null) return null;
    let shift = offset;
    let first = a;
    let second = b;
    if (shift < 0) {
      first = b;
      second = a;
      shift = -shift;
    }
    const height = Math.min(second.height, first.height - shift);
    if (height <= 100) return null;
    let sumA = 0;
    let sumB = 0;
    let sumAA = 0;
    let sumBB = 0;
    let sumAB = 0;
    let count = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < Math.min(first.width, second.width); x += 2) {
        const va = first.data[(y + shift) * first.width + x]!;
        const vb = second.data[y * second.width + x]!;
        sumA += va;
        sumB += vb;
        sumAA += va * va;
        sumBB += vb * vb;
        sumAB += va * vb;
        count += 1;
      }
    }
    const covariance = sumAB / count - (sumA / count) * (sumB / count);
    const varianceA = sumAA / count - (sumA / count) ** 2;
    const varianceB = sumBB / count - (sumB / count) ** 2;
    if (varianceA <= 0 || varianceB <= 0) return null;
    return covariance / Math.sqrt(varianceA * varianceB);
  };
}

interface PenBoundsCacheFile {
  [file: string]: { mtimeMs: number; size: number; bounds: PenTextBound[] };
}

function createPenBoundsCache(designRoot: string): {
  forFile: (file: string) => PenTextBound[];
  flush: () => void;
} {
  const cachePath = path.join(designRoot, "pen", "text-bounds.json");
  let cache: PenBoundsCacheFile = {};
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as PenBoundsCacheFile;
  } catch {
    cache = {};
  }
  let dirty = false;
  const forFile = (file: string): PenTextBound[] => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    const existing = cache[file];
    if (existing !== undefined && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
      return existing.bounds;
    }
    let bounds: PenTextBound[] = [];
    try {
      bounds = readPenTextBounds(file);
    } catch {
      bounds = [];
    }
    cache[file] = { mtimeMs: stat.mtimeMs, size: stat.size, bounds };
    dirty = true;
    return bounds;
  };
  const flush = (): void => {
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n");
    } catch {
      /* best effort */
    }
  };
  return { forFile, flush };
}

export async function buildInteractionReport(input: {
  designRoot: string;
  flowsPath: string;
  projectRoot: string;
  viewport?: InteractionViewport;
  visual?: VisualSimilarity;
  usePenBounds?: boolean;
  requireVisual?: boolean;
}): Promise<InteractionReport | null> {
  const boundsCache = input.usePenBounds === true ? createPenBoundsCache(input.designRoot) : null;
  const built = await buildInteractionFrames({
    ...input,
    ...(boundsCache === null ? {} : { boundsFor: boundsCache.forFile })
  });
  boundsCache?.flush();
  if (built.frames.length < 2) return null;
  const visual = input.visual ?? createPngVisual(built.imageById);
  const result = pairContainers(built.frames, {
    viewport: built.viewport,
    visual,
    requireVisual: input.requireVisual ?? true
  });
  return {
    candidates: result.candidates,
    questions: result.questions,
    stats: result.stats,
    frames: built.frames.length,
    warnings: built.warnings
  };
}
