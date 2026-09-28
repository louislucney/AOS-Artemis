import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';

export const GET_SELECTED_INTERACTIONS = 'get_selected_interactions';

export const getSelectedInteractionsDefinition = {
  name: GET_SELECTED_INTERACTIONS,
  description: 'Returns the prototype interactions/animations (node.reactions) of the selected Figma nodes and their descendants: trigger (ON_CLICK, ON_HOVER, AFTER_TIMEOUT...), action, navigation, destination, and transition (SMART_ANIMATE, MOVE_IN, PUSH...) with its duration (seconds) and easing.',
  inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] },
};

export function handleGetSelectedInteractions(): CallToolResult {
  const ctx = store.getContext();
  if (!ctx || !ctx.selectedInteractions) return { content: [{ type: 'text', text: 'No data available. Make sure the plugin is connected (green dot) and a frame is selected.' }] };
  if (ctx.selectedInteractions.length === 0) return { content: [{ type: 'text', text: 'No prototype interactions found in the current selection. Select a node that has prototype connections.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.selectedInteractions, null, 2) }] };
}
