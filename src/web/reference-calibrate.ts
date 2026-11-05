import fs from "node:fs";
import path from "node:path";

import { decodeImage, diffScreens, type RgbaImage } from "../diff/engine.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { DEFAULT_REFERENCE_DIFF } from "./llm/reference.js";

export interface ReferenceCalibrationPair {
  name?: string;
  reference: string;
  device: string;
  expected: "passed" | "failed";
}

export interface ReferenceThreshold {
  pixelThreshold: number;
  minAreaRatio: number;
  systemBandRatio: number;
}

export interface ReferenceThresholdResult extends ReferenceThreshold {
  /** expected=failed 且检出差异。 */
  caught: number;
  /** expected=failed 但未检出（漏报）。 */
  missed: number;
  /** expected=passed 且未检出差异。 */
  clean: number;
  /** expected=passed 但误报差异。 */
  falseAlarm: number;
  accuracy: number;
  balancedAccuracy: number;
}

export interface ReferenceCalibrationReport {
  ok: boolean;
  manifest: string;
  total: number;
  checked: number;
  skipped: number;
  expected: { passed: number; failed: number };
  current: ReferenceThresholdResult | null;
  /** 样本同时包含 passed/failed 时才给出推荐；否则为 null。 */
  best: ReferenceThresholdResult | null;
  thresholds: ReferenceThresholdResult[];
  recommendedEnv: Record<string, string> | null;
  errors: string[];
  saved?: string;
}

export interface ReferenceCalibrationOptions {
  manifestPath: string;
  outputDir?: string;
  save?: boolean;
  /** 漏报（expected=failed 未检出）即失败。 */
  strict?: boolean;
  now?: () => Date;
}

const PIXEL_GRID = [0.06, 0.08, 0.1, 0.12, 0.16];
const AREA_GRID = [0.001, 0.003, 0.005, 0.01, 0.02];
const BAND_GRID = [0, 0.03, 0.05];

interface LoadedPair {
  name: string;
  expected: "passed" | "failed";
  reference: RgbaImage;
  device: RgbaImage;
}

function stampOf(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, "");
}

function parseExpected(value: unknown, index: number, errors: string[]): "passed" | "failed" | null {
  if (value === "passed" || value === "failed") return value;
  errors.push(`pairs[${index}].expected 仅支持 passed/failed（当前 ${String(value)}）`);
  return null;
}

function loadPair(
  raw: Record<string, unknown>,
  index: number,
  baseDir: string,
  errors: string[]
): LoadedPair | null {
  const name =
    typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : `pair-${index + 1}`;
  const expected = parseExpected(raw.expected, index, errors);
  if (expected === null) return null;
  if (typeof raw.reference !== "string" || raw.reference.trim() === "") {
    errors.push(`${name}: 缺少 reference 图片路径`);
    return null;
  }
  if (typeof raw.device !== "string" || raw.device.trim() === "") {
    errors.push(`${name}: 缺少 device 图片路径`);
    return null;
  }
  const referencePath = path.resolve(baseDir, raw.reference);
  const devicePath = path.resolve(baseDir, raw.device);
  let reference: RgbaImage;
  let device: RgbaImage;
  try {
    reference = decodeImage(fs.readFileSync(referencePath));
  } catch (error) {
    errors.push(`${name}: 参考图不可读（${referencePath}）：${errorMessage(error)}`);
    return null;
  }
  try {
    device = decodeImage(fs.readFileSync(devicePath));
  } catch (error) {
    errors.push(`${name}: 设备图不可读（${devicePath}）：${errorMessage(error)}`);
    return null;
  }
  return { name, expected, reference, device };
}

function evaluate(pairs: LoadedPair[], threshold: ReferenceThreshold): ReferenceThresholdResult {
  let caught = 0;
  let missed = 0;
  let clean = 0;
  let falseAlarm = 0;
  for (const pair of pairs) {
    const diff = diffScreens(pair.reference, pair.device, {
      pixelThreshold: threshold.pixelThreshold,
      minAreaRatio: threshold.minAreaRatio,
      maxEdge: 1440,
      systemBandRatio: threshold.systemBandRatio
    });
    const predicted = diff.regions.length === 0 ? "passed" : "failed";
    if (pair.expected === "failed") {
      if (predicted === "failed") caught += 1;
      else missed += 1;
    } else if (predicted === "passed") {
      clean += 1;
    } else {
      falseAlarm += 1;
    }
  }
  const total = pairs.length;
  const accuracy = total === 0 ? 0 : (caught + clean) / total;
  const sensitivity = caught + missed === 0 ? 1 : caught / (caught + missed);
  const specificity = clean + falseAlarm === 0 ? 1 : clean / (clean + falseAlarm);
  return {
    ...threshold,
    caught,
    missed,
    clean,
    falseAlarm,
    accuracy,
    balancedAccuracy: (sensitivity + specificity) / 2
  };
}

