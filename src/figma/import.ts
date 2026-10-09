import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { restExportImage } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { formatAssetFilename, detectProjectStacks, primaryProfile, skippedStacksWarning, type StackProfile } from "../projects/stack.js";
import { DEFAULT_ASSET_GLOBS, walkProjectFiles } from "./gaps.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

export interface GapAssetEntry {
  name: string;
  slug?: string;
  suggestedFilename?: string;
  suggestedDir?: string | null;
  figmaId?: string;
  figmaSuggestedFilename?: string;
}

export interface ImportPlanEntry {
  sourceId: string;
  name: string;
  relativePath: string;
  /** Pixel ratio of the exported bitmap (1/2/3); 0 for generated side files. */
  scale: number;
  role: "image" | "contents";
  /** Density label shown in reports (xhdpi / 2.0x / @2x / 1x). */
  variant?: string;
  /** iOS `Contents.json` image filenames (only for `role: "contents"`). */
  contentsFiles?: Array<{ filename: string; scale: number }>;
  contentsVector?: boolean;
}

export type ImportStatus =
  | "written"
  | "unchanged"
  | "skipped_exists"
  | "duplicate"
  | "planned"
  | "error";

export interface ImportResultEntry {
  name: string;
  sourceId: string;
  file?: string;
  status: ImportStatus;
  bytes?: number;
  sha256?: string;
  /** For `duplicate`: the already-present project file with identical content. */
  duplicateOf?: string;
  error?: string;
  scale?: number;
  role?: "image" | "contents";
  variant?: string;
}

const RASTER_FORMATS = new Set(["png", "jpg", "jpeg", "webp"]);

function stemAndExt(filename: string): { stem: string; ext: string } {
  const match = /^(.*?)(\.[A-Za-z0-9]+)$/.exec(filename);
  return match ? { stem: match[1]!, ext: match[2]! } : { stem: filename, ext: "" };
}

interface DensityVariant {
  relativePath: string;
  scale: number;
  variant: string;
}

interface DensityPlan {
  variants: DensityVariant[];
  contents?: { relativePath: string; files: Array<{ filename: string; scale: number }> };
}

/** Per-stack bitmap density layout (spec §13.3): Android xhdpi/xxhdpi,
 * Flutter 1x/2.0x/3.0x, iOS imageset 1x/2x/3x (+ Contents.json), RN
 * base/@2x/@3x, Web single 1x. Returns null when no convention applies. */
function densityPlan(profile: StackProfile | null, dir: string, filename: string): DensityPlan | null {
  if (!profile) return null;
  const { stem, ext } = stemAndExt(filename);
  const base = stem.replace(/@[0-9]+x$/i, "");
  const file = (suffix = ""): string => `${base}${suffix}${ext}`;

  switch (profile.id) {
    case "android-native": {
      const match = /^(.*\/)?(drawable|mipmap)(?:-[a-z0-9]+dpi)?$/.exec(dir);
      if (!match) return null;
      const resBase = `${match[1] ?? ""}${match[2]}`;
      return {
        variants: [
          { relativePath: `${resBase}-xhdpi/${file()}`, scale: 2, variant: "xhdpi" },
          { relativePath: `${resBase}-xxhdpi/${file()}`, scale: 3, variant: "xxhdpi" }
        ]
      };
    }
    case "flutter":
      return {
        variants: [
          { relativePath: `${dir}/${file()}`, scale: 1, variant: "1.0x" },
          { relativePath: `${dir}/2.0x/${file()}`, scale: 2, variant: "2.0x" },
          { relativePath: `${dir}/3.0x/${file()}`, scale: 3, variant: "3.0x" }
        ]
      };
    case "ios-native": {
      const imageset = `${dir}/${base}.imageset`;
      const files = [
        { filename: file(), scale: 1 },
        { filename: file("@2x"), scale: 2 },
        { filename: file("@3x"), scale: 3 }
      ];
      return {
        variants: files.map((entry) => ({
          relativePath: `${imageset}/${entry.filename}`,
          scale: entry.scale,
          variant: `${entry.scale}x`
        })),
        contents: { relativePath: `${imageset}/Contents.json`, files }
      };
    }
    case "react-native":
      return {
        variants: [
          { relativePath: `${dir}/${file()}`, scale: 1, variant: "1x" },
          { relativePath: `${dir}/${file("@2x")}`, scale: 2, variant: "@2x" },
          { relativePath: `${dir}/${file("@3x")}`, scale: 3, variant: "@3x" }
        ]
      };
    case "web":
      return { variants: [{ relativePath: `${dir}/${file()}`, scale: 1, variant: "1x" }] };
    default:
      return null;
  }
}

