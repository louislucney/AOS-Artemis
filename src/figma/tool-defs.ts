import { z } from "zod";

export interface FigmaToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
}

const url = (text: string) => z.string().describe(text);

/** 20 Figma tools (vendored design-context-bridge surface) with zod input schemas. */
export const FIGMA_TOOLS: FigmaToolDef[] = [
  {
    name: "get_current_selection",
    description: "Returns the currently selected elements in the active Figma document (plugin mode).",
    schema: z.object({})
  },
  {
    name: "get_current_page",
    description:
      "Returns the name and top-level frame list of a Figma page. Plugin mode (default) returns the page currently open in Figma. In REST mode (pass a \"url\") it returns the page containing the URL's node-id, or the first page.",
    schema: z.object({ url: url("Optional Figma URL. If provided, reads via REST API instead of the plugin.").optional() })
  },
  {
    name: "get_all_pages",
    description:
      "Returns the list of all pages in the Figma document with their IDs and child counts. Plugin mode (default) reads from the live bridge; pass a \"url\" to read over the REST API instead.",
    schema: z.object({ url: url("Optional Figma URL. If provided, reads via REST API instead of the plugin.").optional() })
  },
  {
    name: "get_frame_by_name",
    description:
      "Finds a frame or layer by name (case-insensitive partial match) and returns its data. Plugin mode (default) searches the live page; pass a \"url\" to search the whole file over the REST API instead.",
    schema: z.object({
      name: z.string().describe("Name of the frame or layer to find (case-insensitive partial match)"),
      url: url("Optional Figma URL. If provided, searches via REST API instead of the plugin.").optional()
    })
  },
  {
    name: "get_component_definitions",
    description:
      "Returns all component and component set definitions in the Figma file. Plugin mode (default) reads the current page from the live bridge; pass a \"url\" to read the whole file over REST instead.",
    schema: z.object({ url: url("Optional Figma URL. If provided, reads via REST API instead of the plugin.").optional() })
  },
  {
    name: "get_selected_colors",
    description: "Returns all unique fill colors (with hex codes) found in the selected Figma nodes and all their descendants.",
    schema: z.object({})
  },
  {
    name: "get_selected_texts",
    description: "Returns all text nodes (content, font family, font size) found in the selected Figma nodes and all their descendants.",
    schema: z.object({})
  },
  {
    name: "get_variables",
    description:
      "Returns all local Figma Variables (design tokens) grouped by collection with values per mode. Plugin mode (default) reads the live bridge; REST mode (pass a \"url\") uses the Enterprise-only Variables API — for non-Enterprise files use extract_design_system instead.",
    schema: z.object({
      type: z
        .enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"])
        .optional()
        .describe("Optional. Only return variables of this resolved type."),
      url: url("Optional Figma URL. If provided, reads via REST API (Enterprise-only) instead of the plugin.").optional()
    })
  },
  {
    name: "get_selected_spacing",
    description:
      "Returns auto-layout spacing (itemSpacing/gap and padding) for the selected nodes and descendants, including the name of any spacing variable/token bound to each property.",
    schema: z.object({})
  },
  {
    name: "get_selected_interactions",
    description:
      "Returns prototype interactions/animations (trigger, action, destination, transition with duration and easing) of the selected Figma nodes and descendants.",
    schema: z.object({})
  },
  {
    name: "get_node_info",
    description:
      "Fetches a single Figma node by id and returns its properties plus children up to a given depth. Plugin mode (default) reads from the live bridge; pass a \"url\" to read over the REST API instead.",
    schema: z.object({
      id: z.string().optional().describe('The node id (e.g. "12:345"). Get ids from get_current_page or get_all_pages.'),
      depth: z.number().optional().describe("How many levels of children to include. Default 2. Keep low for big frames."),
      url: url("Optional Figma URL. If provided, reads via REST API instead of the plugin. The node id can come from ?node-id= or the \"id\" param.").optional()
    })
  },
  {
    name: "get_nodes_info",
    description:
      "Fetches multiple Figma nodes by id in one call. Returns an array of node info. Plugin mode (default) reads from the live bridge; pass a \"url\" to read over the REST API instead.",
    schema: z.object({
      ids: z.array(z.string()).describe("List of node ids to fetch."),
      depth: z.number().optional().describe("Children depth per node. Default 1."),
      url: url("Optional Figma URL. If provided, reads via REST API instead of the plugin.").optional()
    })
  },
  {
    name: "scan_nodes_by_types",
    description:
      'Scans the document (or a subtree) and returns every node whose type matches the given list — e.g. find all TEXT, COMPONENT, INSTANCE, FRAME nodes. Results capped at 1000. Plugin mode (default) scans the live document; pass a "url" to scan over the REST API instead.',
    schema: z.object({
      types: z
        .array(z.string())
        .describe('Figma node types to match, e.g. ["TEXT","INSTANCE","COMPONENT","FRAME","RECTANGLE","VECTOR"].'),
      rootId: z.string().optional().describe("Optional. Scan only under this node id. Defaults to the whole document."),
      url: url("Optional Figma URL. If provided, scans via REST API instead of the plugin.").optional()
    })
  },
  {
    name: "get_file_from_url",
    description:
      "Fetches a Figma file via the Figma REST API using a figma.com URL. If the URL includes a node-id, returns the full data for that node; otherwise returns the file overview. Requires FIGMA_ACCESS_TOKEN.",
    schema: z.object({
      url: z.string().describe("Figma URL — with or without ?node-id, e.g. https://www.figma.com/design/ABC123/My-File?node-id=123-456")
    })
  },
  {
    name: "get_node_from_url",
    description:
      "Fetches a specific node from a Figma file using a figma.com URL that includes a node-id. Returns the node tree. Requires FIGMA_ACCESS_TOKEN.",
    schema: z.object({
      url: z.string().describe("Figma URL with node-id, e.g. https://www.figma.com/design/ABC123/File?node-id=0-1"),
      node_id: z.string().optional().describe('Optional node id override (e.g. "0:1"). If omitted, the id is read from the URL.')
    })
  },
  {
    name: "extract_design_system",
    description:
      "Reverse-engineers a design system from a Figma file: unique colors (with usage counts), type scale, spacing scale, border radii, and shadows — even without Figma Variables. Requires FIGMA_ACCESS_TOKEN.",
    schema: z.object({
      url: z.string().describe("Figma file URL. Add ?node-id=X-Y to scope extraction to a single frame or section."),
      id: z.string().optional().describe("Optional node id to scope extraction to, overriding the URL node-id.")
    })
  },
  {
    name: "analyze_structure",
    description:
      'Analyzes a Figma file the way a developer planning the build would: lists pages and screens, suggests app routes from screen names, inventories components, and ranks the most-used instances. Requires FIGMA_ACCESS_TOKEN.',
    schema: z.object({
      url: z.string().describe("Figma file URL.")
    })
  },
  {
    name: "get_component_variants",
    description:
      "Describes a component (or component set) and every variant: property definitions (e.g. State, Size) and each variant's values (e.g. State=Hover, Size=Large). Requires FIGMA_ACCESS_TOKEN and a URL with a node-id pointing at the component set.",
    schema: z.object({
      url: z.string().describe("Figma URL with ?node-id pointing at a component or component set."),
      id: z.string().optional().describe("Optional node id, overriding the URL node-id.")
    })
  },
  {
    name: "export_image",
    description:
      "Exports one or more Figma nodes as images. For SVG the source code is returned inline; for PNG/JPG the render URL is returned to download. Use with find_assets. Requires FIGMA_ACCESS_TOKEN.",
    schema: z.object({
      url: z.string().describe('Figma URL. A single node can come from ?node-id=; for several, use "ids".'),
      ids: z.array(z.string()).optional().describe("Node ids to export. Overrides the URL node-id."),
      format: z.enum(["svg", "png", "jpg"]).optional().describe("Export format. Default svg."),
      scale: z.number().optional().describe("Raster scale for png/jpg (1–4). Ignored for svg. Default 2.")
    })
  },
  {
    name: "find_assets",
    description:
      "Scans a Figma file for nodes worth exporting as assets: explicit export settings, vectors, and icon/logo-named layers. Returns ids and suggested filenames for export_image. Requires FIGMA_ACCESS_TOKEN.",
    schema: z.object({
      url: z.string().describe("Figma file URL.")
    })
  }
];

export const FIGMA_TOOL_NAMES = new Set(FIGMA_TOOLS.map((tool) => tool.name));
