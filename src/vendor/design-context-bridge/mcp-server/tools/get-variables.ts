import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';
import { restResult, restGetVariables } from '../../figma-rest/resolve.js';

export const GET_VARIABLES = 'get_variables';

export const getVariablesDefinition = {
  name: GET_VARIABLES,
  description: 'Returns all local Figma Variables (design tokens): colors, spacing/sizing (FLOAT), strings and booleans, grouped by collection with their value per mode. Optionally filter by type. Plugin mode (default) reads from the live bridge. REST mode (pass a "url") uses the Variables REST API, which is Enterprise-only — for non-Enterprise files, use extract_design_system instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'], description: 'Optional. Only return variables of this resolved type.' },
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API (Enterprise-only) instead of the plugin.' },
    },
    required: [] as string[],
  },
};

export async function handleGetVariables(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) {
    const type = typeof args.type === 'string' ? args.type : undefined;
    return restResult(() => restGetVariables(url, type));
  }

  const ctx = store.getContext();
  if (!ctx || !ctx.variables) return { content: [{ type: 'text', text: 'No variable data yet. Make sure the plugin is connected (green dot) and try again.' }] };

  let vars = ctx.variables;
  const filter = typeof args.type === 'string' ? args.type.toUpperCase() : '';
  if (filter) vars = vars.filter((v) => v.type === filter);

  if (vars.length === 0) {
    return { content: [{ type: 'text', text: filter ? `No variables of type ${filter} found.` : 'No local variables found in this document.' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(vars, null, 2) }] };
}
