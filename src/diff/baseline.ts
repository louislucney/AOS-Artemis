import fs from "node:fs";
import path from "node:path";

import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import { captureStepScreenshot } from "./device-source.js";
import {
  decodeImage,
  diffScreens,
  type Bbox,
  type DiffRegion,
  type DiffThresholds
} from "./engine.js";

const BASELINE_SCHEMA_VERSION = 1 as const;
const DEVICE_BASELINE_MAX_EDGE = 4096;
const DEFAULT_MATCH_DISTANCE = 24;

export interface BaselineMeta {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  serial: string;
  caseId: string;
  stepNumber: number;
  image: "post" | "pre";
  width: number;
  height: number;
  dpi: number | null;
  ignoreRegions: Bbox[];
  traceId: string;
  capturedAt: string;
}

export interface BaselineRequest {
  caseId: string;
  stepNumber: number;
  traceId: string;
  image?: "post" | "pre";
  serial?: string | null;
  dpi?: number | null;
  ignoreRegions?: Bbox[];
}

export interface BaselineCompareOptions extends BaselineRequest {
  thresholds?: Partial<DiffThresholds>;
  matchDistance?: number;
  save?: boolean;
}

export interface BaselineRegion extends DiffRegion {
  change: "new" | "persisting";
}

export interface BaselineCompareReport {
  status: "ok" | "no-baseline" | "unmapped";
  reason?: string;
  serial: string;
  caseId: string;
  stepNumber: number;
  baseline: { meta: BaselineMeta; image: string } | null;
  current: { scene: string; width: number; height: number } | null;
  regions: BaselineRegion[];
  fixed: DiffRegion[];
  summary: { regions: number; new: number; persisting: number; fixed: number };
  saved?: { dir: string; lastDiff: string };
}

export interface BaselineSaveResult {
  meta: BaselineMeta;
  dir: string;
  image: string;
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "_");
  return sanitized !== "" ? sanitized : "default";
}

function baselineDir(runtime: Runtime, serial: string, request: BaselineRequest): string {
  return path.join(
    runtime.configDirAbs,
    "design",
    "baselines",
    safeSegment(serial),
    safeSegment(request.caseId),
    `step-${request.stepNumber}-${request.image ?? "post"}`
  );
}

function readMeta(dir: string): BaselineMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")) as BaselineMeta;
    if (typeof parsed.caseId !== "string" || typeof parsed.stepNumber !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLastDiff(dir: string): DiffRegion[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "last-diff.json"), "utf-8")) as {
      regions?: DiffRegion[];
    };
    return Array.isArray(parsed.regions) ? parsed.regions : [];
  } catch {
    return [];
  }
}

