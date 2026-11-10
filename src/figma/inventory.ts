import {
  fetchFile,
  parseFigmaUrl
} from "../vendor/design-context-bridge/figma-rest/client.js";
import type { FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { errorMessage } from "../util.js";

const MAX_FRAMES_PER_PAGE = 200;

export interface FigmaFrameSummary {
  id: string;
  name: string;
  type: string;
}

export interface FigmaPageSummary {
  id: string;
  name: string;
  type: string;
  frames: FigmaFrameSummary[];
  truncated: boolean;
}

export interface FigmaFrameInventory {
  ok: true;
  fileKey: string;
  fileName: string | null;
  pages: FigmaPageSummary[];
  warnings: string[];
}

export interface FigmaFrameInventoryError {
  ok: false;
  error: string;
}

function isPage(node: FigmaNode): boolean {
  return node.type === "PAGE" || node.type === "CANVAS";
}

function isFrameLike(node: FigmaNode): boolean {
  return ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "INSTANCE"].includes(node.type);
}

/** Depth=2 inventory: document → pages → top-level frames. Does not download
 * the full node tree; use the returned ids with `figma_extract_flows.nodeId`. */
export async function listFigmaFrames(input: {
  url: string;
  token?: string | null;
}): Promise<FigmaFrameInventory | FigmaFrameInventoryError> {
  try {
    const { fileKey } = parseFigmaUrl(input.url);
    const file = (await fetchFile(fileKey, 2, input.token ?? undefined)) as {
      name?: string;
      document?: FigmaNode;
    };
    if (!file.document) return { ok: false, error: `文件 ${fileKey} 没有 document 数据` };
    const children = file.document.children ?? [];
    const pages = children.filter(isPage).length > 0 ? children.filter(isPage) : children;
    const warnings: string[] = [];
    const summaries: FigmaPageSummary[] = [];
    for (const page of pages) {
      const all = (page.children ?? []).filter(isFrameLike);
      if (all.length > MAX_FRAMES_PER_PAGE) {
        warnings.push(
          `页面「${page.name}」有 ${all.length} 个顶层画板，已截断为 ${MAX_FRAMES_PER_PAGE} 个`
        );
      }
      summaries.push({
        id: page.id,
        name: page.name,
        type: page.type,
        frames: all.slice(0, MAX_FRAMES_PER_PAGE).map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type
        })),
        truncated: all.length > MAX_FRAMES_PER_PAGE
      });
    }
    if (summaries.length === 0) {
      warnings.push("文件没有可用的页面/画板");
    }
    return {
      ok: true,
      fileKey,
      fileName: file.name ?? null,
      pages: summaries,
      warnings
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
