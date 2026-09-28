import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { requestFromPlugin } from '../../figma-bridge/store.js';
import { restResult, restGetNodeInfo } from '../../figma-rest/resolve.js';

export const GET_NODE_INFO = 'get_node_info';

export const getNodeInfoDefinition = {
  name: GET_NODE_INFO,
  description: 'Fetches a single Figma node by its id and returns its properties plus children up to a given depth. Use this to navigate the whole document: get_all_pages / get_current_page give you ids, then drill into any node by id. Plugin mode (default) reads from the live selection bridge; pass a "url" to read the same data over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'string', description: 'The node id (e.g. "12:345"). Get ids from get_current_page or get_all_pages.' },
      depth: { type: 'number', description: 'How many levels of children to include. Default 2. Keep low for big frames.' },
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API instead of the plugin. The node id can come from the URL (?node-id=) or the "id" param.' },
    },
    required: [] as string[],
  },
};

export async function handleGetNodeInfo(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) {
    const id = typeof args.id === 'string' ? args.id : undefined;
    return restResult(() => restGetNodeInfo(url, id));
  }

  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return { content: [{ type: 'text', text: 'Provide a node "id".' }] };
  const params: Record<string, unknown> = { id };
  if (typeof args.depth === 'number') params.depth = args.depth;
  const result = await requestFromPlugin(GET_NODE_INFO, params);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
