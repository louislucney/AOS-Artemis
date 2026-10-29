import type { RgbaImage } from "../diff/engine.js";

export interface TextSizeEstimate {
  /** 估计字号（设备像素）；仅报告，不参与门禁。 */
  estimatedFontSizePx: number | null;
  /** 文本行高中位数（设备像素）。 */
  estimatedLineHeightPx: number | null;
  lineCount: number;
  confidence: "low" | "medium";
  method: "line-height-median";
  reportOnly: true;
  reason?: string;
}

export interface EstimateTextSizeOptions {
  /** 无损 PNG 才给 medium；JPEG/未知来源固定 low。 */
  lossless?: boolean;
  /** 行高上限，默认 120px。 */
  maxLineHeight?: number;
}

const MIN_IMAGE = 10;
const MIN_LINE = 6;
const MAX_GAP = 4;
const INK_THRESHOLD = 42;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function backgroundLuminance(image: RgbaImage): number {
  const samples: number[] = [];
  const sample = (x: number, y: number): void => {
    const index = (y * image.width + x) * 4;
    samples.push(luminance(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!));
  };
  for (let x = 0; x < image.width; x += 1) {
    sample(x, 0);
    if (image.height > 1) sample(x, image.height - 1);
  }
  for (let y = 1; y < image.height - 1; y += 1) {
    sample(0, y);
    if (image.width > 1) sample(image.width - 1, y);
  }
  if (samples.length === 0) return 255;
  // 取众数（按 8 级量化）而不是均值：文字/色块贴边时均值会被少量墨色拉偏。
  const counts = new Map<number, number>();
  for (const value of samples) {
    const bucket = Math.round(value / 8) * 8;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  let best = 255;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function empty(reason: string): TextSizeEstimate {
  return {
    estimatedFontSizePx: null,
    estimatedLineHeightPx: null,
    lineCount: 0,
    confidence: "low",
    method: "line-height-median",
    reportOnly: true,
    reason
  };
}

/**
 * 从文本区域截图中估计字号/行高：逐行统计非背景像素，按连续行分组，
 * 取有效行高中位数 × 0.7（imugi design-extractor 的经验系数）。
 * 仅用于失败证据/人工复核，不参与 PASS/FAIL。
 */
export function estimateTextSize(
  image: RgbaImage,
  options: EstimateTextSizeOptions = {}
): TextSizeEstimate {
  if (image.width < MIN_IMAGE || image.height < MIN_IMAGE) return empty("image-too-small");
  const background = backgroundLuminance(image);
  const rowCounts: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      const lum = luminance(image.data[index]!, image.data[index + 1]!, image.data[index + 2]!);
      if (Math.abs(lum - background) > INK_THRESHOLD) count += 1;
    }
    rowCounts.push(count);
  }

  const contentThreshold = Math.max(3, image.width * 0.01);
  const maxLineHeight = Math.max(MIN_LINE, options.maxLineHeight ?? 120);
  const lines: Array<{ start: number; end: number }> = [];
  let lineStart: number | null = null;
  let gap = 0;
  for (let y = 0; y < rowCounts.length; y += 1) {
    if (rowCounts[y]! > contentThreshold) {
      if (lineStart === null) lineStart = y;
      gap = 0;
    } else if (lineStart !== null) {
      gap += 1;
      if (gap > MAX_GAP) {
        lines.push({ start: lineStart, end: y - gap + 1 });
        lineStart = null;
        gap = 0;
      }
    }
  }
  if (lineStart !== null) lines.push({ start: lineStart, end: image.height });

  const valid = lines.filter((line) => {
    const height = line.end - line.start;
    return height >= MIN_LINE && height <= maxLineHeight;
  });
  if (valid.length === 0) return empty("no-text-lines");

  const heights = valid.map((line) => line.end - line.start).sort((left, right) => left - right);
  const middle = Math.floor(heights.length / 2);
  const median =
    heights.length % 2 === 1
      ? heights[middle]!
      : (heights[middle - 1]! + heights[middle]!) / 2;
  const lossless = options.lossless !== false;
  return {
    estimatedFontSizePx: Math.round(median * 0.7),
    estimatedLineHeightPx: median,
    lineCount: valid.length,
    confidence: lossless && valid.length >= 2 ? "medium" : "low",
    method: "line-height-median",
    reportOnly: true,
    ...(lossless ? {} : { reason: "lossy-source" })
  };
}
