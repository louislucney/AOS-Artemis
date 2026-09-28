import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';
import { restResult, restGetAllPages } from '../../figma-rest/resolve.js';

export const GET_ALL_PAGES = 'get_all_pages';

export const getAllPagesDefinition = {
  name: GET_ALL_PAGES,
  description: 'Returns the list of all pages in the Figma document with their IDs and child counts. Plugin mode (default) reads from the live bridge; pass a "url" to read the same data over the REST API instead (no plugin needed).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API instead of the plugin.' },
    },
    required: [] as string[],
  },
};

export async function handleGetAllPages(args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) return restResult(() => restGetAllPages(url));

  const ctx = store.getContext();
  if (!ctx || !ctx.pages) return { content: [{ type: 'text', text: 'No page list yet. Make sure the plugin is connected (green dot) and try again.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.pages, null, 2) }] };
}
