import fs from "node:fs";
import path from "node:path";

import { pngDimensions } from "../design/screens.js";
import {
  detectProjectStacksDetailed,
  type StackDetection,
  type StackId
} from "../projects/stack.js";
import type { Runtime } from "../runtime.js";
import type { UiContract, UiImageContract, UiScreenContract, UiTextContract } from "./contract.js";

/** 资源对账是 design_to_test 的内部观测阶段：只报告，不写回、不升硬门禁。
 * 代码扫描是启发式的；解析不到一律显式 unmapped/unverifiable，绝不假绿。 */

export type ResourceCalibrationStatus =
  | "match"
  | "mismatch"
  | "upscale"
  | "font-weight-substituted"
  | "font-unbundled"
  | "unmapped"
  | "unverifiable";

export type ResourceDeviceStatus = "normal" | "text-scale" | "not-evaluated";

export interface ResourceCalibrationItem {
  kind: "image" | "text";
  screenId: string;
  screenName: string;
  designId: string;
  designRef: string;
  codeRef: string | null;
  status: ResourceCalibrationStatus;
  deviceStatus: ResourceDeviceStatus;
  issues: string[];
  notes: string[];
}

export interface ResourceCalibrationCounts {
  total: number;
  match: number;
  mismatch: number;
  upscale: number;
  fontWeightSubstituted: number;
  fontUnbundled: number;
  unmapped: number;
  unverifiable: number;
}

export interface ResourceCalibrationReport {
  ok: true;
  mode: "report-only";
  generatedAt: string;
  stacks: Array<{
    id: StackId;
    source: "detected" | "config";
    confidence: number;
    evidence: StackDetection["evidence"];
  }>;
  device: {
    nativeUnit: "pt" | "dp" | null;
    pixelRatio: number | null;
    fontScale: number | null;
  };
  images: ResourceCalibrationCounts;
  texts: ResourceCalibrationCounts;
  items: ResourceCalibrationItem[];
  truncated: boolean;
  warnings: string[];
}

export interface ResourceCalibrationOptions {
  device?: {
    nativeUnit?: "pt" | "dp";
    pixelRatio?: number;
    fontScale?: number;
  };
  maxItems?: number;
  maxFiles?: number;
}

interface CodeStyle {
  fontFamily: string | null;
  fontSize: number | null;
  lineHeight: number | null;
  letterSpacing: number | null;
  fontWeight: number | null;
  file: string;
  line: number;
}

interface CodeImage {
  key: string;
  assetPath: string | null;
  width: number | null;
  height: number | null;
  fit: string | null;
  file: string;
  line: number;
}

interface CodeText {
  content: string;
  styleKey: string | null;
  style: CodeStyle | null;
  maxLines: number | null;
  file: string;
  line: number;
}

interface CodeScan {
  stack: "react-native" | "flutter";
  images: CodeImage[];
  texts: CodeText[];
  styles: Map<string, CodeStyle>;
  fontFamilies: Map<string, Set<number>>;
  fontAssets: string[];
  filesScanned: number;
  truncated: boolean;
}

const IGNORED_DIRS = new Set([
  ".artemis",
  ".dart_tool",
  ".git",
  ".gradle",
  ".next",
  "build",
  "coverage",
  "dist",
  "DerivedData",
  "node_modules",
  "Pods",
  "vendor"
]);
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 600;
const DEFAULT_MAX_ITEMS = 400;
const SOURCE_EXTENSIONS = new Set([".dart", ".js", ".jsx", ".ts", ".tsx"]);

