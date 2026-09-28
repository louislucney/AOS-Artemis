import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { fetchFile, parseFigmaUrl } from "../vendor/design-context-bridge/figma-rest/client.js";
import {
  restExtractDesignSystem,
  restFindAssets,
  walk,
  type FigmaNode
} from "../vendor/design-context-bridge/figma-rest/resolve.js";
import { detectProjectStacks, formatAssetFilename, primaryProfile, type StackProfile } from "../projects/stack.js";
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
    unresolvedDestinations: [...unresolved]
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
    const file = (await fetchFile(fileKey)) as { name?: string; document?: FigmaNode };
    if (!file.document) throw new Error(`文件 ${fileKey} 没有 document 数据`);

    const graph = buildFlowGraph(file.document, { nodeId: args.nodeId });
    const payload: Record<string, unknown> = {
      ok: true,
      fileKey,
      fileName: file.name ?? null,
      counts: {
        screens: graph.screens.length,
        edges: graph.edges.length,
        entryScreens: graph.entryScreens.length,
        unresolved: graph.unresolvedDestinations.length
      },
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

// ---------------------------------------------------------------------------
// Project scan + gap analysis
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".artemis",
  ".artemis-deps",
  ".venv",
  "vendor",
  ".next",
  ".nuxt",
  "coverage",
  "Pods"
]);

const DEFAULT_ASSET_GLOBS = ["**/*.svg", "**/*.png", "**/*.webp", "**/*.jpg", "**/*.jpeg", "**/*.gif"];
const DEFAULT_TOKEN_GLOBS = [
  "**/tokens.json",
  "**/tokens.css",
  "**/theme.json",
  "**/theme.css",
  "**/variables.css",
  "**/colors.json"
];

export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        out += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export function walkProjectFiles(rootDir: string, globs: string[], limit = 8000): string[] {
  const regexes = globs.map(globToRegExp);
  const results: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && results.length < limit) {
    const relative = stack.pop()!;
    const absolute = path.join(rootDir, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(childRelative);
        continue;
      }
      if (regexes.some((regex) => regex.test(childRelative))) results.push(childRelative);
    }
  }
  return results.sort();
}

export function readTokenContents(
  rootDir: string,
  files: string[],
  maxFileBytes = 512 * 1024,
  maxFiles = 50
): string[] {
  const contents: string[] = [];
  for (const file of files.slice(0, maxFiles)) {
    try {
      const raw = fs.readFileSync(path.join(rootDir, file), "utf-8");
      if (raw.includes("\u0000")) continue; // binary
      contents.push(raw.slice(0, maxFileBytes));
    } catch {
      /* skip unreadable */
    }
  }
  return contents;
}

export function normalizeAssetName(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  );
}

const ICON_SUFFIXES = ["-icon", "-ic", "-logo", "-glyph"];

export interface GapInput {
  designAssets: Array<{ id?: string; name: string; suggestedFilename?: string }>;
  designColors: string[];
  projectAssetPaths: string[];
  tokenContents?: string[];
}

export interface GapResult {
  missingAssets: Array<{
    name: string;
    slug: string;
    suggestedFilename: string;
    figmaId?: string;
  }>;
  existingAssets: Array<{ name: string; matchedPath: string }>;
  missingColors: string[];
  colorsChecked: boolean;
  projectAssetCount: number;
}

function expandHex(hex: string): string {
  const body = hex.replace("#", "");
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`.toUpperCase();
  }
  return `#${body}`.toUpperCase();
}

export function analyzeGapData(input: GapInput): GapResult {
  const projectBySlug = new Map<string, string>();
  for (const assetPath of input.projectAssetPaths) {
    const base = assetPath.split("/").pop() ?? assetPath;
    projectBySlug.set(normalizeAssetName(base), assetPath);
  }

  const candidatesFor = (slug: string): string[] => {
    const candidates = new Set<string>([slug]);
    for (const suffix of ICON_SUFFIXES) {
      candidates.add(slug.endsWith(suffix) ? slug.slice(0, -suffix.length) : `${slug}${suffix}`);
    }
    return [...candidates];
  };

  const missingAssets: GapResult["missingAssets"] = [];
  const existingAssets: GapResult["existingAssets"] = [];
  for (const asset of input.designAssets) {
    const fileSlug = normalizeAssetName(asset.suggestedFilename ?? asset.name);
    const nameSlug = normalizeAssetName(asset.name);
    const slugs = new Set([...candidatesFor(fileSlug), ...candidatesFor(nameSlug)]);
    let matched: string | undefined;
    for (const slug of slugs) {
      const hit = projectBySlug.get(slug);
      if (hit) {
        matched = hit;
        break;
      }
    }
    if (matched) {
      existingAssets.push({ name: asset.name, matchedPath: matched });
    } else {
      missingAssets.push({
        name: asset.name,
        slug: fileSlug,
        suggestedFilename: asset.suggestedFilename ?? `${fileSlug}.svg`,
        figmaId: asset.id
      });
    }
  }

  const colorsChecked = Array.isArray(input.tokenContents) && input.tokenContents.length > 0;
  const projectColors = new Set<string>();
  if (colorsChecked) {
    for (const text of input.tokenContents!) {
      for (const match of text.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
        projectColors.add(expandHex(match[0]));
      }
    }
  }
  const designColorSet = new Set(input.designColors.map((color) => color.toUpperCase()));
  const missingColors = colorsChecked
    ? [...designColorSet].filter((color) => !projectColors.has(color))
    : [];

  return {
    missingAssets,
    existingAssets,
    missingColors,
    colorsChecked,
    projectAssetCount: input.projectAssetPaths.length
  };
}

