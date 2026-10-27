import fs from "node:fs";
import path from "node:path";

/** ui-lint 的逐屏映射（DESIGN §13.218）：读 `.artemis/design/screen-map.json`
 * 的 `design.screen ↔ code.file/component`，把源码文件关联到契约屏幕。
 * 只有高置信显式映射才用于 per-screen token 收窄；启发式候选仅进报告。 */

export interface UiMappingScreen {
  id: string;
  name: string;
  sourceFrameName?: string | null;
  status: string;
  radii: number[];
  colors: string[];
  fontSizes: number[];
  fontWeights: number[];
  fontFamilies: string[];
}

export interface UiMappingEntryReport {
  screenId: string;
  screenName: string;
  file: string;
  source: "screen-map" | "heuristic";
  confidence: number;
  usedForScoping: boolean;
}

export interface UiMappingReport {
  screenMapPath: string;
  entries: number;
  screens: {
    total: number;
    /** 至少有一条高置信、屏幕已提取且用于 per-screen 的屏幕数。 */
    mapped: number;
    unmapped: Array<{ id: string; name: string; status: string; explicit: boolean }>;
  };
  files: {
    total: number;
    /** 有高置信、可用于 per-screen 映射的文件数。 */
    scoped: number;
    /** 有任何显式 screen-map 映射的文件数（含低置信/未提取屏）。 */
    explicit: number;
    /** 仅有启发式候选（未用于 per-screen）的文件数。 */
    heuristic: number;
    /** 回退全局 token 的文件数（total - scoped）。 */
    globalFallback: number;
  };
  mappings: UiMappingEntryReport[];
  warnings: string[];
}

export interface UiFileMapping {
  /** 显式/启发式映射到的屏幕（报告用）。 */
  screenIds: string[];
  /** 仅高置信、屏幕 status=extracted 且用于 per-screen 的屏幕。 */
  scopedScreenIds: string[];
  confidence: number;
  source: "screen-map" | "heuristic";
}

export interface BuildUiMappingInput {
  rootDir: string;
  screens: UiMappingScreen[];
  /** 已选源码文件（相对 rootDir 的 POSIX 路径）→ 内容。 */
  fileContents: Map<string, string>;
  screenMapPath: string;
  /** 默认开启启发式候选（仅报告，不参与 per-screen）。 */
  heuristics?: boolean;
}

export interface BuildUiMappingResult {
  report: UiMappingReport;
  byFile: Map<string, UiFileMapping>;
}

const SCOPING_CONFIDENCE = 0.7;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function keyOf(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function basenameKey(file: string): string {
  return keyOf(path.basename(file, path.extname(file)));
}

function screenKeys(screen: UiMappingScreen): string[] {
  return [screen.id, screen.name, screen.sourceFrameName ?? ""]
    .map((value) => (typeof value === "string" ? keyOf(value) : ""))
    .filter((value) => value !== "");
}

function screenNameCandidates(name: string): string[] {
  const cleaned = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned === "") return [];
  const pascal = cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const values = new Set<string>([name, cleaned.replace(/\s+/g, ""), pascal]);
  if (/Screen$/i.test(pascal)) values.add(pascal.replace(/Screen$/i, ""));
  return [...values].filter((value) => value !== "");
}

function loadEntries(
  file: string,
  warnings: string[]
): { entries: unknown[] } {
  if (!fs.existsSync(file)) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    warnings.push(`screen-map 不是合法 JSON，已忽略：${file}`);
    return { entries: [] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : null;
  if (list === null) {
    warnings.push(`screen-map 缺少 entries 数组，已忽略：${file}`);
    return { entries: [] };
  }
  return { entries: list };
}

/** 组件声明索引：`class HomeView` / `struct HomeView` / `fun HomeScreen` 等。 */
function declarationIndex(fileContents: Map<string, string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const pattern =
    /\b(?:class|struct|enum|protocol|interface|object|trait|fun|func|function|const|let|var|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const [file, content] of fileContents) {
    for (const match of content.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const key = keyOf(name);
      if (key === "") continue;
      const files = index.get(key) ?? new Set<string>();
      files.add(file);
      index.set(key, files);
    }
  }
  return index;
}

function basenameIndex(fileContents: Map<string, string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const file of fileContents.keys()) {
    const key = basenameKey(file);
    if (key === "") continue;
    const files = index.get(key) ?? new Set<string>();
    files.add(file);
    index.set(key, files);
  }
  return index;
}