function center(bbox: Bbox): { x: number; y: number } {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

function classifyRegions(
  current: DiffRegion[],
  previous: DiffRegion[],
  distance: number
): { regions: BaselineRegion[]; fixed: DiffRegion[] } {
  const used = new Set<number>();
  const regions = current.map((region) => {
    const here = center(region.bbox);
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    previous.forEach((candidate, index) => {
      if (used.has(index) || candidate.category !== region.category) return;
      const there = center(candidate.bbox);
      const gap = Math.hypot(there.x - here.x, there.y - here.y);
      if (gap < bestDistance) {
        bestDistance = gap;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestDistance <= distance) {
      used.add(bestIndex);
      return { ...region, change: "persisting" as const };
    }
    return { ...region, change: "new" as const };
  });
  const fixed = previous.filter((_, index) => !used.has(index));
  return { regions, fixed };
}

export async function saveBaseline(
  runtime: Runtime,
  request: BaselineRequest
): Promise<BaselineSaveResult> {
  const image = request.image ?? "post";
  const captured = await captureStepScreenshot(runtime, {
    traceId: request.traceId,
    stepNumber: request.stepNumber,
    image
  });
  const decoded = decodeImage(captured.bytes);
  const serial = request.serial?.trim() || captured.serial || "default";
  const dir = baselineDir(runtime, serial, { ...request, image });
  fs.mkdirSync(dir, { recursive: true });
  const imagePath = path.join(dir, "image.png");
  fs.writeFileSync(imagePath, captured.bytes);

  const meta: BaselineMeta = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    serial,
    caseId: request.caseId,
    stepNumber: request.stepNumber,
    image,
    width: decoded.width,
    height: decoded.height,
    dpi: request.dpi ?? null,
    ignoreRegions: request.ignoreRegions ?? [],
    traceId: request.traceId,
    capturedAt: new Date().toISOString()
  };
  writeFileAtomic(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { meta, dir, image: imagePath };
}

export async function compareBaseline(
  runtime: Runtime,
  request: BaselineCompareOptions
): Promise<BaselineCompareReport> {
  const image = request.image ?? "post";
  const captured = await captureStepScreenshot(runtime, {
    traceId: request.traceId,
    stepNumber: request.stepNumber,
    image
  });
  const current = decodeImage(captured.bytes);
  const serial = request.serial?.trim() || captured.serial || "default";
  const dir = baselineDir(runtime, serial, { ...request, image });

  const emptySummary = { regions: 0, new: 0, persisting: 0, fixed: 0 };
  const meta = readMeta(dir);
  const baselineImagePath = path.join(dir, "image.png");
  if (!meta || !fs.existsSync(baselineImagePath)) {
    return {
      status: "no-baseline",
      serial,
      caseId: request.caseId,
      stepNumber: request.stepNumber,
      baseline: null,
      current: { scene: captured.note, width: current.width, height: current.height },
      regions: [],
      fixed: [],
      summary: emptySummary
    };
  }

  if (meta.width !== current.width || meta.height !== current.height) {
    return {
      status: "unmapped",
      reason: `resolution-mismatch（基线 ${meta.width}x${meta.height} ≠ 当前 ${current.width}x${current.height}）`,
      serial,
      caseId: request.caseId,
      stepNumber: request.stepNumber,
      baseline: { meta, image: baselineImagePath },
      current: { scene: captured.note, width: current.width, height: current.height },
      regions: [],
      fixed: [],
      summary: emptySummary
    };
  }

  if (request.dpi != null && meta.dpi != null && request.dpi !== meta.dpi) {
    return {
      status: "unmapped",
      reason: `dpi-mismatch（基线 ${meta.dpi} ≠ 当前 ${request.dpi}）`,
      serial,
      caseId: request.caseId,
      stepNumber: request.stepNumber,
      baseline: { meta, image: baselineImagePath },
      current: { scene: captured.note, width: current.width, height: current.height },
      regions: [],
      fixed: [],
      summary: emptySummary
    };
  }

  const ignoreRegions = [...(meta.ignoreRegions ?? []), ...(request.ignoreRegions ?? [])];
  const baselineImage = decodeImage(fs.readFileSync(baselineImagePath));
  const result = diffScreens(baselineImage, current, {
    ...request.thresholds,
    ignoreRegions,
    maxEdge: DEVICE_BASELINE_MAX_EDGE
  });
  const previous = readLastDiff(dir);
  const { regions, fixed } = classifyRegions(
    result.regions,
    previous,
    request.matchDistance ?? DEFAULT_MATCH_DISTANCE
  );

  let saved: BaselineCompareReport["saved"];
  if (request.save !== false) {
    try {
      writeFileAtomic(
        path.join(dir, "last-diff.json"),
        `${JSON.stringify(
          {
            schemaVersion: BASELINE_SCHEMA_VERSION,
            comparedAt: new Date().toISOString(),
            regions: result.regions
          },
          null,
          2
        )}\n`
      );
      saved = { dir, lastDiff: path.join(dir, "last-diff.json") };
    } catch (error) {
      throw new Error(`基线差异写入失败: ${errorMessage(error)}`);
    }
  }

  return {
    status: "ok",
    serial,
    caseId: request.caseId,
    stepNumber: request.stepNumber,
    baseline: { meta, image: baselineImagePath },
    current: { scene: captured.note, width: current.width, height: current.height },
    regions,
    fixed,
    summary: {
      regions: regions.length,
      new: regions.filter((region) => region.change === "new").length,
      persisting: regions.filter((region) => region.change === "persisting").length,
      fixed: fixed.length
    },
    ...(saved ? { saved } : {})
  };
}
