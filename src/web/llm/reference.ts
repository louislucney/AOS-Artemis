import fs from "node:fs";
import path from "node:path";

import { decodeImage, diffScreens } from "../../diff/engine.js";
import { errorMessage } from "../../util.js";

export const DEFAULT_REFERENCE_DIFF = {
  pixelThreshold: 0.12,
  minAreaRatio: 0.01,
  maxEdge: 1440,
  systemBandRatio: 0.05
} as const;

function boundedEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

/** L2 阈值可由项目 `.env` 覆盖（校准 CLI 的推荐值直接写入即可）。 */
export function referenceDiffOptions(env: NodeJS.ProcessEnv = process.env): {
  pixelThreshold: number;
  minAreaRatio: number;
  maxEdge: number;
  systemBandRatio: number;
} {
  return {
    pixelThreshold: boundedEnv(
      env,
      "AOS_L2_PIXEL_THRESHOLD",
      DEFAULT_REFERENCE_DIFF.pixelThreshold,
      0,
      1
    ),
    minAreaRatio: boundedEnv(env, "AOS_L2_MIN_AREA_RATIO", DEFAULT_REFERENCE_DIFF.minAreaRatio, 0, 1),
    maxEdge: DEFAULT_REFERENCE_DIFF.maxEdge,
    systemBandRatio: boundedEnv(
      env,
      "AOS_L2_SYSTEM_BAND_RATIO",
      DEFAULT_REFERENCE_DIFF.systemBandRatio,
      0,
      0.25
    )
  };
}

export interface ReferenceCheck {
  status: "passed" | "failed" | "unverified" | "missing";
  regions?: number;
  reason?: string;
  referenceAssetId?: string;
  screenshot?: string;
}

function readImage(file: string): ReturnType<typeof decodeImage> | null {
  try {
    if (!fs.existsSync(file)) return null;
    return decodeImage(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** iOS trace: 最后一步的 postShot 优先，其次 shot。 */
export function lastIosScreenshot(traceDir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(traceDir, "run.json"), "utf8")) as {
      steps?: Array<{ shot?: unknown; postShot?: unknown }>;
    };
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    for (const step of [...steps].reverse()) {
      for (const key of ["postShot", "shot"] as const) {
        const rel = step[key];
        if (typeof rel !== "string" || rel === "") continue;
        const file = path.resolve(traceDir, rel);
        if (fs.existsSync(file)) return file;
      }
    }
  } catch {
    /* trace 缺失/损坏 → null */
  }
  return null;
}

/**
 * L2 report-only：参考图 vs 最终设备截图。
 * 只产出确定性差异，不改变 PASS/FAIL；证据缺失一律 unverified/missing。
 */
export function compareReference(input: {
  referencePath: string | null | undefined;
  screenshotPath: string | null | undefined;
  referenceAssetId?: string | null;
  /** 参考图显式指定但未匹配时给出具体原因（缺省 reference-asset-missing）。 */
  missingReason?: string | null;
  env?: NodeJS.ProcessEnv;
}): ReferenceCheck {
  const referenceAssetId = input.referenceAssetId ?? undefined;
  if (input.referencePath === null || input.referencePath === undefined) {
    return {
      status: "missing",
      reason: input.missingReason ?? "reference-asset-missing",
      ...(referenceAssetId === undefined ? {} : { referenceAssetId })
    };
  }
  if (input.screenshotPath === null || input.screenshotPath === undefined) {
    return {
      status: "unverified",
      reason: "device-screenshot-missing",
      ...(referenceAssetId === undefined ? {} : { referenceAssetId })
    };
  }
  const design = readImage(input.referencePath);
  const device = readImage(input.screenshotPath);
  if (design === null || device === null) {
    return {
      status: "unverified",
      reason: "image-unreadable",
      screenshot: input.screenshotPath,
      ...(referenceAssetId === undefined ? {} : { referenceAssetId })
    };
  }
  try {
    const diff = diffScreens(design, device, referenceDiffOptions(input.env));
    return {
      status: diff.regions.length === 0 ? "passed" : "failed",
      regions: diff.regions.length,
      ...(diff.regions.length === 0
        ? {}
        : { reason: `pixel-diff:${diff.regions.length}` }),
      screenshot: input.screenshotPath,
      ...(referenceAssetId === undefined ? {} : { referenceAssetId })
    };
  } catch (error) {
    return {
      status: "unverified",
      reason: `diff-failed:${errorMessage(error)}`,
      screenshot: input.screenshotPath,
      ...(referenceAssetId === undefined ? {} : { referenceAssetId })
    };
  }
}
