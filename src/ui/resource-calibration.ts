import fs from "node:fs";
import path from "node:path";

import { loadScreenMap } from "../diff/screen-map.js";
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
  stack: "react-native" | "flutter" | "android-native" | "ios-native";
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

/** 从 trace run.json 的 step.scale 回填设备倍率；没有有效 scale 返回 null（不猜）。 */
export function tracePixelRatioFromRun(run: unknown): number | null {
  if (run === null || typeof run !== "object" || Array.isArray(run)) return null;
  const steps = (run as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return null;
  const scales = steps
    .map((step) => {
      if (step === null || typeof step !== "object" || Array.isArray(step)) return null;
      const scale = (step as { scale?: unknown }).scale;
      return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : null;
    })
    .filter((scale): scale is number => scale !== null)
    .sort((left, right) => left - right);
  if (scales.length === 0) return null;
  const middle = Math.floor(scales.length / 2);
  const ratio = scales.length % 2 === 0 ? (scales[middle - 1]! + scales[middle]!) / 2 : scales[middle]!;
  return round(ratio);
}


/** 读取 trace 若显式声明的 fontScale；当前 executor 未写该字段时返回 null。 */
export function traceFontScaleFromRun(run: unknown): number | null {
  if (run === null || typeof run !== "object" || Array.isArray(run)) return null;
  const record = run as Record<string, unknown>;
  const device = record.device;
  const candidates = [
    record.fontScale,
    record.font_scale,
    device !== null && typeof device === "object" && !Array.isArray(device)
      ? (device as Record<string, unknown>).fontScale
      : null
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return round(candidate);
    }
  }
  return null;
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

function scanRn(rootDir: string, maxFiles: number, catalog: Map<string, string>): CodeScan {
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
        // Width/height live in the style block or inline style.
        if (styleRef !== null) {
          const block = new RegExp(`${styleRef}\\s*:\\s*\\{([^{}]*)\\}`).exec(source)?.[1];
          if (block !== undefined) {
            images[images.length - 1]!.width = numberAfter(block, "width");
            images[images.length - 1]!.height = numberAfter(block, "height");
          }
        } else {
          const inline = /style=\{\{([^}]*)\}\}/.exec(line)?.[1];
          if (inline !== undefined) {
            images[images.length - 1]!.width = numberAfter(inline, "width");
            images[images.length - 1]!.height = numberAfter(inline, "height");
          }
        }
      }
      const i18nText = /<Text\b([^>]*)>\{\s*(?:t|i18n\.t|\$t)\(\s*["']([^"']+)["']\s*\)\s*\}<\/Text>/.exec(line);
      if (i18nText !== null) {
        const attrs = i18nText[1]!;
        const styleRef = /style=\{\s*(?:styles|typography)\.(\w+)/.exec(attrs)?.[1] ?? null;
        const inline = styleRef === null ? /style=\{\{([^}]*)\}\}/.exec(attrs)?.[1] : undefined;
        const style = inline === undefined ? null : parseRnStyle(inline, relative, index + 1);
        texts.push({
          content: catalog.get(i18nText[2]!) ?? i18nText[2]!,
          styleKey: styleRef,
          style: styleRef === null ? style : styles.get(styleRef) ?? null,
          maxLines: /numberOfLines=\{(\d+)\}/.exec(attrs)?.[1]
            ? Number(/numberOfLines=\{(\d+)\}/.exec(attrs)![1])
            : null,
          file: relative,
          line: index + 1
        });
        continue;
      }
      const textMatch = /<Text\b([^>]*)>([^<]+)<\/Text>/.exec(line);
      if (textMatch !== null) {
        const attrs = textMatch[1]!;
        const content = textMatch[2]!.trim();
        if (/[{}$]/.test(content)) continue;
        const styleRef = /style=\{\s*(?:styles|typography)\.(\w+)/.exec(attrs)?.[1] ?? null;
        const inline = styleRef === null ? /style=\{\{([^}]*)\}\}/.exec(attrs)?.[1] : undefined;
        const style = inline === undefined ? null : parseRnStyle(inline, relative, index + 1);
        texts.push({
          content,
          styleKey: styleRef,
          style: styleRef === null ? style : styles.get(styleRef) ?? null,
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
    if (text.styleKey !== null) text.style = styles.get(text.styleKey) ?? null;
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

function scanFlutter(rootDir: string, maxFiles: number, catalog: Map<string, string>): CodeScan {
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
      } else {
        const i18nText =
          /Text\(\s*(?:AppLocalizations\.of\(context\)!?\.|S\.of\(context\)!?\.)([A-Za-z_]\w*)\s*(?:,\s*style:\s*([A-Za-z_][\w.]*))?/.exec(
            line
          );
        if (i18nText !== null) {
          const styleKey = i18nText[2]?.split(".").pop() ?? null;
          texts.push({
            content: catalog.get(i18nText[1]!) ?? i18nText[1]!,
            styleKey,
            style: styleKey === null ? null : styles.get(styleKey) ?? null,
            maxLines: null,
            file: relative,
            line: index + 1
          });
        } else {
          const inlineText = /Text\(\s*['"]([^'"]+)['"]\s*,\s*style:\s*TextStyle\(([^)]*)\)\s*\)/.exec(line);
          if (inlineText !== null) {
            texts.push({
              content: inlineText[1]!,
              styleKey: null,
              style: parseFlutterStyle(inlineText[2]!, relative, index + 1),
              maxLines: null,
              file: relative,
              line: index + 1
            });
          }
        }
      }
    }
  }

  for (const text of texts) {
    if (text.styleKey !== null) text.style = styles.get(text.styleKey) ?? null;
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


function findAndroidAsset(rootDir: string, key: string, maxFiles: number): string | null {
  const walked = walkSources(rootDir, new Set([".png", ".webp", ".jpg", ".jpeg"]), maxFiles);
  const normalized = normalizeKey(key);
  if (normalized === null) return null;
  const match = walked.files.find(
    (file) =>
      /(?:^|\/)res\/(?:drawable|mipmap)[^/]*\//.test(`/${file}`) &&
      normalizeKey(path.basename(file)) === normalized
  );
  return match === undefined ? null : path.join(rootDir, match);
}

function findIosImageset(rootDir: string, key: string): string | null {
  const target = `${key.toLowerCase()}.imageset`;
  const pending: string[] = [""];
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
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.toLowerCase() === target) {
          return path.join(rootDir, relative, entry.name);
        }
        pending.push(relative === "" ? entry.name : `${relative}/${entry.name}`);
      }
    }
  }
  return null;
}

