import { resize, type RgbaImage } from "../diff/engine.js";

export type TextWeightHint = "lighter" | "similar" | "heavier";
export type TextWeightStatus = "checked" | "unverified";

export interface TextWeightMetrics {
  inkRatio: number;
  meanRunNorm: number;
  rowProfileCorrelation: number;
  columnProfileCorrelation: number;
  inkExtent: { width: number; height: number };
}

export interface TextWeightResult {
  status: TextWeightStatus;
  weightHint: TextWeightHint | null;
  delta: number | null;
  confidence: number;
  designWeight: number | null;
  experimental: true;
  reason?: string;
  metrics: TextWeightMetrics | null;
}

export interface TextWeightInput {
  design: RgbaImage;
  device: RgbaImage;
  designWeight?: number | null;
  /** Text height in device pixels before any resize. */
  textPixelHeight?: number | null;
  sourceFormat?: "png" | "jpeg" | "unknown";
  lossless?: boolean;
  localization?: "baseline-bbox" | "design-bbox" | "device-text";
}

const MIN_TEXT_PIXELS = 10;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function backgroundLuminance(image: RgbaImage): number {
  let sum = 0;
  let count = 0;
  const sample = (x: number, y: number): void => {
    const index = (y * image.width + x) * 4;
    sum += luminance(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!);
    count += 1;
  };
  for (let x = 0; x < image.width; x += 1) {
    sample(x, 0);
    if (image.height > 1) sample(x, image.height - 1);
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    sample(0, y);
    if (image.width > 1) sample(image.width - 1, y);
  }
  return count > 0 ? sum / count : 255;
}

function inkMask(image: RgbaImage, background: number): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  const threshold = 42;
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4;
    const lum = luminance(image.data[offset]!, image.data[offset + 1]!, image.data[offset + 2]!);
    mask[index] = Math.abs(lum - background) > threshold ? 1 : 0;
  }
  return mask;
}

function inkRatio(mask: Uint8Array): number {
  let count = 0;
  for (const value of mask) count += value;
  return mask.length > 0 ? count / mask.length : 0;
}

function meanRunNorm(mask: Uint8Array, width: number, height: number): number {
  let total = 0;
  let runs = 0;
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 1) {
        run += 1;
      } else if (run > 0) {
        total += run;
        runs += 1;
        run = 0;
      }
    }
    if (run > 0) {
      total += run;
      runs += 1;
    }
  }
  return runs > 0 ? total / runs / Math.max(1, height) : 0;
}

function profile(mask: Uint8Array, width: number, height: number, axis: "row" | "column"): number[] {
  const length = axis === "row" ? height : width;
  const out = new Array<number>(length).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 1) {
        if (axis === "row") out[y]! += 1;
        else out[x]! += 1;
      }
    }
  }
  return out;
}

/** Smooth a 1-D profile before correlation so a uniform stroke-width change
 * (bold) keeps the same peak structure, while shifted/changed text does not. */
function smoothProfile(values: number[], radius: number): number[] {
  if (radius <= 0 || values.length === 0) return values;
  const out = new Array<number>(values.length).fill(0);
  for (let index = 0; index < values.length; index += 1) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const at = index + offset;
      if (at < 0 || at >= values.length) continue;
      sum += values[at]!;
      count += 1;
    }
    out[index] = sum / Math.max(1, count);
  }
  return out;
}

function correlation(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  const leftMean = left.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  const rightMean = right.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let leftVar = 0;
  let rightVar = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index]! - leftMean;
    const r = right[index]! - rightMean;
    numerator += l * r;
    leftVar += l * l;
    rightVar += r * r;
  }
  const denominator = Math.sqrt(leftVar * rightVar);
  return denominator > 0 ? numerator / denominator : 0;
}

function inkExtent(mask: Uint8Array, width: number, height: number): { width: number; height: number } {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== 1) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX || maxY < minY
    ? { width: 0, height: 0 }
    : { width: maxX - minX + 1, height: maxY - minY + 1 };
}

function unverified(reason: string, metrics: TextWeightMetrics | null = null): TextWeightResult {
  return {
    status: "unverified",
    weightHint: null,
    delta: null,
    confidence: 0,
    designWeight: null,
    experimental: true,
    reason,
    metrics
  };
}

/** Compare the ink profile of the same text region on design and device.
 * Profiling (not raw mask IoU) is the content guard: increasing stroke width
 * scales row/column profiles while keeping their shape, whereas a text or
 * line-wrap change breaks the profile correlation. */
export function measureTextWeight(input: TextWeightInput): TextWeightResult {
  if (input.sourceFormat !== undefined && (input.sourceFormat !== "png" || input.lossless !== true)) {
    return unverified("lossy-source");
  }
  const textPixelHeight = input.textPixelHeight ?? input.device.height;
  if (textPixelHeight < MIN_TEXT_PIXELS) return unverified("text-too-small");

  const design = input.design;
  const device =
    input.device.width === design.width && input.device.height === design.height
      ? input.device
      : resize(input.device, design.width, design.height);
  const designMask = inkMask(design, backgroundLuminance(design));
  const deviceMask = inkMask(device, backgroundLuminance(device));
  const designInk = inkRatio(designMask);
  const deviceInk = inkRatio(deviceMask);
  if (designInk < 0.004 || deviceInk < 0.004) return unverified("no-text-ink");

  const rowCorrelation = correlation(
    profile(designMask, design.width, design.height, "row"),
    profile(deviceMask, device.width, device.height, "row")
  );
  const columnCorrelation = correlation(
    smoothProfile(profile(designMask, design.width, design.height, "column"), 4),
    smoothProfile(profile(deviceMask, device.width, device.height, "column"), 4)
  );
  const designExtent = inkExtent(designMask, design.width, design.height);
  const deviceExtent = inkExtent(deviceMask, device.width, device.height);
  const widthRatio = designExtent.width > 0 ? deviceExtent.width / designExtent.width : 1;
  const heightRatio = designExtent.height > 0 ? deviceExtent.height / designExtent.height : 1;
  const metrics: TextWeightMetrics = {
    inkRatio: deviceInk,
    meanRunNorm: meanRunNorm(deviceMask, device.width, device.height),
    rowProfileCorrelation: rowCorrelation,
    columnProfileCorrelation: columnCorrelation,
    inkExtent: deviceExtent
  };

  if (
    rowCorrelation < 0.8 ||
    columnCorrelation < 0.75 ||
    widthRatio < 0.7 ||
    widthRatio > 1.4 ||
    heightRatio < 0.7 ||
    heightRatio > 1.4
  ) {
    return unverified("content-or-wrap-mismatch", metrics);
  }

  const delta = designInk > 0 ? (deviceInk - designInk) / designInk : 0;
  const low = textPixelHeight < 14 ? 0.1 : 0.08;
  const high = textPixelHeight < 14 ? 0.2 : 0.18;
  const weightHint: TextWeightHint = delta > high ? "heavier" : delta > low ? "heavier" : delta < -low ? "lighter" : "similar";
  const confidence =
    Math.min(
      0.9,
      0.35 +
        (input.sourceFormat === "png" && input.lossless === true ? 0.25 : 0) +
        (rowCorrelation > 0.9 ? 0.15 : 0) +
        (textPixelHeight >= 14 ? 0.1 : 0) +
        (input.localization === "baseline-bbox" || input.localization === "device-text" ? 0.1 : 0)
    ) || 0;

  return {
    status: "checked",
    weightHint,
    delta,
    confidence,
    designWeight: input.designWeight ?? null,
    experimental: true,
    metrics
  };
}
