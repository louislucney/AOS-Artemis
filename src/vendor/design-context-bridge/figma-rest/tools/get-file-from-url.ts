import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseFigmaUrl, fetchFile, fetchNodes } from '../client.js';

export const GET_FILE_FROM_URL = 'get_file_from_url';

export const getFileFromUrlDefinition = {
  name: GET_FILE_FROM_URL,
  description:
    'Fetches a Figma file via the Figma REST API using a figma.com URL. If the URL includes a node-id (e.g. ?node-id=123-456), returns the full data for that specific node. Otherwise returns the file overview: pages, top-level frames, and metadata. Requires FIGMA_ACCESS_TOKEN.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'Figma URL — with or without ?node-id. e.g. https://www.figma.com/design/ABC123/My-File?node-id=123-456',
      },
    },
    required: ['url'],
  },
};

export async function handleGetFileFromUrl(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };

  try {
    const { fileKey, nodeId } = parseFigmaUrl(url);

    // If the URL has a node-id, return that node's full data directly
    if (nodeId) {
      const result = (await fetchNodes(fileKey, [nodeId])) as Record<string, unknown>;
      const nodes = result.nodes as Record<string, unknown> | undefined;
      const wrapper = nodes?.[nodeId] as Record<string, unknown> | undefined;

      if (!wrapper) {
        return { content: [{ type: 'text', text: `Node ${nodeId} not found in file ${fileKey}.` }] };
      }

      const payload = {
        node: wrapper.document,
        styles: wrapper.styles ?? {},
        components: wrapper.components ?? {},
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }

    // No node-id — return file overview
    const file = (await fetchFile(fileKey)) as Record<string, unknown>;
    const doc = file.document as Record<string, unknown> | undefined;
    const pages = (doc?.children as Array<Record<string, unknown>> | undefined) ?? [];

    const summary = {
      name: file.name,
      lastModified: file.lastModified,
      version: file.version,
      fileKey,
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        childCount: (p.children as unknown[] | undefined)?.length ?? 0,
        frames: ((p.children as Array<Record<string, unknown>> | undefined) ?? [])
          .filter((c) => c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'SECTION')
          .map((c) => ({ id: c.id, name: c.name, type: c.type })),
      })),
    };

    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] };
  }
}
