import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFigmaDesignNodes, fetchFigmaRenderPng, resolveFigmaNodeId, type FigmaDesignNode } from "../figma/render.js";
import { PEN_CLI_HINT, type PenExecFn } from "../pen/cli.js";
import type { PenEnsureFn } from "../pen/install.js";
import { PEN_HINT, resolvePenTarget } from "../pen/paths.js";
import { errorMessage } from "../util.js";
import type { Runtime } from "../runtime.js";
import { renderAnnotatedPng } from "./annotate.js";
import {
  captureLiveScreenshot,
  captureStepScreenshot,
  resolveTraceStepAnchor,
  type DeviceCapture,
  type LiveCaptureOptions,
  type StepAnchor
} from "./device-source.js";
import { decodeImage, diffScreens, encodePng, normalizeDesignCrop, type Bbox, type Insets } from "./engine.js";
import { renderPenDesign } from "./pen-source.js";
import {
  composeDetailPair,
  extractDetailPair,
  proposeDetailRegions,
  resolveDetailGeometry,
  runDetailDiff,
  scaleDetailNodes,
  type DetailLocalSummary
} from "./detail.js";
import { loadScreenMap, localizeRegion, proposeScreenMapEntries, type ProposeResult } from "./screen-map.js";
import type { UiContract, UiTextContract } from "../ui/contract.js";
import { loadUiSemantics, semanticsForScreen } from "../ui/semantics.js";
import { measureTextWeight, type TextWeightResult } from "../ui/text-weight.js";
import { detectProjectStacks, primaryProfile } from "../projects/stack.js";

export interface DesignSourceArgs {
  source?: "figma" | "pen" | "image";
  figmaUrl?: string;
  penPath?: string;
  /** 设计源为现成 PNG 截图（相对项目根或绝对路径；仅 PNG）。 */
  imagePath?: string;
  nodeId?: string;
  renderOut?: string;
}

interface DetailRegionReport {
  idx: number;
  source: string;
  bbox: Bbox;
  name?: string;
  localSummary: DetailLocalSummary;
  textStyle?: TextWeightResult;
  crops?: { pair: string };
}

export interface DesignDeviceDiffArgs {
  design: DesignSourceArgs;
  device?: {
    mode?: "live" | "step";
    platform?: "android" | "ios";
    serial?: string;
    traceId?: string;
    stepNumber?: number;
    image?: "post" | "pre";
    lossless?: boolean;
  };
  alignment?: { insets?: Partial<Insets>; ignoreRegions?: Bbox[]; designCrop?: Bbox };
  ui?: {
    semanticsPath?: string;
    screenId?: string;
    ignoreDynamicRegions?: boolean;
    expectedAssets?: boolean;
  };
  diff?: {
    pixelThreshold?: number;
    minAreaRatio?: number;
    clusterGap?: number;
    maxRegions?: number;
    maxEdge?: number;
    nodeProximity?: number;
    colorTolerance?: number;
    systemBandRatio?: number;
  };
  regions?: "auto" | "nodes" | "tiles" | "none" | Bbox[];
  zoom?: number;
  returnCrops?: number;
  detail?: {
    pixelThreshold?: number;
    minAreaRatio?: number;
    clusterGap?: number;
  };
  save?: boolean;
  dryRun?: boolean;
}

export interface DesignDeviceDiffDeps {
  exec?: PenExecFn;
  ensure?: PenEnsureFn;
  capturePng?: LiveCaptureOptions["capturePng"];
  captureIosPng?: LiveCaptureOptions["captureIosPng"];
}

function resolveDesignSource(
  design: DesignSourceArgs
): { kind: "figma" } | { kind: "pen" } | { kind: "image" } | { error: string } {
  const hasFigma = typeof design.figmaUrl === "string" && design.figmaUrl.length > 0;
  const hasPen = typeof design.penPath === "string" && design.penPath.length > 0;
  const hasImage = typeof design.imagePath === "string" && design.imagePath.length > 0;
  const provided = [hasFigma, hasPen, hasImage].filter(Boolean).length;
  if (provided > 1) {
    return { error: "design 只能给 figmaUrl / penPath / imagePath 之一。" };
  }
  if (design.source === "figma") {
    return hasFigma ? { kind: "figma" } : { error: "design.source=figma 需要 design.figmaUrl。" };
  }
  if (design.source === "image") {
    return hasImage
      ? { kind: "image" }
      : { error: 'design.source=image 需要 design.imagePath（现成 PNG 截图）。' };
  }
  if (design.source === "pen" && hasImage) {
    return { error: "design.source=pen 不能同时给 design.imagePath。" };
  }
  if (design.source === "pen") return { kind: "pen" };
  if (hasFigma) return { kind: "figma" };
  if (hasPen) return { kind: "pen" };
  if (hasImage) return { kind: "image" };
  return {
    error:
      'design 需要设计源：figmaUrl（Figma 链接）、source:"pen"（可选 penPath，缺省取 .artemis/design 下最新 .pen）或 source:"image" + imagePath（现成 PNG）。'
  };
}

/** 现成设计截图只做路径解析；读取/PNG 校验在真正取源时做（dryRun 不读盘）。 */
function resolveDesignImagePath(
  runtime: Runtime,
  imagePath: string
): { absolute: string; relative: string } {
  const absolute = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(runtime.project.rootDir, imagePath);
  return { absolute, relative: path.relative(runtime.project.rootDir, absolute) };
}

function intersectDesignCrop(box: Bbox, crop: Bbox): Bbox | null {
  const x0 = Math.max(box.x, crop.x);
  const y0 = Math.max(box.y, crop.y);
  const x1 = Math.min(box.x + box.width, crop.x + crop.width);
  const y1 = Math.min(box.y + box.height, crop.y + crop.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 - crop.x, y: y0 - crop.y, width: x1 - x0, height: y1 - y0 };
}

