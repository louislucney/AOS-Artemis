import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { restResult, restAnalyzeStructure } from '../resolve.js';

export const ANALYZE_STRUCTURE = 'analyze_structure';

export const analyzeStructureDefinition = {
  name: ANALYZE_STRUCTURE,
  description:
    'Analyzes a Figma file the way a developer planning the build would: lists pages and screens, suggests app routes from screen names, inventories components, and ranks the most-used component instances. Use this to answer "what routes would this app have?", "how should we split the work?", or "which components repeat?". Requires FIGMA_ACCESS_TOKEN. Pass a full file URL.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Figma file URL.' },
    },
    required: ['url'],
  },
};

export async function handleAnalyzeStructure(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };
  return restResult(() => restAnalyzeStructure(url));
}
