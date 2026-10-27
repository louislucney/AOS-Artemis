import fs from "node:fs";
import path from "node:path";

import { decodeImage, type RgbaImage } from "../diff/engine.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import {
  measureTextWeight,
  type TextWeightHint,
  type TextWeightResult
} from "./text-weight.js";

export type CalibrationExpected = TextWeightHint;
export type CalibrationActual = CalibrationExpected | "unverified";

export interface TextWeightCalibrationPair {
  name?: string;
  /** "design"/"device" 与 "baseline"/"current" 等价；baseline 用于同平台校准。 */
  design?: string;
  device?: string;
  baseline?: string;
  current?: string;
  designWeight?: number;
  expected?: CalibrationExpected;
  textPixelHeight?: number;
  sourceFormat?: "png" | "jpeg" | "unknown";
  lossless?: boolean;
  localization?: "baseline-bbox" | "design-bbox" | "device-text";
}

export interface TextWeightCalibrationOptions {
  manifestPath: string;
  outputDir?: string;
  save?: boolean;
  /** 任何 labeled 不匹配都失败（默认只把高置信误报算失败）。 */
  strict?: boolean;
  now?: () => Date;
}

export interface TextWeightCalibrationMismatch {
  name: string;
  expected: CalibrationExpected;
  actual: CalibrationActual;
  delta: number | null;
  confidence: number;
  reason?: string;
}

export interface TextWeightDeltaStats {
  expected: CalibrationExpected;
  count: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface TextWeightCalibrationReport {
  ok: boolean;
  manifest: string;
  total: number;
  labeled: number;
  unlabeled: number;
  checked: number;
  unverified: number;
  unverifiedByReason: Record<string, number>;
  confusion: Record<string, Record<string, number>>;
  highConfidenceMismatches: TextWeightCalibrationMismatch[];
  highConfidenceFalseHeavier: number;
  /** 所有 labeled 的 actual≠expected（含低置信；不含 unverified）。 */
  labeledMismatches: number;
  deltaStats: TextWeightDeltaStats[];
  thresholdHint: {
    minHeavierDelta: number | null;
    maxNonHeavierDelta: number | null;
    separated: boolean | null;
    suggestedHeavierDelta: number | null;
  };
  errors: string[];
  saved?: string;
}

const EXPECTED_LABELS: CalibrationExpected[] = ["lighter", "similar", "heavier"];

function stampOf(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function imageFormat(bytes: Uint8Array): "png" | "jpeg" | "unknown" {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return "unknown";
}

function resolveImage(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function statsOf(expected: CalibrationExpected, values: number[]): TextWeightDeltaStats | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length === 1
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return {
    expected,
    count: values.length,
    mean: Number(mean.toFixed(4)),
    stddev: Number(Math.sqrt(variance).toFixed(4)),
    min: Number(Math.min(...values).toFixed(4)),
    max: Number(Math.max(...values).toFixed(4))
  };
}

function actualLabel(result: TextWeightResult): CalibrationActual {
  return result.status === "unverified" ? "unverified" : result.weightHint ?? "unverified";
}

function measurePair(
  baseDir: string,
  pair: TextWeightCalibrationPair
): { result: TextWeightResult; name: string } | { error: string; name: string } {
  const name = pair.name?.trim() || "";
  const designPath = pair.design ?? pair.baseline;
  const devicePath = pair.device ?? pair.current;
  if (typeof designPath !== "string" || typeof devicePath !== "string") {
    return { name, error: "缺 design/device（或 baseline/current）" };
  }
  let design: RgbaImage;
  let device: RgbaImage;
  try {
    design = decodeImage(fs.readFileSync(resolveImage(baseDir, designPath)));
    device = decodeImage(fs.readFileSync(resolveImage(baseDir, devicePath)));
  } catch (error) {
    return { name, error: errorMessage(error) };
  }
  const designBytes = fs.readFileSync(resolveImage(baseDir, designPath));
  const deviceBytes = fs.readFileSync(resolveImage(baseDir, devicePath));
  const designFormat = imageFormat(designBytes);
  const deviceFormat = imageFormat(deviceBytes);
  const sourceFormat =
    pair.sourceFormat ??
    (designFormat === "png" && deviceFormat === "png"
      ? "png"
      : designFormat === "jpeg" || deviceFormat === "jpeg"
        ? "jpeg"
        : "unknown");
  const lossless = pair.lossless ?? sourceFormat === "png";
  const result = measureTextWeight({
    design,
    device,
    ...(typeof pair.designWeight === "number" ? { designWeight: pair.designWeight } : {}),
    ...(typeof pair.textPixelHeight === "number"
      ? { textPixelHeight: pair.textPixelHeight }
      : {}),
    sourceFormat,
    lossless,
    localization: pair.localization ?? "design-bbox"
  });
  return { result, name };
}

/** 离线校准：成对图片 manifest → 混淆矩阵/高置信误报/delta 分布/阈值建议。 */
export async function runTextWeightCalibration(
  options: TextWeightCalibrationOptions
): Promise<TextWeightCalibrationReport> {
  const manifestPath = path.resolve(options.manifestPath);
  const baseDir = path.dirname(manifestPath);
  let pairs: TextWeightCalibrationPair[];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      pairs?: unknown;
    };
    if (!Array.isArray(parsed.pairs)) throw new Error("manifest 缺少 pairs 数组");
    pairs = parsed.pairs.filter(
      (entry): entry is TextWeightCalibrationPair =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
    );
  } catch (error) {
    return {
      ok: false,
      manifest: manifestPath,
      total: 0,
      labeled: 0,
      unlabeled: 0,
      checked: 0,
      unverified: 0,
      unverifiedByReason: {},
      confusion: {},
      highConfidenceMismatches: [],
      highConfidenceFalseHeavier: 0,
      labeledMismatches: 0,
      deltaStats: [],
      thresholdHint: {
        minHeavierDelta: null,
        maxNonHeavierDelta: null,
        separated: null,
        suggestedHeavierDelta: null
      },
      errors: [errorMessage(error)]
    };
  }

