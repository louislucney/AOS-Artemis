import fs from "node:fs";
import path from "node:path";

import { decodeImage } from "../diff/engine.js";
import { readTraceTexts } from "../diff/tool.js";
import type { Runtime } from "../runtime.js";
import type { UiRuntimeAsset, UiRuntimeText } from "./parity.js";
import type { UiViewport } from "./semantics.js";

export interface UiRuntimeSnapshot {
  screen?: string;
  /** trace step 的 screen 摘要（通常是可见文本串）；用于多屏兜底匹配。 */
  screenText?: string;
  step?: number;
  viewport?: UiViewport;
  source: "trace" | "file";
  /** trace AX 树为 content；--snapshot 默认 viewport。 */
  space: "content" | "viewport";
  texts: UiRuntimeText[];
  assets?: UiRuntimeAsset[];
  coverage?: { visible: number; unverified: number; offscreen: number };
}

export interface UiRuntimeSnapshotInput {
  traceId?: string;
  stepNumber?: number;
  snapshotPath?: string;
  visualTextPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBbox(value: unknown, pathLabel: string): { x: number; y: number; width: number; height: number } {
  if (!isObject(value)) throw new Error(`${pathLabel}: bbox must be an object`);
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    throw new Error(`${pathLabel}: bbox expects finite x/y and width/height > 0`);
  }
  return { x, y, width, height };
}

function parseViewport(value: unknown, pathLabel: string): UiViewport {
  if (!isObject(value)) throw new Error(`${pathLabel}: viewport must be an object`);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  const scale = value.scale === undefined ? undefined : finiteNumber(value.scale);
  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new Error(`${pathLabel}: viewport width/height must be > 0`);
  }
  if (value.scale !== undefined && (typeof scale !== "number" || scale <= 0)) {
    throw new Error(`${pathLabel}: viewport scale must be > 0`);
  }
  return {
    width,
    height,
    ...(typeof scale === "number" && scale > 0 ? { scale } : {})
  };
}

function parseText(value: unknown, pathLabel: string, defaultSpace: "content" | "viewport"): UiRuntimeText {
  if (!isObject(value)) throw new Error(`${pathLabel}: text entry must be an object`);
  if (typeof value.text !== "string" || value.text.trim() === "") {
    throw new Error(`${pathLabel}.text: expected non-empty string`);
  }
  const spaceValue = value.space === undefined ? defaultSpace : value.space;
  if (spaceValue !== "content" && spaceValue !== "viewport") {
    throw new Error(`${pathLabel}.space: expected content | viewport`);
  }
  const sourceValue = value.source === undefined ? "manual" : value.source;
  if (sourceValue !== "ax" && sourceValue !== "visual" && sourceValue !== "manual") {
    throw new Error(`${pathLabel}.source: expected ax | visual | manual`);
  }
  const visible = value.visible === undefined ? undefined : value.visible;
  if (visible !== undefined && typeof visible !== "boolean") {
    throw new Error(`${pathLabel}.visible: expected boolean`);
  }
  const bbox = value.bbox === undefined ? undefined : parseBbox(value.bbox, `${pathLabel}.bbox`);
  return {
    text: value.text,
    ...(bbox !== undefined ? { bbox } : {}),
    space: spaceValue,
    source: sourceValue,
    ...(visible !== undefined ? { visible } : {})
  };
}

function parseAsset(value: unknown, pathLabel: string, defaultSpace: "content" | "viewport"): UiRuntimeAsset {
  if (!isObject(value)) throw new Error(`${pathLabel}: asset entry must be an object`);
  const kind = value.kind;
  if (kind !== "image" && kind !== "banner" && kind !== "icon") {
    throw new Error(`${pathLabel}.kind: expected image | banner | icon`);
  }
  if (typeof value.present !== "boolean") {
    throw new Error(`${pathLabel}.present: expected boolean`);
  }
  const spaceValue = value.space === undefined ? defaultSpace : value.space;
  if (spaceValue !== "content" && spaceValue !== "viewport") {
    throw new Error(`${pathLabel}.space: expected content | viewport`);
  }
  const sourceValue = value.source === undefined ? "manual" : value.source;
  if (sourceValue !== "ax" && sourceValue !== "visual" && sourceValue !== "manual") {
    throw new Error(`${pathLabel}.source: expected ax | visual | manual`);
  }
  const placeholder = value.placeholder === undefined ? undefined : value.placeholder;
  if (placeholder !== undefined && typeof placeholder !== "boolean") {
    throw new Error(`${pathLabel}.placeholder: expected boolean`);
  }
  const bbox = value.bbox === undefined ? undefined : parseBbox(value.bbox, `${pathLabel}.bbox`);
  return {
    kind,
    present: value.present,
    space: spaceValue,
    source: sourceValue,
    ...(bbox !== undefined ? { bbox } : {}),
    ...(placeholder !== undefined ? { placeholder } : {})
  };
}

