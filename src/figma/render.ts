import type { DesignNode } from "../diff/engine.js";
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
): Promise<FigmaDesignNode[]> {
  const { fileKey } = parseFigmaUrl(figmaUrl);
  const targetNode = resolveFigmaNodeId(figmaUrl, nodeIdOverride);
  const response = (await fetchNodes(fileKey, [targetNode])) as {
    nodes?: Record<string, { document?: RawNode } | undefined>;
  };
  const document = response.nodes?.[targetNode]?.document;
  if (!document) throw new Error(`Figma 未返回节点数据（node ${targetNode}）`);
  const rootBox = document.absoluteBoundingBox;
  const nodes: FigmaDesignNode[] = [];
  const visit = (node: RawNode, inheritedFill: string | undefined): void => {
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
        ...(node.characters ? { text: node.characters } : {}),
        ...(inheritedFill ? { parentFill: inheritedFill } : {})
      });
      for (const child of node.children ?? []) visit(child, ownFill ?? inheritedFill);
      return;
    }
    for (const child of node.children ?? []) visit(child, inheritedFill);
  };
  for (const child of document.children ?? []) visit(child, solidFillOf(document));
  return nodes;
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
