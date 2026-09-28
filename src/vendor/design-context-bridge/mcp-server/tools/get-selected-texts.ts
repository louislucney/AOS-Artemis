import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';

export const GET_SELECTED_TEXTS = 'get_selected_texts';

export const getSelectedTextsDefinition = {
  name: GET_SELECTED_TEXTS,
  description: 'Returns all text nodes (content, font family, font size) found in the selected Figma nodes and all their descendants.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export function handleGetSelectedTexts(): CallToolResult {
  const ctx = store.getContext();
  if (!ctx) return { content: [{ type: 'text', text: 'No data available. Make sure the Figma Context MCP plugin is running.' }] };
  if (ctx.selectedTexts.length === 0) return { content: [{ type: 'text', text: 'No text nodes found in the current selection.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.selectedTexts, null, 2) }] };
}