  const confusion: Record<string, Record<string, number>> = {};
  const errors: string[] = [];
  const mismatches: TextWeightCalibrationMismatch[] = [];
  const unverifiedByReason: Record<string, number> = {};
  const deltasByExpected = new Map<CalibrationExpected, number[]>();
  const heavierDeltas: number[] = [];
  const nonHeavierDeltas: number[] = [];
  let checked = 0;
  let unverified = 0;
  let labeled = 0;
  let labeledMismatches = 0;

  for (const pair of pairs) {
    const measured = measurePair(baseDir, pair);
    if ("error" in measured) {
      errors.push(`${measured.name || "pair"}: ${measured.error}`);
      continue;
    }
    const { result, name } = measured;
    const actual = actualLabel(result);
    const expected = pair.expected;
    if (expected !== undefined && !EXPECTED_LABELS.includes(expected)) {
      errors.push(`${name || "pair"}: expected 必须是 lighter/similar/heavier`);
      continue;
    }
    const expectedKey = expected ?? "unlabeled";
    confusion[expectedKey] = confusion[expectedKey] ?? {};
    confusion[expectedKey][actual] = (confusion[expectedKey][actual] ?? 0) + 1;
    if (actual === "unverified") {
      unverified += 1;
      if (result.reason) {
        unverifiedByReason[result.reason] = (unverifiedByReason[result.reason] ?? 0) + 1;
      }
    } else {
      checked += 1;
    }
    if (expected === undefined) continue;
    labeled += 1;
    if (typeof result.delta === "number" && actual !== "unverified") {
      const list = deltasByExpected.get(expected) ?? [];
      list.push(result.delta);
      deltasByExpected.set(expected, list);
      if (expected === "heavier") heavierDeltas.push(result.delta);
      else nonHeavierDeltas.push(result.delta);
    }
    if (actual !== "unverified" && actual !== expected) {
      labeledMismatches += 1;
    }
    if (actual !== "unverified" && actual !== expected && result.confidence >= 0.7) {
      mismatches.push({
        name: name || `pair-${labeled}`,
        expected,
        actual,
        delta: result.delta,
        confidence: result.confidence
      });
    }
  }

  const minHeavierDelta =
    heavierDeltas.length > 0 ? Number(Math.min(...heavierDeltas).toFixed(4)) : null;
  const maxNonHeavierDelta =
    nonHeavierDeltas.length > 0 ? Number(Math.max(...nonHeavierDeltas).toFixed(4)) : null;
  const separated =
    minHeavierDelta !== null && maxNonHeavierDelta !== null
      ? minHeavierDelta > maxNonHeavierDelta
      : null;
  const thresholdHint = {
    minHeavierDelta,
    maxNonHeavierDelta,
    separated,
    suggestedHeavierDelta:
      separated === true && minHeavierDelta !== null && maxNonHeavierDelta !== null
        ? Number(((minHeavierDelta + maxNonHeavierDelta) / 2).toFixed(4))
        : null
  };

  const highConfidenceFalseHeavier = mismatches.filter(
    (entry) => entry.expected !== "heavier" && entry.actual === "heavier"
  ).length;
  const unlabeled = pairs.length - labeled - errors.length;
  const ok =
    errors.length === 0 &&
    (options.strict === true
      ? labeledMismatches === 0 && unlabeled === 0 && unverified === 0
      : mismatches.length === 0);
  const report: TextWeightCalibrationReport = {
    ok,
    manifest: manifestPath,
    total: pairs.length,
    labeled,
    unlabeled,
    checked,
    unverified,
    unverifiedByReason,
    confusion,
    highConfidenceMismatches: mismatches,
    highConfidenceFalseHeavier,
    labeledMismatches,
    deltaStats: EXPECTED_LABELS.flatMap((expected) => {
      const stats = statsOf(expected, deltasByExpected.get(expected) ?? []);
      return stats === null ? [] : [stats];
    }),
    thresholdHint,
    errors
  };

  if (options.save !== false) {
    const now = (options.now ?? (() => new Date()))();
    const dir = path.resolve(options.outputDir ?? baseDir);
    const saved = path.join(dir, `text-weight-calibration-${stampOf(now)}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(saved, `${JSON.stringify(report, null, 2)}\n`);
      report.saved = saved;
    } catch (error) {
      report.ok = false;
      report.errors.push(`报告写入失败: ${errorMessage(error)}`);
    }
  }
  return report;
}
