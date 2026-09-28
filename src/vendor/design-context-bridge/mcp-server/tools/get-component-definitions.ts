import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';
import { restResult, restGetComponentDefinitions } from '../../figma-rest/resolve.js';

export const GET_COMPONENT_DEFINITIONS = 'get_component_definitions';

export const getComponentDefinitionsDefinition = {
  name: GET_COMPONENT_DEFINITIONS,
  description: 'Returns all component and component set definitions in the Figma file. Plugin mode (default) reads the current page from the live bridge; pass a "url" to read the whole file over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API instead of the plugin.' },
    },
    required: [] as string[],
  },
};

export async function handleGetComponentDefinitions(args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) return restResult(() => restGetComponentDefinitions(url));

  const ctx = store.getContext();
  if (!ctx || !ctx.components) return { content: [{ type: 'text', text: 'No component data yet. Make sure the plugin is connected (green dot) and try again.' }] };
  if (ctx.components.length === 0) return { content: [{ type: 'text', text: 'No components found in the current page.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.components, null, 2) }] };
}
