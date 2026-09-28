import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { requestFromPlugin } from '../../figma-bridge/store.js';
import { restResult, restScanNodesByTypes } from '../../figma-rest/resolve.js';

export const SCAN_NODES_BY_TYPES = 'scan_nodes_by_types';

export const scanNodesByTypesDefinition = {
  name: SCAN_NODES_BY_TYPES,
  description: 'Scans the document (or a subtree) and returns every node whose type matches the given list — e.g. find all TEXT, COMPONENT, INSTANCE, FRAME nodes. Returns id/name/type so you can then drill in with get_node_info. Results capped at 1000. Plugin mode (default) scans the live document; pass a "url" to scan over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      types: { type: 'array', items: { type: 'string' }, description: 'Figma node types to match, e.g. ["TEXT","INSTANCE","COMPONENT","FRAME","RECTANGLE","VECTOR"].' },
      rootId: { type: 'string', description: 'Optional. Scan only under this node id. Defaults to the whole document.' },
      url: { type: 'string', description: 'Optional Figma URL. If provided, scans via REST API instead of the plugin.' },
    },
    required: ['types'],
  },
};

export async function handleScanNodesByTypes(args: Record<string, unknown>): Promise<CallToolResult> {
  const types = Array.isArray(args.types) ? (args.types as unknown[]).filter((x) => typeof x === 'string') : [];
  if (types.length === 0) return { content: [{ type: 'text', text: 'Provide a "types" array, e.g. ["TEXT","INSTANCE"].' }] };

  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) {
    const rootId = typeof args.rootId === 'string' ? args.rootId : undefined;
    return restResult(() => restScanNodesByTypes(url, types, rootId));
  }
  const params: Record<string, unknown> = { types };
  if (typeof args.rootId === 'string') params.rootId = args.rootId;
  const result = await requestFromPlugin(SCAN_NODES_BY_TYPES, params);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
