import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import { walk, type FigmaNode } from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import type { Runtime } from "../runtime.js";

// ---------------------------------------------------------------------------
// Flow extraction (pure graph builder + tool)
// ---------------------------------------------------------------------------

export interface FlowScreen {
  id: string;
  name: string;
  suggestedRoute: string;
  /** Direct child layer names — used as visible-element hints for assertions. */
  childNames: string[];
  /** First TEXT contents found inside this screen. */
  textHints: string[];
}

export interface FlowEdge {
  from: { id: string; name: string };
  to: { id: string; name: string } | null;
  element: { id: string; name: string; type: string };
  /** First TEXT contents inside the tapped element (locator hints). */
  textHints: string[];
  trigger: string;
  triggerTimeoutMs?: number;
  navigation?: string;
  actionType: string;
  back?: boolean;
}

export interface FlowGraph {
  screens: FlowScreen[];
  edges: FlowEdge[];
  entryScreens: string[];
  unresolvedDestinations: string[];
  /** Nodes carrying prototype interactions within the extracted scope (set by Figma extraction; pen omits it and emits its own warnings). */
  interactionNodes?: number;
}

export interface FlowGraphWarning {
  code: "no-entry" | "unreachable-screens" | "unresolved-destinations" | "no-interactions";
  message: string;
  details?: string[];
}

/** Deterministic structural warnings: these are exactly the ways a flow graph
 * can fail to be an entry→terminal route set, so downstream coverage gates can
 * trust `entryScreens`/reachability. */
export function flowGraphWarnings(graph: FlowGraph): FlowGraphWarning[] {
  const warnings: FlowGraphWarning[] = [];
  if (graph.screens.length > 1 && graph.edges.length === 0) {
    const nodes = graph.interactionNodes ?? 0;
    warnings.push({
      code: "no-interactions",
      message:
        nodes === 0
          ? `${graph.screens.length} 个屏幕未检测到任何原型交互（连线）：无法提取跳转，流程缺少交互信息（需在设计稿补原型连线，或改用 pen / 手工产物）`
          : `检测到 ${nodes} 个节点携带原型交互，但未提取到任何可执行跳转（action 类型可能不受支持）：流程仍为孤岛图`,
      details: graph.screens.slice(0, 10).map((screen) => screen.name)
    });
  }
  if (graph.screens.length > 0 && graph.entryScreens.length === 0) {
    warnings.push({
      code: "no-entry",
      message:
        "原型未识别到入口屏（所有屏幕都有入边）：线性化将回退为任意屏起点（entryFallback），入口→终点路线无法保证"
    });
  }
  if (graph.entryScreens.length > 0) {
    const idByName = new Map(graph.screens.map((screen) => [screen.name, screen.id]));
    const reachable = new Set<string>();
    const queue = graph.entryScreens
      .map((name) => idByName.get(name))
      .filter((id): id is string => typeof id === "string");
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const edge of graph.edges) {
        if (edge.from.id === id && edge.to) queue.push(edge.to.id);
      }
    }
    const unreachable = graph.screens
      .filter((screen) => !reachable.has(screen.id))
      .map((screen) => screen.name);
    if (unreachable.length > 0) {
      warnings.push({
        code: "unreachable-screens",
        message: `${unreachable.length} 个屏幕无法从入口屏到达：这些屏幕不会出现在任何完整流程里`,
        details: unreachable
      });
    }
  }
  if (graph.unresolvedDestinations.length > 0) {
    warnings.push({
      code: "unresolved-destinations",
      message: `${graph.unresolvedDestinations.length} 个跳转目标不在当前解析范围内（跨文件/跨页跳转？）：对应边无目的地`,
      details: [...graph.unresolvedDestinations]
    });
  }
  return warnings;
}

interface RawInteraction {
  trigger?: { type?: string; timeout?: number };
  actions?: Array<Record<string, unknown>>;
}

/** Same slug rules as design-context-bridge's toRoute (kept local: upstream
 * does not export it). */
export function routeFor(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean || clean === "home" || clean === "landing" || clean === "index") return "/";
  return `/${clean}`;
}

/** Build a prototype flow graph from a Figma document tree.
 * Consecutive actions are preserved: every interaction becomes an edge
 * labelled with its element, trigger and navigation. */
