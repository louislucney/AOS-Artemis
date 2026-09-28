import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';

export const GET_SELECTED_COLORS = 'get_selected_colors';

export const getSelectedColorsDefinition = {
  name: GET_SELECTED_COLORS,
  description: 'Returns all unique fill colors (with hex codes) found in the selected Figma nodes and all their descendants.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export function handleGetSelectedColors(): CallToolResult {
  const ctx = store.getContext();
  if (!ctx) return { content: [{ type: 'text', text: 'No data available. Make sure the Figma Context MCP plugin is running.' }] };
  if (ctx.selectedColors.length === 0) return { content: [{ type: 'text', text: 'No solid fill colors found in the current selection.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.selectedColors, null, 2) }] };
}
