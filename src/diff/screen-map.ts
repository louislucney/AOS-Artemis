import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { isGenericLayerName } from "../figma/color.js";
import { pngDimensions } from "../ios/vision.js";
import {
  detectProjectStacks,
  formatComponentFileName,
  primaryProfile,
  skippedStacksWarnings,
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

/** Element-level mapping (design runtime text ↔ observed device label) with a
 * stack-conventional accessibilityIdentifier suggestion (auto-discovered from
 * exploration/execution observations; manual entries win). */
export interface ElementMapEntry {
  screen: string;
  /** Design-side runtime text that matched an observed label. */
  text: string;
  /** Design node identity when the hint metadata provided one (stable anchor). */
  designNodeId?: string;
  /** Design bounds normalized to 0..1 within the screen (when known). */
  bounds?: ElementBounds;
  observedLabel: string;
  identifier: string;
  /** 1 = unique text match; 0.8 = geometry-disambiguated duplicated text. */
  confidence: number;
  source: "observed" | "manual";
  hits: number;
  /** Traces that produced a hit (audit trail; same-trace replay is idempotent). */
  traces: string[];
  lastSeenAt: string;
}

export interface ScreenMapFile {
  version: number;
  entries: ScreenMapEntry[];
  /** Element-level mappings; omitted from serialization when empty. */
  elements: ElementMapEntry[];
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
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown; elements?: unknown };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(normalizeEntry).filter((entry): entry is ScreenMapEntry => entry !== null)
      : [];
    const elements = Array.isArray(parsed.elements)
      ? parsed.elements
          .map(normalizeElementEntry)
          .filter((entry): entry is ElementMapEntry => entry !== null)
      : [];
    return {
      version: typeof parsed.version === "number" ? parsed.version : SCREEN_MAP_VERSION,
      entries,
      elements
    };
  } catch {
    return { version: SCREEN_MAP_VERSION, entries: [], elements: [] };
  }
}

function elementKey(entry: Pick<ElementMapEntry, "screen" | "text" | "designNodeId">): string {
  return JSON.stringify([entry.screen, entry.designNodeId ?? "", entry.text]);
}

function normalizeElementEntry(value: unknown): ElementMapEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const screen = typeof record.screen === "string" ? record.screen.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!screen || !text) return null;
  const observedLabel =
    typeof record.observedLabel === "string" && record.observedLabel.trim() !== ""
      ? record.observedLabel.trim()
      : text;
  const identifier =
    typeof record.identifier === "string" && record.identifier.trim() !== ""
      ? record.identifier.trim()
      : suggestIdentifier(text);
  const designNodeId =
    typeof record.designNodeId === "string" && record.designNodeId.trim() !== ""
      ? record.designNodeId.trim()
      : undefined;
  const boundsRecord = record.bounds;
  let bounds: ElementBounds | undefined;
  if (boundsRecord && typeof boundsRecord === "object" && !Array.isArray(boundsRecord)) {
    const box = boundsRecord as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    const values = [box.x, box.y, box.width, box.height];
    if (values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
      bounds = { x: box.x as number, y: box.y as number, width: box.width as number, height: box.height as number };
    }
  }
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : 1;
  const source = record.source === "manual" ? "manual" : "observed";
  const hits =
    typeof record.hits === "number" && Number.isFinite(record.hits) && record.hits >= 0
      ? Math.floor(record.hits)
      : 0;
  const traces = Array.isArray(record.traces)
    ? record.traces.filter((trace): trace is string => typeof trace === "string")
    : [];
  const lastSeenAt = typeof record.lastSeenAt === "string" ? record.lastSeenAt : "";
  return {
    screen,
    text,
    ...(designNodeId ? { designNodeId } : {}),
    ...(bounds ? { bounds } : {}),
    observedLabel,
    identifier,
    confidence,
    source,
    hits,
    traces,
    lastSeenAt
  };
}

/** Stack-conventional identifier suggestion: latin words become camelCase
 * (must start with a letter); non-ASCII-only texts fall back to a stable
 * hashed name (`element_<sha1 前 8>`). Deterministic and idempotent. */
export function suggestIdentifier(text: string): string {
  const tokens = text.match(/[A-Za-z0-9]+/g) ?? [];
  const camel = tokens
    .map((token, index) =>
      index === 0
        ? token.toLowerCase()
        : `${token[0]!.toUpperCase()}${token.slice(1).toLowerCase()}`
    )
    .join("");
  if (/^[a-z][A-Za-z0-9]*$/.test(camel)) return camel;
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 8);
  return `element_${hash}`;
}

