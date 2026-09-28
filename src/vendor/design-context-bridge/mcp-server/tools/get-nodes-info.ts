import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { requestFromPlugin } from '../../figma-bridge/store.js';
import { restResult, restGetNodesInfo } from '../../figma-rest/resolve.js';

export const GET_NODES_INFO = 'get_nodes_info';

export const getNodesInfoDefinition = {
  name: GET_NODES_INFO,
  description: 'Fetches multiple Figma nodes by id in one call. Returns an array of node info. Plugin mode (default) reads from the live bridge; pass a "url" to read the same data over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'List of node ids to fetch.' },
      depth: { type: 'number', description: 'Children depth per node. Default 1.' },
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API instead of the plugin.' },
    },
    required: ['ids'],
  },
};

export async function handleGetNodesInfo(args: Record<string, unknown>): Promise<CallToolResult> {
  const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((x) => typeof x === 'string') : [];
  if (ids.length === 0) return { content: [{ type: 'text', text: 'Provide an "ids" array of node ids.' }] };

  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) return restResult(() => restGetNodesInfo(url, ids));
  const params: Record<string, unknown> = { ids };
  if (typeof args.depth === 'number') params.depth = args.depth;
  const result = await requestFromPlugin(GET_NODES_INFO, params);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
