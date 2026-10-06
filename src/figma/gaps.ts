import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  restExtractDesignSystem,
  restFindAssets
} from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { detectProjectStacks, formatAssetFilename, primaryProfile, skippedStacksWarnings, type StackProfile } from "../projects/stack.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const TOKEN_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或调用 aos_configure 携带 figmaToken）。";

// ---------------------------------------------------------------------------
// Project scan + gap analysis
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".artemis",
  ".artemis-deps",
  ".venv",
  "vendor",
  ".next",
  ".nuxt",
  "coverage",
  "Pods"
]);

export const DEFAULT_ASSET_GLOBS = ["**/*.svg", "**/*.png", "**/*.webp", "**/*.jpg", "**/*.jpeg", "**/*.gif"];
const DEFAULT_TOKEN_GLOBS = [
  "**/tokens.json",
  "**/tokens.css",
  "**/theme.json",
  "**/theme.css",
  "**/variables.css",
  "**/colors.json"
];

export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export function walkProjectFiles(rootDir: string, globs: string[], limit = 8000): string[] {
  const regexes = globs.map(globToRegExp);
  const results: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && results.length < limit) {
    const relative = stack.pop()!;
    const absolute = path.join(rootDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(childRelative);
        continue;
      }
      if (regexes.some((regex) => regex.test(childRelative))) results.push(childRelative);
    }
  }
  return results.sort();
}

export function readTokenContents(
  rootDir: string,
  files: string[],
  maxFileBytes = 512 * 1024,
  maxFiles = 50
): string[] {
  const contents: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    try {
      const raw = fs.readFileSync(path.join(rootDir, file), "utf-8");
      if (raw.includes("\u0000")) continue; // binary
      contents.push(raw.slice(0, maxFileBytes));
    } catch {
      /* skip unreadable */
    }
  }
  return contents;
}

export function normalizeAssetName(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/@[23]x$/i, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  );
}

const GENERIC_LAYER_RE =
  /^(frame|group|rectangle|ellipse|vector|text|component|instance|auto ?layout|line|image|mask|polygon|star|slice|boolean( operation)?|content|container)([ _-]?\d+)?$/i;

/** True for Figma's auto-generated layer names (`Frame 427`, `Text`, …) that
 * carry no semantic value for naming assets/keys. */
export function isGenericLayerName(name: string): boolean {
  return GENERIC_LAYER_RE.test(name.trim());
}

function fallbackAssetName(figmaId: string | undefined): string {
  const seed = figmaId && figmaId !== "" ? figmaId : "unknown";
  return `asset ${createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

const ICON_SUFFIXES = ["-icon", "-ic", "-logo", "-glyph"];

export interface GapInput {
  designAssets: Array<{ id?: string; name: string; suggestedFilename?: string }>;
  designColors: string[];
  projectAssetPaths: string[];
  tokenContents?: string[];
}

export interface GapResult {
  missingAssets: Array<{
    name: string;
    slug: string;
    suggestedFilename: string;
    figmaId?: string;
  }>;
  existingAssets: Array<{ name: string; matchedPath: string }>;
  missingColors: string[];
  colorsChecked: boolean;
  projectAssetCount: number;
}

function expandHex(hex: string): string {
  const body = hex.replace("#", "");
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toUpperCase();
  }
  return `#${body}`.toUpperCase();
}

function componentHex(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(255, Math.round(value * 255)));
  return clamped.toString(16).padStart(2, "0").toUpperCase();
}