export interface GapAnalysisArgs {
  url: string;
  id?: string;
  assetGlobs?: string[];
  tokenFiles?: string[];
  save?: boolean;
}

/** Re-target missing-asset filenames to the project's stack naming rules
 * (Android: ic_home.svg, Flutter: home_icon.svg, RN/Web: home-icon.svg).
 * The Figma-suggested name is preserved as `figmaSuggestedFilename`. */
export function applyAssetNaming(
  missing: GapResult["missingAssets"],
  profile: StackProfile | null
): Array<
  GapResult["missingAssets"][number] & {
    figmaSuggestedFilename: string;
    suggestedDir: string | null;
    namingNote: string | null;
  }
> {
  return missing.map((asset) => ({
    ...asset,
    figmaSuggestedFilename: asset.suggestedFilename,
    suggestedFilename: formatAssetFilename(asset.slug || asset.name, profile, "svg"),
    suggestedDir: profile?.naming.assets.preferredDir ?? null,
    namingNote: profile?.naming.assets.note ?? null
  }));
}

export async function figmaGapAnalysis(
  runtime: Runtime,
  args: GapAnalysisArgs
): Promise<CallToolResult> {
  try {
    const designAssets = (await restFindAssets(args.url)) as {
      count: number;
      assets: Array<{ id: string; name: string; suggestedFilename?: string; reason?: string }>;
    };
    const designSystem = (await restExtractDesignSystem(args.url, args.id)) as {
      colors?: Array<{ hex: string; usageCount?: number }>;
    };

    // Scanner rules follow the project's detected stack unless overridden.
    const stacks = detectProjectStacks(runtime.project.rootDir);
    const profile = primaryProfile(stacks);
    const assetGlobs = args.assetGlobs?.length
      ? args.assetGlobs
      : (profile?.assetGlobs ?? DEFAULT_ASSET_GLOBS);
    const tokenGlobs = args.tokenFiles?.length
      ? args.tokenFiles
      : (profile?.tokenGlobs ?? DEFAULT_TOKEN_GLOBS);
    const projectAssets = walkProjectFiles(runtime.project.rootDir, assetGlobs);
    const tokenContents = readTokenContents(
      runtime.project.rootDir,
      walkProjectFiles(runtime.project.rootDir, tokenGlobs)
    );

    const gap = analyzeGapData({
      designAssets: designAssets.assets ?? [],
      designColors: (designSystem.colors ?? []).map((color) => color.hex),
      projectAssetPaths: projectAssets,
      tokenContents
    });

    const payload: Record<string, unknown> = {
      ok: true,
      sourceUrl: args.url,
      design: {
        assets: designAssets.count ?? designAssets.assets?.length ?? 0,
        colors: designSystem.colors?.length ?? 0
      },
      detectedStacks: stacks,
      rules: profile
        ? {
            stack: profile.id,
            displayName: profile.displayName,
            assetGlobs,
            tokenGlobs,
            locatorRules: profile.locatorRules,
            codeRules: profile.codeRules
          }
        : { stack: null, assetGlobs, tokenGlobs },
      project: {
        assetGlobs,
        scannedAssets: gap.projectAssetCount,
        tokenGlobs,
        tokenFilesRead: tokenContents.length
      },
      summary: {
        missingAssets: gap.missingAssets.length,
        existingAssets: gap.existingAssets.length,
        missingColors: gap.colorsChecked ? gap.missingColors.length : "not-checked (no token files matched)"
      },
      missingAssets: applyAssetNaming(gap.missingAssets, profile),
      existingAssets: gap.existingAssets,
      missingColors: gap.missingColors,
      colorsChecked: gap.colorsChecked
    };

    if (args.save !== false) {
      const savedTo = path.join(runtime.configDirAbs, "design", "gaps.json");
      writeFileAtomic(savedTo, JSON.stringify(payload, null, 2) + "\n");
      payload.savedTo = savedTo;
    }
    return jsonResult(payload);
  } catch (error) {
    return jsonResult(
      { ok: false, error: `缺口分析失败: ${errorMessage(error)}`, hint: TOKEN_HINT },
      true
    );
  }
}