/** Normalized comparison key for element labels/texts (shared by matching and
 * generation-side identifier lookup). */
export function normalizeElementLabel(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

const normalizeLabelForMatch = normalizeElementLabel;

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Design-side hint metadata (nodeId + design-px bounds enrich plain texts). */
export interface ElementDesignHint {
  text: string;
  nodeId?: string;
  bounds?: ElementBounds;
}

export interface ElementDesignScreen {
  screen: string;
  hints: Array<string | ElementDesignHint>;
  /** Screen frame bounds in design px (normalizes hint bounds to 0..1). */
  bounds?: ElementBounds;
}

/** Normalized (0..1 within the screen) tap evidence from the run. */
export interface ElementObservedTap {
  relX: number;
  relY: number;
}

export interface ElementObservationInput {
  /** Design-side runtime texts per screen (from tests.json expectations,
   * optionally enriched with nodeId/bounds from flows.json). */
  designs: ElementDesignScreen[];
  /** Labels observed during the run (any step's visible text labels). */
  observedLabels: string[];
  /** Trace-level tap points for geometry disambiguation of duplicated texts. */
  observedTaps?: ElementObservedTap[];
}

function normalizeHintBounds(
  bounds: ElementBounds | undefined,
  screen: ElementBounds | undefined
): ElementBounds | null {
  if (!bounds || !screen || screen.width <= 0 || screen.height <= 0) return null;
  const normalized = {
    x: (bounds.x - screen.x) / screen.width,
    y: (bounds.y - screen.y) / screen.height,
    width: bounds.width / screen.width,
    height: bounds.height / screen.height
  };
  if (!Object.values(normalized).every((value) => Number.isFinite(value))) return null;
  return normalized;
}

function hintContainsTap(bounds: ElementBounds | null, taps: ElementObservedTap[]): boolean {
  if (!bounds) return false;
  const epsilon = 0.01;
  return taps.some(
    (tap) =>
      tap.relX >= bounds.x - epsilon &&
      tap.relX <= bounds.x + bounds.width + epsilon &&
      tap.relY >= bounds.y - epsilon &&
      tap.relY <= bounds.y + bounds.height + epsilon
  );
}

/** Deterministic text matching (unique exact normalized equality), scoped per
 * screen: duplicated texts within one screen are resolved by geometry when
 * trace tap evidence falls inside exactly one candidate rect, otherwise
 * skipped (no guessing); duplicates across screens are independent entries.
 * Duplicate observed labels collapse to one candidate. */
export function matchElementObservations(input: ElementObservationInput): Omit<
  ElementMapEntry,
  "hits" | "traces" | "lastSeenAt"
>[] {
  const observed = new Map<string, string>();
  for (const label of input.observedLabels) {
    const normalized = normalizeLabelForMatch(label);
    if (normalized !== "" && !observed.has(normalized)) observed.set(normalized, label.trim());
  }
  const observedTaps = input.observedTaps ?? [];
  const matches: Omit<ElementMapEntry, "hits" | "traces" | "lastSeenAt">[] = [];
  const seen = new Set<string>();
  for (const design of input.designs) {
    const hints = design.hints
      .map((raw) => (typeof raw === "string" ? { text: raw } : { ...raw, text: raw.text.trim() }))
      .filter((hint) => hint.text !== "");
    const byNormalized = new Map<string, ElementDesignHint[]>();
    for (const hint of hints) {
      const key = normalizeLabelForMatch(hint.text);
      if (key === "") continue;
      const list = byNormalized.get(key) ?? [];
      if (!list.some((candidate) => (candidate.nodeId ?? "") === (hint.nodeId ?? ""))) {
        list.push(hint);
      }
      byNormalized.set(key, list);
    }
    for (const [normalized, candidates] of byNormalized) {
      const observedLabel = observed.get(normalized);
      if (observedLabel === undefined) continue;
      let chosen: ElementDesignHint | null = null;
      let confidence = 1;
      if (candidates.length === 1) {
        chosen = candidates[0]!;
      } else {
        const hit = candidates.filter((candidate) =>
          hintContainsTap(normalizeHintBounds(candidate.bounds, design.bounds), observedTaps)
        );
        if (hit.length === 1) {
          chosen = hit[0]!;
          confidence = 0.8;
        }
      }
      if (!chosen) continue;
      const bounds = normalizeHintBounds(chosen.bounds, design.bounds);
      const key = JSON.stringify([design.screen, chosen.nodeId ?? "", chosen.text]);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        screen: design.screen,
        text: chosen.text,
        ...(chosen.nodeId ? { designNodeId: chosen.nodeId } : {}),
        ...(bounds ? { bounds } : {}),
        observedLabel,
        identifier: suggestIdentifier(chosen.text),
        confidence,
        source: "observed"
      });
    }
  }
  return matches;
}