export function buildFlowGraph(root: FigmaNode, options: { nodeId?: string } = {}): FlowGraph {
  let scope: FigmaNode | null = null;
  if (options.nodeId) {
    walk(root, (node) => {
      if (node.id === options.nodeId) scope = node;
    });
    if (!scope) throw new Error(`节点 ${options.nodeId} 不在文件中`);
  } else {
    scope = root;
  }
  const scopeRoot: FigmaNode = scope;

  const byId = new Map<string, FigmaNode>();
  const parentOf = new Map<string, string>();
  walk(scopeRoot, (node) => {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child.id, node.id);
  });

  const screenOf = (id: string): FigmaNode | null => {
    let current = byId.get(id);
    if (!current) return null;
    for (;;) {
      const parentId = parentOf.get(current.id);
      if (!parentId) return current.type === "PAGE" ? null : current;
      const parent = byId.get(parentId);
      if (!parent) return current;
      if (parent.type === "PAGE") return current;
      current = parent;
    }
  };

  const edges: FlowEdge[] = [];
  const unresolved = new Set<string>();
  const elementTextHints = new Map<string, string[]>();
  const sources: Array<{ node: FigmaNode; interactions: RawInteraction[] }> = [];
  walk(scopeRoot, (node) => {
    const interactions = (node as { interactions?: RawInteraction[] }).interactions;
    if (Array.isArray(interactions) && interactions.length > 0) {
      sources.push({ node, interactions });
      elementTextHints.set(node.id, collectTextHints(node, 3));
    }
  });

  for (const { node, interactions } of sources) {
    const fromScreen = screenOf(node.id);
    for (const interaction of interactions) {
      const trigger = interaction.trigger?.type ?? "UNKNOWN";
      const timeout =
        typeof interaction.trigger?.timeout === "number" ? interaction.trigger.timeout : undefined;
      for (const action of interaction.actions ?? []) {
        const actionType = String(action.type ?? "UNKNOWN");
        let to: FigmaNode | null = null;
        let navigation: string | undefined;
        let back = false;
        if (actionType === "NODE") {
          navigation = typeof action.navigation === "string" ? action.navigation : undefined;
          const destinationId =
            typeof action.destinationId === "string" ? action.destinationId : undefined;
          if (navigation === "BACK") {
            back = true;
            to = fromScreen;
          } else if (destinationId) {
            const destination = byId.get(destinationId);
            if (destination) to = screenOf(destination.id);
            else unresolved.add(destinationId);
          }
        }
        edges.push({
          from: fromScreen
            ? { id: fromScreen.id, name: fromScreen.name }
            : { id: node.id, name: node.name },
          to: to ? { id: to.id, name: to.name } : null,
          element: { id: node.id, name: node.name, type: node.type },
          textHints: elementTextHints.get(node.id) ?? [],
          trigger,
          ...(timeout !== undefined ? { triggerTimeoutMs: timeout } : {}),
          ...(navigation ? { navigation } : {}),
          ...(back ? { back: true } : {}),
          actionType
        });
      }
    }
  }

  const screenNodes: FigmaNode[] = [];
  walk(scopeRoot, (node) => {
    if (node.type === "PAGE") screenNodes.push(...(node.children ?? []));
  });
  if (screenNodes.length === 0 && scopeRoot.type !== "DOCUMENT" && scopeRoot.type !== "PAGE") {
    screenNodes.push(scopeRoot);
  }

  const screenTextHints = new Map<string, string[]>();
  for (const node of byId.values()) {
    if (node.type !== "TEXT") continue;
    const characters = (node as { characters?: unknown }).characters;
    if (typeof characters !== "string" || characters.trim() === "") continue;
    const screen = screenOf(node.id);
    if (!screen) continue;
    const list = screenTextHints.get(screen.id) ?? [];
    if (list.length < 3 && !list.includes(characters.trim())) {
      list.push(characters.trim());
      screenTextHints.set(screen.id, list);
    }
  }

  const screens: FlowScreen[] = screenNodes.map((screen) => ({
    id: screen.id,
    name: screen.name,
    suggestedRoute: routeFor(screen.name),
    childNames: (screen.children ?? []).slice(0, 10).map((child) => child.name),
    textHints: screenTextHints.get(screen.id) ?? []
  }));

  const incoming = new Set(edges.filter((edge) => edge.to).map((edge) => edge.to!.id));
  return {
    screens,
    edges,
    entryScreens: screens.filter((screen) => !incoming.has(screen.id)).map((screen) => screen.name),
    unresolvedDestinations: [...unresolved],
    interactionNodes: sources.length
  };
}

function collectTextHints(node: FigmaNode, limit: number): string[] {
  const hints: string[] = [];
  walk(node, (candidate) => {
    if (hints.length >= limit || candidate.type !== "TEXT") return;
    const characters = (candidate as { characters?: unknown }).characters;
    if (typeof characters !== "string") return;
    const text = characters.trim();
    if (text !== "" && !hints.includes(text)) hints.push(text);
  });
  return hints;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

const TOKEN_HINT =
  "提示：REST 模式需要 FIGMA_ACCESS_TOKEN（项目 .env 或调用 aos_configure 携带 figmaToken）。";

export interface ExtractFlowsArgs {
  url: string;
  nodeId?: string;
  save?: boolean;
}

export async function figmaExtractFlows(
  runtime: Runtime,
  args: ExtractFlowsArgs
): Promise<CallToolResult> {
  try {
    const { fileKey } = parseFigmaUrl(args.url);
    const file = (await fetchFile(fileKey)) as {
      name?: string;
      version?: unknown;
      lastModified?: unknown;
      document?: FigmaNode;
    };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);

    const graph = buildFlowGraph(file.document, { nodeId: args.nodeId });
    const warnings = flowGraphWarnings(graph);
    const fileVersion = typeof file.version === "string" ? file.version : null;
    const lastModified = typeof file.lastModified === "string" ? file.lastModified : null;
    const payload: Record<string, unknown> = {
      ok: true,
      fileKey,
      fileName: file.name ?? null,
      ...(fileVersion !== null ? { fileVersion } : {}),
      ...(lastModified !== null ? { lastModified } : {}),
      counts: {
        screens: graph.screens.length,
        edges: graph.edges.length,
        entryScreens: graph.entryScreens.length,
        unresolved: graph.unresolvedDestinations.length,
        interactionNodes: graph.interactionNodes ?? 0,
        warnings: warnings.length
      },
      warnings,
      ...graph
    };

    if (args.save !== false) {
      const savedTo = path.join(runtime.configDirAbs, "design", "flows.json");
      writeFileAtomic(savedTo, JSON.stringify(payload, null, 2) + "\n");
      payload.savedTo = savedTo;
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult({ ok: false, error: `流程图解析失败: ${errorMessage(error)}`, hint: TOKEN_HINT }, true);
  }
}
