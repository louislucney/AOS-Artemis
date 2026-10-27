import fs from "node:fs";
import path from "node:path";

import { designDeviceDiff } from "../diff/tool.js";
import { classifyIosSerial } from "../device/ios.js";
import { designDir, loadDesignFlowGraph } from "../figma/design-store.js";
import { designFlowsPath } from "../figma/design-source.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, logWarn } from "../util.js";
import {
  addUiTextStyles,
  normalizeUiTextStyles,
  unverifiedUi,
  type UiCoverage,
  type UiScreenRef,
  type UiSourceFormat,
  type UiTextStyleSummary,
  type UiVerification
} from "./verification.js";

interface TraceStep {
  step: number;
  screen: string;
}

interface ScreenMatch {
  screen: NonNullable<ReturnType<typeof loadDesignFlowGraph>>["screens"][number];
  step: TraceStep;
  /** 原始请求串（testCase.screens），用于未匹配/覆盖率账本。 */
  requested: string;
}

function readTraceSteps(traceDir: string): TraceStep[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(traceDir, "run.json"), "utf-8")) as {
      steps?: Array<{ step?: unknown; screen?: unknown }>;
    };
    return (parsed.steps ?? [])
      .filter(
        (step): step is { step: number; screen: string } =>
          typeof step?.step === "number" && typeof step?.screen === "string"
      )
      .map((step) => ({ step: step.step, screen: step.screen }));
  } catch {
    return [];
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function matchScreens(
  screens: string[],
  flows: NonNullable<ReturnType<typeof loadDesignFlowGraph>>,
  steps: TraceStep[]
): ScreenMatch[] {
  const matches: ScreenMatch[] = [];
  for (const requested of screens) {
    const wanted = normalize(requested);
    if (wanted === "") continue;
    const screen =
      flows.screens.find((entry) => normalize(entry.name) === wanted) ??
      flows.screens.find(
        (entry) => normalize(entry.name).includes(wanted) || wanted.includes(normalize(entry.name))
      );
    if (!screen) continue;
    let best: { step: TraceStep; score: number } | null = null;
    for (const step of steps) {
      const haystack = normalize(step.screen);
      let score = haystack.includes(normalize(screen.name)) ? 2 : 0;
      for (const hint of screen.textHints ?? []) {
        if (hint.text && haystack.includes(normalize(hint.text))) score += 1;
      }
      if (score > 0 && (best === null || score >= best.score)) best = { step, score };
    }
    if (best !== null) matches.push({ screen, step: best.step, requested });
  }
  return matches;
}

function parseResult(result: Awaited<ReturnType<typeof designDeviceDiff>>): Record<string, unknown> | null {
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sourceOf(payload: Record<string, unknown>): {
  format: UiSourceFormat;
  lossless: boolean;
} {
  const detail = payload.detail as { deviceSource?: { format?: unknown; lossless?: unknown } } | undefined;
  const unit = payload.unit as
    | { device?: { sourceFormat?: unknown; lossless?: unknown } }
    | undefined;
  const source = (detail?.deviceSource ?? unit?.device) as Record<string, unknown> | undefined;
  const rawFormat = source?.format ?? source?.sourceFormat;
  const format =
    rawFormat === "png" || rawFormat === "jpeg" || rawFormat === "unknown" ? rawFormat : "unknown";
  return { format, lossless: source?.lossless === true };
}

function buildCoverage(input: {
  requested: string[];
  matchedRequests: Set<string>;
  compared: UiScreenRef[];
  skipped: UiScreenRef[];
}): UiCoverage {
  const unmatchedScreens = input.requested.filter((screen) => !input.matchedRequests.has(screen));
  const matched = input.requested.length - unmatchedScreens.length;
  return {
    requested: input.requested.length,
    matched,
    compared: input.compared.length,
    skipped: input.skipped.length,
    unmatched: unmatchedScreens.length,
    comparedScreens: [...input.compared],
    skippedScreens: [...input.skipped],
    unmatchedScreens
  };
}

function attachCoverage(ui: UiVerification, coverage: UiCoverage): UiVerification {
  return { ...ui, coverage };
}

/** Auto UI check for screens actually visited by the case. First version only
 * compares screens with a per-screen `.pen` and a matching trace step; other
 * screens stay `unverified` (coverage gap, never a fake pass). */
export async function autoCheckUi(
  runtime: Runtime,
  input: {
    traceId: string;
    screens: string[];
    deviceSerial?: string | null;
    maxScreens?: number;
  },
  deps: { designDeviceDiff?: typeof designDeviceDiff } = {}
): Promise<UiVerification> {
  const diff = deps.designDeviceDiff ?? designDeviceDiff;
  const requested = input.screens;
  const noMatchCoverage = (): UiCoverage =>
    buildCoverage({
      requested,
      matchedRequests: new Set<string>(),
      compared: [],
      skipped: []
    });
  const contractPath = path.join(designDir(runtime.configDirAbs), "ui-contract.json");
  if (!fs.existsSync(contractPath)) {
    return attachCoverage(unverifiedUi("no-ui-contract"), noMatchCoverage());
  }
  const flows = loadDesignFlowGraph(runtime.configDirAbs, {
    flowsPath: designFlowsPath(runtime)
  });
  if (flows === null) return attachCoverage(unverifiedUi("no-flows"), noMatchCoverage());

  const steps = readTraceSteps(runtime.traceDir(input.traceId));
  if (steps.length === 0) {
    return attachCoverage(unverifiedUi("no-trace-steps"), noMatchCoverage());
  }
  const matches = matchScreens(requested, flows, steps).slice(
    0,
    Math.max(1, Math.trunc(input.maxScreens ?? 3))
  );
  if (matches.length === 0) {
    return attachCoverage(unverifiedUi("no-screen-match"), noMatchCoverage());
  }

  const platform = classifyIosSerial(input.deviceSerial ?? "") === null ? "android" : "ios";
  const evidence: string[] = [];
  let failed = 0;
  let regions = 0;
  let sourceFormat: UiSourceFormat = "unknown";
  let lossless = false;
  let textStyles: UiTextStyleSummary | undefined;
  const comparedScreens: UiScreenRef[] = [];
  const skippedScreens: UiScreenRef[] = [];
  const matchedRequests = new Set(matches.map((match) => match.requested));
  const coverageNow = (): UiCoverage =>
    buildCoverage({
      requested,
      matchedRequests,
      compared: comparedScreens,
      skipped: skippedScreens
    });
  const finish = (ui: UiVerification): UiVerification => {
    const withCoverage = attachCoverage(ui, coverageNow());
    return textStyles === undefined ? withCoverage : { ...withCoverage, textStyles };
  };

  for (const match of matches) {
    const penPath = path.join(
      designDir(runtime.configDirAbs),
      "pen",
      "screens",
      `${match.screen.id}.pen`
    );
    if (!fs.existsSync(penPath)) {
      skippedScreens.push({ id: match.screen.id, name: match.screen.name });
      continue;
    }
    try {
      const result = await diff(runtime, {
        design: { source: "pen", penPath },
        device: {
          mode: "step",
          platform,
          ...(input.deviceSerial ? { serial: input.deviceSerial } : {}),
          traceId: input.traceId,
          stepNumber: match.step.step,
          image: "post"
        },
        regions: "auto",
        zoom: 2,
        returnCrops: 0
      });
      if (result.isError === true) {
        skippedScreens.push({ id: match.screen.id, name: match.screen.name });
        continue;
      }
      const payload = parseResult(result);
      if (payload === null || payload.ok !== true) {
        skippedScreens.push({ id: match.screen.id, name: match.screen.name });
        continue;
      }
      const source = sourceOf(payload);
      sourceFormat = source.format;
      lossless = source.lossless;
      const textStyleValue = (
        payload as { detail?: { textStyles?: unknown } }
      ).detail?.textStyles;
      const textStyle = normalizeUiTextStyles(textStyleValue);
      if (textStyle !== null) textStyles = addUiTextStyles(textStyles, textStyle);
      const summary = payload.summary as { regions?: unknown; bySeverity?: Record<string, unknown> } | undefined;
      const bySeverity = summary?.bySeverity ?? {};
      const major = Number(bySeverity.blocker ?? 0) + Number(bySeverity.major ?? 0);
      regions += typeof summary?.regions === "number" ? summary.regions : 0;
      const saved = payload.saved as { dir?: unknown } | undefined;
      if (typeof saved?.dir === "string") evidence.push(saved.dir);
      comparedScreens.push({ id: match.screen.id, name: match.screen.name });
      if (major > 0) failed += 1;
    } catch (error) {
      logWarn(`UI 自动比对失败（${match.screen.name} / ${input.traceId}）: ${errorMessage(error)}`);
      skippedScreens.push({ id: match.screen.id, name: match.screen.name });
    }
  }

  if (comparedScreens.length === 0) {
    return finish(
      unverifiedUi(skippedScreens.length > 0 ? "no-comparable-screen" : "no-screen-match")
    );
  }
  if (sourceFormat !== "png" || !lossless) {
    return finish({
      status: "unverified",
      reason: "lossy-source",
      sourceFormat,
      lossless,
      regions,
      ...(evidence.length > 0 ? { evidence } : {})
    });
  }
  if (failed > 0) {
    return finish({
      status: "failed",
      reason: "auto-diff",
      sourceFormat,
      lossless,
      regions,
      evidence
    });
  }
  if (skippedScreens.length > 0) {
    return finish({
      status: "unverified",
      reason: "partial-screen-coverage",
      sourceFormat,
      lossless,
      regions,
      evidence
    });
  }
  return finish({
    status: "passed",
    reason: "auto-diff",
    sourceFormat,
    lossless,
    regions,
    evidence
  });
}