export function buildUiMapping(input: BuildUiMappingInput): BuildUiMappingResult {
  const warnings: string[] = [];
  const { entries } = loadEntries(input.screenMapPath, warnings);

  const screenByKey = new Map<string, UiMappingScreen>();
  for (const screen of input.screens) {
    for (const key of screenKeys(screen)) {
      if (!screenByKey.has(key)) screenByKey.set(key, screen);
    }
  }

  const declarations = declarationIndex(input.fileContents);
  const basenames = basenameIndex(input.fileContents);
  const reportMappings: UiMappingEntryReport[] = [];
  const reported = new Set<string>();
  const explicitByScreen = new Map<string, Set<string>>();
  const scopedByScreen = new Map<string, Set<string>>();
  const byFile = new Map<
    string,
    {
      screenIds: Set<string>;
      scopedScreenIds: Set<string>;
      confidence: number;
      source: "screen-map" | "heuristic";
    }
  >();

  const resolveFile = (raw: string): string | null => {
    const absolute = path.isAbsolute(raw) ? raw : path.resolve(input.rootDir, raw);
    const relative = path.relative(input.rootDir, absolute).replace(/\\/g, "/");
    if (relative === "" || relative === ".." || relative.startsWith("../")) {
      warnings.push(`screen-map code.file 在项目根之外，已忽略：${raw}`);
      return null;
    }
    if (input.fileContents.has(relative)) return relative;
    const suffixMatches = [...input.fileContents.keys()].filter(
      (file) => file === relative || file.endsWith(`/${relative}`)
    );
    if (suffixMatches.length === 1) return suffixMatches[0]!;
    if (suffixMatches.length > 1) {
      warnings.push(`screen-map code.file 后缀匹配不唯一，已忽略：${raw}`);
      return null;
    }
    if (!fs.existsSync(path.join(input.rootDir, relative))) {
      warnings.push(`screen-map code.file 不存在，已忽略：${raw}`);
    }
    return null;
  };

  const resolveComponent = (component: string): string | null => {
    const files = new Set<string>();
    for (const file of declarations.get(keyOf(component)) ?? []) files.add(file);
    for (const file of basenames.get(keyOf(component)) ?? []) files.add(file);
    if (files.size === 1) return [...files][0]!;
    if (files.size === 0) {
      warnings.push(`screen-map code.component 未在扫描源码中找到，已忽略：${component}`);
    } else {
      warnings.push(`screen-map code.component 匹配 ${files.size} 个文件，已忽略（请补 code.file）：${component}`);
    }
    return null;
  };

  const addMapping = (
    screen: UiMappingScreen,
    file: string,
    source: "screen-map" | "heuristic",
    confidence: number
  ): void => {
    const usedForScoping =
      source === "screen-map" &&
      confidence >= SCOPING_CONFIDENCE &&
      screen.status === "extracted";
    const key = `${screen.id}|${file}|${source}`;
    if (!reported.has(key)) {
      reported.add(key);
      reportMappings.push({
        screenId: screen.id,
        screenName: screen.name,
        file,
        source,
        confidence,
        usedForScoping
      });
    }
    if (source === "screen-map") {
      const files = explicitByScreen.get(screen.id) ?? new Set<string>();
      files.add(file);
      explicitByScreen.set(screen.id, files);
    }
    if (usedForScoping) {
      const files = scopedByScreen.get(screen.id) ?? new Set<string>();
      files.add(file);
      scopedByScreen.set(screen.id, files);
    }
    const entry = byFile.get(file) ?? {
      screenIds: new Set<string>(),
      scopedScreenIds: new Set<string>(),
      confidence: 0,
      source
    };
    entry.screenIds.add(screen.id);
    if (usedForScoping) entry.scopedScreenIds.add(screen.id);
    if (source === "screen-map") {
      entry.source = "screen-map";
      entry.confidence = Math.max(entry.confidence, confidence);
    } else if (entry.screenIds.size === 1) {
      entry.confidence = confidence;
    }
    byFile.set(file, entry);
  };

  entries.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`screen-map entries[${index}] 不是对象，已忽略`);
      return;
    }
    const record = raw as Record<string, unknown>;
    const design = record.design as Record<string, unknown> | undefined;
    const code = record.code as Record<string, unknown> | undefined;
    const designName =
      (design && (stringValue(design.screen) ?? stringValue(design.component))) ?? null;
    if (designName === null) {
      warnings.push(`screen-map entries[${index}] 缺 design.screen/component，已忽略`);
      return;
    }
    const screen = screenByKey.get(keyOf(designName));
    if (screen === undefined) {
      warnings.push(`screen-map 未匹配契约屏幕，已忽略：${designName}`);
      return;
    }
    const file = code ? stringValue(code.file) : null;
    const component = code ? stringValue(code.component) : null;
    const route = code ? stringValue(code.route) : null;
    if (file === null && component === null) {
      if (route !== null) {
        warnings.push(`screen-map 仅提供 code.route，无法静态映射，已忽略：${route}`);
      } else {
        warnings.push(`screen-map entries[${index}] 缺 code.file/component，已忽略`);
      }
      return;
    }
    let matched = file !== null ? resolveFile(file) : null;
    if (matched === null && component !== null) matched = resolveComponent(component);
    if (matched === null) return;
    const source =
      record.source === "manual"
        ? "manual"
        : record.source === "proposed"
          ? "proposed"
          : null;
    const confidence = clampConfidence(
      typeof record.confidence === "number" && Number.isFinite(record.confidence)
        ? record.confidence
        : source === "manual"
          ? 1
          : 0.8
    );
    addMapping(screen, matched, "screen-map", confidence);
  });

  if (input.heuristics !== false) {
    for (const screen of input.screens) {
      if (explicitByScreen.has(screen.id)) continue;
      const files = new Set<string>();
      for (const candidate of screenNameCandidates(screen.name)) {
        const key = keyOf(candidate);
        if (key === "") continue;
        for (const file of declarations.get(key) ?? []) files.add(file);
        for (const file of basenames.get(key) ?? []) files.add(file);
      }
      if (files.size === 1) addMapping(screen, [...files][0]!, "heuristic", 0.5);
    }
  }

  const explicitFiles = new Set<string>();
  const scopedFiles = new Set<string>();
  const heuristicFiles = new Set<string>();
  for (const [file, entry] of byFile) {
    if (entry.source === "screen-map") explicitFiles.add(file);
    else heuristicFiles.add(file);
    if (entry.scopedScreenIds.size > 0) scopedFiles.add(file);
  }
  const unmapped = input.screens
    .filter((screen) => !scopedByScreen.has(screen.id))
    .map((screen) => ({
      id: screen.id,
      name: screen.name,
      status: screen.status,
      explicit: explicitByScreen.has(screen.id)
    }));

  const report: UiMappingReport = {
    screenMapPath: input.screenMapPath,
    entries: entries.length,
    screens: {
      total: input.screens.length,
      mapped: scopedByScreen.size,
      unmapped
    },
    files: {
      total: input.fileContents.size,
      scoped: scopedFiles.size,
      explicit: explicitFiles.size,
      heuristic: heuristicFiles.size,
      globalFallback: input.fileContents.size - scopedFiles.size
    },
    mappings: reportMappings.sort(
      (left, right) =>
        left.screenId.localeCompare(right.screenId) ||
        left.file.localeCompare(right.file) ||
        left.source.localeCompare(right.source)
    ),
    warnings
  };

  const internal = new Map<string, UiFileMapping>();
  for (const [file, entry] of byFile) {
    internal.set(file, {
      screenIds: [...entry.screenIds],
      scopedScreenIds: [...entry.scopedScreenIds],
      confidence: entry.confidence,
      source: entry.source
    });
  }
  return { report, byFile: internal };
}