export function renderIosContents(
  files: Array<{ filename: string; scale: number }>,
  options: { vector?: boolean } = {}
): string {
  const payload =
    options.vector === true
      ? {
          images: files.map((entry) => ({ filename: entry.filename, idiom: "universal" })),
          info: { author: "xcode", version: 1 },
          properties: { "preserves-vector-representation": true }
        }
      : {
          images: files.map((entry) => ({
            filename: entry.filename,
            idiom: "universal",
            scale: `${entry.scale}x`
          })),
          info: { author: "xcode", version: 1 }
        };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Normalize a project-relative destination; rejects absolute paths and any
 * escape above the project root. */
export function safeRelativePath(dir: string, filename: string): string | null {
  const normalizedDir = dir.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/^[a-zA-Z]:/.test(normalizedDir)) return null; // windows drive escape
  const combined = path.posix.normalize(path.posix.join(normalizedDir, filename));
  if (combined.startsWith("..") || path.isAbsolute(combined) || combined === ".") return null;
  return combined;
}

/** Plan target files for the missing assets: stack naming + preferred dirs,
 * with `figmaSuggestedFilename`/explicit overrides taking precedence. Raster
 * assets expand to the stack density set when `densities` is enabled. */
export function planImports(
  assets: GapAssetEntry[],
  profile: StackProfile | null,
  options: { destDir?: string; format?: string; densities?: boolean } = {}
): ImportPlanEntry[] {
  const format = options.format ?? "svg";
  const raster = RASTER_FORMATS.has(format);
  const plan: ImportPlanEntry[] = [];
  const push = (entry: Omit<ImportPlanEntry, "name" | "sourceId"> & { name: string; sourceId: string }): void => {
    const relativePath = safeRelativePath("", entry.relativePath);
    if (!relativePath) throw new Error(`非法目标路径: ${entry.relativePath}`);
    plan.push({ ...entry, relativePath });
  };

  for (const asset of assets) {
    if (!asset.figmaId) continue;
    const filename = asset.suggestedFilename ?? formatAssetFilename(asset.name, profile, format);
    const dir = options.destDir ?? asset.suggestedDir ?? profile?.naming.assets.preferredDir ?? "assets";

    if (raster && options.densities === true) {
      const density = densityPlan(profile, dir, filename);
      if (density) {
        for (const variant of density.variants) {
          push({
            sourceId: asset.figmaId,
            name: asset.name,
            relativePath: variant.relativePath,
            scale: variant.scale,
            role: "image",
            variant: variant.variant
          });
        }
        if (density.contents) {
          push({
            sourceId: asset.figmaId,
            name: asset.name,
            relativePath: density.contents.relativePath,
            scale: 0,
            role: "contents",
            contentsFiles: density.contents.files
          });
        }
        continue;
      }
    }

    if (profile?.id === "ios-native") {
      const { stem, ext } = stemAndExt(filename);
      const base = stem.replace(/@[0-9]+x$/i, "");
      const single = `${base}${ext}`;
      const imageset = `${dir}/${base}.imageset`;
      push({
        sourceId: asset.figmaId,
        name: asset.name,
        relativePath: `${imageset}/${single}`,
        scale: raster ? 2 : 1,
        role: "image"
      });
      push({
        sourceId: asset.figmaId,
        name: asset.name,
        relativePath: `${imageset}/Contents.json`,
        scale: 0,
        role: "contents",
        contentsFiles: [{ filename: single, scale: raster ? 2 : 1 }],
        contentsVector: !raster
      });
      continue;
    }

    push({
      sourceId: asset.figmaId,
      name: asset.name,
      relativePath: `${dir}/${filename}`,
      scale: raster ? 2 : 1,
      role: "image"
    });
  }
  return plan;
}

