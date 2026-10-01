import { fetchImages, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";

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

export async function fetchFigmaRenderPng(figmaUrl: string, nodeIdOverride?: string): Promise<FigmaRender> {
  const { fileKey } = parseFigmaUrl(figmaUrl);
  const targetNode = resolveFigmaNodeId(figmaUrl, nodeIdOverride);
  const render = await fetchImages(fileKey, [targetNode], "png", 2);
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
