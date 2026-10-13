import type { DesignNode } from "../diff/engine.js";
import { isPngBuffer } from "../design/screens.js";
import { errorMessage } from "../util.js";
import { rgbaToHex } from "../vendor/design-context-bridge/figma-rest/analysis.js";
import { fetchImages, fetchNodes, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";

export interface FigmaRender {
  png: Buffer;
  nodeId: string;
  renderUrl: string;
}

export function resolveFigmaNodeId(figmaUrl: string, nodeIdOverride?: string): string {
  const { nodeId } = parseFigmaUrl(figmaUrl);
  const targetNode = nodeIdOverride ?? nodeId;
  if (!targetNode) {
    throw new Error("URL 缺少 node-id：请传入带 ?node-id= 的 Figma URL，或提供 nodeId 参数。");
  }
  return targetNode;
}

export type FigmaDesignNode = DesignNode;

const MAX_DESIGN_NODES = 500;

interface RawNode {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  fills?: Array<{ type?: string; visible?: boolean; color?: { r: number; g: number; b: number; a?: number } }>;
  children?: RawNode[];
}

function solidFillOf(node: RawNode): string | undefined {
  for (const fill of node.fills ?? []) {
    if (fill.type === "SOLID" && fill.visible !== false && fill.color) {
      return rgbaToHex(fill.color as Parameters<typeof rgbaToHex>[0]);
    }
  }
  return undefined;
}

export async function fetchFigmaDesignNodes(
  figmaUrl: string,
  nodeIdOverride?: string
): Promise<{ nodes: FigmaDesignNode[]; truncated: boolean }> {
  const { fileKey } = parseFigmaUrl(figmaUrl);
  const targetNode = resolveFigmaNodeId(figmaUrl, nodeIdOverride);
  const response = (await fetchNodes(fileKey, [targetNode])) as {
    nodes?: Record<string, { document?: RawNode } | undefined>;
  };
  const document = response.nodes?.[targetNode]?.document;
  if (!document) throw new Error(`Figma 未返回节点数据（node ${targetNode}）`);
  const rootBox = document.absoluteBoundingBox;
  const nodes: FigmaDesignNode[] = [];
  if (rootBox && typeof document.id === "string") {
    nodes.push({
      id: document.id,
      name: document.name ?? "",
      type: document.type ?? "unknown",
      x: 0,
      y: 0,
      width: rootBox.width,
      height: rootBox.height,
      depth: 0
    });
  }
  const visit = (node: RawNode, inheritedFill: string | undefined, depth: number): void => {
    if (nodes.length >= MAX_DESIGN_NODES) return;
    const box = node.absoluteBoundingBox;
    if (box && rootBox && typeof node.id === "string") {
      const ownFill = solidFillOf(node);
      nodes.push({
        id: node.id,
        name: node.name ?? "",
        type: node.type ?? "unknown",
        x: box.x - rootBox.x,
        y: box.y - rootBox.y,
        width: box.width,
        height: box.height,
        depth,
        ...(node.characters ? { text: node.characters } : {}),
        ...(inheritedFill ? { parentFill: inheritedFill } : {})
      });
      for (const child of node.children ?? []) visit(child, ownFill ?? inheritedFill, depth + 1);
      return;
    }
    for (const child of node.children ?? []) visit(child, inheritedFill, depth + 1);
  };
  for (const child of document.children ?? []) visit(child, solidFillOf(document), 1);
  return { nodes, truncated: nodes.length >= MAX_DESIGN_NODES };
}

export async function fetchFigmaRenderPng(
  figmaUrl: string,
  nodeIdOverride?: string,
  scale = 2
): Promise<FigmaRender> {
  const { fileKey } = parseFigmaUrl(figmaUrl);
  const targetNode = resolveFigmaNodeId(figmaUrl, nodeIdOverride);
  const render = await fetchImages(fileKey, [targetNode], "png", scale);
  const renderUrl = render.images?.[targetNode];
  if (!renderUrl) {
    throw new Error(`Figma 未返回渲染图（node ${targetNode}）${render.err ? `: ${render.err}` : ""}`);
  }
  const response = await fetch(renderUrl);
  if (!response.ok) throw new Error(`下载 Figma 渲染图失败: HTTP ${response.status}`);
  return {
    png: Buffer.from(await response.arrayBuffer()),
    nodeId: targetNode,
    renderUrl
  };
}

export interface FigmaScreenCapture {
  /** nodeId → PNG bytes（校验过魔术头；仅成功的屏）。 */
  pngById: Map<string, Buffer>;
  /** 未产出渲染的屏（含下载/校验失败）。 */
  skipped: string[];
  /** 通道级失败（无 token / 限流冷却 / 请求失败）——大于 0 屏时仍可能部分成功。 */
  channelError: string | null;
}

const SCREEN_RETRY_WAIT_MS = 1000;

/** 批量渲染屏幕 PNG（design-screenshots T3）：一次 `/images` 调用（scale=1）→
 * 下载；个别节点返回 null（未就绪/失败）时有界重试一次（绕响应缓存）→
 * 仍缺则逐屏降级；通道级失败原样上报（调用方记 screenshot-render-unavailable）。 */
export async function captureFigmaScreens(
  fileKey: string,
  nodeIds: string[],
  deps: { scale?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<FigmaScreenCapture> {
  const ids = [...new Set(nodeIds.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { pngById: new Map(), skipped: [], channelError: null };
  const scale = deps.scale ?? 1;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let urls: Record<string, string | null>;
  try {
    const first = await fetchImages(fileKey, ids, "png", scale);
    urls = { ...(first.images ?? {}) };
  } catch (error) {
    return { pngById: new Map(), skipped: ids, channelError: errorMessage(error) };
  }

  const unresolved = ids.filter((id) => !urls[id]);
  if (unresolved.length > 0) {
    await sleep(SCREEN_RETRY_WAIT_MS);
    try {
      const retry = await fetchImages(fileKey, unresolved, "png", scale, { noCache: true });
      for (const id of unresolved) {
        const url = retry.images?.[id];
        if (url) urls[id] = url;
      }
    } catch {
      /* 保留首轮结果；未决屏按缺屏降级 */
    }
  }

  const pngById = new Map<string, Buffer>();
  for (const id of ids) {
    const url = urls[id];
    if (!url) continue;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isPngBuffer(buffer)) continue;
      pngById.set(id, buffer);
    } catch {
      /* 单屏下载失败 → 按缺屏降级 */
    }
  }
  return { pngById, skipped: ids.filter((id) => !pngById.has(id)), channelError: null };
}
