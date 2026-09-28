import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { restResult, restGetComponentVariants } from '../resolve.js';

export const GET_COMPONENT_VARIANTS = 'get_component_variants';

export const getComponentVariantsDefinition = {
  name: GET_COMPONENT_VARIANTS,
  description:
    'Describes a component (or component set) and every one of its variants: the property definitions (e.g. State, Size) and each variant\'s property values (e.g. State=Hover, Size=Large). Use this to recreate all states — default, hover, disabled, etc. — faithfully in code. Requires FIGMA_ACCESS_TOKEN and a URL with a node-id pointing at the component set.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Figma URL with ?node-id pointing at a component or component set.' },
      id: { type: 'string', description: 'Optional node id, overriding the URL node-id.' },
    },
    required: ['url'],
  },
};

export async function handleGetComponentVariants(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!url) return { content: [{ type: 'text', text: 'Provide a "url" parameter.' }] };
  const id = typeof args.id === 'string' ? args.id : undefined;
  return restResult(() => restGetComponentVariants(url, id));
}