function attributeOf(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match?.[1]?.trim() ?? null;
}

function dimensionValue(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^(-?\d+(?:\.\d+)?)(?:dp|dip|sp)?$/i.exec(raw);
  return match === null ? null : Number(match[1]);
}

function androidFontWeight(raw: string | null): number | null {
  if (raw === null) return null;
  const value = raw.toLowerCase();
  if (value.includes("bold")) return 700;
  if (value.includes("medium")) return 500;
  if (value.includes("normal")) return 400;
  return null;
}

function androidFit(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "centerCrop") return "cover";
  if (raw === "fitCenter" || raw === "centerInside") return "contain";
  if (raw === "fitXY") return "fill";
  return null;
}

function composeWeight(raw: string | null): number | null {
  if (raw === null) return null;
  const map: Record<string, number> = {
    Thin: 100,
    ExtraLight: 200,
    Light: 300,
    Normal: 400,
    Medium: 500,
    SemiBold: 600,
    Bold: 700,
    ExtraBold: 800,
    Black: 900
  };
  return map[raw] ?? null;
}

function composeFit(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "Crop") return "cover";
  if (raw === "Fit") return "contain";
  if (raw === "FillBounds") return "fill";
  return null;
}

function scanAndroidNative(rootDir: string, maxFiles: number, catalog: Map<string, string>): CodeScan {
  const walked = walkSources(rootDir, new Set([".xml", ".kt", ".java"]), maxFiles);
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
    const tagRe = /<(TextView|ImageView)\b([^>]*)>/g;
    let tagMatch;
    while ((tagMatch = tagRe.exec(source)) !== null) {
      const tag = tagMatch[1]!;
      const attrs = tagMatch[2]!;
      const line = lineOf(source, tagMatch.index);
      if (tag === "TextView") {
        const rawContent = attributeOf(attrs, "android:text");
        if (rawContent === null) continue;
        const content = rawContent.startsWith("@string/")
          ? catalog.get(rawContent.slice("@string/".length)) ?? null
          : rawContent.startsWith("@")
            ? null
            : rawContent;
        if (content === null) continue;
        const fontSize = dimensionValue(attributeOf(attrs, "android:textSize"));
        const extra = dimensionValue(attributeOf(attrs, "android:lineSpacingExtra"));
        const letterRaw = attributeOf(attrs, "android:letterSpacing");
        const maxLines = dimensionValue(attributeOf(attrs, "android:maxLines"));
        texts.push({
          content,
          styleKey: null,
          style: {
            fontFamily: attributeOf(attrs, "android:fontFamily"),
            fontSize,
            lineHeight: fontSize !== null && extra !== null ? round(fontSize + extra) : null,
            letterSpacing:
              letterRaw === null || fontSize === null ? null : round(Number(letterRaw) * fontSize),
            fontWeight: androidFontWeight(attributeOf(attrs, "android:textStyle")),
            file: relative,
            line
          },
          maxLines,
          file: relative,
          line
        });
      } else {
        const src = attributeOf(attrs, "android:src");
        const key = src === null ? null : normalizeKey(src.replace(/^@(?:drawable|mipmap)\//, ""));
        if (key === null) continue;
        images.push({
          key,
          assetPath: findAndroidAsset(rootDir, key, maxFiles),
          width: dimensionValue(attributeOf(attrs, "android:layout_width")),
          height: dimensionValue(attributeOf(attrs, "android:layout_height")),
          fit: androidFit(attributeOf(attrs, "android:scaleType")),
          file: relative,
          line
        });
      }
    }

    for (const [index, line] of source.split("\n").entries()) {
      const textMatch = /Text\(\s*"([^"]+)"/.exec(line);
      if (textMatch !== null) {
        const window = source.split("\n").slice(index, index + 6).join(" ");
        const fontSize = /fontSize\s*=\s*(\d+(?:\.\d+)?)\.sp/.exec(window)?.[1];
        const lineHeight = /lineHeight\s*=\s*(\d+(?:\.\d+)?)\.sp/.exec(window)?.[1];
        const letterSpacing = /letterSpacing\s*=\s*(\d+(?:\.\d+)?)\.sp/.exec(window)?.[1];
        texts.push({
          content: textMatch[1]!,
          styleKey: null,
          style: {
            fontFamily: null,
            fontSize: fontSize === undefined ? null : Number(fontSize),
            lineHeight: lineHeight === undefined ? null : Number(lineHeight),
            letterSpacing: letterSpacing === undefined ? null : Number(letterSpacing),
            fontWeight: composeWeight(/fontWeight\s*=\s*FontWeight\.(\w+)/.exec(window)?.[1] ?? null),
            file: relative,
            line: index + 1
          },
          maxLines: (() => {
            const raw = /maxLines\s*=\s*(\d+)/.exec(window)?.[1];
            return raw === undefined ? null : Number(raw);
          })(),
          file: relative,
          line: index + 1
        });
      }
      const imageMatch = /Image\(\s*painterResource\(R\.drawable\.(\w+)\)/.exec(line);
      if (imageMatch !== null) {
        const window = source.split("\n").slice(index, index + 6).join(" ");
        const size = /Modifier\.size\((\d+(?:\.\d+)?)\.dp\)/.exec(window)?.[1];
        images.push({
          key: normalizeKey(imageMatch[1]!) ?? "",
          assetPath: findAndroidAsset(rootDir, imageMatch[1]!, maxFiles),
          width: size === undefined ? null : Number(size),
          height: size === undefined ? null : Number(size),
          fit: composeFit(/contentScale\s*=\s*ContentScale\.(\w+)/.exec(window)?.[1] ?? null),
          file: relative,
          line: index + 1
        });
      }
    }
  }

  return {
    stack: "android-native",
    images,
    texts,
    styles: new Map(),
    fontFamilies: new Map(),
    fontAssets: [],
    filesScanned: walked.files.length,
    truncated: walked.truncated
  };
}

function swiftWeight(raw: string | null): number | null {
  if (raw === null) return null;
  const map: Record<string, number> = {
    ultraLight: 100,
    thin: 200,
    light: 300,
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    heavy: 800,
    black: 900
  };
  return map[raw] ?? null;
}

function swiftFit(raw: string | null): string | null {
  if (raw === null) return null;
  if (raw === "scaledToFill" || raw === "scaleAspectFill") return "cover";
  if (raw === "scaledToFit" || raw === "scaleAspectFit") return "contain";
  return null;
}

function scanIosNative(rootDir: string, maxFiles: number, catalog: Map<string, string>): CodeScan {
  const walked = walkSources(rootDir, new Set([".swift", ".m", ".mm"]), maxFiles);
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
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const swiftText = /Text\(\s*"([^"]+)"\s*\)/.exec(line);
      if (swiftText !== null) {
        const window = lines.slice(index, index + 8).join(" ");
        const system = /\.font\(\.system\(size:\s*(\d+(?:\.\d+)?)(?:,\s*weight:\s*\.(\w+))?\)\)/.exec(window);
        const custom = /\.font\(\.custom\("([^"]+)",\s*size:\s*(\d+(?:\.\d+)?)\)\)/.exec(window);
        const kerning = /\.kerning\((-?\d+(?:\.\d+)?)\)/.exec(window);
        texts.push({
          content: swiftText[1]!,
          styleKey: null,
          style: {
            fontFamily: custom?.[1] ?? null,
            fontSize: custom !== null ? Number(custom[2]) : system !== null ? Number(system[1]) : null,
            lineHeight: null,
            letterSpacing: kerning === null ? null : Number(kerning[1]),
            fontWeight: system !== null ? swiftWeight(system[2] ?? null) : null,
            file: relative,
            line: index + 1
          },
          maxLines: null,
          file: relative,
          line: index + 1
        });
      }
      const swiftImage = /Image\(\s*"([^"]+)"\s*\)/.exec(line);
      if (swiftImage !== null) {
        const window = lines.slice(index, index + 8).join(" ");
        const frame = /\.frame\(width:\s*(\d+(?:\.\d+)?),\s*height:\s*(\d+(?:\.\d+)?)\)/.exec(window);
        images.push({
          key: normalizeKey(swiftImage[1]!) ?? "",
          assetPath: findIosImageset(rootDir, swiftImage[1]!),
          width: frame === null ? null : Number(frame[1]),
          height: frame === null ? null : Number(frame[2]),
          fit: swiftFit(/\.(scaledToFill|scaledToFit)\(\)/.exec(window)?.[1] ?? null),
          file: relative,
          line: index + 1
        });
      }
      const uiLocalized = /(?:\.text|text)\s*=\s*NSLocalizedString\(\s*"([^"]+)"/.exec(line);
      const uiText = uiLocalized ?? /(?:\.text|text)\s*=\s*"([^"]+)"/.exec(line);
      if (uiText !== null) {
        const window = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
        const font = /UIFont\.systemFont\(ofSize:\s*(\d+(?:\.\d+)?)(?:,\s*weight:\s*\.(\w+))?\)/.exec(window);
        const custom = /UIFont\(name:\s*"([^"]+)",\s*size:\s*(\d+(?:\.\d+)?)\)/.exec(window);
        const numberOfLines = /numberOfLines\s*=\s*(\d+)/.exec(window)?.[1];
        texts.push({
          content: uiLocalized === null ? uiText[1]! : catalog.get(uiText[1]!) ?? uiText[1]!,
          styleKey: null,
          style: {
            fontFamily: custom?.[1] ?? null,
            fontSize: custom !== null ? Number(custom[2]) : font !== null ? Number(font[1]) : null,
            lineHeight: null,
            letterSpacing: null,
            fontWeight: font !== null ? swiftWeight(font[2] ?? null) : null,
            file: relative,
            line: index + 1
          },
          maxLines: numberOfLines === undefined ? null : Number(numberOfLines),
          file: relative,
          line: index + 1
        });
      }
      const uiImage = /UIImage\(named:\s*"([^"]+)"\)/.exec(line);
      if (uiImage !== null) {
        const window = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
        const frame = /width:\s*(\d+(?:\.\d+)?),\s*height:\s*(\d+(?:\.\d+)?)/.exec(window);
        images.push({
          key: normalizeKey(uiImage[1]!) ?? "",
          assetPath: findIosImageset(rootDir, uiImage[1]!),
          width: frame === null ? null : Number(frame[1]),
          height: frame === null ? null : Number(frame[2]),
          fit: swiftFit(/contentMode\s*=\s*\.(scaleAspectFill|scaleAspectFit)/.exec(window)?.[1] ?? null),
          file: relative,
          line: index + 1
        });
      }
    }
  }

  return {
    stack: "ios-native",
    images,
    texts,
    styles: new Map(),
    fontFamilies: new Map(),
    fontAssets: [],
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

function imageVariants(
  code: CodeImage,
  stack: CodeScan["stack"]
): Array<{ scale: number; file: string }> {
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
  if (stack === "flutter") {
    return [
      { scale: 1, file: code.assetPath },
      { scale: 2, file: path.join(dir, "2.0x", `${name}${ext}`) },
      { scale: 3, file: path.join(dir, "3.0x", `${name}${ext}`) }
    ];
  }
  if (stack === "android-native") {
    const resDir = path.dirname(dir);
    const file = path.basename(code.assetPath);
    const buckets: Array<[number, string]> = [
      [1, "drawable"],
      [1, "drawable-mdpi"],
      [1.5, "drawable-hdpi"],
      [2, "drawable-xhdpi"],
      [3, "drawable-xxhdpi"],
      [4, "drawable-xxxhdpi"]
    ];
    return buckets.map(([scale, bucket]) => ({ scale, file: path.join(resDir, bucket, file) }));
  }
  if (stack === "ios-native") {
    try {
      const contents = JSON.parse(readText(path.join(code.assetPath, "Contents.json"))) as {
        images?: Array<{ filename?: unknown; scale?: unknown }>;
      };
      return (contents.images ?? [])
        .filter((entry): entry is { filename: string; scale: string } => typeof entry.filename === "string" && typeof entry.scale === "string")
        .map((entry) => ({ scale: Number(entry.scale.replace(/x$/i, "")) || 1, file: path.join(code.assetPath!, entry.filename) }));
    } catch {
      return [];
    }
  }
  return [{ scale: 1, file: code.assetPath }];
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
  } else if (scan.stack === "android-native" || scan.stack === "ios-native") {
    notes.push("native-font-weight-unverified");
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

function screenFileFilters(runtime: Runtime): Map<string, Set<string>> {
  const configDir = (runtime as { configDirAbs?: string }).configDirAbs;
  if (typeof configDir !== "string" || configDir === "") return new Map();
  try {
    const map = loadScreenMap(configDir);
    const filters = new Map<string, Set<string>>();
    for (const entry of map.entries) {
      const screen = entry.design.screen?.trim() ?? "";
      const file = entry.code.file?.trim() ?? "";
      if (screen === "" || file === "") continue;
      const files = filters.get(screen) ?? new Set<string>();
      files.add(file.replace(/\\/g, "/"));
      filters.set(screen, files);
    }
    return filters;
  } catch {
    return new Map();
  }
}

function loadStringCatalog(runtime: Runtime): Map<string, string> {
  const configDir = (runtime as { configDirAbs?: string }).configDirAbs;
  if (typeof configDir !== "string" || configDir === "") return new Map();
  try {
    const parsed = JSON.parse(readText(path.join(configDir, "design", "strings.json"))) as {
      entries?: Array<{ key?: unknown; sourceText?: unknown }>;
    };
    const catalog = new Map<string, string>();
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.key === "string" && typeof entry.sourceText === "string") {
        catalog.set(entry.key, entry.sourceText);
      }
    }
    return catalog;
  } catch {
    return new Map();
  }
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

  const catalog = loadStringCatalog(runtime);
  let scan: CodeScan | null = null;
  if (primary === null) {
    warnings.push("未检测到技术栈：资源对账降级为 unverifiable");
  } else if (
    primary.id === "react-native" ||
    primary.id === "flutter" ||
    primary.id === "android-native" ||
    primary.id === "ios-native"
  ) {
    try {
      scan =
        primary.id === "react-native"
          ? scanRn(rootDir, maxFiles, catalog)
          : primary.id === "flutter"
            ? scanFlutter(rootDir, maxFiles, catalog)
            : primary.id === "android-native"
              ? scanAndroidNative(rootDir, maxFiles, catalog)
              : scanIosNative(rootDir, maxFiles, catalog);
      if (scan.filesScanned === 0) warnings.push(`${primary.id} 未扫描到源文件：资源对账降级为 unverifiable`);
      if (scan.truncated) warnings.push(`${primary.id} 源文件超过上限 ${maxFiles}，扫描已截断`);
      if (scan.stack === "android-native" || scan.stack === "ios-native") {
        warnings.push(`${scan.stack} 资源扫描是尽力而为：字体文件/行高/复杂布局可能 unverifiable`);
      }
    } catch (error) {
      warnings.push(`资源代码扫描失败（${error instanceof Error ? error.message : String(error)}）：降级为 unverifiable`);
    }
  } else {
    warnings.push(`技术栈 ${primary.id} 的资源扫描尚未实现：降级为 unverifiable`);
  }

  const filters = screenFileFilters(runtime);
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
      const filter = filters.get(screen.name) ?? filters.get(screen.id);
      const screenScan: CodeScan =
        filter === undefined || filter.size === 0
          ? scan
          : {
              ...scan,
              images: scan.images.filter((image) => filter.has(image.file)),
              texts: scan.texts.filter((text) => filter.has(text.file))
            };
      for (const image of screen.images ?? []) {
        push(calibrateImage(screen, image, screenScan, options));
        if (truncated) break;
      }
      if (truncated) break;
      for (const text of screen.texts) {
        push(calibrateText(screen, text, screenScan, options));
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
