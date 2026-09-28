import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { restExportImage } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { formatAssetFilename, detectProjectStacks, primaryProfile, type StackProfile } from "../projects/stack.js";
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
  figmaId: string;
  name: string;
  relativePath: string;
}

export type ImportStatus = "written" | "unchanged" | "skipped_exists" | "planned" | "error";

export interface ImportResultEntry {
  name: string;
  figmaId: string;
  file?: string;
  status: ImportStatus;
  bytes?: number;
  error?: string;
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
 * with `figmaSuggestedFilename`/explicit overrides taking precedence. */
export function planImports(
  assets: GapAssetEntry[],
  profile: StackProfile | null,
  options: { destDir?: string; format?: string } = {}
): ImportPlanEntry[] {
  const format = options.format ?? "svg";
  const plan: ImportPlanEntry[] = [];
  for (const asset of assets) {
    if (!asset.figmaId) continue;
    const filename = asset.suggestedFilename ?? formatAssetFilename(asset.name, profile, format);
    const dir = options.destDir ?? asset.suggestedDir ?? profile?.naming.assets.preferredDir ?? "assets";
    const relativePath = safeRelativePath(dir, filename);
    if (!relativePath) throw new Error(`非法目标路径: ${dir}/${filename}`);
    plan.push({ figmaId: asset.figmaId, name: asset.name, relativePath });
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

    let missing = gap.missingAssets ?? [];
    if (args.ids?.length) {
      const wanted = new Set(args.ids);
      missing = missing.filter((asset) => asset.figmaId && wanted.has(asset.figmaId));
    }
    const plan = planImports(missing, profile, { destDir: args.destDir, format });
    if (plan.length === 0) {
      return jsonResult({ ok: true, message: "没有可导入的资源（missingAssets 为空或 ids 不匹配）", results: [] });
    }

    const exportResult = (await restExportImage(
      url,
      plan.map((entry) => entry.figmaId),
      format,
      2
    )) as {
      error?: string;
      assets?: Array<{ id: string; svg?: string; url?: string; error?: string }>;
    };
    if (exportResult.error) throw new Error(exportResult.error);
    const exportedById = new Map<string, { svg?: string; url?: string; error?: string }>();
    for (const asset of exportResult.assets ?? []) {
      exportedById.set(asset.id, asset);
    }

    const results: ImportResultEntry[] = [];
    for (const entry of plan) {
      const exported = exportedById.get(entry.figmaId);
      if (!exported) {
        results.push({ ...entry, status: "error", error: "Figma 未返回该节点的导出" });
        continue;
      }
      if (exported.error) {
        results.push({ ...entry, status: "error", error: exported.error });
        continue;
      }

      let content: Buffer | null = null;
      if (typeof exported.svg === "string") {
        content = Buffer.from(exported.svg, "utf-8");
      } else if (exported.url) {
        const response = await fetch(exported.url);
        if (!response.ok) {
          results.push({ ...entry, status: "error", error: `下载失败: HTTP ${response.status}` });
          continue;
        }
        content = Buffer.from(await response.arrayBuffer());
      }
      if (!content) {
        results.push({ ...entry, status: "error", error: "导出内容为空" });
        continue;
      }

      if (args.dryRun) {
        results.push({ ...entry, status: "planned", bytes: content.length });
        continue;
      }
      const written = writeAssetFile(runtime.project.rootDir, entry.relativePath, content, args.overwrite === true);
      results.push({ ...entry, status: written.status, bytes: written.bytes });
    }

    const counts = results.reduce<Record<string, number>>((accumulator, entry) => {
      accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
      return accumulator;
    }, {});

    const payload: Record<string, unknown> = {
      ok: true,
      sourceUrl: url,
      format,
      dryRun: args.dryRun === true,
      detectedStacks: stacks,
      counts,
      results,
      hint:
        args.dryRun === true
          ? "dryRun 预览：确认路径后去掉 dryRun 正式写入。"
          : "需要组件接线/转换的场景见结果的 namingNote（如 Android SVG→Vector XML）。"
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
