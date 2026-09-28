import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';

export const GET_CURRENT_SELECTION = 'get_current_selection';

export const getCurrentSelectionDefinition = {
  name: GET_CURRENT_SELECTION,
  description: 'Returns the currently selected elements in the active Figma document.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export function handleGetCurrentSelection(): CallToolResult {
  const ctx = store.getContext();
  if (!ctx) return noData();
  return ok(ctx.selection);
}

function noData(): CallToolResult {
  return { content: [{ type: 'text', text: 'No data available. Make sure the Figma Context MCP plugin is running.' }] };
}

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