function distanceToDefault(value: ReferenceThreshold): number {
  return (
    Math.abs(value.pixelThreshold - DEFAULT_REFERENCE_DIFF.pixelThreshold) +
    Math.abs(value.minAreaRatio - DEFAULT_REFERENCE_DIFF.minAreaRatio) * 10 +
    Math.abs(value.systemBandRatio - DEFAULT_REFERENCE_DIFF.systemBandRatio) * 10
  );
}

function better(a: ReferenceThresholdResult, b: ReferenceThresholdResult): boolean {
  if (a.balancedAccuracy !== b.balancedAccuracy) return a.balancedAccuracy > b.balancedAccuracy;
  if (a.accuracy !== b.accuracy) return a.accuracy > b.accuracy;
  if (a.missed !== b.missed) return a.missed < b.missed;
  if (a.falseAlarm !== b.falseAlarm) return a.falseAlarm < b.falseAlarm;
  if (distanceToDefault(a) !== distanceToDefault(b)) {
    return distanceToDefault(a) < distanceToDefault(b);
  }
  if (a.pixelThreshold !== b.pixelThreshold) return a.pixelThreshold > b.pixelThreshold;
  return a.minAreaRatio > b.minAreaRatio;
}

function thresholdKey(value: ReferenceThreshold): string {
  return `${value.pixelThreshold}/${value.minAreaRatio}/${value.systemBandRatio}`;
}

function envOf(best: ReferenceThresholdResult): Record<string, string> {
  return {
    AOS_L2_PIXEL_THRESHOLD: String(best.pixelThreshold),
    AOS_L2_MIN_AREA_RATIO: String(best.minAreaRatio),
    AOS_L2_SYSTEM_BAND_RATIO: String(best.systemBandRatio)
  };
}

/** 离线 L2 阈值校准：成对参考图/设备图 → 阈值网格混淆矩阵与推荐值。 */
export async function runReferenceCalibration(
  options: ReferenceCalibrationOptions
): Promise<ReferenceCalibrationReport> {
  const manifestPath = path.resolve(options.manifestPath);
  const errors: string[] = [];
  let rawPairs: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
    if (Array.isArray(parsed)) rawPairs = parsed;
    else if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { pairs?: unknown }).pairs)
    ) {
      rawPairs = (parsed as { pairs: unknown[] }).pairs;
    } else {
      errors.push("manifest 必须是 { pairs: [...] } 或数组");
    }
  } catch (error) {
    errors.push(`manifest 不可读：${errorMessage(error)}`);
  }

  const baseDir = path.dirname(manifestPath);
  const pairs: LoadedPair[] = [];
  rawPairs.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      errors.push(`pairs[${index}] 不是对象`);
      return;
    }
    const pair = loadPair(raw as Record<string, unknown>, index, baseDir, errors);
    if (pair !== null) pairs.push(pair);
  });

  const expected = { passed: 0, failed: 0 };
  for (const pair of pairs) expected[pair.expected] += 1;

  const thresholds: ReferenceThresholdResult[] = [];
  for (const pixelThreshold of PIXEL_GRID) {
    for (const minAreaRatio of AREA_GRID) {
      for (const systemBandRatio of BAND_GRID) {
        thresholds.push(evaluate(pairs, { pixelThreshold, minAreaRatio, systemBandRatio }));
      }
    }
  }
  const current = evaluate(pairs, DEFAULT_REFERENCE_DIFF);
  const seen = new Set(thresholds.map(thresholdKey));
  const currentKey = thresholdKey(DEFAULT_REFERENCE_DIFF);
  if (!seen.has(currentKey)) thresholds.push(current);

  const comparable = expected.passed > 0 && expected.failed > 0;
  if (pairs.length === 0) errors.push("没有可校准的成对样本");
  else if (!comparable) errors.push("样本需同时包含 expected=passed 与 expected=failed，才给出推荐阈值");

  let best: ReferenceThresholdResult | null = null;
  if (comparable) {
    best = thresholds.reduce((winner, entry) => (better(entry, winner) ? entry : winner));
  }

  const report: ReferenceCalibrationReport = {
    ok: pairs.length > 0 && (options.strict !== true || (best !== null && best.missed === 0)),
    manifest: manifestPath,
    total: rawPairs.length,
    checked: pairs.length,
    skipped: rawPairs.length - pairs.length,
    expected,
    current: pairs.length === 0 ? null : current,
    best,
    thresholds: thresholds.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0)),
    recommendedEnv: best === null ? null : envOf(best),
    errors
  };

  if (options.save !== false) {
    const now = (options.now ?? (() => new Date()))();
    const dir = path.resolve(options.outputDir ?? baseDir);
    const saved = path.join(dir, `reference-calibration-${stampOf(now)}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(saved, `${JSON.stringify(report, null, 2)}\n`);
      report.saved = saved;
    } catch (error) {
      report.ok = false;
      report.errors.push(`报告写入失败：${errorMessage(error)}`);
    }
  }
  return report;
}
