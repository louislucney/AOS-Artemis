import { loadDotenvValues } from "../config/loader.js";
import type { ProjectStore, WebAssetRecord } from "../db/types.js";
import { sanitizeScreenId } from "../design/screens.js";
import {
  captureFigmaScreens,
  type FigmaScreenCapture
} from "../figma/render.js";
import { parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import { resolveFigmaNodeId } from "../figma/render.js";
import { errorMessage } from "../util.js";
import { storeWebAsset } from "./assets.js";

export class FigmaReferenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FigmaReferenceError";
    this.code = code;
  }
}

export interface FigmaReferenceDeps {
  capture?: typeof captureFigmaScreens;
}

/**
 * Figma 参考图导入：只接受带 node-id 的 URL（或显式 nodeId），
 * 用项目 `.env`/进程 env 的 FIGMA_ACCESS_TOKEN 拉取该节点 PNG。
 */
export async function storeFigmaReference(input: {
  store: ProjectStore;
  rootPath: string;
  figmaUrl: string;
  nodeId?: string | null;
  uploadedBy: string | null;
  deps?: FigmaReferenceDeps;
}): Promise<{ asset: WebAssetRecord; fileKey: string; nodeId: string }> {
  const url = input.figmaUrl.trim();
  if (url === "") throw new FigmaReferenceError("figma-url-missing", "缺少 Figma URL");
  const token =
    loadDotenvValues(input.rootPath).FIGMA_ACCESS_TOKEN?.trim() ||
    process.env.FIGMA_ACCESS_TOKEN?.trim() ||
    "";
  if (token === "") {
    throw new FigmaReferenceError(
      "figma-token-missing",
      "缺少 FIGMA_ACCESS_TOKEN（写入项目 .env 或通过 aos_configure 配置）"
    );
  }
  let fileKey: string;
  let nodeId: string;
  try {
    fileKey = parseFigmaUrl(url).fileKey;
    nodeId = resolveFigmaNodeId(url, input.nodeId?.trim() || undefined);
  } catch (error) {
    throw new FigmaReferenceError("figma-url-invalid", errorMessage(error));
  }
  let capture: FigmaScreenCapture;
  try {
    capture = await (input.deps?.capture ?? captureFigmaScreens)(fileKey, [nodeId], {
      scale: 1,
      figmaToken: token
    });
  } catch (error) {
    throw new FigmaReferenceError("figma-render-failed", errorMessage(error));
  }
  const png = capture.pngById.get(nodeId);
  if (!png) {
    throw new FigmaReferenceError(
      "figma-render-failed",
      `Figma 未产出节点 ${nodeId} 的 PNG${capture.channelError ? `：${capture.channelError}` : ""}`
    );
  }
  const asset = await storeWebAsset({
    store: input.store,
    rootPath: input.rootPath,
    kind: "reference",
    filename: `figma-${sanitizeScreenId(fileKey)}-${sanitizeScreenId(nodeId)}.png`,
    buffer: png,
    uploadedBy: input.uploadedBy,
    metadata: {
      sourceType: "figma",
      figmaUrl: url,
      fileKey,
      nodeId,
      renderScale: 1
    }
  });
  return { asset, fileKey, nodeId };
}