function loadDynamicIgnoreRegions(
  runtime: Runtime,
  ui: DesignDeviceDiffArgs["ui"],
  designCrop: Bbox | null
): { ignore: Bbox[]; warnings: string[]; ignored: number; skipped: number } {
  if (ui?.ignoreDynamicRegions !== true && ui?.expectedAssets !== true) {
    return { ignore: [], warnings: [], ignored: 0, skipped: 0 };
  }
  const warnings: string[] = [];
  const shouldIgnore = ui.ignoreDynamicRegions === true;
  const semanticsPath = ui.semanticsPath
    ? path.resolve(runtime.project.rootDir, ui.semanticsPath)
    : undefined;
  const loaded = loadUiSemantics(runtime.configDirAbs, semanticsPath ? { path: semanticsPath } : undefined);
  if (loaded.errors.length > 0) {
    warnings.push(`semantics 解析失败，动态区域未忽略：${loaded.errors.join(" | ")}`);
    return { ignore: [], warnings, ignored: 0, skipped: 0 };
  }
  if (loaded.file === null) {
    warnings.push("未找到 ui-semantics，动态区域未忽略");
    return { ignore: [], warnings, ignored: 0, skipped: 0 };
  }
  if (loaded.file.draft === true) {
    warnings.push("semantics 仍是 draft（owner 未确认），动态区域不自动忽略");
    return { ignore: [], warnings, ignored: 0, skipped: 0 };
  }
  const screen =
    ui.screenId !== undefined
      ? semanticsForScreen(loaded.file, ui.screenId)
      : loaded.file.screens.length === 1
        ? loaded.file.screens[0]!
        : null;
  if (screen === null) {
    warnings.push(`未找到 semantics 屏 ${ui.screenId ?? "(未指定)"}，动态区域未忽略`);
    return { ignore: [], warnings, ignored: 0, skipped: 0 };
  }
  const ignore: Bbox[] = [];
  let skipped = 0;
  for (const region of screen.regions) {
    if (region.isDynamic !== true && region.dynamicAssets !== true) continue;
    if ((region.expectedAssets ?? 0) > 0) {
      warnings.push(
        `dynamic-assets-not-ignored：${region.id} 声明 expectedAssets，需用 suite ui-parity 检查存在性/placeholder，不能整块忽略`
      );
      continue;
    }
    if (!shouldIgnore) continue;
    if (region.designBbox === undefined) {
      skipped += 1;
      warnings.push(`dynamic-region-without-bbox：${region.id} 没有 designBbox，无法自动忽略`);
      continue;
    }
    const box = designCrop === null ? region.designBbox : intersectDesignCrop(region.designBbox, designCrop);
    if (box === null) {
      warnings.push(`dynamic-region-outside-crop：${region.id} 完全在设计裁剪范围外`);
      continue;
    }
    ignore.push(box);
  }
  return { ignore, warnings, ignored: ignore.length, skipped };
}

const FIGMA_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（写入项目 .env 或调用 aos_configure 携带 figmaToken）。";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function jsonError(message: string): CallToolResult {
  return jsonResult({ ok: false, error: message }, true);
}

function diffSlug(nodeId: string): string {
  return nodeId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "screen";
}

function intersects(left: Bbox, right: Bbox): boolean {
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  );
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function isPngBytes(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpegBytes(bytes: Buffer): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function sourceFormatOf(bytes: Buffer): "png" | "jpeg" | "unknown" {
  if (isPngBytes(bytes)) return "png";
  if (isJpegBytes(bytes)) return "jpeg";
  return "unknown";
}

function findContractScreen(
  runtime: Runtime,
  args: DesignDeviceDiffArgs
): { contract: UiContract; screen: UiContract["screens"][number]; screenId: string } | null {
  const file = path.join(runtime.configDirAbs, "design", "ui-contract.json");
  let contract: UiContract;
  try {
    contract = JSON.parse(fs.readFileSync(file, "utf-8")) as UiContract;
  } catch {
    return null;
  }
  const urlNodeId = /[?&]node-id=([^&]+)/.exec(args.design.figmaUrl ?? "")?.[1] ?? null;
  const candidates = [
    args.design.penPath ? path.basename(args.design.penPath, ".pen") : null,
    args.design.imagePath
      ? path.basename(args.design.imagePath, path.extname(args.design.imagePath))
      : null,
    args.design.nodeId ?? null,
    urlNodeId ? decodeURIComponent(urlNodeId).replace("-", ":") : null
  ].filter((entry): entry is string => typeof entry === "string" && entry !== "");
  const screen = contract.screens.find((entry) => candidates.includes(entry.id));
  return screen ? { contract, screen, screenId: screen.id } : null;
}

export function readTraceTexts(
  runtime: Runtime,
  traceId: string,
  stepNumber: number | null
): { texts: Array<{ text: string; x: number; y: number; width: number; height: number }>; scale: number } | null {
  if (stepNumber === null) return null;
  try {
    const run = JSON.parse(
      fs.readFileSync(path.join(runtime.traceDir(traceId), "run.json"), "utf-8")
    ) as { steps?: Array<{ step?: unknown; texts?: unknown; scale?: unknown }> };
    const step = (run.steps ?? []).find((entry) => entry.step === stepNumber);
    if (!step || !Array.isArray(step.texts)) return null;
    const texts = step.texts
      .filter(
        (entry): entry is { text: string; x: number; y: number; width: number; height: number } =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { text?: unknown }).text === "string" &&
          typeof (entry as { x?: unknown }).x === "number" &&
          typeof (entry as { y?: unknown }).y === "number" &&
          typeof (entry as { width?: unknown }).width === "number" &&
          typeof (entry as { height?: unknown }).height === "number" &&
          (entry as { width: number }).width > 0 &&
          (entry as { height: number }).height > 0
      )
      .map((entry) => ({
        text: entry.text,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height
      }));
    const scale = typeof step.scale === "number" && Number.isFinite(step.scale) ? step.scale : 1;
    return { texts, scale };
  } catch {
    return null;
  }
}

