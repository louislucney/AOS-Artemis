import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isGenericLayerName } from "../figma/color.js";
import {
  detectProjectStacks,
  formatComponentFileName,
  primaryProfile,
  toCase,
  type StackProfile
} from "../projects/stack.js";
import type { Runtime } from "../runtime.js";
import { errorMessage, writeFileAtomic } from "../util.js";

export const SCREEN_MAP_FILE = "screen-map.json";
export const SCREEN_MAP_VERSION = 1;

export interface ScreenMapEntry {
  design: { screen?: string; nodeId?: string; component?: string };
  code: { route?: string; component?: string; file?: string };
  source?: "proposed" | "manual";
  confidence?: number;
}

export interface ScreenMapFile {
  version: number;
  entries: ScreenMapEntry[];
  corrupt?: boolean;
}

export interface ProposeResult {
  buildBrief: boolean;
  error?: string;
  candidates: ScreenMapEntry[];
  unmatched: Array<{ design: string; reason: string }>;
}

function entryKey(entry: ScreenMapEntry): string {
  return JSON.stringify([entry.design.screen ?? "", entry.design.nodeId ?? "", entry.design.component ?? ""]);
}

function normalizeEntry(value: unknown): ScreenMapEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const design = record.design as Record<string, unknown> | undefined;
  const code = record.code as Record<string, unknown> | undefined;
  if (!design || typeof design !== "object") return null;
  const screen = typeof design.screen === "string" && design.screen.trim() !== "" ? design.screen.trim() : undefined;
  const designComponent =
    typeof design.component === "string" && design.component.trim() !== "" ? design.component.trim() : undefined;
  if (!screen && !designComponent) return null;
  if (!code || typeof code !== "object") return null;
  const route = typeof code.route === "string" && code.route.trim() !== "" ? code.route.trim() : undefined;
  const component = typeof code.component === "string" && code.component.trim() !== "" ? code.component.trim() : undefined;
  const file = typeof code.file === "string" && code.file.trim() !== "" ? code.file.trim() : undefined;
  if (!route && !component && !file) return null;
  const entry: ScreenMapEntry = {
    design: {
      ...(screen ? { screen } : {}),
      ...(typeof design.nodeId === "string" && design.nodeId ? { nodeId: design.nodeId } : {}),
      ...(designComponent ? { component: designComponent } : {})
    },
    code: { ...(route ? { route } : {}), ...(component ? { component } : {}), ...(file ? { file } : {}) }
  };
  if (record.source === "manual" || record.source === "proposed") entry.source = record.source;
  if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) entry.confidence = record.confidence;
  return entry;
}

export function parseScreenMap(text: string): ScreenMapFile {
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(normalizeEntry).filter((entry): entry is ScreenMapEntry => entry !== null)
      : [];
    return { version: typeof parsed.version === "number" ? parsed.version : SCREEN_MAP_VERSION, entries };
  } catch {
    return { version: SCREEN_MAP_VERSION, entries: [] };
  }
}

export function serializeScreenMap(map: ScreenMapFile): string {
  const entries = [...map.entries]
    .map(normalizeEntry)
    .filter((entry): entry is ScreenMapEntry => entry !== null)
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  const lines = [`{`, `  "version": ${SCREEN_MAP_VERSION},`, `  "entries": [`];
  entries.forEach((entry, index) => {
    const record: Record<string, unknown> = { design: entry.design, code: entry.code };
    if (entry.source) record.source = entry.source;
    if (entry.confidence !== undefined) record.confidence = entry.confidence;
    lines.push(`    ${JSON.stringify(record)}${index === entries.length - 1 ? "" : ","}`);
  });
  lines.push("  ]", "}", "");
  return lines.join("\n");
}

export function screenMapFilePath(configDirAbs: string): string {
  return path.join(configDirAbs, "design", SCREEN_MAP_FILE);
}

export function loadScreenMap(configDirAbs: string): ScreenMapFile {
  const file = screenMapFilePath(configDirAbs);
  if (!fs.existsSync(file)) return { version: SCREEN_MAP_VERSION, entries: [] };
  const text = fs.readFileSync(file, "utf-8");
  const map = parseScreenMap(text);
  const corrupt = text.trim() !== "" && map.entries.length === 0;
  return corrupt ? { ...map, corrupt: true } : map;
}

