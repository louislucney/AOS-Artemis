import fs from "node:fs";
import path from "node:path";

import { designDir, readFlowDocumentMeta } from "../figma/design-store.js";
import { designFlowsPath } from "../figma/design-source.js";
import type { Runtime } from "../runtime.js";

/** Excel 导入时可见的设计上下文摘要；只读文件，不触网、不调用 pen/Figma。 */
export interface DesignContextSummary {
  available: boolean;
  sources: string[];
  flows: boolean;
  uiContract: boolean;
  screenMap: boolean;
  acceptance: boolean;
  penScreens: number;
  screenshots: number;
  referenceAssets: number;
  figmaToken: boolean;
}

function countFiles(dir: string, extension?: string): number {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => extension === undefined || entry.name.toLowerCase().endsWith(extension))
      .length;
  } catch {
    return 0;
  }
}

function countEntries(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).length;
  } catch {
    return 0;
  }
}

/** 检测项目已有的设计基线（flows/ui-contract/pen 逐屏/截图/screen-map/acceptance）。
 * `figmaToken` 只表示“有凭证”，不单独算设计基线可用。 */
export function detectDesignContext(
  runtime: Runtime,
  options: { referenceAssets?: number } = {}
): DesignContextSummary {
  const root = designDir(runtime.configDirAbs);
  const flowsPath = designFlowsPath(runtime);
  const flows = fs.existsSync(flowsPath);
  const meta = flows ? readFlowDocumentMeta(runtime.configDirAbs, { flowsPath }) : null;
  const uiContract = fs.existsSync(path.join(root, "ui-contract.json"));
  const screenMap = fs.existsSync(path.join(root, "screen-map.json"));
  const acceptance = fs.existsSync(path.join(root, "acceptance.json"));
  const penScreens = countFiles(path.join(root, "pen", "screens"), ".pen");
  const screenshots = countEntries(path.join(root, "screens"));
  const referenceAssets = Math.max(0, Math.trunc(options.referenceAssets ?? 0));
  const figmaToken = Boolean(
    (runtime.project.dotenvValues?.FIGMA_ACCESS_TOKEN ?? "").trim() ||
      (process.env.FIGMA_ACCESS_TOKEN ?? "").trim()
  );
  const sources: string[] = [];
  if (flows) sources.push("flows.json");
  if (meta?.fileKey !== null && meta?.fileKey !== undefined) sources.push("figma-file");
  if (meta?.penPath !== null && meta?.penPath !== undefined) sources.push("pen-source");
  if (uiContract) sources.push("ui-contract.json");
  if (screenMap) sources.push("screen-map.json");
  if (acceptance) sources.push("acceptance.json");
  if (penScreens > 0) sources.push("pen-screens");
  if (screenshots > 0) sources.push("screenshots");
  if (referenceAssets > 0) sources.push("reference-assets");
  if (figmaToken) sources.push("figma-token");
  return {
    available:
      flows ||
      uiContract ||
      screenMap ||
      acceptance ||
      penScreens > 0 ||
      screenshots > 0 ||
      referenceAssets > 0,
    sources,
    flows,
    uiContract,
    screenMap,
    acceptance,
    penScreens,
    screenshots,
    referenceAssets,
    figmaToken
  };
}
