import fs from "node:fs";
import path from "node:path";

import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";
import { loadGeneratedCases } from "../figma/design-store.js";
import type { UiContract } from "../ui/contract.js";
import { measureTextWeight, type TextWeightResult } from "../ui/text-weight.js";
import { captureStepScreenshot } from "./device-source.js";
import {
  decodeImage,
  diffScreens,
  type Bbox,
  type DiffRegion,
  type DiffThresholds
} from "./engine.js";
import { cropRgba, readTraceTexts } from "./tool.js";

const BASELINE_SCHEMA_VERSION = 1 as const;
const DEVICE_BASELINE_MAX_EDGE = 4096;
const DEFAULT_MATCH_DISTANCE = 24;

export interface BaselineTextMeta {
  content: string;
  bbox: Bbox;
  scale: number;
  source?: "trace" | "design-bbox";
}

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
  /** 设备侧文本 bbox（trace 优先，缺省 design-bbox bootstrap）。 */
  texts?: BaselineTextMeta[];
  textSource?: "trace" | "design-bbox";
}

export interface BaselineRequest {
  caseId: string;
  stepNumber: number;
  traceId: string;
  image?: "post" | "pre";
  serial?: string | null;
  dpi?: number | null;
  ignoreRegions?: Bbox[];
  /** design-bbox bootstrap 的显式屏名/节点 id（缺省按步骤屏文本唯一匹配）。 */
  screen?: string | null;
}

export interface BaselineCompareOptions extends BaselineRequest {
  thresholds?: Partial<DiffThresholds>;
  matchDistance?: number;
  save?: boolean;
}

export interface BaselineRegion extends DiffRegion {
  change: "new" | "persisting";
}

export interface BaselineTextStyleItem {
  content: string;
  bbox: Bbox;
  status: TextWeightResult["status"];
  weightHint: TextWeightResult["weightHint"];
  delta: number | null;
  confidence: number;
  reason?: string;
}

export interface BaselineTextStyles {
  textsTotal: number;
  checked: number;
  lighter: number;
  similar: number;
  heavier: number;
  highConfidenceHeavier: number;
  unverified: number;
  byReason: Record<string, number>;
  items: BaselineTextStyleItem[];
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
  /** 同平台 baseline 文本字重（无文本基线时为 null）。 */
  textStyles: BaselineTextStyles | null;
  saved?: { dir: string; lastDiff: string };
}

