import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';

export const GET_SELECTED_SPACING = 'get_selected_spacing';

export const getSelectedSpacingDefinition = {
  name: GET_SELECTED_SPACING,
  description: 'Returns auto-layout spacing (itemSpacing/gap and padding) for the selected Figma nodes and their descendants, including the NAME of any spacing variable/token bound to each property (works for both local and library variables).',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export function handleGetSelectedSpacing(): CallToolResult {
  const ctx = store.getContext();
  if (!ctx || !ctx.selectedSpacing) return { content: [{ type: 'text', text: 'No data available. Make sure the plugin is connected (green dot) and a frame is selected.' }] };
  if (ctx.selectedSpacing.length === 0) return { content: [{ type: 'text', text: 'No auto-layout spacing found in the current selection. Select a frame that uses auto-layout.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.selectedSpacing, null, 2) }] };
}