/** Merge element observations into the mapping asset: new entries start at
 * hits=1; existing entries refresh label/hits/time. Manual entries keep their
 * identifier (human curation wins). Same-trace replay is idempotent. */
export function mergeElementObservations(
  map: ScreenMapFile,
  observations: Array<Omit<ElementMapEntry, "hits" | "traces" | "lastSeenAt">>,
  at: string,
  traceId?: string
): { map: ScreenMapFile; updated: number } {
  const byKey = new Map(map.elements.map((entry) => [elementKey(entry), { ...entry, traces: [...entry.traces] }]));
  let updated = 0;
  for (const observation of observations) {
    const key = elementKey(observation);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...observation,
        hits: 1,
        traces: traceId ? [traceId] : [],
        lastSeenAt: at
      });
      updated += 1;
      continue;
    }
    if (traceId && existing.traces.includes(traceId)) continue;
    existing.observedLabel = observation.observedLabel;
    existing.hits += 1;
    if (traceId) existing.traces.push(traceId);
    existing.lastSeenAt = at;
    if (existing.source !== "manual") {
      existing.identifier = observation.identifier;
      existing.confidence = observation.confidence;
    }
    updated += 1;
  }
  if (updated === 0) return { map, updated: 0 };
  return {
    map: {
      version: map.version,
      entries: map.entries,
      elements: [...byKey.values()].sort((a, b) => elementKey(a).localeCompare(elementKey(b)))
    },
    updated
  };
}

/** Observing labels recorded by the iOS executor (step screen text summaries). */
export function observedLabelsFromRunSteps(run: unknown): string[] {
  if (!run || typeof run !== "object" || Array.isArray(run)) return [];
  const steps = (run as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  const labels = new Set<string>();
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const screen = (step as { screen?: unknown }).screen;
    if (typeof screen !== "string") continue;
    for (const part of screen.split(" | ")) {
      const label = part.trim();
      if (label !== "") labels.add(label);
    }
  }
  return [...labels];
}

/** Trace-level tap points (normalized to 0..1) for geometry disambiguation.
 * Device logical size derives from the first step screenshot (PNG) ÷ scale;
 * without a readable screenshot the taps are omitted (text-only matching). */
export function observedTapsFromRunSteps(run: unknown, traceDirAbs: string): ElementObservedTap[] {
  if (!run || typeof run !== "object" || Array.isArray(run)) return [];
  const steps = (run as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];
  let deviceSize: { width: number; height: number } | null = null;
  const rawTaps: Array<{ x: number; y: number }> = [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const record = step as Record<string, unknown>;
    if (
      deviceSize === null &&
      typeof record.shot === "string" &&
      typeof record.scale === "number" &&
      Number.isFinite(record.scale) &&
      record.scale > 0
    ) {
      try {
        const dims = pngDimensions(fs.readFileSync(path.join(traceDirAbs, record.shot)));
        if (dims) {
          deviceSize = { width: dims.width / record.scale, height: dims.height / record.scale };
        }
      } catch {
        /* screenshot missing: fall back to text-only matching */
      }
    }
    if (record.action !== "tap") continue;
    const params = record.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) continue;
    const x = (params as { x?: unknown }).x;
    const y = (params as { y?: unknown }).y;
    if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
      rawTaps.push({ x, y });
    }
  }
  if (!deviceSize || deviceSize.width <= 0 || deviceSize.height <= 0) return [];
  const size = deviceSize;
  return rawTaps.map((tap) => ({ relX: tap.x / size.width, relY: tap.y / size.height }));
}

/** Persist element observations (load → merge → save only when changed).
 * `traceId` makes same-trace replay idempotent. */
export function recordElementObservations(
  configDirAbs: string,
  input: ElementObservationInput,
  at: string,
  traceId?: string
): number {
  const observations = matchElementObservations(input);
  if (observations.length === 0) return 0;
  const current = loadScreenMap(configDirAbs);
  const merged = mergeElementObservations(current, observations, at, traceId);
  if (merged.updated > 0) saveScreenMap(configDirAbs, merged.map);
  return merged.updated;
}

