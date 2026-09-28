import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseFigmaUrl, fetchFile, fetchNodes, fetchLocalVariables, fetchImages, downloadText } from './client.js';
import { extractDesignSystem, analyzeStructure, describeComponentVariants } from './analysis.js';

/** Run a REST resolver and wrap its result (or error) as a CallToolResult. */
export async function restResult(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `REST error: ${(err as Error).message}` }] };
  }
}

/** Minimal shape of a Figma node — only the fields we traverse. */
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

/** Depth-first walk over a node tree, invoking `visit` on every node. */
export function walk(node: FigmaNode, visit: (n: FigmaNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** Fetch a file and return its document root (full tree). */
async function getDocument(fileKey: string): Promise<FigmaNode> {
  const file = (await fetchFile(fileKey)) as { document?: FigmaNode };
  if (!file.document) throw new Error(`File ${fileKey} returned no document.`);
  return file.document;
}

/** Resolve a single node's full data via the nodes endpoint. */
async function getNodeDocument(fileKey: string, nodeId: string): Promise<FigmaNode | undefined> {
  const result = (await fetchNodes(fileKey, [nodeId])) as {
    nodes?: Record<string, { document?: FigmaNode } | undefined>;
  };
  return result.nodes?.[nodeId]?.document;
}

/**
 * REST equivalent of get_all_pages: pages with id, name and child count —
 * the same shape the plugin pushes.
 */
export async function restGetAllPages(url: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const file = (await fetchFile(fileKey, 1)) as { document?: FigmaNode };
  const pages = file.document?.children ?? [];
  return pages.map((p) => ({ id: p.id, name: p.name, childCount: p.children?.length ?? 0 }));
}

/**
 * REST equivalent of get_current_page. REST has no "current" page, so we use
 * the page that contains the URL's node-id, or the first page otherwise.
 */
export async function restGetCurrentPage(url: string): Promise<unknown> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const root = await getDocument(fileKey);
  const pages = root.children ?? [];

  let page = pages[0];
  if (nodeId) {
    page = pages.find((p) => {
      let found = false;
      walk(p, (n) => { if (n.id === nodeId) found = true; });
      return found;
    }) ?? pages[0];
  }
  if (!page) return { error: 'No pages found in file.' };

  return {
    id: page.id,
    name: page.name,
    children: (page.children ?? []).map((c) => ({ id: c.id, name: c.name, type: c.type })),
  };
}

/** REST equivalent of get_frame_by_name: case-insensitive partial match. */
export async function restGetFrameByName(url: string, name: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const root = await getDocument(fileKey);
  const needle = name.toLowerCase();
  const matches: FigmaNode[] = [];
  walk(root, (n) => {
    if (n.name?.toLowerCase().includes(needle)) matches.push(n);
  });
  if (matches.length === 0) return { error: `No node matching "${name}" found.` };
  // Return the first match in full, plus a short list of other matches.
  const [first, ...rest] = matches;
  return {
    match: first,
    otherMatches: rest.slice(0, 20).map((n) => ({ id: n.id, name: n.name, type: n.type })),
  };
}

/** REST equivalent of get_component_definitions: all COMPONENT / COMPONENT_SET nodes. */
export async function restGetComponentDefinitions(url: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const root = await getDocument(fileKey);
  const components: Array<{ id: string; name: string; type: string; pageName: string }> = [];
  for (const page of root.children ?? []) {
    walk(page, (n) => {
      if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') {
        components.push({ id: n.id, name: n.name, type: n.type, pageName: page.name });
      }
    });
  }
  if (components.length === 0) return { error: 'No components found in this file.' };
  return components;
}

/** REST equivalent of get_node_info: a node plus its styles/components context. */
export async function restGetNodeInfo(url: string, idOverride?: string): Promise<unknown> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const targetId = idOverride ?? nodeId;
  if (!targetId) {
    return { error: 'No node-id in URL. Include ?node-id=X-Y or pass an explicit id.' };
  }
  const node = await getNodeDocument(fileKey, targetId);
  if (!node) return { error: `Node ${targetId} not found in file ${fileKey}.` };
  return node;
}

/** REST equivalent of get_nodes_info: multiple nodes in one call. */
export async function restGetNodesInfo(url: string, ids: string[]): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const result = (await fetchNodes(fileKey, ids)) as {
    nodes?: Record<string, { document?: FigmaNode } | undefined>;
  };
  return ids.map((id) => ({ id, node: result.nodes?.[id]?.document ?? null }));
}

/**
 * REST equivalent of get_variables. The Figma Variables REST API is
 * Enterprise-only, so on a 403 we explain that and point to extract_design_system.
 */
export async function restGetVariables(url: string, typeFilter?: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  let payload: { meta?: { variables?: Record<string, Record<string, unknown>> } };
  try {
    payload = (await fetchLocalVariables(fileKey)) as typeof payload;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('403')) {
      return {
        error: 'The Figma Variables REST API is only available on Enterprise plans.',
        hint: 'If you are not on Enterprise, use extract_design_system to derive tokens (colors, type scale, spacing) directly from the design instead.',
      };
    }
    throw err;
  }

  const all = Object.values(payload.meta?.variables ?? {});
  const filter = typeFilter ? typeFilter.toUpperCase() : '';
  const vars = filter ? all.filter((v) => (v as { resolvedType?: string }).resolvedType === filter) : all;
  if (vars.length === 0) {
    return { message: filter ? `No variables of type ${filter} found.` : 'No local variables found in this file.' };
  }
  return vars;
}

