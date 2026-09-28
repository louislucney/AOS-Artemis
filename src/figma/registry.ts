import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { FIGMA_TOOLS, FIGMA_TOOL_NAMES, type FigmaToolDef } from "./tool-defs.js";
import { handleGetCurrentSelection } from "../vendor/design-context-bridge/mcp-server/tools/get-current-selection.js";
import { handleGetCurrentPage } from "../vendor/design-context-bridge/mcp-server/tools/get-current-page.js";
import { handleGetAllPages } from "../vendor/design-context-bridge/mcp-server/tools/get-all-pages.js";
import { handleGetFrameByName } from "../vendor/design-context-bridge/mcp-server/tools/get-frame-by-name.js";
import { handleGetComponentDefinitions } from "../vendor/design-context-bridge/mcp-server/tools/get-component-definitions.js";
import { handleGetSelectedColors } from "../vendor/design-context-bridge/mcp-server/tools/get-selected-colors.js";
import { handleGetSelectedTexts } from "../vendor/design-context-bridge/mcp-server/tools/get-selected-texts.js";
import { handleGetVariables } from "../vendor/design-context-bridge/mcp-server/tools/get-variables.js";
import { handleGetSelectedSpacing } from "../vendor/design-context-bridge/mcp-server/tools/get-selected-spacing.js";
import { handleGetSelectedInteractions } from "../vendor/design-context-bridge/mcp-server/tools/get-selected-interactions.js";
import { handleGetNodeInfo } from "../vendor/design-context-bridge/mcp-server/tools/get-node-info.js";
import { handleGetNodesInfo } from "../vendor/design-context-bridge/mcp-server/tools/get-nodes-info.js";
import { handleScanNodesByTypes } from "../vendor/design-context-bridge/mcp-server/tools/scan-nodes-by-types.js";
import { handleGetFileFromUrl } from "../vendor/design-context-bridge/figma-rest/tools/get-file-from-url.js";
import { handleGetNodeFromUrl } from "../vendor/design-context-bridge/figma-rest/tools/get-node-from-url.js";
import { handleExtractDesignSystem } from "../vendor/design-context-bridge/figma-rest/tools/extract-design-system.js";
import { handleAnalyzeStructure } from "../vendor/design-context-bridge/figma-rest/tools/analyze-structure.js";
import { handleGetComponentVariants } from "../vendor/design-context-bridge/figma-rest/tools/get-component-variants.js";
import { handleExportImage } from "../vendor/design-context-bridge/figma-rest/tools/export-image.js";
import { handleFindAssets } from "../vendor/design-context-bridge/figma-rest/tools/find-assets.js";

type FigmaHandler = (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;

const HANDLERS: Record<string, FigmaHandler> = {
  get_current_selection: () => handleGetCurrentSelection(),
  get_current_page: (args) => handleGetCurrentPage(args),
  get_all_pages: (args) => handleGetAllPages(args),
  get_frame_by_name: (args) => handleGetFrameByName(args),
  get_component_definitions: (args) => handleGetComponentDefinitions(args),
  get_selected_colors: () => handleGetSelectedColors(),
  get_selected_texts: () => handleGetSelectedTexts(),
  get_variables: (args) => handleGetVariables(args),
  get_selected_spacing: () => handleGetSelectedSpacing(),
  get_selected_interactions: () => handleGetSelectedInteractions(),
  get_node_info: (args) => handleGetNodeInfo(args),
  get_nodes_info: (args) => handleGetNodesInfo(args),
  scan_nodes_by_types: (args) => handleScanNodesByTypes(args),
  get_file_from_url: (args) => handleGetFileFromUrl(args),
  get_node_from_url: (args) => handleGetNodeFromUrl(args),
  extract_design_system: (args) => handleExtractDesignSystem(args),
  analyze_structure: (args) => handleAnalyzeStructure(args),
  get_component_variants: (args) => handleGetComponentVariants(args),
  export_image: (args) => handleExportImage(args),
  find_assets: (args) => handleFindAssets(args)
};

export interface RegisteredFigmaTool extends FigmaToolDef {
  handler: FigmaHandler;
}

export function figmaTools(): RegisteredFigmaTool[] {
  return FIGMA_TOOLS.map((def) => {
    const handler = HANDLERS[def.name];
    if (!handler) throw new Error(`Figma tool handler missing for "${def.name}"`);
    return { ...def, handler };
  });
}

export function isFigmaTool(name: string): boolean {
  return FIGMA_TOOL_NAMES.has(name);
}

/** Validate args with the tool's zod schema, then run the vendored handler. */
export async function handleFigmaTool(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const def = FIGMA_TOOLS.find((tool) => tool.name === name);
  const handler = HANDLERS[name];
  if (!def || !handler) {
    return {
      content: [{ type: "text", text: `Unknown Figma tool: ${name}` }],
      isError: true
    };
  }
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `参数校验失败: ${parsed.error.message}` }],
      isError: true
    };
  }
  return await handler(parsed.data as Record<string, unknown>);
}