function readText(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function numberAfter(source: string, key: string): number | null {
  const match = new RegExp(`${key}\\s*:\\s*["']?(-?\\d+(?:\\.\\d+)?)`).exec(source);
  return match === null ? null : Number(match[1]);
}

function stringAfter(source: string, key: string): string | null {
  const match = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`).exec(source);
  return match === null ? null : match[1];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameNumber(left: number | null, right: number | null, tolerance = 0.01): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= tolerance;
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .toLowerCase()
    .replace(/^.*[/\\]/, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  return normalized === "" ? null : normalized;
}

function walkSources(
  rootDir: string,
  extensions: Set<string>,
  maxFiles: number
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const pending: string[] = [""];
  let truncated = false;
  while (pending.length > 0) {
    const relative = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(rootDir, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          pending.push(relative === "" ? entry.name : `${relative}/${entry.name}`);
        }
        continue;
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(rootDir, child));
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(child);
    }
    if (truncated) break;
  }
  return { files: files.sort(), truncated };
}

function parseRnStyle(body: string, file: string, line: number): CodeStyle {
  return {
    fontFamily: stringAfter(body, "fontFamily"),
    fontSize: numberAfter(body, "fontSize"),
    lineHeight: numberAfter(body, "lineHeight"),
    letterSpacing: numberAfter(body, "letterSpacing"),
    fontWeight: numberAfter(body, "fontWeight"),
    file,
    line
  };
}

function parseFlutterStyle(body: string, file: string, line: number): CodeStyle {
  const fontSize = numberAfter(body, "fontSize");
  const heightRaw = /height\s*:\s*([^,\n]+)/.exec(body)?.[1]?.trim() ?? null;
  let height: number | null = null;
  if (heightRaw !== null) {
    const ratio = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(heightRaw);
    height = ratio === null ? Number(heightRaw) : Number(ratio[1]) / Number(ratio[2]);
    if (!Number.isFinite(height)) height = null;
  }
  return {
    fontFamily: stringAfter(body, "fontFamily"),
    fontSize,
    lineHeight: fontSize !== null && height !== null ? round(fontSize * height) : null,
    letterSpacing: numberAfter(body, "letterSpacing"),
    fontWeight: (() => {
      const match = /FontWeight\.w(\d+)/.exec(body);
      return match === null ? null : Number(match[1]);
    })(),
    file,
    line
  };
}

function parseFlutterFonts(projectDir: string): { families: Map<string, Set<number>>; assets: string[] } {
  const file = path.join(projectDir, "pubspec.yaml");
  if (!fs.existsSync(file)) return { families: new Map(), assets: [] };
  const families = new Map<string, Set<number>>();
  const assets: string[] = [];
  let family: string | null = null;
  for (const line of readText(file).split("\n")) {
    const familyMatch = /^\s*-\s*family:\s*(.+)$/.exec(line);
    if (familyMatch !== null) {
      family = familyMatch[1]!.trim();
      if (!families.has(family)) families.set(family, new Set());
      continue;
    }
    if (family === null) continue;
    const weightMatch = /^\s*weight:\s*(\d+)/.exec(line);
    if (weightMatch !== null) families.get(family)!.add(Number(weightMatch[1]));
    const assetMatch = /^\s*-\s*asset:\s*(.+)$/.exec(line);
    if (assetMatch !== null && assetMatch[1]!.startsWith("assets/fonts/")) {
      assets.push(assetMatch[1]!.trim());
    }
  }
  return { families, assets };
}

function scanRn(rootDir: string, maxFiles: number): CodeScan {
  const walked = walkSources(rootDir, SOURCE_EXTENSIONS, maxFiles);
  const styles = new Map<string, CodeStyle>();
  const images: CodeImage[] = [];
  const texts: CodeText[] = [];

  for (const relative of walked.files) {
    const absolute = path.join(rootDir, relative);
    let source: string;
    try {
      source = readText(absolute);
    } catch {
      continue;
    }
    const styleRe = /(\w+)\s*:\s*\{([^{}]*)\}/g;
    let styleMatch;
    while ((styleMatch = styleRe.exec(source)) !== null) {
      const body = styleMatch[2]!;
      if (!/(fontSize|fontFamily|lineHeight|letterSpacing|fontWeight|width|height)\s*:/.test(body)) {
        continue;
      }
      if (!styles.has(styleMatch[1]!)) {
        styles.set(styleMatch[1]!, parseRnStyle(body, relative, lineOf(source, styleMatch.index)));
      }
    }

    for (const [index, line] of source.split("\n").entries()) {
      const requireMatch = /require\(\s*["']([^"']+)["']\s*\)/.exec(line);
      if (requireMatch !== null) {
        const styleRef = /style=\{styles\.(\w+)\}/.exec(line)?.[1] ?? null;
        const assetPath = path.resolve(path.dirname(absolute), requireMatch[1]!);
        images.push({
          key: normalizeKey(path.basename(assetPath)) ?? "",
          assetPath,
          width: null,
          height: null,
          fit: /resizeMode=["'](\w+)["']/.exec(line)?.[1] ?? "cover",
          file: relative,
          line: index + 1
        });
        // Width/height live in the style block, not in the fontSize fields.
        if (styleRef !== null) {
          const block = new RegExp(`${styleRef}\\s*:\\s*\\{([^{}]*)\\}`).exec(source)?.[1];
          if (block !== undefined) {
            images[images.length - 1]!.width = numberAfter(block, "width");
            images[images.length - 1]!.height = numberAfter(block, "height");
          }
        }
      }
      const textMatch = /<Text\b([^>]*)>([^<]+)<\/Text>/.exec(line);
      if (textMatch !== null) {
        const attrs = textMatch[1]!;
        const content = textMatch[2]!.trim();
        if (/[{}$]/.test(content)) continue;
        const styleRef = /style=\{\s*(?:styles|typography)\.(\w+)/.exec(attrs)?.[1] ?? null;
        texts.push({
          content,
          styleKey: styleRef,
          style: styleRef === null ? null : styles.get(styleRef) ?? null,
          maxLines: /numberOfLines=\{(\d+)\}/.exec(attrs)?.[1]
            ? Number(/numberOfLines=\{(\d+)\}/.exec(attrs)![1])
            : null,
          file: relative,
          line: index + 1
        });
      }
    }
  }

  for (const text of texts) {
    text.style = text.styleKey === null ? null : styles.get(text.styleKey) ?? null;
  }

  return {
    stack: "react-native",
    images,
    texts,
    styles,
    fontFamilies: new Map(),
    fontAssets: [],
    filesScanned: walked.files.length,
    truncated: walked.truncated
  };
}

function scanFlutter(rootDir: string, maxFiles: number): CodeScan {
  const walked = walkSources(rootDir, new Set([".dart"]), maxFiles);
  const styles = new Map<string, CodeStyle>();
  const images: CodeImage[] = [];
  const texts: CodeText[] = [];
  const fonts = parseFlutterFonts(rootDir);

  for (const relative of walked.files) {
    const absolute = path.join(rootDir, relative);
    let source: string;
    try {
      source = readText(absolute);
    } catch {
      continue;
    }
    const styleRe = /(?:static\s+const|const|final)\s+(\w+)\s*=\s*TextStyle\(([\s\S]*?)\);/g;
    let styleMatch;
    while ((styleMatch = styleRe.exec(source)) !== null) {
      if (!styles.has(styleMatch[1]!)) {
        styles.set(styleMatch[1]!, parseFlutterStyle(styleMatch[2]!, relative, lineOf(source, styleMatch.index)));
      }
    }

    for (const [index, line] of source.split("\n").entries()) {
      const imageMatch =
        /Image\.asset\(\s*['"]([^'"]+)['"]\s*,\s*width:\s*(\d+(?:\.\d+)?)\s*,\s*height:\s*(\d+(?:\.\d+)?)\s*(?:,\s*fit:\s*BoxFit\.(\w+))?\s*\)/.exec(
          line
        );
      if (imageMatch !== null) {
        const assetPath = path.resolve(rootDir, imageMatch[1]!);
        images.push({
          key: normalizeKey(path.basename(assetPath)) ?? "",
          assetPath,
          width: Number(imageMatch[2]),
          height: Number(imageMatch[3]),
          fit: imageMatch[4] ?? null,
          file: relative,
          line: index + 1
        });
      }
      const textMatch =
        /Text\(\s*['"]([^'"]+)['"]\s*,\s*style:\s*([A-Za-z_][\w.]*)\s*(?:,\s*maxLines:\s*(\d+))?\s*\)/.exec(
          line
        );
      if (textMatch !== null) {
        const styleKey = textMatch[2]!.split(".").pop() ?? null;
        texts.push({
          content: textMatch[1]!,
          styleKey,
          style: styleKey === null ? null : styles.get(styleKey) ?? null,
          maxLines: textMatch[3] === undefined ? null : Number(textMatch[3]),
          file: relative,
          line: index + 1
        });
      }
    }
  }

  for (const text of texts) {
    text.style = text.styleKey === null ? null : styles.get(text.styleKey) ?? null;
  }

  return {
    stack: "flutter",
    images,
    texts,
    styles,
    fontFamilies: fonts.families,
    fontAssets: fonts.assets,
    filesScanned: walked.files.length,
    truncated: walked.truncated
  };
}

function emptyCounts(): ResourceCalibrationCounts {
  return {
    total: 0,
    match: 0,
    mismatch: 0,
    upscale: 0,
    fontWeightSubstituted: 0,
    fontUnbundled: 0,
    unmapped: 0,
    unverifiable: 0
  };
}

function countStatus(counts: ResourceCalibrationCounts, status: ResourceCalibrationStatus): void {
  counts.total += 1;
  switch (status) {
    case "match":
      counts.match += 1;
      break;
    case "mismatch":
      counts.mismatch += 1;
      break;
    case "upscale":
      counts.upscale += 1;
      break;
    case "font-weight-substituted":
      counts.fontWeightSubstituted += 1;
      break;
    case "font-unbundled":
      counts.fontUnbundled += 1;
      break;
    case "unmapped":
      counts.unmapped += 1;
      break;
    case "unverifiable":
      counts.unverifiable += 1;
      break;
  }
}

function designFitOf(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.toLowerCase();
  if (value === "fill" || value === "cover") return "cover";
  if (value === "fit" || value === "contain") return "contain";
  if (value === "stretch") return "fill";
  if (value === "tile" || value === "repeat") return "repeat";
  return null;
}

function codeFitOf(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "stretch") return "fill";
  return raw;
}

function imageVariants(code: CodeImage, stack: "react-native" | "flutter"): Array<{ scale: number; file: string }> {
  if (code.assetPath === null) return [];
  const dir = path.dirname(code.assetPath);
  const ext = path.extname(code.assetPath);
  const name = path.basename(code.assetPath, ext);
  if (stack === "react-native") {
    return [
      { scale: 1, file: code.assetPath },
      { scale: 2, file: path.join(dir, `${name}@2x${ext}`) },
      { scale: 3, file: path.join(dir, `${name}@3x${ext}`) }
    ];
  }
  return [
    { scale: 1, file: code.assetPath },
    { scale: 2, file: path.join(dir, "2.0x", `${name}${ext}`) },
    { scale: 3, file: path.join(dir, "3.0x", `${name}${ext}`) }
  ];
}

function calibrateImage(
  screen: UiScreenContract,
  design: UiImageContract,
  scan: CodeScan | null,
  options: ResourceCalibrationOptions
): ResourceCalibrationItem {
  const base: ResourceCalibrationItem = {
    kind: "image",
    screenId: screen.id,
    screenName: screen.name,
    designId: design.id,
    designRef: `${screen.id}#${design.id}`,
    codeRef: null,
    status: "unmapped",
    deviceStatus: "not-evaluated",
    issues: [],
    notes: []
  };
  if (scan === null) {
    base.issues.push("code-scan-unavailable");
    return { ...base, status: "unverifiable" };
  }
  const designKey = normalizeKey(design.assetKey ?? design.name);
  const matches = scan.images.filter((image) => image.key === designKey);
  if (matches.length === 0) {
    base.issues.push(`asset ${design.assetKey ?? design.name} not found in code`);
    return base;
  }
  if (matches.length > 1) base.notes.push(`multiple-code-matches ${matches.length}`);
  const code = matches[0]!;
  base.codeRef = `${code.file}:${code.line}`;
  const issues: string[] = [];
  const notes: string[] = [];

  if (design.bbox === null) {
    notes.push("design-bbox-unverifiable");
  } else {
    if (!sameNumber(code.width, design.bbox.width, 0.1)) {
      issues.push(`width ${code.width ?? "?"} != ${design.bbox.width}`);
    }
    if (!sameNumber(code.height, design.bbox.height, 0.1)) {
      issues.push(`height ${code.height ?? "?"} != ${design.bbox.height}`);
    }
  }

  const designFit = designFitOf(design.fit);
  const codeFit = codeFitOf(code.fit);
  if (designFit === null) {
    notes.push("design-fit-unverifiable");
  } else if (codeFit === null) {
    notes.push("code-fit-not-declared");
  } else if (designFit !== codeFit) {
    issues.push(`fit ${codeFit} != ${designFit}`);
  }

  if (code.assetPath !== null && !fs.existsSync(code.assetPath)) {
    base.issues.push("asset-file-missing");
    base.notes.push(...notes);
    return { ...base, status: "unmapped" };
  }

  if (code.assetPath !== null && design.bbox !== null) {
    const variants = imageVariants(code, scan.stack);
    const available = variants.filter((variant) => fs.existsSync(variant.file));
    for (const variant of available) {
      const dims = pngDimensions(fs.readFileSync(variant.file));
      if (dims === null) {
        notes.push(`${variant.scale}x-unreadable`);
        continue;
      }
      if (
        !sameNumber(dims.width, design.bbox.width * variant.scale, 1) ||
        !sameNumber(dims.height, design.bbox.height * variant.scale, 1)
      ) {
        issues.push(
          `${variant.scale}x ${dims.width}x${dims.height} != ${round(design.bbox.width * variant.scale)}x${round(design.bbox.height * variant.scale)}`
        );
      }
    }
    const maxScale = available.length === 0 ? 0 : Math.max(...available.map((variant) => variant.scale));
    notes.push(`variants ${available.map((variant) => variant.scale).join("/") || "none"}`);
    if (issues.length === 0 && options.device?.pixelRatio !== undefined && maxScale < options.device.pixelRatio) {
      base.deviceStatus = "normal";
      base.notes.push(...notes);
      return { ...base, status: "upscale" };
    }
  } else {
    notes.push("density-not-evaluated");
  }

  if (options.device?.pixelRatio === undefined) notes.push("device-pixel-ratio-not-evaluated");
  base.deviceStatus = options.device?.pixelRatio === undefined ? "not-evaluated" : "normal";
  base.issues.push(...issues);
  base.notes.push(...notes);
  base.status = issues.length > 0 ? "mismatch" : "match";
  return base;
}

