import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { store } from '../../figma-bridge/store.js';
import { restResult, restGetCurrentPage } from '../../figma-rest/resolve.js';

export const GET_CURRENT_PAGE = 'get_current_page';

export const getCurrentPageDefinition = {
  name: GET_CURRENT_PAGE,
  description: 'Returns the name and top-level frame list of a Figma page. Plugin mode (default) returns the page currently open in Figma. In REST mode (pass a "url") there is no "current" page, so it returns the page containing the URL\'s node-id, or the first page.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Optional Figma URL. If provided, reads via REST API instead of the plugin.' },
    },
    required: [] as string[],
  },
};

export async function handleGetCurrentPage(args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : undefined;
  if (url) return restResult(() => restGetCurrentPage(url));

  const ctx = store.getContext();
  if (!ctx || !ctx.currentPage) return { content: [{ type: 'text', text: 'No page data yet. Make sure the plugin is connected (green dot) and try again.' }] };
  return { content: [{ type: 'text', text: JSON.stringify(ctx.currentPage, null, 2) }] };
}