function collectColorsetColors(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectColorsetColors(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const color = record.color as Record<string, unknown> | undefined;
  const components = color?.components as Record<string, unknown> | undefined;
  if (components) {
    const red = componentHex(Number(components.red));
    const green = componentHex(Number(components.green));
    const blue = componentHex(Number(components.blue));
    if (red !== null && green !== null && blue !== null) out.add(`#${red}${green}${blue}`);
  }
  for (const value of Object.values(record)) collectColorsetColors(value, out);
}

export function extractProjectColors(text: string): string[] {
  const colors = new Set<string>();
  for (const match of text.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    colors.add(expandHex(match[0]));
  }
  const swiftColor =
    /Color\(\s*red:\s*([0-9.]+)\s*,\s*green:\s*([0-9.]+)\s*,\s*blue:\s*([0-9.]+)(?:\s*,\s*opacity:\s*[0-9.]+)?\s*\)/g;
  for (const match of text.matchAll(swiftColor)) {
    const red = componentHex(Number(match[1]));
    const green = componentHex(Number(match[2]));
    const blue = componentHex(Number(match[3]));
    if (red !== null && green !== null && blue !== null) colors.add(`#${red}${green}${blue}`);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed !== null) collectColorsetColors(parsed, colors);
  return [...colors];
}

export function analyzeGapData(input: GapInput): GapResult {
  const projectBySlug = new Map<string, string>();
  for (const assetPath of input.projectAssetPaths) {
    const base = assetPath.split("/").pop() ?? assetPath;
    projectBySlug.set(normalizeAssetName(base), assetPath);
  }

  const candidatesFor = (slug: string): string[] => {
    const candidates = new Set<string>([slug]);
    for (const suffix of ICON_SUFFIXES) {
      candidates.add(slug.endsWith(suffix) ? slug.slice(0, -suffix.length) : `${slug}${suffix}`);
    }
    return [...candidates];
  };

  const missingAssets: GapResult["missingAssets"] = [];
  const existingAssets: GapResult["existingAssets"] = [];
  for (const asset of input.designAssets) {
    const fileSlug = normalizeAssetName(asset.suggestedFilename ?? asset.name);
    const nameSlug = normalizeAssetName(asset.name);
    const slugs = new Set([...candidatesFor(fileSlug), ...candidatesFor(nameSlug)]);
    let matched: string | undefined;
    for (const slug of slugs) {
      const hit = projectBySlug.get(slug);
      if (hit) {
        matched = hit;
        break;
      }
    }
    if (matched) {
      existingAssets.push({ name: asset.name, matchedPath: matched });
    } else {
      missingAssets.push({
        name: asset.name,
        slug: fileSlug,
        suggestedFilename: asset.suggestedFilename ?? `${fileSlug}.svg`,
        figmaId: asset.id
      });
    }
  }

  const colorsChecked = Array.isArray(input.tokenContents) && input.tokenContents.length > 0;
  const projectColors = new Set<string>();
  if (colorsChecked) {
    for (const text of input.tokenContents!) {
      for (const color of extractProjectColors(text)) projectColors.add(color);
    }
  }
  const designColorSet = new Set(input.designColors.map((color) => color.toUpperCase()));
  const missingColors = colorsChecked
    ? [...designColorSet].filter((color) => !projectColors.has(color))
    : [];

  return {
    missingAssets,
    existingAssets,
    missingColors,
    colorsChecked,
    projectAssetCount: input.projectAssetPaths.length
  };
}

export interface GapAnalysisArgs {
  url: string;
  id?: string;
  assetGlobs?: string[];
  tokenFiles?: string[];
  save?: boolean;
}

/** Re-target missing-asset filenames to the project's stack naming rules
 * (Android: ic_home.svg, Flutter: home_icon.svg, RN/Web: home-icon.svg).
 * The Figma-suggested name is preserved as `figmaSuggestedFilename`; generic
 * layer names (`Frame 427`) fall back to a deterministic `asset <figmaId hash>`
 * name and are flagged `needsRename`. */
export function applyAssetNaming(
  missing: GapResult["missingAssets"],
  profile: StackProfile | null
): Array<
  GapResult["missingAssets"][number] & {
    figmaSuggestedFilename: string;
    suggestedDir: string | null;
    namingNote: string | null;
    needsRename?: boolean;
  }
> {
  return missing.map((asset) => {
    const generic = isGenericLayerName(asset.name);
    const sourceName = generic ? fallbackAssetName(asset.figmaId) : asset.slug || asset.name;
    return {
      ...asset,
      figmaSuggestedFilename: asset.suggestedFilename,
      suggestedFilename: formatAssetFilename(sourceName, profile, "svg"),
      suggestedDir: profile?.naming.assets.preferredDir ?? null,
      namingNote: profile?.naming.assets.note ?? null,
      ...(generic ? { needsRename: true } : {})
    };
  });
}

export async function figmaGapAnalysis(
  runtime: Runtime,
  args: GapAnalysisArgs
): Promise<CallToolResult> {
  try {
    const designAssets = (await restFindAssets(args.url)) as {
      count: number;
      assets: Array<{ id: string; name: string; suggestedFilename?: string; reason?: string }>;
    };
    const designSystem = (await restExtractDesignSystem(args.url, args.id)) as {
      colors?: Array<{ hex: string; usageCount?: number }>;
    };

    // Scanner rules follow the project's detected stack unless overridden.
    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const assetGlobs = args.assetGlobs?.length
      ? args.assetGlobs
      : (profile?.assetGlobs ?? DEFAULT_ASSET_GLOBS);
    const tokenGlobs = args.tokenFiles?.length
      ? args.tokenFiles
      : (profile?.tokenGlobs ?? DEFAULT_TOKEN_GLOBS);
    const projectAssets = walkProjectFiles(runtime.project.rootDir, assetGlobs);
    const tokenContents = readTokenContents(
      runtime.project.rootDir,
      walkProjectFiles(runtime.project.rootDir, tokenGlobs)
    );

    const gap = analyzeGapData({
      designAssets: designAssets.assets ?? [],
      designColors: (designSystem.colors ?? []).map((color) => color.hex),
      projectAssetPaths: projectAssets,
      tokenContents
    });

    const payload: Record<string, unknown> = {
      ok: true,
      sourceUrl: args.url,
      warnings: skippedStacksWarnings(stacks, profile),
      design: {
        assets: designAssets.count ?? designAssets.assets?.length ?? 0,
        colors: designSystem.colors?.length ?? 0
      },
      detectedStacks: stacks,
      rules: profile
        ? {
            stack: profile.id,
            displayName: profile.displayName,
            assetGlobs,
            tokenGlobs,
            locatorRules: profile.locatorRules,
            codeRules: profile.codeRules
          }
        : { stack: null, assetGlobs, tokenGlobs },
      project: {
        assetGlobs,
        scannedAssets: gap.projectAssetCount,
        tokenGlobs,
        tokenFilesRead: tokenContents.length
      },
      summary: {
        missingAssets: gap.missingAssets.length,
        existingAssets: gap.existingAssets.length,
        missingColors: gap.colorsChecked ? gap.missingColors.length : "not-checked (no token files matched)"
      },
      missingAssets: applyAssetNaming(gap.missingAssets, profile),
      existingAssets: gap.existingAssets,
      missingColors: gap.missingColors,
      colorsChecked: gap.colorsChecked
    };

    if (args.save !== false) {
      const savedTo = path.join(runtime.configDirAbs, "design", "gaps.json");
      writeFileAtomic(savedTo, JSON.stringify(payload, null, 2) + "\n");
      payload.savedTo = savedTo;
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `缺口分析失败: ${errorMessage(error)}`, hint: TOKEN_HINT },
      true
    );
  }
}
