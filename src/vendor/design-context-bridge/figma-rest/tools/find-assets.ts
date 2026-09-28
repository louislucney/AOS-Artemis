import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { restResult, restFindAssets } from '../resolve.js';

export const FIND_ASSETS = 'find_assets';

export const findAssetsDefinition = {
  name: FIND_ASSETS,
  description:
    'Scans a Figma file for nodes worth exporting as assets: anything with explicit export settings, plus vectors and icon/logo-named layers. Returns ids and suggested filenames ready to pass to export_image. Use this to build an assets/ or icons/ folder from a design. Requires FIGMA_ACCESS_TOKEN.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Figma file URL.' },
    },
    required: ['url'],
  },
};

export async function handleFindAssets(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };
  return restResult(() => restFindAssets(url));
}