function calibrateText(
  screen: UiScreenContract,
  design: UiTextContract,
  scan: CodeScan | null,
  options: ResourceCalibrationOptions
): ResourceCalibrationItem {
  const base: ResourceCalibrationItem = {
    kind: "text",
    screenId: screen.id,
    screenName: screen.name,
    designId: design.id,
    designRef: `${screen.id}#${design.id}`,
    codeRef: null,
    status: "unmapped",
    deviceStatus: "not-evaluated",
    issues: [],
    notes: []
  };
  if (scan === null) {
    base.issues.push("code-scan-unavailable");
    return { ...base, status: "unverifiable" };
  }
  const content = normalizeContent(design.content);
  const matches = scan.texts.filter((text) => normalizeContent(text.content) === content);
  if (matches.length === 0) {
    base.issues.push("static-text-not-found");
    return base;
  }
  if (matches.length > 1) base.notes.push(`multiple-code-matches ${matches.length}`);
  const code = matches[0]!;
  base.codeRef = `${code.file}:${code.line}`;
  if (code.style === null) {
    base.issues.push("style-not-parsed");
    return { ...base, status: "unverifiable" };
  }
  const issues: string[] = [];
  const notes: string[] = [];

  if (design.fontFamily !== null && code.style.fontFamily !== null) {
    if (design.fontFamily !== code.style.fontFamily) {
      issues.push(`font-family ${code.style.fontFamily} != ${design.fontFamily}`);
    }
  } else if (design.fontFamily !== null) {
    notes.push("code-font-family-not-parsed");
  }
  if (design.fontSize !== null && code.style.fontSize !== null) {
    if (!sameNumber(design.fontSize, code.style.fontSize, 0.01)) {
      issues.push(`font-size ${code.style.fontSize} != ${design.fontSize}`);
    }
  } else if (design.fontSize !== null) {
    notes.push("code-font-size-not-parsed");
  }
  const designLineHeight = design.lineHeight ?? null;
  if (designLineHeight !== null && code.style.lineHeight !== null) {
    if (!sameNumber(designLineHeight, code.style.lineHeight, 0.1)) {
      issues.push(`line-height ${round(code.style.lineHeight)} != ${designLineHeight}`);
    }
  } else if (designLineHeight !== null) {
    notes.push("code-line-height-not-parsed");
  }
  const designLetterSpacing = design.letterSpacing ?? null;
  if (designLetterSpacing !== null && code.style.letterSpacing !== null) {
    if (!sameNumber(designLetterSpacing, code.style.letterSpacing, 0.01)) {
      issues.push(`letter-spacing ${code.style.letterSpacing} != ${designLetterSpacing}`);
    }
  } else if (designLetterSpacing !== null) {
    notes.push("code-letter-spacing-not-parsed");
  }
  if (design.fontWeight !== null && code.style.fontWeight !== null) {
    if (!sameNumber(design.fontWeight, code.style.fontWeight, 0.01)) {
      issues.push(`font-weight ${code.style.fontWeight} != ${design.fontWeight}`);
    }
  } else if (design.fontWeight !== null) {
    notes.push("code-font-weight-not-parsed");
  }
  const designMaxLines = design.maxLines ?? null;
  if (designMaxLines !== null && code.maxLines !== null) {
    if (designMaxLines !== code.maxLines) {
      issues.push(`max-lines ${code.maxLines} != ${designMaxLines}`);
    }
  } else if (designMaxLines !== null) {
    notes.push("code-max-lines-not-parsed");
  }

  let fontStatus: ResourceCalibrationStatus | null = null;
  if (scan.stack === "flutter" && design.fontFamily !== null) {
    const weights = scan.fontFamilies.get(design.fontFamily);
    if (weights === undefined) {
      fontStatus = "font-unbundled";
    } else if (design.fontWeight !== null && !weights.has(design.fontWeight)) {
      fontStatus = "font-weight-substituted";
    }
  } else if (scan.stack === "react-native") {
    notes.push("rn-font-weight-unverified");
  }

  if (options.device?.fontScale !== undefined && options.device.fontScale !== 1) {
    base.deviceStatus = "text-scale";
    notes.push(`text-scale ${options.device.fontScale}`);
  } else if (options.device?.fontScale !== undefined) {
    base.deviceStatus = "normal";
  } else {
    notes.push("device-font-scale-not-evaluated");
  }

  base.issues.push(...issues);
  base.notes.push(...notes);
  if (issues.length > 0) {
    base.status = "mismatch";
  } else if (fontStatus !== null) {
    base.status = fontStatus;
  } else if (notes.some((note) => note.endsWith("-not-parsed"))) {
    base.status = "unverifiable";
  } else {
    base.status = "match";
  }
  return base;
}