function readJson(file: string, label: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    throw new Error(`${label} not found: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function textCoverage(texts: readonly UiRuntimeText[]): { visible: number; unverified: number; offscreen: number } {
  let visible = 0;
  let offscreen = 0;
  for (const text of texts) {
    if (text.visible === false) offscreen += 1;
    else visible += 1;
  }
  return { visible, unverified: 0, offscreen };
}

function loadVisualTexts(rootDir: string, file: string, fallbackSpace: "content" | "viewport"): UiRuntimeText[] {
  const resolved = path.isAbsolute(file) ? file : path.join(rootDir, file);
  const parsed = readJson(resolved, "visual text");
  if (!isObject(parsed) || !Array.isArray(parsed.texts)) {
    throw new Error("visual text: expected object with texts[]");
  }
  return parsed.texts.map((entry, index) => {
    const text = parseText(entry, `visual.texts[${index}]`, fallbackSpace);
    return { ...text, source: "visual" };
  });
}

function loadSnapshotFile(
  rootDir: string,
  file: string,
  visualTextPath: string | undefined
): UiRuntimeSnapshot {
  const resolved = path.isAbsolute(file) ? file : path.join(rootDir, file);
  const parsed = readJson(resolved, "snapshot");
  if (!isObject(parsed)) throw new Error("snapshot: expected object");
  const space = parsed.space === undefined ? "viewport" : parsed.space;
  if (space !== "content" && space !== "viewport") {
    throw new Error("snapshot.space: expected content | viewport");
  }
  if (!Array.isArray(parsed.texts)) throw new Error("snapshot.texts: expected array");
  const texts = parsed.texts.map((entry, index) => parseText(entry, `snapshot.texts[${index}]`, space));
  const assets =
    parsed.assets === undefined
      ? undefined
      : Array.isArray(parsed.assets)
        ? parsed.assets.map((entry, index) => parseAsset(entry, `snapshot.assets[${index}]`, space))
        : (() => {
            throw new Error("snapshot.assets: expected array");
          })();
  const visualTexts =
    visualTextPath === undefined ? null : loadVisualTexts(rootDir, visualTextPath, space);
  const effectiveTexts = visualTexts ?? texts;
  return {
    source: "file",
    space,
    ...(typeof parsed.screen === "string" && parsed.screen.trim() !== "" ? { screen: parsed.screen.trim() } : {}),
    ...(parsed.viewport !== undefined ? { viewport: parseViewport(parsed.viewport, "snapshot.viewport") } : {}),
    texts: effectiveTexts,
    ...(assets !== undefined ? { assets } : {}),
    coverage: textCoverage(effectiveTexts)
  };
}

function loadTraceSnapshot(
  runtime: Runtime,
  traceId: string,
  stepNumber: number,
  visualTextPath: string | undefined
): UiRuntimeSnapshot {
  const traceDir = runtime.traceDir(traceId);
  const runPath = path.join(traceDir, "run.json");
  const run = readJson(runPath, "trace run.json");
  if (!isObject(run) || !Array.isArray(run.steps)) {
    throw new Error("trace run.json: expected steps[]");
  }
  const step = run.steps.find(
    (entry) => isObject(entry) && entry.step === stepNumber
  );
  if (!isObject(step)) throw new Error(`trace step ${stepNumber} not found`);
  const shotRelative =
    typeof step.postShot === "string"
      ? step.postShot
      : typeof step.shot === "string"
        ? step.shot
        : null;
  if (shotRelative === null) throw new Error(`trace step ${stepNumber} has no screenshot`);
  const shotPath = path.isAbsolute(shotRelative) ? shotRelative : path.join(traceDir, shotRelative);
  let image: ReturnType<typeof decodeImage>;
  try {
    image = decodeImage(fs.readFileSync(shotPath));
  } catch (error) {
    throw new Error(`trace screenshot cannot be decoded (${shotPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const trace = readTraceTexts(runtime, traceId, stepNumber);
  if (trace === null) throw new Error(`trace step ${stepNumber} has no texts[]`);
  const scale = trace.scale;
  const texts: UiRuntimeText[] = trace.texts.map((entry) => {
    const bbox = {
      x: entry.x * scale,
      y: entry.y * scale,
      width: entry.width * scale,
      height: entry.height * scale
    };
    const visible =
      bbox.x < image.width &&
      bbox.y < image.height &&
      bbox.x + bbox.width > 0 &&
      bbox.y + bbox.height > 0;
    return { text: entry.text, bbox, space: "content", source: "ax", visible };
  });
  const effectiveTexts =
    visualTextPath === undefined
      ? texts
      : loadVisualTexts(runtime.project.rootDir, visualTextPath, "viewport");
  const traceScreen =
    typeof step.screen === "string" &&
    step.screen.trim() !== "" &&
    step.screen.length <= 80 &&
    !step.screen.includes("|")
      ? step.screen.trim()
      : undefined;
  return {
    source: visualTextPath === undefined ? "trace" : "file",
    step: stepNumber,
    viewport: { width: image.width, height: image.height, scale },
    space: visualTextPath === undefined ? "content" : "viewport",
    ...(traceScreen !== undefined ? { screen: traceScreen } : {}),
    ...(typeof step.screen === "string" && step.screen.trim() !== "" ? { screenText: step.screen } : {}),
    texts: effectiveTexts,
    coverage: textCoverage(effectiveTexts)
  };
}

export function loadUiRuntimeSnapshot(
  runtime: Runtime,
  input: UiRuntimeSnapshotInput
): UiRuntimeSnapshot {
  if (input.traceId !== undefined && input.snapshotPath !== undefined) {
    throw new Error("--trace 与 --snapshot 二选一");
  }
  if (input.traceId !== undefined) {
    if (input.stepNumber === undefined) throw new Error("--trace 需要 --step");
    return loadTraceSnapshot(runtime, input.traceId, input.stepNumber, input.visualTextPath);
  }
  if (input.snapshotPath !== undefined) {
    return loadSnapshotFile(runtime.project.rootDir, input.snapshotPath, input.visualTextPath);
  }
  throw new Error("需要 --trace <traceId> --step <n> 或 --snapshot <json>");
}