/** Idempotent write: identical bytes → unchanged; different + !overwrite → skipped. */
export function writeAssetFile(
  rootDir: string,
  relativePath: string,
  content: string | Buffer,
  overwrite: boolean
): { status: Exclude<ImportStatus, "planned" | "error">; bytes: number } {
  const absolute = path.join(rootDir, relativePath);
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  if (fs.existsSync(absolute)) {
    const existing = fs.readFileSync(absolute);
    if (existing.equals(next)) return { status: "unchanged", bytes: next.length };
    if (!overwrite) return { status: "skipped_exists", bytes: next.length };
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, absolute);
  return { status: "written", bytes: next.length };
}

// ---------------------------------------------------------------------------
// Content-hash uniqueness
// ---------------------------------------------------------------------------

export function sha256Buffer(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Index project assets by content hash (sha256 → relative path) so imports can
 * detect same-content files regardless of their names. Bounded by file count
 * and per-file size; unreadable/oversized files are skipped. */
export function buildAssetHashIndex(
  rootDir: string,
  files: string[],
  options: { maxFiles?: number; maxBytes?: number } = {}
): Map<string, string> {
  const index = new Map<string, string>();
  const maxFiles = options.maxFiles ?? 2000;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  for (const file of files.slice(0, maxFiles)) {
    try {
      const absolute = path.join(rootDir, file);
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const hash = sha256Buffer(fs.readFileSync(absolute));
      if (!index.has(hash)) index.set(hash, file);
    } catch {
      /* skip unreadable */
    }
  }
  return index;
}

export interface WriteDecision {
  status: Exclude<ImportStatus, "planned" | "error">;
  sha256: string;
  bytes: number;
  duplicateOf?: string;
}

/** Decide what to do with one exported asset, enforcing content uniqueness:
 * 1) identical content already queued/written in this batch → duplicate;
 * 2) same target path: same bytes → unchanged, different bytes → overwrite?;
 * 3) identical content elsewhere in the project (different name) → duplicate. */
export function decideAssetWrite(args: {
  rootDir: string;
  relativePath: string;
  content: Buffer;
  projectHashes: Map<string, string>;
  batchHashes: Map<string, string>;
  overwrite: boolean;
}): WriteDecision {
  const sha256 = sha256Buffer(args.content);
  const bytes = args.content.length;

  const batchHit = args.batchHashes.get(sha256);
  if (batchHit && batchHit !== args.relativePath) {
    return { status: "duplicate", sha256, bytes, duplicateOf: batchHit };
  }

  const absolute = path.join(args.rootDir, args.relativePath);
  if (fs.existsSync(absolute)) {
    const existing = fs.readFileSync(absolute);
    if (existing.equals(args.content)) return { status: "unchanged", sha256, bytes };
    if (!args.overwrite) return { status: "skipped_exists", sha256, bytes };
  }

  const projectHit = args.projectHashes.get(sha256);
  if (projectHit && projectHit !== args.relativePath) {
    return { status: "duplicate", sha256, bytes, duplicateOf: projectHit };
  }

  return { status: "written", sha256, bytes };
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const TOKEN_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或调用 aos_configure 携带 figmaToken）。";

export interface ImportAssetsArgs {
  url?: string;
  gapPath?: string;
  destDir?: string;
  ids?: string[];
  format?: "svg" | "png";
  /** Export raster assets as the stack density set (default true). */
  densities?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  save?: boolean;
}

export async function figmaImportAssets(
  runtime: Runtime,
  args: ImportAssetsArgs
): Promise<CallToolResult> {
  try {
    const gapPath = args.gapPath
      ? path.resolve(runtime.project.rootDir, args.gapPath)
      : path.join(runtime.configDirAbs, "design", "gaps.json");
    if (!fs.existsSync(gapPath)) {
      throw new Error(`未找到 ${gapPath}：先运行 figma_gap_analysis`);
    }
    const gap = JSON.parse(fs.readFileSync(gapPath, "utf-8")) as {
      sourceUrl?: string;
      missingAssets?: GapAssetEntry[];
    };
    const url = args.url ?? gap.sourceUrl;
    if (!url) {
      throw new Error("缺少 Figma URL：gaps.json 未记录 sourceUrl，请显式传 url");
    }

    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const format = args.format ?? "svg";
    const densities = args.densities !== false;

    let missing = gap.missingAssets ?? [];
    if (args.ids?.length) {
      const wanted = new Set(args.ids);
      missing = missing.filter((asset) => asset.figmaId && wanted.has(asset.figmaId));
    }
    const plan = planImports(missing, profile, { destDir: args.destDir, format, densities });
    if (plan.length === 0) {
      return jsonResult({ ok: true, message: "没有可导入的资源（missingAssets 为空或 ids 不匹配）", results: [] });
    }

    const imageIds = [...new Set(plan.filter((entry) => entry.role === "image").map((entry) => entry.sourceId))];
    const scales = [...new Set(plan.filter((entry) => entry.role === "image").map((entry) => entry.scale))].sort(
      (a, b) => a - b
    );
    const exportedByScale = new Map<number, Map<string, { svg?: string; url?: string; error?: string }>>();
    for (const scale of scales) {
      const exportResult = (await restExportImage(url, imageIds, format, scale)) as {
        error?: string;
        assets?: Array<{ id: string; svg?: string; url?: string; error?: string }>;
      };
      if (exportResult.error) throw new Error(exportResult.error);
      const byId = new Map<string, { svg?: string; url?: string; error?: string }>();
      for (const asset of exportResult.assets ?? []) {
        byId.set(asset.id, asset);
      }
      exportedByScale.set(scale, byId);
    }

    const results: ImportResultEntry[] = [];
    const imageResults = new Map<string, ImportResultEntry>();
    const assetGlobs = profile?.assetGlobs ?? DEFAULT_ASSET_GLOBS;
    const projectHashes = buildAssetHashIndex(
      runtime.project.rootDir,
      walkProjectFiles(runtime.project.rootDir, assetGlobs)
    );
    const batchHashes = new Map<string, string>();
    const imageEntries = plan.filter((entry) => entry.role === "image");
    const contentsEntries = plan.filter((entry) => entry.role === "contents");

    for (const entry of imageEntries) {
      const exported = exportedByScale.get(entry.scale)?.get(entry.sourceId);
      if (!exported) {
        const result: ImportResultEntry = { ...entry, status: "error", error: "Figma 未返回该节点的导出" };
        results.push(result);
        imageResults.set(entry.relativePath, result);
        continue;
      }
      if (exported.error) {
        const result: ImportResultEntry = { ...entry, status: "error", error: exported.error };
        results.push(result);
        imageResults.set(entry.relativePath, result);
        continue;
      }

      let content: Buffer | null = null;
      if (typeof exported.svg === "string") {
        content = Buffer.from(exported.svg, "utf-8");
      } else if (exported.url) {
        const response = await fetch(exported.url);
        if (!response.ok) {
          const result: ImportResultEntry = {
            ...entry,
            status: "error",
            error: `下载失败: HTTP ${response.status}`
          };
          results.push(result);
          imageResults.set(entry.relativePath, result);
          continue;
        }
        content = Buffer.from(await response.arrayBuffer());
      }
      if (!content) {
        const result: ImportResultEntry = { ...entry, status: "error", error: "导出内容为空" };
        results.push(result);
        imageResults.set(entry.relativePath, result);
        continue;
      }

      const decision = decideAssetWrite({
        rootDir: runtime.project.rootDir,
        relativePath: entry.relativePath,
        content,
        projectHashes,
        batchHashes,
        overwrite: args.overwrite === true
      });

      let result: ImportResultEntry;
      if (decision.status === "written") {
        if (args.dryRun !== true) {
          writeAssetFile(runtime.project.rootDir, entry.relativePath, content, true);
        }
        batchHashes.set(decision.sha256, entry.relativePath);
        result = {
          ...entry,
          status: args.dryRun === true ? "planned" : "written",
          bytes: decision.bytes,
          sha256: decision.sha256
        };
      } else {
        result = {
          ...entry,
          status: decision.status,
          bytes: decision.bytes,
          sha256: decision.sha256,
          duplicateOf: decision.duplicateOf
        };
      }
      results.push(result);
      imageResults.set(entry.relativePath, result);
    }

    for (const entry of contentsEntries) {
      const dirOf = (relativePath: string): string => path.posix.dirname(relativePath);
      const failed = imageEntries.filter((image) => {
        const result = imageResults.get(image.relativePath);
        return (
          image.sourceId === entry.sourceId &&
          dirOf(image.relativePath) === dirOf(entry.relativePath) &&
          result !== undefined &&
          (result.status === "error" || result.status === "duplicate")
        );
      });
      if (failed.length > 0) {
        results.push({
          ...entry,
          status: "error",
          error: `有图片未写入（${failed.map((image) => image.relativePath).join("、")}），跳过 Contents.json`
        });
        continue;
      }
      const content = Buffer.from(
        renderIosContents(entry.contentsFiles ?? [], { vector: entry.contentsVector === true }),
        "utf-8"
      );
      const decision = decideAssetWrite({
        rootDir: runtime.project.rootDir,
        relativePath: entry.relativePath,
        content,
        projectHashes,
        batchHashes,
        overwrite: args.overwrite === true
      });
      if (decision.status === "written") {
        if (args.dryRun !== true) {
          writeAssetFile(runtime.project.rootDir, entry.relativePath, content, true);
        }
        batchHashes.set(decision.sha256, entry.relativePath);
        results.push({
          ...entry,
          status: args.dryRun === true ? "planned" : "written",
          bytes: decision.bytes,
          sha256: decision.sha256
        });
        continue;
      }
      results.push({
        ...entry,
        status: decision.status,
        bytes: decision.bytes,
        sha256: decision.sha256,
        duplicateOf: decision.duplicateOf
      });
    }

    const counts = results.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
      return accumulator;
    }, {});

    const warnings: string[] = [];
    const multiStackWarning = skippedStacksWarning(stacks, profile);
    if (multiStackWarning) warnings.push(multiStackWarning);

    const payload: Record<string, unknown> = {
      ok: true,
      sourceUrl: url,
      schemaVersion: 2,
      format,
      densities: format === "svg" ? false : densities,
      dryRun: args.dryRun === true,
      detectedStacks: stacks,
      warnings,
      counts: {
        ...counts,
        assets: new Set(plan.filter((entry) => entry.role === "image").map((entry) => entry.sourceId)).size,
        files: plan.length
      },
      uniqueness: {
        indexedProjectAssets: projectHashes.size,
        duplicates: results.filter((entry) => entry.status === "duplicate").length
      },
      results,
      hint:
        (args.dryRun === true
          ? "dryRun 预览：确认路径后去掉 dryRun 正式写入；duplicate 表示同内容已存在（duplicateOf 指向现有文件）。"
          : "duplicate=同内容已存在（跳过，见 duplicateOf）；skipped_exists=同名但内容不同（需 overwrite 或改名）。") +
        ` 位图按栈倍率集导出（Android drawable-xhdpi/-xxhdpi、Flutter 2.0x/3.0x、iOS imageset、RN @2x/@3x）；densities:false 回退单文件 @2x。`
    };

    if (args.dryRun !== true && args.save !== false) {
      const reportPath = path.join(runtime.configDirAbs, "design", "import-report.json");
      writeFileAtomic(reportPath, JSON.stringify(payload, null, 2) + "\n");
      payload.savedTo = reportPath;
    }

    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `资源导入失败: ${errorMessage(error)}`, hint: TOKEN_HINT }, true);
  }
}
