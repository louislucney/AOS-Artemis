import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { restResult, restExportImage } from '../resolve.js';

export const EXPORT_IMAGE = 'export_image';

export const exportImageDefinition = {
  name: EXPORT_IMAGE,
  description:
    'Exports one or more Figma nodes as images. For SVG, the source code is returned inline so you can write it straight to a file (e.g. an assets/ folder). For PNG/JPG, the Figma render URL is returned to download. Use with find_assets to export every icon in a file. Requires FIGMA_ACCESS_TOKEN.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Figma URL. A single node can come from ?node-id=; for several, use "ids".' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Node ids to export. Overrides the URL node-id.' },
      format: { type: 'string', enum: ['svg', 'png', 'jpg'], description: 'Export format. Default svg.' },
      scale: { type: 'number', description: 'Raster scale for png/jpg (1–4). Ignored for svg. Default 2.' },
    },
    required: ['url'],
  },
};

export async function handleExportImage(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };
  const ids = Array.isArray(args.ids) ? (args.ids as unknown[]).filter((x) => typeof x === 'string') as string[] : undefined;
  const format = args.format === 'png' || args.format === 'jpg' ? args.format : 'svg';
  const scale = typeof args.scale === 'number' ? args.scale : 2;
  return restResult(() => restExportImage(url, ids, format, scale));
}