export function serializeScreenMap(map: ScreenMapFile): string {
  const entries = [...map.entries]
    .map(normalizeEntry)
    .filter((entry): entry is ScreenMapEntry => entry !== null)
    .sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  const elements = [...(map.elements ?? [])]
    .map(normalizeElementEntry)
    .filter((entry): entry is ElementMapEntry => entry !== null)
    .sort((a, b) => elementKey(a).localeCompare(elementKey(b)));
  const lines = [`{`, `  "version": ${SCREEN_MAP_VERSION},`, `  "entries": [`];
  entries.forEach((entry, index) => {
    const record: Record<string, unknown> = { design: entry.design, code: entry.code };
    if (entry.source) record.source = entry.source;
    if (entry.confidence !== undefined) record.confidence = entry.confidence;
    lines.push(`    ${JSON.stringify(record)}${index === entries.length - 1 ? "" : ","}`);
  });
  lines.push(`  ]${elements.length > 0 ? "," : ""}`);
  if (elements.length > 0) {
    lines.push(`  "elements": [`);
    elements.forEach((entry, index) => {
      lines.push(`    ${JSON.stringify(entry)}${index === elements.length - 1 ? "" : ","}`);
    });
    lines.push(`  ]`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

export function screenMapFilePath(configDirAbs: string): string {
  return path.join(configDirAbs, "design", SCREEN_MAP_FILE);
}

export function loadScreenMap(configDirAbs: string): ScreenMapFile {
  const file = screenMapFilePath(configDirAbs);
  if (!fs.existsSync(file)) return { version: SCREEN_MAP_VERSION, entries: [], elements: [] };
  const text = fs.readFileSync(file, "utf-8");
  const map = parseScreenMap(text);
  const corrupt = text.trim() !== "" && map.entries.length === 0 && map.elements.length === 0;
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
  /** Manual element-level mappings (identifier curation); source forced to manual. */
  elements?: unknown[];
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
        elements: map.elements,
        ...(map.corrupt ? { corrupt: true } : {}),
        hint: map.corrupt
          ? "screen-map.json 无法解析（已按空表处理）；修复或删除后重试。"
          : map.entries.length === 0 && map.elements.length === 0
            ? '映射为空：先运行 screen_map(action:"propose") 生成候选，再由 agent 复核后 save（元素级映射由 iOS 套件运行自动发现）。'
            : undefined
      });
    }
    if (args.action === "propose") {
      const stacks = detectProjectStacks(runtime.project.rootDir);
      const profile = primaryProfile(stacks);
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
        warnings: skippedStacksWarnings(stacks, profile),
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
    const normalizedElements: ElementMapEntry[] = [];
    const invalidElements: number[] = [];
    (args.elements ?? []).forEach((raw, index) => {
      const entry = normalizeElementEntry(raw);
      if (entry) normalizedElements.push({ ...entry, source: "manual" });
      else invalidElements.push(index);
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
    if (invalidElements.length > 0) {
      return jsonResult(
        {
          ok: false,
          error: `elements[${invalidElements.join(", ")}] 非法：需要 screen 与 text`,
          hint: "每条目形如 {screen,text,observedLabel?,identifier?,confidence?}（source 强制 manual）。"
        },
        true
      );
    }
    if (normalized.length === 0 && normalizedElements.length === 0) {
      return jsonResult({ ok: false, error: "entries/elements 均为空，无可保存内容" }, true);
    }

    const existing = loadScreenMap(runtime.configDirAbs);
    const merged =
      normalized.length === 0
        ? existing.entries
        : args.merge === true && existing.entries.length > 0
          ? [...existing.entries.filter((entry) => !normalized.some((next) => entryKey(next) === entryKey(entry))), ...normalized]
          : normalized;
    const elementByKey = new Map(existing.elements.map((entry) => [elementKey(entry), entry]));
    for (const entry of normalizedElements) elementByKey.set(elementKey(entry), entry);
    const elements = [...elementByKey.values()].sort((a, b) => elementKey(a).localeCompare(elementKey(b)));
    const result = saveScreenMap(runtime.configDirAbs, { version: SCREEN_MAP_VERSION, entries: merged, elements });
    return jsonResult({
      ok: true,
      action: result.action,
      file: result.file,
      entries: merged.length,
      elements: elements.length
    });
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