export interface BaselineSaveResult {
  meta: BaselineMeta;
  dir: string;
  image: string;
  texts: number;
  textSource: "trace" | "design-bbox" | "none";
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

function imageFormat(bytes: Uint8Array): "png" | "jpeg" | "unknown" {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return "unknown";
}

function measureBaselineTexts(
  meta: BaselineMeta,
  baseline: ReturnType<typeof decodeImage>,
  current: ReturnType<typeof decodeImage>,
  sourceFormat: "png" | "jpeg" | "unknown",
  lossless: boolean
): BaselineTextStyles | null {
  const texts = meta.texts ?? [];
  if (texts.length === 0) return null;
  const items: BaselineTextStyleItem[] = [];
  for (const text of texts) {
    const baselineCrop = cropRgba(baseline, text.bbox);
    const currentCrop = cropRgba(current, text.bbox);
    if (baselineCrop === null || currentCrop === null) {
      items.push({
        content: text.content,
        bbox: text.bbox,
        status: "unverified",
        weightHint: null,
        delta: null,
        confidence: 0,
        reason: "no-localization"
      });
      continue;
    }
    const measured = measureTextWeight({
      design: baselineCrop,
      device: currentCrop,
      textPixelHeight: Math.max(1, currentCrop.height),
      sourceFormat,
      lossless,
      localization: "baseline-bbox"
    });
    items.push({
      content: text.content,
      bbox: text.bbox,
      status: measured.status,
      weightHint: measured.weightHint,
      delta: measured.delta,
      confidence: measured.confidence,
      ...(measured.reason ? { reason: measured.reason } : {})
    });
  }
  const byReason: Record<string, number> = {};
  for (const item of items) {
    if (item.status === "unverified" && item.reason) {
      byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
    }
  }
  return {
    textsTotal: items.length,
    checked: items.filter((item) => item.status === "checked").length,
    lighter: items.filter((item) => item.weightHint === "lighter").length,
    similar: items.filter((item) => item.weightHint === "similar").length,
    heavier: items.filter((item) => item.weightHint === "heavier").length,
    highConfidenceHeavier: items.filter(
      (item) => item.status === "checked" && item.weightHint === "heavier" && item.confidence >= 0.7
    ).length,
    unverified: items.filter((item) => item.status === "unverified").length,
    byReason,
    items
  };
}

/** 切片 5 门禁：仅在显式 `--fail-on text-weight` 且同平台 baseline 高置信 heavier 时阻断。 */
export function textWeightGateFails(
  report: BaselineCompareReport,
  failOn: string | null
): boolean {
  return (
    failOn === "text-weight" &&
    report.status === "ok" &&
    (report.textStyles?.highConfidenceHeavier ?? 0) > 0
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function traceStepScreen(runtime: Runtime, traceId: string, stepNumber: number): string | null {
  try {
    const run = JSON.parse(
      fs.readFileSync(path.join(runtime.traceDir(traceId), "run.json"), "utf-8")
    ) as { steps?: Array<{ step?: unknown; screen?: unknown }> };
    const step = (run.steps ?? []).find((entry) => entry.step === stepNumber);
    return step !== undefined && typeof step.screen === "string" && step.screen.trim() !== ""
      ? step.screen
      : null;
  } catch {
    return null;
  }
}

/** trace 无 texts 时的切片 4 bootstrap：显式 screen 优先；否则按步骤屏文本唯一匹配契约屏。 */
function designTextsFromContract(
  runtime: Runtime,
  request: BaselineRequest,
  deviceWidth: number
): BaselineTextMeta[] {
  let contract: UiContract;
  try {
    contract = JSON.parse(
      fs.readFileSync(path.join(runtime.configDirAbs, "design", "ui-contract.json"), "utf-8")
    ) as UiContract;
  } catch {
    return [];
  }
  if (!Array.isArray(contract.screens) || contract.screens.length === 0) return [];

  let screen: UiContract["screens"][number] | null = null;
  if (request.screen !== undefined && request.screen !== null && request.screen.trim() !== "") {
    const wanted = request.screen.trim().toLowerCase();
    screen =
      contract.screens.find(
        (entry) => entry.id.toLowerCase() === wanted || entry.name.toLowerCase() === wanted
      ) ?? null;
  } else {
    const stepScreen = traceStepScreen(runtime, request.traceId, request.stepNumber);
    if (stepScreen === null) return [];
    const caseScreens =
      loadGeneratedCases(runtime.configDirAbs)?.find((entry) => entry.id === request.caseId)?.screens ??
      null;
    const candidates =
      caseScreens === null
        ? contract.screens
        : contract.screens.filter(
            (entry) => caseScreens.includes(entry.name) || caseScreens.includes(entry.id)
          );
    const normalized = normalizeText(stepScreen);
    const scored = candidates
      .map((entry) => ({
        entry,
        score: entry.texts.filter(
          (text) =>
            text.content.trim().length > 1 && normalized.includes(normalizeText(text.content))
        ).length
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score);
    if (scored.length === 0) return [];
    if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return [];
    screen = scored[0]!.entry;
  }
  if (screen === null) return [];

  const scale =
    screen.frameWidth !== null && screen.frameWidth > 0 ? deviceWidth / screen.frameWidth : 1;
  return screen.texts
    .flatMap((text) => {
      if (text.geometryStatus !== "extracted" || text.bbox === null) return [];
      return [
        {
          content: text.content,
          bbox: {
            x: text.bbox.x * scale,
            y: text.bbox.y * scale,
            width: text.bbox.width * scale,
            height: text.bbox.height * scale
          },
          scale,
          source: "design-bbox" as const
        }
      ];
    })
    .slice(0, 200);
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

  const traceTexts = readTraceTexts(runtime, request.traceId, request.stepNumber);
  const traceMapped: BaselineTextMeta[] =
    traceTexts === null
      ? []
      : traceTexts.texts
          .map((text) => ({
            content: text.text,
            bbox: {
              x: Math.round(text.x * traceTexts.scale),
              y: Math.round(text.y * traceTexts.scale),
              width: Math.max(1, Math.round(text.width * traceTexts.scale)),
              height: Math.max(1, Math.round(text.height * traceTexts.scale))
            },
            scale: traceTexts.scale,
            source: "trace" as const
          }))
          .filter((text) => text.bbox.width > 0 && text.bbox.height > 0);
  const designMapped =
    traceMapped.length > 0 ? [] : designTextsFromContract(runtime, request, decoded.width);
  const texts = traceMapped.length > 0 ? traceMapped : designMapped;
  const textSource: BaselineSaveResult["textSource"] =
    texts.length === 0 ? "none" : traceMapped.length > 0 ? "trace" : "design-bbox";

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
    capturedAt: new Date().toISOString(),
    ...(texts.length > 0 && textSource !== "none" ? { texts, textSource } : {})
  };
  writeFileAtomic(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { meta, dir, image: imagePath, texts: texts.length, textSource };
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
      summary: emptySummary,
      textStyles: null
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
      summary: emptySummary,
      textStyles: null
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
      summary: emptySummary,
      textStyles: null
    };
  }

  const ignoreRegions = [...(meta.ignoreRegions ?? []), ...(request.ignoreRegions ?? [])];
  const baselineBytes = fs.readFileSync(baselineImagePath);
  const baselineImage = decodeImage(baselineBytes);
  const baselineFormat = imageFormat(baselineBytes);
  const currentFormat = imageFormat(captured.bytes);
  const textSourceFormat =
    baselineFormat === "png" && currentFormat === "png"
      ? "png"
      : baselineFormat === "jpeg" || currentFormat === "jpeg"
        ? "jpeg"
        : "unknown";
  const textStyles = measureBaselineTexts(
    meta,
    baselineImage,
    current,
    textSourceFormat,
    textSourceFormat === "png"
  );
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
    textStyles,
    ...(saved ? { saved } : {})
  };
}