export function cropRgba(
  image: ReturnType<typeof decodeImage>,
  box: { x: number; y: number; width: number; height: number }
): ReturnType<typeof decodeImage> | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(image.height, Math.ceil(box.y + box.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const width = x1 - x0;
  const height = y1 - y0;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const source = ((y0 + row) * image.width + x0) * 4;
    data.set(image.data.subarray(source, source + width * 4), row * width * 4);
  }
  return { width, height, data };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function measureContractTexts(input: {
  screen: UiContract["screens"][number];
  design: ReturnType<typeof decodeImage>;
  device: ReturnType<typeof decodeImage>;
  geometry: ReturnType<typeof resolveDetailGeometry>;
  sourceFormat: "png" | "jpeg" | "unknown";
  lossless: boolean;
  deviceTexts?: Array<{ text: string; x: number; y: number; width: number; height: number }>;
  deviceScale?: number;
}): {
  items: Array<{
    id: string;
    content: string;
    bbox: UiTextContract["bbox"];
    status: TextWeightResult["status"];
    weightHint: TextWeightResult["weightHint"];
    delta: number | null;
    confidence: number;
    designWeight: number | null;
    reason?: string;
  }>;
  summary: {
    scope: "contract";
    screenId: string;
    textsTotal: number;
    checked: number;
    lighter: number;
    similar: number;
    heavier: number;
    unverified: number;
    byReason: Record<string, number>;
  };
} {
  const designScale =
    input.screen.frameWidth !== null && input.screen.frameWidth > 0
      ? input.design.width / input.screen.frameWidth
      : 1;
  const items: Array<{
    id: string;
    content: string;
    bbox: UiTextContract["bbox"];
    status: TextWeightResult["status"];
    weightHint: TextWeightResult["weightHint"];
    delta: number | null;
    confidence: number;
    designWeight: number | null;
    reason?: string;
  }> = [];
  for (const text of input.screen.texts) {
    if (text.bbox === null || text.geometryStatus === "unverifiable") {
      items.push({
        id: text.id,
        content: text.content,
        bbox: text.bbox,
        status: "unverified",
        weightHint: null,
        delta: null,
        confidence: 0,
        designWeight: text.fontWeight,
        reason: "no-geometry"
      });
      continue;
    }
    const normalized = normalizeText(text.content);
    const deviceMatches = (input.deviceTexts ?? []).filter(
      (entry) => normalizeText(entry.text) === normalized
    );
    if (deviceMatches.length > 1) {
      items.push({
        id: text.id,
        content: text.content,
        bbox: text.bbox,
        status: "unverified",
        weightHint: null,
        delta: null,
        confidence: 0,
        designWeight: text.fontWeight,
        reason: "multiple-device-text"
      });
      continue;
    }
    if (deviceMatches.length === 1) {
      const deviceScale = input.deviceScale ?? 1;
      const match = deviceMatches[0]!;
      const designCrop = cropRgba(input.design, {
        x: text.bbox.x * designScale,
        y: text.bbox.y * designScale,
        width: text.bbox.width * designScale,
        height: text.bbox.height * designScale
      });
      const deviceCrop = cropRgba(input.device, {
        x: match.x * deviceScale,
        y: match.y * deviceScale,
        width: match.width * deviceScale,
        height: match.height * deviceScale
      });
      if (designCrop !== null && deviceCrop !== null) {
        const measured = measureTextWeight({
          design: designCrop,
          device: deviceCrop,
          designWeight: text.fontWeight,
          textPixelHeight: deviceCrop.height,
          sourceFormat: input.sourceFormat,
          lossless: input.lossless,
          localization: "device-text"
        });
        items.push({
          id: text.id,
          content: text.content,
          bbox: text.bbox,
          status: measured.status,
          weightHint: measured.weightHint,
          delta: measured.delta,
          confidence: measured.confidence,
          designWeight: measured.designWeight,
          ...(measured.reason ? { reason: measured.reason } : {})
        });
        continue;
      }
    }
    const pad = Math.max(2, Math.round(text.bbox.height * 0.15));
    const region = {
      x: Math.max(0, (text.bbox.x - pad) * designScale),
      y: Math.max(0, (text.bbox.y - pad) * designScale),
      width: Math.max(1, (text.bbox.width + pad * 2) * designScale),
      height: Math.max(1, (text.bbox.height + pad * 2) * designScale)
    };
    const pair = extractDetailPair({
      design: input.design,
      device: input.device,
      region,
      geometry: input.geometry
    });
    if (pair === null) {
      items.push({
        id: text.id,
        content: text.content,
        bbox: text.bbox,
        status: "unverified",
        weightHint: null,
        delta: null,
        confidence: 0,
        designWeight: text.fontWeight,
        reason: "out-of-bounds"
      });
      continue;
    }
    const measured = measureTextWeight({
      design: pair.design,
      device: pair.device,
      designWeight: text.fontWeight,
      textPixelHeight: pair.device.height,
      sourceFormat: input.sourceFormat,
      lossless: input.lossless,
      localization: "design-bbox"
    });
    items.push({
      id: text.id,
      content: text.content,
      bbox: text.bbox,
      status: measured.status,
      weightHint: measured.weightHint,
      delta: measured.delta,
      confidence: measured.confidence,
      designWeight: measured.designWeight,
      ...(measured.reason ? { reason: measured.reason } : {})
    });
  }
  const byReason: Record<string, number> = {};
  for (const item of items) {
    if (item.status === "unverified" && item.reason) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1;
  }
  return {
    items,
    summary: {
      scope: "contract",
      screenId: input.screen.id,
      textsTotal: items.length,
      checked: items.filter((item) => item.status === "checked").length,
      lighter: items.filter((item) => item.weightHint === "lighter").length,
      similar: items.filter((item) => item.weightHint === "similar").length,
      heavier: items.filter((item) => item.weightHint === "heavier").length,
      unverified: items.filter((item) => item.status === "unverified").length,
      byReason
    }
  };
}

export async function designDeviceDiff(
  runtime: Runtime,
  args: DesignDeviceDiffArgs,
  deps: DesignDeviceDiffDeps = {}
): Promise<CallToolResult> {
  try {
    const source = resolveDesignSource(args.design ?? {});
    if ("error" in source) return jsonError(source.error);
    const started = Date.now();
    const mode = args.device?.mode ?? (args.device?.traceId ? "step" : "live");
    if (args.device?.traceId && mode !== "step") {
      return jsonError('提供了 device.traceId，但 mode 不是 step：请显式设 device.mode="step"（或省略 mode 让其自动推断）。');
    }
    if (args.device?.lossless === true && mode !== "live") {
      return jsonError('device.lossless 仅适用于 mode="live"（步骤截图来自轨迹原图）。');
    }
    if (mode === "step") {
      if (!args.device?.traceId) {
        return jsonError("device.mode=step 需要 device.traceId（截图经 mobile_inspect_trace 获取）。");
      }
      if (args.device.stepNumber !== undefined && (!Number.isInteger(args.device.stepNumber) || args.device.stepNumber <= 0)) {
        return jsonError("device.stepNumber 必须是正整数（省略则用失败证据自动检索步骤）。");
      }
    }
    const stepRequest = mode === "step"
      ? {
          traceId: args.device!.traceId!,
          stepNumber: args.device!.stepNumber,
          image: args.device?.image ?? ("post" as const)
        }
      : null;

    let plannedNodeId: string | null = null;
    try {
      plannedNodeId = source.kind === "figma" ? resolveFigmaNodeId(args.design.figmaUrl!, args.design.nodeId) : null;
    } catch {
      plannedNodeId = null;
    }
    const penTarget = source.kind === "pen" ? resolvePenTarget(runtime, args.design.penPath) : null;
    const imageTarget =
      source.kind === "image" && args.design.imagePath !== undefined
        ? resolveDesignImagePath(runtime, args.design.imagePath)
        : null;

    if (args.dryRun === true) {
      const slug =
        source.kind === "figma"
          ? plannedNodeId
            ? diffSlug(plannedNodeId)
            : "screen"
          : source.kind === "pen"
            ? penTarget
              ? diffSlug(path.basename(penTarget, ".pen"))
              : "screen"
            : imageTarget
              ? diffSlug(path.basename(imageTarget.absolute, path.extname(imageTarget.absolute)))
              : "screen";
      return jsonResult({
        ok: true,
        dryRun: true,
        design:
          source.kind === "figma"
            ? { source: "figma", figmaUrl: args.design.figmaUrl, nodeId: plannedNodeId }
            : source.kind === "pen"
              ? { source: "pen", penPath: args.design.penPath ?? null, resolved: penTarget ? path.relative(runtime.project.rootDir, penTarget) : null, renderOut: args.design.renderOut ?? null }
              : {
                  source: "image",
                  imagePath: args.design.imagePath ?? null,
                  resolved: imageTarget?.relative ?? null,
                  format: "png"
                },
        device:
          stepRequest !== null
            ? {
                mode: "step",
                traceId: stepRequest.traceId,
                stepNumber: stepRequest.stepNumber ?? null,
                autoAnchor: stepRequest.stepNumber === undefined,
                image: stepRequest.image,
                serial: args.device?.serial ?? null
              }
            : {
                mode: "live",
                ...(args.device?.platform === "ios" ? { platform: "ios" } : {}),
                serial: args.device?.serial ?? null
              },
        alignment: {
          designCrop: args.alignment?.designCrop ?? null,
          ignoreRegions: args.alignment?.ignoreRegions ?? []
        },
        ...(args.ui !== undefined ? { ui: args.ui } : {}),
        plannedDir: path.join(runtime.configDirAbs, "design", "diffs", `${slug}-<timestamp>`),
        hint: "dryRun 不拉取设计/设备截图、不写盘。"
      });
    }

    let stepAnchor: StepAnchor | null = null;
    let anchorSource: "explicit" | "search" | null = null;
    let stepNumber: number | null = null;
    if (stepRequest !== null) {
      if (stepRequest.stepNumber !== undefined) {
        stepNumber = stepRequest.stepNumber;
        anchorSource = "explicit";
      } else {
        try {
          stepAnchor = await resolveTraceStepAnchor(runtime, stepRequest.traceId);
        } catch (error) {
          return jsonError(`自动锚点失败: ${errorMessage(error)}`);
        }
        stepNumber = stepAnchor.stepNumber;
        anchorSource = "search";
      }
    }

    let captured: DeviceCapture;
    try {
      captured = stepRequest !== null && stepNumber !== null
        ? await captureStepScreenshot(runtime, {
            traceId: stepRequest.traceId,
            stepNumber,
            image: stepRequest.image
          })
        : await captureLiveScreenshot(runtime, args.device?.serial, {
            platform: args.device?.platform === "ios" ? "ios" : undefined,
            lossless: args.device?.lossless === true,
            capturePng: deps.capturePng,
            captureIosPng: deps.captureIosPng
          });
    } catch (error) {
      return jsonError(stepRequest !== null ? `步骤截图失败: ${errorMessage(error)}` : `真机截图失败: ${errorMessage(error)}`);
    }
    const deviceBytes = captured.bytes;
    const deviceNote = captured.note;

    let designPng: Buffer;
    let designNodes: FigmaDesignNode[] = [];
    let nodeWarning: string | null = null;
    let designUnit: Record<string, unknown>;
    let designResponse: Record<string, unknown>;
    let designSlug = "screen";
    if (source.kind === "figma") {
      try {
        const render = await fetchFigmaRenderPng(args.design.figmaUrl!, args.design.nodeId, 1);
        designPng = render.png;
        designUnit = { source: "figma", nodeId: render.nodeId };
        designResponse = { source: "figma", nodeId: render.nodeId, renderUrl: render.renderUrl };
        designSlug = diffSlug(render.nodeId);
      } catch (error) {
        return jsonResult({ ok: false, error: `Figma 渲染失败: ${errorMessage(error)}`, hint: FIGMA_HINT }, true);
      }
      try {
        const fetched = await fetchFigmaDesignNodes(args.design.figmaUrl!, args.design.nodeId);
        designNodes = fetched.nodes;
        if (fetched.truncated) {
          nodeWarning = `设计节点超过 ${designNodes.length} 个上限，已截断（分类可能不完整）。`;
        }
      } catch (error) {
        nodeWarning = `设计节点几何获取失败（分类降级为 pixel）：${errorMessage(error)}`;
      }
    } else if (source.kind === "pen") {
      try {
        const rendered = await renderPenDesign(runtime, {
          penPath: args.design.penPath,
          renderOut: args.design.renderOut,
          exec: deps.exec,
          ensure: deps.ensure
        });
        designPng = rendered.png;
        designNodes = rendered.nodes;
        designUnit = { source: "pen", name: rendered.penPath };
        designSlug = diffSlug(path.basename(rendered.penPath, ".pen"));
        designResponse = {
          source: "pen",
          path: rendered.penPath,
          output: path.relative(runtime.project.rootDir, rendered.output)
        };
      } catch (error) {
        const message = errorMessage(error);
        return jsonResult(
          { ok: false, error: `pen 渲染失败: ${message}`, hint: message.includes("没有找到 .pen 文件") ? PEN_HINT : PEN_CLI_HINT },
          true
        );
      }
    } else {
      const target = imageTarget;
      if (target === null) {
        return jsonError("design.source=image 缺少 design.imagePath。");
      }
      if (!fs.existsSync(target.absolute)) {
        return jsonError(`design.imagePath 不存在：${args.design.imagePath}`);
      }
      try {
        designPng = fs.readFileSync(target.absolute);
      } catch (error) {
        return jsonError(`design.imagePath 读取失败：${errorMessage(error)}`);
      }
      if (!isPngBytes(designPng)) {
        return jsonError(`design.imagePath 仅支持 PNG（无损源）：${args.design.imagePath}`);
      }
      designUnit = { source: "image", path: target.relative, format: "png" };
      designResponse = { source: "image", path: target.relative, format: "png" };
      designSlug = diffSlug(path.basename(target.absolute, path.extname(target.absolute)));
      nodeWarning =
        "image-source：现成截图无设计节点几何，差异分类按 pixel、区域核验用 tiles；细节档随源分辨率降级。";
    }

    const resolvedStepNumber = stepRequest !== null ? stepNumber : null;
    const anchorAmbiguous = stepAnchor !== null && stepAnchor.candidates.length > 1;
    const anchorInfo = stepAnchor
      ? {
          source: anchorSource,
          query: stepAnchor.query,
          candidates: stepAnchor.candidates.slice(0, 5),
          ...(anchorAmbiguous ? { ambiguous: true } : {})
        }
      : anchorSource
        ? { source: anchorSource }
        : null;

    let annotated: Buffer;
    let deviceImage: ReturnType<typeof decodeImage>;
    let diffResult: ReturnType<typeof diffScreens>;
    let croppedDesign: ReturnType<typeof decodeImage> | null = null;
    let dynamicRegions: ReturnType<typeof loadDynamicIgnoreRegions> = {
      ignore: [],
      warnings: [],
      ignored: 0,
      skipped: 0
    };
    try {
      const design = decodeImage(designPng);
      const device = decodeImage(deviceBytes);
      deviceImage = device;
      const designCrop = normalizeDesignCrop(args.alignment?.designCrop, design);
      croppedDesign = designCrop === null ? null : cropRgba(design, designCrop);
      if (designCrop !== null && croppedDesign === null) {
        return jsonError("designCrop 裁剪失败");
      }
      dynamicRegions = loadDynamicIgnoreRegions(runtime, args.ui, designCrop);
      diffResult = diffScreens(design, device, {
        insets: args.alignment?.insets,
        ignoreRegions: [...(args.alignment?.ignoreRegions ?? []), ...dynamicRegions.ignore],
        ...(args.alignment?.designCrop !== undefined ? { designCrop: args.alignment.designCrop } : {}),
        designNodes,
        ...args.diff
      });
      annotated = renderAnnotatedPng(croppedDesign ?? design, diffResult.regions);
    } catch (error) {
      return jsonError(`差异计算失败: ${errorMessage(error)}`);
    }

    const screens = designNodes.filter((node) => (node.depth ?? 0) === 0);
    const screenMap = loadScreenMap(runtime.configDirAbs);
    let proposal: ProposeResult | null = null;
    for (const region of diffResult.regions) {
      const node = region.designNode
        ? designNodes.find((candidate) => candidate.id === region.designNode!.id)
        : undefined;
      if (proposal === null) {
        const mapped = localizeRegion(region, node, screens, screenMap.entries, null);
        if (mapped.status === "mapped") {
          region.localized = mapped;
          continue;
        }
        proposal = proposeScreenMapEntries(
          runtime.configDirAbs,
          primaryProfile(detectProjectStacks(runtime.project.rootDir))
        );
      }
      region.localized = localizeRegion(region, node, screens, screenMap.entries, proposal);
    }

    const noCandidateCount = diffResult.regions.filter((region) => region.localized?.status === "no-candidates").length;

    const regionsArg = args.regions ?? "auto";
    let detailMeta: {
      enabled: true;
      zoom: number;
      returned: number;
      regionCount: number;
      tilesUsed: boolean;
      truncated: boolean;
      degraded: boolean;
      deviceSource: { format: "png" | "jpeg" | "unknown"; lossless: boolean };
      textStyles: {
        scope: "contract" | "text-regions";
        screenId?: string;
        texts: number;
        textsTotal?: number;
        checked: number;
        lighter: number;
        similar: number;
        heavier: number;
        highConfidenceHeavier: number;
        unverified: number;
        byReason: Record<string, number>;
        items?: Array<{
          id: string;
          content: string;
          bbox: UiTextContract["bbox"];
          status: TextWeightResult["status"];
          weightHint: TextWeightResult["weightHint"];
          delta: number | null;
          confidence: number;
          designWeight: number | null;
          reason?: string;
        }>;
      };
    } | null = null;
    let regionDetailsPayload: DetailRegionReport[] | null = null;
    const pairBuffers: Buffer[] = [];
    const detailWarnings: string[] = [];
    let inlinePairBuffers: Buffer[] = [];

    if (regionsArg !== "none") {
      if (Array.isArray(regionsArg)) {
        const invalid = regionsArg.some(
          (box) =>
            !Number.isFinite(box?.x) ||
            !Number.isFinite(box?.y) ||
            !Number.isFinite(box?.width) ||
            !Number.isFinite(box?.height) ||
            box.width <= 0 ||
            box.height <= 0
        );
        if (invalid) return jsonError("regions 显式区域需要合法的 {x,y,width,height}（宽高 > 0）。");
      }
      const zoom = Math.min(4, Math.max(1, args.zoom ?? 2));
      const returnCrops = Math.min(Math.max(0, Math.trunc(args.returnCrops ?? 8)), 50);
      const maxRegions = Math.max(1, Math.trunc(args.diff?.maxRegions ?? 20));
      const insets = diffResult.alignment.insets;

      let detailDesignPng = croppedDesign !== null ? encodePng(croppedDesign) : designPng;
      let detailScale = 1;
      let designRetryReason: string | null =
        croppedDesign !== null
          ? "designCrop 启用（细节档使用裁剪图，不重渲染）"
          : source.kind === "image"
            ? "image-source（固定栅格，不重渲染）"
            : null;
      const deviceCroppedWidth = deviceImage.width - insets.left - insets.right;
      const rootWidth = screens.find((node) => node.width > 0)?.width ?? null;
      if (rootWidth !== null && croppedDesign === null) {
        const target = Math.min(4, Math.max(1, Math.round((deviceCroppedWidth / rootWidth) * 100) / 100));
        if (target > 1.02 && source.kind !== "image") {
          try {
            if (source.kind === "figma") {
              const render = await fetchFigmaRenderPng(args.design.figmaUrl!, args.design.nodeId, target);
              detailDesignPng = render.png;
            } else {
              const penName = typeof designResponse.path === "string" ? path.basename(designResponse.path, ".pen") : "design";
              const rendered = await renderPenDesign(runtime, {
                penPath: args.design.penPath,
                renderOut: path.relative(
                  runtime.project.rootDir,
                  path.join(runtime.configDirAbs, "design", "pen", `${penName}.detail.png`)
                ),
                scale: target,
                exec: deps.exec,
                ensure: deps.ensure
              });
              detailDesignPng = rendered.png;
            }
            detailScale = target;
          } catch (error) {
            designRetryReason = errorMessage(error);
          }
        }
      }
      const detailDesign = decodeImage(detailDesignPng);
      const geometry = resolveDetailGeometry(detailDesign, deviceImage, insets);
      const designDegraded = geometry.ratio > 1.02;
      if (designDegraded) {
        detailWarnings.push(
          `design-upscaled：设计源低于设备栅格${designRetryReason ? `（${designRetryReason}）` : ""}，细节档降级（阈值 0.1）`
        );
      }

      let detailDeviceBytes = deviceBytes;
      let deviceLossless = captured.lossless;
      const explicitLossy = args.device?.lossless === false;
      if (stepRequest === null && args.device?.platform !== "ios" && !explicitLossy && captured.lossless !== true) {
        try {
          const recapture = await captureLiveScreenshot(runtime, args.device?.serial, {
            lossless: true,
            capturePng: deps.capturePng,
            captureIosPng: deps.captureIosPng
          });
          detailDeviceBytes = recapture.bytes;
          deviceLossless = recapture.lossless === true;
        } catch (error) {
          deviceLossless = false;
          detailWarnings.push(`lossy-source：无损二次抓图失败（${errorMessage(error)}），细节档降级（阈值 0.1）`);
        }
      }
      if (stepRequest === null && deviceLossless !== true && !detailWarnings.some((warning) => warning.startsWith("lossy-source"))) {
        detailWarnings.push(
          explicitLossy
            ? "lossy-source：device.lossless=false 显式有损，细节档降级（阈值 0.1）"
            : "lossy-source：设备源为有损截图（无损不可用回退），细节档降级（阈值 0.1）"
        );
      }
      const stepDeviceLossy = stepRequest !== null && !isPngBytes(deviceBytes);
      if (stepDeviceLossy) {
        detailWarnings.push("lossy-source：步骤截图为有损格式（非 PNG），细节档降级（阈值 0.1）");
      }
      /** 步骤截图来自轨迹原图：PNG 即无损，不受 `captured.lossless`（实时抓图语义）影响。 */
      const effectiveLossless = stepRequest !== null ? !stepDeviceLossy : deviceLossless === true;
      const degraded = designDegraded || (stepRequest === null ? deviceLossless !== true : stepDeviceLossy);
      const detailDevice = detailDeviceBytes === deviceBytes ? deviceImage : decodeImage(detailDeviceBytes);

      const scaledDesignNodes = scaleDetailNodes(designNodes, detailScale);
      const proposalResult = proposeDetailRegions({
        designWidth: detailDesign.width,
        designHeight: detailDesign.height,
        nodes: scaledDesignNodes,
        screenRegionBboxes: diffResult.regions.map((region) => ({
          x: region.bbox.x * detailScale,
          y: region.bbox.y * detailScale,
          width: region.bbox.width * detailScale,
          height: region.bbox.height * detailScale
        })),
        mode: regionsArg,
        maxRegions
      });
      if (proposalResult.truncated) {
        detailWarnings.push(`detail-truncated：区域数超过上限 ${maxRegions}（diff 命中与小面积优先），未全量核验`);
      }

      const saving = args.save !== false;
      let outOfBounds = 0;
      let clippedRegions = 0;
      const details: DetailRegionReport[] = [];
      for (const region of proposalResult.regions) {
        const pair = extractDetailPair({ design: detailDesign, device: detailDevice, region: region.bbox, geometry });
        if (pair === null) {
          outOfBounds += 1;
          continue;
        }
        if (pair.clipped) clippedRegions += 1;
        const localSummary = runDetailDiff(pair.design, pair.device, { degraded, thresholds: args.detail });
        pairBuffers.push(composeDetailPair(pair.device, pair.design, { zoom }).png);
        const textNode = scaledDesignNodes
          .filter((node) => node.text && intersects(node, region.bbox))
          .sort(
            (left, right) =>
              Math.min(left.width, region.bbox.width) * Math.min(left.height, region.bbox.height) -
              Math.min(right.width, region.bbox.width) * Math.min(right.height, region.bbox.height)
          )
          .at(-1);
        const textStyle =
          textNode === undefined
            ? undefined
            : measureTextWeight({
                design: pair.design,
                device: pair.device,
                designWeight: textNode.fontWeight ?? null,
                textPixelHeight: Math.max(1, Math.round(textNode.height * geometry.ratio)),
                sourceFormat: sourceFormatOf(detailDeviceBytes),
                lossless: effectiveLossless,
                localization: "design-bbox"
              });
        const slug = region.name ? diffSlug(region.name) : `r${region.idx}`;
        details.push({
          idx: region.idx,
          source: region.source,
          bbox: region.bbox,
          ...(region.name ? { name: region.name } : {}),
          localSummary,
          ...(textStyle ? { textStyle } : {}),
          ...(saving ? { crops: { pair: `regions/${String(region.idx).padStart(2, "0")}-${slug}.png` } } : {})
        });
      }
      if (outOfBounds > 0 || clippedRegions > 0) {
        const parts: string[] = [];
        if (outOfBounds > 0) parts.push(`${outOfBounds} 个不可见已跳过`);
        if (clippedRegions > 0) parts.push(`${clippedRegions} 个部分截断按可见窗口核验`);
        detailWarnings.push(`out-of-bounds：${outOfBounds + clippedRegions} 个区域越出设备视口（${parts.join("、")}）`);
      }

      const severityRank: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
      const rankOf = (summary: DetailLocalSummary): number =>
        summary.clusters.reduce((rank, cluster) => Math.min(rank, severityRank[cluster.severity] ?? 4), 4);
      const ordered = details
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => {
          const diffOrder = Number(!a.entry.localSummary.hasDiff) - Number(!b.entry.localSummary.hasDiff);
          if (diffOrder !== 0) return diffOrder;
          if (a.entry.localSummary.hasDiff) {
            const rankOrder = rankOf(a.entry.localSummary) - rankOf(b.entry.localSummary);
            if (rankOrder !== 0) return rankOrder;
            const areaOrder = b.entry.bbox.width * b.entry.bbox.height - a.entry.bbox.width * a.entry.bbox.height;
            if (areaOrder !== 0) return areaOrder;
          }
          return a.index - b.index;
        });
      inlinePairBuffers = ordered.slice(0, returnCrops).map((item) => pairBuffers[item.index]!);

      regionDetailsPayload = details;
      const textSummaries = details
        .map((entry) => entry.textStyle)
        .filter((entry): entry is TextWeightResult => entry !== undefined);
      const textByReason: Record<string, number> = {};
      for (const entry of textSummaries) {
        if (entry.status === "unverified" && entry.reason) {
          textByReason[entry.reason] = (textByReason[entry.reason] ?? 0) + 1;
        }
      }
      const contractMatch = findContractScreen(runtime, args);
      const traceTexts =
        stepRequest !== null
          ? readTraceTexts(runtime, stepRequest.traceId, resolvedStepNumber)
          : null;
      const contractTexts =
        contractMatch === null || croppedDesign !== null
          ? null
          : measureContractTexts({
              screen: contractMatch.screen,
              design: detailDesign,
              device: detailDevice,
              geometry,
              sourceFormat: sourceFormatOf(detailDeviceBytes),
              lossless: effectiveLossless,
              ...(traceTexts !== null ? { deviceTexts: traceTexts.texts, deviceScale: traceTexts.scale } : {})
            });
      if (croppedDesign !== null && contractMatch !== null) {
        detailWarnings.push("designCrop 启用：contract 文本字重检查跳过（bbox 为 design-source，未整体平移）");
      }
      const highConfidenceHeavier =
        contractTexts !== null
          ? contractTexts.items.filter(
              (item) =>
                item.status === "checked" &&
                item.weightHint === "heavier" &&
                item.confidence >= 0.7
            ).length
          : textSummaries.filter(
              (entry) =>
                entry.status === "checked" &&
                entry.weightHint === "heavier" &&
                entry.confidence >= 0.7
            ).length;
      detailMeta = {
        enabled: true,
        zoom,
        returned: inlinePairBuffers.length,
        regionCount: details.length,
        tilesUsed: proposalResult.tilesUsed,
        truncated: proposalResult.truncated,
        degraded,
        deviceSource: {
          format: sourceFormatOf(detailDeviceBytes),
          lossless: effectiveLossless
        },
        textStyles:
          contractTexts !== null
            ? {
                ...contractTexts.summary,
                texts: contractTexts.summary.textsTotal,
                highConfidenceHeavier,
                items: contractTexts.items
              }
            : {
                scope: "text-regions",
                texts: textSummaries.length,
                checked: textSummaries.filter((entry) => entry.status === "checked").length,
                lighter: textSummaries.filter((entry) => entry.weightHint === "lighter").length,
                similar: textSummaries.filter((entry) => entry.weightHint === "similar").length,
                heavier: textSummaries.filter((entry) => entry.weightHint === "heavier").length,
                highConfidenceHeavier,
                unverified: textSummaries.filter((entry) => entry.status === "unverified").length,
                byReason: textByReason
              }
      };
    }

    const warnings = [
      ...(nodeWarning ? [nodeWarning] : []),
      ...(noCandidateCount > 0 && proposal?.buildBrief
        ? [`${noCandidateCount} 个差异区域未在 build-brief/screen-map 中找到落点（no-candidates）；可补 screen-map.json 或核对屏幕命名。`]
        : []),
      ...(anchorAmbiguous
        ? [`失败证据命中 ${stepAnchor!.candidates.length} 个步骤，已取首个 Step ${stepAnchor!.stepNumber}；可用 device.stepNumber 显式指定。`]
        : []),
      ...dynamicRegions.warnings,
      ...detailWarnings
    ];
    const designScreens = screens
      .slice(0, 10)
      .map((node) => ({ id: node.id, name: node.name, width: node.width, height: node.height }));
    const shared = {
      alignment: diffResult.alignment,
      designScreens,
      ignoredRegions: diffResult.ignoredRegions,
      dynamicIgnoreRegions: dynamicRegions.ignore,
      dynamicRegions: { ignored: dynamicRegions.ignored, skipped: dynamicRegions.skipped },
      designNodes: designNodes.length,
      thresholds: diffResult.thresholds,
      warnings,
      ...(anchorInfo ? { anchor: anchorInfo } : {}),
      regions: diffResult.regions,
      summary: diffResult.summary
    };
    const report = {
      schemaVersion: 1 as const,
      unit: {
        design: designUnit,
        device:
          stepRequest !== null
            ? {
                mode: "step" as const,
                traceId: stepRequest.traceId,
                stepNumber: resolvedStepNumber,
                image: stepRequest.image,
                anchor: anchorSource,
                sourceFormat: sourceFormatOf(deviceBytes),
                lossless: isPngBytes(deviceBytes),
                ...(captured.serial ? { serial: captured.serial } : {})
              }
            : {
                mode: "live" as const,
                ...(args.device?.platform === "ios" ? { platform: "ios" } : {}),
                sourceFormat: sourceFormatOf(deviceBytes),
                lossless: isPngBytes(deviceBytes),
                ...(args.device?.serial ? { serial: args.device.serial } : {})
              }
      },
      ...shared,
      ...(detailMeta !== null && regionDetailsPayload !== null
        ? { detail: detailMeta, regionDetails: regionDetailsPayload }
        : {}),
      elapsedMs: Date.now() - started
    };

    let saved: Record<string, string> | undefined;
    if (args.save !== false) {
      const dir = path.join(runtime.configDirAbs, "design", "diffs", `${designSlug}-${timestamp()}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        fs.writeFileSync(path.join(dir, "annotated.png"), annotated);
        fs.writeFileSync(path.join(dir, "design.png"), croppedDesign !== null ? encodePng(croppedDesign) : designPng);
        fs.writeFileSync(path.join(dir, "device.png"), encodePng(deviceImage));
        if (regionDetailsPayload !== null && regionDetailsPayload.length > 0) {
          fs.mkdirSync(path.join(dir, "regions"), { recursive: true });
          for (const [index, entry] of regionDetailsPayload.entries()) {
            if (!entry.crops) continue;
            const target = path.join(dir, entry.crops.pair);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, pairBuffers[index]!);
          }
        }
      } catch (error) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        return jsonError(`产物写入失败: ${errorMessage(error)}`);
      }
      saved = {
        dir,
        report: path.join(dir, "report.json"),
        annotated: path.join(dir, "annotated.png"),
        design: path.join(dir, "design.png"),
        device: path.join(dir, "device.png")
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              dryRun: false,
              design: designResponse,
              device: {
                source: deviceNote,
                serial: captured.serial ?? args.device?.serial ?? "(auto)",
                ...(args.device?.platform === "ios" ? { platform: "ios" } : {})
              },
              ...shared,
              ...(detailMeta !== null && regionDetailsPayload !== null
                ? { detail: detailMeta, regionDetails: regionDetailsPayload }
                : {}),
              saved
            },
            null,
            2
          )
        },
        { type: "image", data: annotated.toString("base64"), mimeType: "image/png" },
        ...inlinePairBuffers.map((png) => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }))
      ]
    };
  } catch (error) {
    return jsonError(`设计 vs 真机对比失败: ${errorMessage(error)}`);
  }
}