export function saveScreenMap(configDirAbs: string, map: ScreenMapFile): { action: "written" | "unchanged"; file: string } {
  const file = screenMapFilePath(configDirAbs);
  const content = serializeScreenMap(map);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  if (existing === content) return { action: "unchanged", file };
  writeFileAtomic(file, content);
  return { action: "written", file };
}

export function proposeScreenMapEntries(configDirAbs: string, profile: StackProfile | null): ProposeResult {
  const briefPath = path.join(configDirAbs, "design", "build-brief.json");
  if (!fs.existsSync(briefPath)) return { buildBrief: false, candidates: [], unmatched: [] };
  let parsed: {
    brief?: {
      screens?: Array<{ name?: string; suggestedRoute?: string }>;
      components?: Array<{ name?: string; type?: string }>;
      stack?: { componentDir?: string };
    };
  };
  try {
    parsed = JSON.parse(fs.readFileSync(briefPath, "utf-8")) as typeof parsed;
  } catch {
    return { buildBrief: false, error: "build-brief.json 无法解析", candidates: [], unmatched: [] };
  }
  const componentDir =
    parsed.brief?.stack?.componentDir ?? profile?.naming.componentFile.preferredDir ?? "src/components";
  const candidates: ScreenMapEntry[] = [];
  const unmatched: Array<{ design: string; reason: string }> = [];

  const push = (entry: ScreenMapEntry): void => {
    if (candidates.some((candidate) => entryKey(candidate) === entryKey(entry))) return;
    candidates.push(entry);
  };

  for (const screen of parsed.brief?.screens ?? []) {
    const name = typeof screen.name === "string" ? screen.name.trim() : "";
    if (!name || isGenericLayerName(name)) {
      unmatched.push({ design: name || "(未命名屏幕)", reason: "名称过泛，无法推导代码落点" });
      continue;
    }
    const componentName = toCase(`${name} Screen`, "pascal");
    push({
      design: { screen: name },
      code: {
        ...(typeof screen.suggestedRoute === "string" && screen.suggestedRoute ? { route: screen.suggestedRoute } : {}),
        component: componentName,
        file: path.posix.join(componentDir, formatComponentFileName(`${name} screen`, profile))
      },
      source: "proposed",
      confidence: 0.6
    });
  }

  for (const component of parsed.brief?.components ?? []) {
    const name = typeof component.name === "string" ? component.name.trim() : "";
    if (!name || isGenericLayerName(name)) {
      unmatched.push({ design: name || "(未命名组件)", reason: "名称过泛，只能人工指定目标文件" });
      continue;
    }
    push({
      design: { component: name },
      code: {
        component: toCase(name, "pascal"),
        file: path.posix.join(componentDir, formatComponentFileName(name, profile))
      },
      source: "proposed",
      confidence: 0.5
    });
  }
  return { buildBrief: true, candidates, unmatched };
}