function fallbackItems(
  contract: UiContract,
  reason: string
): ResourceCalibrationItem[] {
  const items: ResourceCalibrationItem[] = [];
  for (const screen of contract.screens) {
    for (const image of screen.images ?? []) {
      items.push({
        kind: "image",
        screenId: screen.id,
        screenName: screen.name,
        designId: image.id,
        designRef: `${screen.id}#${image.id}`,
        codeRef: null,
        status: "unverifiable",
        deviceStatus: "not-evaluated",
        issues: [reason],
        notes: []
      });
    }
    for (const text of screen.texts) {
      items.push({
        kind: "text",
        screenId: screen.id,
        screenName: screen.name,
        designId: text.id,
        designRef: `${screen.id}#${text.id}`,
        codeRef: null,
        status: "unverifiable",
        deviceStatus: "not-evaluated",
        issues: [reason],
        notes: []
      });
    }
  }
  return items;
}

/** 读取 ui-contract + 项目代码，产出 report-only 资源对账。
 * 不写盘、不改 contract、不触发设备；扫描失败只降级为 unverifiable。 */
export function buildResourceCalibration(
  runtime: Runtime,
  contract: UiContract,
  options: ResourceCalibrationOptions = {}
): ResourceCalibrationReport {
  const rootDir = runtime.project.rootDir;
  const detection = detectProjectStacksDetailed(rootDir, {
    stack: runtime.project.config?.project?.stack
  });
  const warnings = [...detection.warnings];
  const primary = detection.stacks[0] ?? null;
  const device = {
    nativeUnit: options.device?.nativeUnit ?? null,
    pixelRatio: options.device?.pixelRatio ?? null,
    fontScale: options.device?.fontScale ?? null
  };
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_ITEMS);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);

  if (detection.stacks.length > 1) {
    warnings.push(`检测到多个技术栈（${detection.stacks.map((stack) => stack.id).join(", ")}）：资源对账按主栈 ${primary?.id ?? "?"} 扫描`);
  }

  let scan: CodeScan | null = null;
  if (primary === null) {
    warnings.push("未检测到技术栈：资源对账降级为 unverifiable");
  } else if (primary.id === "react-native" || primary.id === "flutter") {
    try {
      scan = primary.id === "react-native" ? scanRn(rootDir, maxFiles) : scanFlutter(rootDir, maxFiles);
      if (scan.filesScanned === 0) warnings.push(`${primary.id} 未扫描到源文件：资源对账降级为 unverifiable`);
      if (scan.truncated) warnings.push(`${primary.id} 源文件超过上限 ${maxFiles}，扫描已截断`);
    } catch (error) {
      warnings.push(`资源代码扫描失败（${error instanceof Error ? error.message : String(error)}）：降级为 unverifiable`);
    }
  } else {
    warnings.push(`技术栈 ${primary.id} 的资源扫描尚未实现：降级为 unverifiable`);
  }

  const images = emptyCounts();
  const texts = emptyCounts();
  const items: ResourceCalibrationItem[] = [];
  let truncated = false;

  const push = (item: ResourceCalibrationItem): void => {
    if (items.length >= maxItems) {
      truncated = true;
      return;
    }
    items.push(item);
    countStatus(item.kind === "image" ? images : texts, item.status);
  };

  if (scan === null) {
    for (const item of fallbackItems(contract, primary === null ? "stack-not-detected" : `scanner-not-implemented:${primary.id}`)) {
      push(item);
    }
  } else {
    for (const screen of contract.screens) {
      if (truncated) break;
      for (const image of screen.images ?? []) {
        push(calibrateImage(screen, image, scan, options));
        if (truncated) break;
      }
      if (truncated) break;
      for (const text of screen.texts) {
        push(calibrateText(screen, text, scan, options));
        if (truncated) break;
      }
    }
  }

  if (truncated) warnings.push(`资源对账条目超过上限 ${maxItems}，已截断`);
  if (options.device?.pixelRatio === undefined) warnings.push("设备 pixelRatio 未提供：图片倍率未评估");
  if (options.device?.fontScale === undefined) warnings.push("设备 fontScale 未提供：文字缩放未评估");

  return {
    ok: true,
    mode: "report-only",
    generatedAt: new Date().toISOString(),
    stacks: detection.stacks.map((stack) => ({
      id: stack.id,
      source: stack.source,
      confidence: stack.confidence,
      evidence: stack.evidence
    })),
    device,
    images,
    texts,
    items,
    truncated,
    warnings
  };
}
