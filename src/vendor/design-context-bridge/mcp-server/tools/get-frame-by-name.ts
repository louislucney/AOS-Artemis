import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FigmaTreeNode } from '../../core/types.js';
import { store } from '../../figma-bridge/store.js';
import { restResult, restGetFrameByName } from '../../figma-rest/resolve.js';

export const GET_FRAME_BY_NAME = 'get_frame_by_name';

export const getFrameByNameDefinition = {
  name: GET_FRAME_BY_NAME,
  description: 'Finds a frame or layer by name (case-insensitive partial match) and returns its data. To drill into its children, take its id and call get_node_info. Plugin mode (default) searches the live page; pass a "url" to search the whole file over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Name of the frame or layer to find (case-insensitive partial match)' },
      url: { type: 'string', description: 'Optional Figma URL. If provided, searches via REST API instead of the plugin.' },
    },
    required: ['name'],
  },
};

function findNodes(tree: FigmaTreeNode[], query: string): FigmaTreeNode[] {
  const results: FigmaTreeNode[] = [];
  const q = query.toLowerCase();
  for (const node of tree) {
    if (node.name.toLowerCase().includes(q)) results.push(node);
    if (node.children) results.push(...findNodes(node.children, q));
  }
  return results;
}

export async function handleGetFrameByName(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return { content: [{ type: 'text', text: 'Provide a "name" parameter to search for.' }] };

  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) return restResult(() => restGetFrameByName(url, name));

  const ctx = store.getContext();
  if (!ctx) return { content: [{ type: 'text', text: 'No data available. Make sure the Figma Context MCP plugin is running.' }] };

  if (!ctx.currentPage || !ctx.currentPage.tree) return { content: [{ type: 'text', text: 'No page tree yet. Make sure the plugin is connected (green dot) and try again.' }] };

  const results = findNodes(ctx.currentPage.tree, name);
  if (results.length === 0) return { content: [{ type: 'text', text: `No nodes found matching "${name}".` }] };

  return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}
