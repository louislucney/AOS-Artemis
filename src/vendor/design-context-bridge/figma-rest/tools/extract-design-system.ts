import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { restResult, restExtractDesignSystem } from '../resolve.js';

export const EXTRACT_DESIGN_SYSTEM = 'extract_design_system';

export const extractDesignSystemDefinition = {
  name: EXTRACT_DESIGN_SYSTEM,
  description:
    'Reverse-engineers a design system from a Figma file: unique colors (with usage counts), the type scale (family, size, weight, line height, letter spacing), spacing scale, border radii, and shadows. Use this to generate design tokens even when the designer never defined Figma Variables. Requires FIGMA_ACCESS_TOKEN. Pass a full file URL, or a URL with node-id to scope it to one frame.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Figma file URL. Add ?node-id=X-Y to scope extraction to a single frame or section.' },
      id: { type: 'string', description: 'Optional node id to scope extraction to, overriding the URL node-id.' },
    },
    required: ['url'],
  },
};

export async function handleExtractDesignSystem(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };
  const id = typeof args.id === 'string' ? args.id : undefined;
  return restResult(() => restExtractDesignSystem(url, id));
}