export interface ScreenMapArgs {
  action: "list" | "propose" | "save";
  entries?: unknown[];
  merge?: boolean;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

export async function screenMap(runtime: Runtime, args: ScreenMapArgs): Promise<CallToolResult> {
  try {
    const file = screenMapFilePath(runtime.configDirAbs);
    if (args.action === "list") {
      const map = loadScreenMap(runtime.configDirAbs);
      return jsonResult({
        ok: true,
        version: map.version,
        file,
        entries: map.entries,
        ...(map.corrupt ? { corrupt: true } : {}),
        hint: map.corrupt
          ? "screen-map.json 无法解析（已按空表处理）；修复或删除后重试。"
          : map.entries.length === 0
            ? '映射为空：先运行 screen_map(action:"propose") 生成候选，再由 agent 复核后 save。'
            : undefined
      });
    }
    if (args.action === "propose") {
      const profile = primaryProfile(detectProjectStacks(runtime.project.rootDir));
      const proposal = proposeScreenMapEntries(runtime.configDirAbs, profile);
      if (!proposal.buildBrief) {
        return jsonResult(
          {
            ok: false,
            error: "没有 build-brief.json，无法生成候选",
            hint: "先运行 figma_export_brief 或 pen_export_brief 生成 build-brief.json。"
          },
          true
        );
      }
      return jsonResult({
        ok: true,
        stack: profile?.id ?? null,
        candidates: proposal.candidates,
        unmatched: proposal.unmatched,
        hint: "候选为粗粒度推导（屏幕名→路由/文件命名、AOS scaffold 组件）；请复核后用 screen_map(action:\"save\", entries:[…]) 落盘。"
      });
    }

    const normalized: ScreenMapEntry[] = [];
    const invalid: number[] = [];
    (args.entries ?? []).forEach((raw, index) => {
      const entry = normalizeEntry(raw);
      if (entry) normalized.push(entry);
      else invalid.push(index);
    });
    if (invalid.length > 0) {
      return jsonResult(
        {
          ok: false,
          error: `entries[${invalid.join(", ")}] 非法：需要 design.screen 与 code 中至少一项（route/component/file）`,
          hint: "每条目形如 {design:{screen,nodeId?,component?}, code:{route?,component?,file?}}。"
        },
        true
      );
    }
    if (normalized.length === 0) {
      return jsonResult({ ok: false, error: "entries 为空，无可保存内容" }, true);
    }

    const existing = loadScreenMap(runtime.configDirAbs);
    const merged = args.merge === true && existing.entries.length > 0
      ? [...existing.entries.filter((entry) => !normalized.some((next) => entryKey(next) === entryKey(entry))), ...normalized]
      : normalized;
    const result = saveScreenMap(runtime.configDirAbs, { version: SCREEN_MAP_VERSION, entries: merged });
    return jsonResult({ ok: true, action: result.action, file: result.file, entries: merged.length });
  } catch (error) {
    return jsonResult({ ok: false, error: `screen_map 失败: ${errorMessage(error)}` }, true);
  }
}

export interface RegionLike {
  bbox: { x: number; y: number; width: number; height: number };
}

export interface LocalizeNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RegionLocalization {
  status: "mapped" | "unmapped" | "no-candidates";
  mapEntry?: ScreenMapEntry;
  candidates?: ScreenMapEntry[];
  reason?: string;
}

export function containingScreen(
  node: LocalizeNode | undefined,
  region: RegionLike,
  screens: LocalizeNode[]
): LocalizeNode | null {
  const point = node
    ? { x: node.x + node.width / 2, y: node.y + node.height / 2 }
    : { x: region.bbox.x + region.bbox.width / 2, y: region.bbox.y + region.bbox.height / 2 };
  const hits = screens.filter(
    (screen) =>
      point.x >= screen.x &&
      point.x <= screen.x + screen.width &&
      point.y >= screen.y &&
      point.y <= screen.y + screen.height
  );
  if (hits.length === 0) return null;
  return hits.sort((a, b) => a.width * a.height - b.width * b.height)[0]!;
}

export function localizeRegion(
  region: RegionLike,
  node: LocalizeNode | undefined,
  screens: LocalizeNode[],
  entries: ScreenMapEntry[],
  proposal: ProposeResult | null
): RegionLocalization {
  if (node) {
    const byNodeId = entries.find((entry) => entry.design.nodeId === node.id);
    if (byNodeId) return { status: "mapped", mapEntry: byNodeId };
    const byComponent = entries.find((entry) => entry.design.component === node.name);
    if (byComponent) return { status: "mapped", mapEntry: byComponent };
  }
  const screen = containingScreen(node, region, screens);
  if (screen) {
    const byScreen = entries.find((entry) => entry.design.screen === screen.name);
    if (byScreen) return { status: "mapped", mapEntry: byScreen };
  }
  if (!proposal || !proposal.buildBrief) {
    return {
      status: "no-candidates",
      reason: proposal?.error
        ? `${proposal.error}（可重新运行 figma_export_brief / pen_export_brief）`
        : "没有 build-brief.json，无法生成候选（可运行 figma_export_brief / pen_export_brief）"
    };
  }
  const candidates = proposal.candidates
    .filter(
      (entry) =>
        (screen !== null && entry.design.screen === screen.name) ||
        (node !== undefined && entry.design.component === node.name)
    )
    .slice(0, 3);
  if (candidates.length === 0) {
    return { status: "no-candidates", reason: "该屏幕/组件没有可用的候选（名称泛化或 build-brief 未包含）" };
  }
  return { status: "unmapped", candidates };
}
