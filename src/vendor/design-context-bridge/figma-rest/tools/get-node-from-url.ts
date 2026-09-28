import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseFigmaUrl, fetchNodes } from '../client.js';

export const GET_NODE_FROM_URL = 'get_node_from_url';

export const getNodeFromUrlDefinition = {
  name: GET_NODE_FROM_URL,
  description:
    'Fetches a specific node from a Figma file using a figma.com URL that includes a node-id. Returns the node tree. Requires FIGMA_ACCESS_TOKEN in the server environment. Use this when you have a direct link to a frame or component.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description:
          'Figma URL with node-id, e.g. https://www.figma.com/design/ABC123/File?node-id=0-1',
      },
      node_id: {
        type: 'string',
        description: 'Optional node id override (e.g. "0:1"). If omitted, the id is read from the URL.',
      },
    },
    required: ['url'],
  },
};

export async function handleGetNodeFromUrl(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };

  try {
    const { fileKey, nodeId: urlNodeId } = parseFigmaUrl(url);
    const nodeId =
      typeof args.node_id === 'string' ? args.node_id.replace(/-/g, ':') : urlNodeId;

    if (!nodeId) {
      return {
        content: [
          {
            type: 'text',
            text: 'No node-id found in the URL. Either include ?node-id=X-Y in the URL or pass "node_id" explicitly.',
          },
        ],
      };
    }

    const result = (await fetchNodes(fileKey, [nodeId])) as Record<string, unknown>;
    const nodes = result.nodes as Record<string, unknown> | undefined;
    const wrapper = nodes?.[nodeId] as Record<string, unknown> | undefined;

    if (!wrapper) {
      return { content: [{ type: 'text', text: `Node ${nodeId} not found in file ${fileKey}.` }] };
    }

    // The Figma API wraps the node: { document: <actual node>, components: {}, styles: {} }
    // Return the actual node document plus the styles/components maps as context
    const payload = {
      node: wrapper.document,
      styles: wrapper.styles ?? {},
      components: wrapper.components ?? {},
    };

    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] };
  }
}