/** REST equivalent of scan_nodes_by_types: every node whose type is in `types`. */
export async function restScanNodesByTypes(
  url: string,
  types: string[],
  rootId?: string,
): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const wanted = new Set(types);

  let scanRoot: FigmaNode;
  if (rootId) {
    const node = await getNodeDocument(fileKey, rootId);
    if (!node) return { error: `Root node ${rootId} not found.` };
    scanRoot = node;
  } else {
    scanRoot = await getDocument(fileKey);
  }

  const found: Array<{ id: string; name: string; type: string }> = [];
  walk(scanRoot, (n) => {
    if (wanted.has(n.type) && found.length < 1000) {
      found.push({ id: n.id, name: n.name, type: n.type });
    }
  });
  return { count: found.length, capped: found.length >= 1000, nodes: found };
}

/** Pick the analysis root: a specific node when given/in the URL, else the whole file. */
async function getAnalysisRoot(url: string, idOverride?: string): Promise<FigmaNode> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const targetId = idOverride ?? nodeId;
  if (targetId) {
    const node = await getNodeDocument(fileKey, targetId);
    if (!node) throw new Error(`Node ${targetId} not found in file ${fileKey}.`);
    return node;
  }
  return getDocument(fileKey);
}

/** Derive a design system (colors, type, spacing, radii, shadows) from a URL. */
export async function restExtractDesignSystem(url: string, idOverride?: string): Promise<unknown> {
  return extractDesignSystem(await getAnalysisRoot(url, idOverride));
}

/** Analyze structure (pages, screens, routes, components) from a URL. */
export async function restAnalyzeStructure(url: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  return analyzeStructure(await getDocument(fileKey));
}

/** Describe a component and its variants from a URL with a node-id. */
export async function restGetComponentVariants(url: string, idOverride?: string): Promise<unknown> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const targetId = idOverride ?? nodeId;
  if (!targetId) {
    return { error: 'Provide a component node id — in the URL (?node-id=) or as "id".' };
  }
  const node = await getNodeDocument(fileKey, targetId);
  if (!node) return { error: `Node ${targetId} not found in file ${fileKey}.` };
  return describeComponentVariants(node);
}

/** Turn a layer name into a safe asset filename (without extension). */
function toFilename(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'asset';
}

/**
 * Export nodes as images. For SVG the source is inlined (ready to write to a
 * file); for png/jpg the Figma render URL is returned (download it client-side).
 */
export async function restExportImage(
  url: string,
  ids: string[] | undefined,
  format: 'svg' | 'png' | 'jpg',
  scale: number,
): Promise<unknown> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const targetIds = ids && ids.length > 0 ? ids : nodeId ? [nodeId] : [];
  if (targetIds.length === 0) {
    return { error: 'Provide node ids — in "ids", or a single one via the URL ?node-id=.' };
  }

  const { images, err } = await fetchImages(fileKey, targetIds, format, scale);
  if (err) return { error: `Figma image export error: ${err}` };

  // Resolve names for nice filenames (one nodes call covers all targets).
  const nodesResult = (await fetchNodes(fileKey, targetIds)) as {
    nodes?: Record<string, { document?: FigmaNode } | undefined>;
  };

  const assets = await Promise.all(
    targetIds.map(async (id) => {
      const name = nodesResult.nodes?.[id]?.document?.name ?? id;
      const renderUrl = images[id];
      const base = { id, name, filename: `${toFilename(name)}.${format}` };
      if (!renderUrl) return { ...base, error: 'No render produced for this node.' };
      if (format === 'svg') {
        try {
          return { ...base, format, svg: await downloadText(renderUrl) };
        } catch (e) {
          return { ...base, format, url: renderUrl, note: `Inline failed: ${(e as Error).message}` };
        }
      }
      return { ...base, format, url: renderUrl, scale };
    }),
  );

  return { count: assets.length, assets };
}

const ICON_NAME = /\b(icon|ic|logo|glyph)\b/i;

/**
 * Find nodes worth exporting as assets: anything with explicit export settings,
 * plus vectors and icon/logo-named nodes. Returns ids ready for export_image.
 */
export async function restFindAssets(url: string): Promise<unknown> {
  const { fileKey } = parseFigmaUrl(url);
  const root = await getDocument(fileKey);
  const assets: Array<{ id: string; name: string; type: string; suggestedFilename: string; reason: string }> = [];
  const seen = new Set<string>();

  walk(root, (n) => {
    if (seen.has(n.id)) return;
    const exportSettings = (n as { exportSettings?: unknown[] }).exportSettings;
    let reason = '';
    if (Array.isArray(exportSettings) && exportSettings.length > 0) reason = 'has export settings';
    else if (n.type === 'VECTOR') reason = 'vector';
    else if ((n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'FRAME') && ICON_NAME.test(n.name)) {
      reason = 'icon/logo by name';
    }
    if (reason) {
      seen.add(n.id);
      assets.push({ id: n.id, name: n.name, type: n.type, suggestedFilename: `${toFilename(n.name)}.svg`, reason });
    }
  });

  return { count: assets.length, assets };
}
