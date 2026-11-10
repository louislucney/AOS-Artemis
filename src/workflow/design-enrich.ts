import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../runtime.js";
import { makeChatFn, type ChatFn } from "../llm/chat.js";
import {
  normalizeExcelHeader,
  suggestExcelMapping,
  type ExcelColumnMap
} from "../web/excel-columns.js";
import { readCaseSheet } from "./excel.js";
import {
  importTestDocument,
  parseDesignScreens,
  type DesignRowMapping,
  type ImportColumns
} from "./excel-import.js";

export interface DesignIndexArgs {
  /** 设计屏索引 JSON（flows.json 或 `{screens|nodes:[...]}`）；不传则用 flowsPath/默认 flows.json。 */
  screenIndexPath?: string;
  flowsPath?: string;
}

export interface DesignAssistedImportArgs extends DesignIndexArgs {
  excelPath: string;
  /** 用例集来源展示名（面板资产原始文件名）；缺省用 excelPath basename。 */
  sourceName?: string;
  /** 显式列覆盖；键为规范字段（caseId/name/steps/module/section/wireframe/...）。 */
  columns?: Record<string, string>;
  threshold?: number;
  maxCandidates?: number;
  save?: boolean;
  /** true 时生成新的 enriched 用例集（新 source id，不覆盖普通导入/原 Excel）。 */
  apply?: boolean;
  /** apply 时是否把 near 映射的 screen id 也写入（默认只写 exact）。 */
  allowNear?: boolean;
  /** apply 时存在 unmapped/review 行则拒绝（no-wireframe 不受影响）。 */
  requireAllMapped?: boolean;
  /** 人工确认映射文件；默认 .artemis/design/enrich/enrich-overrides.json。 */
  overridesPath?: string;
  /** 本次人工确认；会覆盖同 row+screen 的旧条目。 */
  overrides?: DesignEnrichOverrideInput[];
  /** 把 overrides 合并写回 overridesPath。 */
  saveOverrides?: boolean;
  /** 逐屏增量：复用未变设计屏的旧映射，默认 true。 */
  delta?: boolean;
  /** 映射缓存路径，默认 .artemis/design/enrich/mapping-cache.json。 */
  cachePath?: string;
  /** 可选 LLM 歧义映射：只处理 unmapped 且有候选的行；默认 off。 */
  llmMapping?: "off" | "auto";
  /** LLM 调用上限（按行），默认 20。 */
  maxLlmCalls?: number;
  /** 测试注入；缺省用 active LLM。 */
  chat?: ChatFn;
}

export interface DesignEnrichOverrideInput {
  /** 省略＝屏级确认，应用到所有引用该屏名的行；行级确认优先。 */
  rowNumber?: number;
  screen: string;
  screenId: string;
  screenName?: string;
  confirmedBy?: string;
}

interface DesignEnrichOverride extends DesignEnrichOverrideInput {
  excelSha8: string;
  source: "human";
  confirmedAt: string;
}

export interface DesignScreenIndexEntry {
  id: string;
  name: string;
  textHints: string[];
  elements: string[];
}

export interface DesignMappingCandidate {
  id: string;
  name: string;
  score: number;
}

export interface DesignMappingMatch {
  screen: string;
  status: "exact" | "near" | "ambiguous" | "unmapped";
  design: { id: string; name: string } | null;
  candidates: DesignMappingCandidate[];
  matchedBy?: "exact" | "near" | "human" | "llm";
}

export interface DesignNeedsInfo {
  needs: "info";
  category:
    | "excel-wireframe-unresolved"
    | "excel-mapping-no-exact"
    | "excel-mapping-review"
    | "excel-mapping-partial";
  questions: string[];
  context: Record<string, unknown>;
}

export interface DesignAssistedReport {
  schemaVersion: 1;
  mode: "preview";
  generatedAt: string;
  source: {
    excel: string;
    sourceName?: string;
    excelSha8: string;
    designIndex: string;
    designIndexKind: "screen-index" | "flows" | "ui-contract";
    screenCount: number;
  };
  summary: {
    rows: number;
    withWireframe: number;
    withoutWireframe: number;
    uniqueScreens: number;
    screenStatus: { exact: number; near: number; ambiguous: number; unmapped: number };
    rowStatus: { matched: number; review: number; unmapped: number; "no-wireframe": number };
    structuralCandidates: number;
    humanMapped: number;
    llmMapped: number;
    llmCalls: number;
  };
  rows: Array<{
    rowNumber: number;
    caseId: string;
    module: string;
    section: string;
    name: string;
    status: "matched" | "review" | "unmapped" | "no-wireframe";
    screens: DesignMappingMatch[];
    /** 无 Wireframe 时用步骤/预期文本匹配出的设计候选（仅建议，需人工确认）。 */
    structural?: {
      status: "candidate";
      matches: DesignMappingCandidate[];
    };
  }>;
  warnings: string[];
  delta: { reused: number; remapped: number; added: number; removed: number };
}

export function resolveProjectPath(runtime: Runtime, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(runtime.project.rootDir, value);
}

function overrideKey(rowNumber: number | undefined, screen: string): string {
  const row =
    typeof rowNumber === "number" && Number.isInteger(rowNumber) && rowNumber >= 2
      ? rowNumber
      : -1;
  return `${row}\u0000${screen}`;
}

function overridesFilePath(runtime: Runtime, args: DesignAssistedImportArgs): string {
  const configured = args.overridesPath?.trim() ?? "";
  return configured === ""
    ? path.join(runtime.configDirAbs, "design", "enrich", "enrich-overrides.json")
    : resolveProjectPath(runtime, configured);
}

function readOverrideEntries(file: string): DesignEnrichOverride[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { entries?: unknown }).entries
        : undefined;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Partial<DesignEnrichOverride>;
      const hasRow =
        typeof record.rowNumber === "number" &&
        Number.isInteger(record.rowNumber) &&
        record.rowNumber >= 2;
      if (
        (record.rowNumber !== undefined && !hasRow) ||
        typeof record.screen !== "string" ||
        record.screen.trim() === "" ||
        typeof record.screenId !== "string" ||
        record.screenId.trim() === ""
      ) {
        return [];
      }
      return [
        {
          ...(hasRow ? { rowNumber: record.rowNumber as number } : {}),
          screen: record.screen.trim(),
          screenId: record.screenId.trim(),
          ...(typeof record.screenName === "string" ? { screenName: record.screenName } : {}),
          ...(typeof record.confirmedBy === "string" ? { confirmedBy: record.confirmedBy } : {}),
          excelSha8: typeof record.excelSha8 === "string" ? record.excelSha8 : "",
          source: "human" as const,
          confirmedAt:
            typeof record.confirmedAt === "string" ? record.confirmedAt : new Date().toISOString()
        }
      ];
    });
  } catch {
    return [];
  }
}

function loadOverrides(
  runtime: Runtime,
  args: DesignAssistedImportArgs,
  excelSha8: string
): Map<string, DesignEnrichOverride> {
  const map = new Map<string, DesignEnrichOverride>();
  const file = overridesFilePath(runtime, args);
  for (const entry of readOverrideEntries(file)) {
    if (entry.excelSha8 !== "" && entry.excelSha8 !== excelSha8) continue;
    map.set(overrideKey(entry.rowNumber, entry.screen), entry);
  }
  const now = new Date().toISOString();
  for (const entry of args.overrides ?? []) {
    const hasRow =
      typeof entry.rowNumber === "number" &&
      Number.isInteger(entry.rowNumber) &&
      entry.rowNumber >= 2;
    if (
      (entry.rowNumber !== undefined && !hasRow) ||
      typeof entry.screen !== "string" ||
      entry.screen.trim() === "" ||
      typeof entry.screenId !== "string" ||
      entry.screenId.trim() === ""
    ) {
      continue;
    }
    const normalized: DesignEnrichOverride = {
      ...(hasRow ? { rowNumber: entry.rowNumber as number } : {}),
      screen: entry.screen.trim(),
      screenId: entry.screenId.trim(),
      ...(typeof entry.screenName === "string" ? { screenName: entry.screenName } : {}),
      ...(typeof entry.confirmedBy === "string" ? { confirmedBy: entry.confirmedBy } : {}),
      excelSha8,
      source: "human",
      confirmedAt: now
    };
    map.set(overrideKey(normalized.rowNumber, normalized.screen), normalized);
  }
  return map;
}

function persistOverrides(
  runtime: Runtime,
  args: DesignAssistedImportArgs,
  excelSha8: string,
  overrides: Map<string, DesignEnrichOverride>
): void {
  if (args.saveOverrides !== true || (args.overrides ?? []).length === 0) return;
  const file = overridesFilePath(runtime, args);
  const all = new Map<string, DesignEnrichOverride>();
  for (const entry of readOverrideEntries(file)) {
    all.set(overrideKey(entry.rowNumber, `${entry.excelSha8}\u0000${entry.screen}`), entry);
  }
  for (const entry of overrides.values()) {
    if (entry.excelSha8 !== excelSha8) continue;
    all.set(overrideKey(entry.rowNumber, `${entry.excelSha8}\u0000${entry.screen}`), entry);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 1, entries: [...all.values()] }, null, 2)}\n`
  );
}

interface MappingCacheEntry {
  excelSha8: string;
  rowHash: string;
  screen: string;
  designId: string;
  designName: string;
  designFingerprint: string;
  status: "exact" | "near" | "ambiguous" | "unmapped";
  matchedBy?: "exact" | "near" | "llm";
  candidates: DesignMappingCandidate[];
  indexFingerprint: string;
  updatedAt: string;
}

function screenFingerprint(screen: DesignScreenIndexEntry): string {
  return createHash("sha256")
    .update(JSON.stringify([screen.id, screen.name, screen.textHints, screen.elements]))
    .digest("hex")
    .slice(0, 16);
}

function designIndexFingerprint(screens: DesignScreenIndexEntry[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        screens
          .map((screen) => [screen.id, screenFingerprint(screen)])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      )
    )
    .digest("hex")
    .slice(0, 16);
}

function rowFingerprint(input: {
  caseId: string;
  module: string;
  section: string;
  name: string;
  steps: string;
  expected: string;
  wireframe: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.caseId,
        input.module,
        input.section,
        input.name,
        input.steps,
        input.expected,
        input.wireframe
      ])
    )
    .digest("hex")
    .slice(0, 16);
}

function cacheFilePath(runtime: Runtime, args: DesignAssistedImportArgs): string {
  const configured = args.cachePath?.trim() ?? "";
  return configured === ""
    ? path.join(runtime.configDirAbs, "design", "enrich", "mapping-cache.json")
    : resolveProjectPath(runtime, configured);
}

function readMappingCache(file: string): Record<string, MappingCacheEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      schemaVersion?: unknown;
      entries?: unknown;
    };
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    if (parsed.schemaVersion !== 2) return {};
    const entries = parsed.entries;
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return {};
    const out: Record<string, MappingCacheEntry> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Partial<MappingCacheEntry>;
      if (
        typeof record.excelSha8 !== "string" ||
        typeof record.rowHash !== "string" ||
        typeof record.screen !== "string" ||
        typeof record.designId !== "string" ||
        typeof record.designName !== "string" ||
        typeof record.designFingerprint !== "string" ||
        (record.status !== "exact" &&
          record.status !== "near" &&
          record.status !== "ambiguous" &&
          record.status !== "unmapped") ||
        typeof record.indexFingerprint !== "string"
      ) {
        continue;
      }
      out[key] = {
        excelSha8: record.excelSha8,
        rowHash: record.rowHash,
        screen: record.screen,
        designId: record.designId,
        designName: record.designName,
        designFingerprint: record.designFingerprint,
        status: record.status,
        ...(record.matchedBy === "exact" ||
        record.matchedBy === "near" ||
        record.matchedBy === "llm"
          ? { matchedBy: record.matchedBy }
          : {}),
        candidates: Array.isArray(record.candidates)
          ? record.candidates.filter(
              (candidate): candidate is DesignMappingCandidate =>
                candidate !== null &&
                typeof candidate === "object" &&
                typeof (candidate as DesignMappingCandidate).id === "string" &&
                typeof (candidate as DesignMappingCandidate).name === "string" &&
                typeof (candidate as DesignMappingCandidate).score === "number"
            )
          : [],
        indexFingerprint: record.indexFingerprint,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
      };
    }
    return out;
  } catch {
    return {};
  }
}

function cacheKey(excelSha8: string, rowHash: string, screen: string): string {
  return `${excelSha8}\u0000${rowHash}\u0000${screen}`;
}

function writeMappingCache(
  file: string,
  excelSha8: string,
  entries: Record<string, MappingCacheEntry>
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 2, entries }, null, 2)}\n`
  );
}

function columnsForImport(columns: Record<string, string> | undefined): ImportColumns | undefined {
  if (columns === undefined) return undefined;
  const value = (key: string): string | undefined => {
    const raw = columns[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
  };
  const out: ImportColumns = {
    ...(value("name") !== undefined ? { name: value("name") } : {}),
    ...(value("steps") !== undefined ? { steps: value("steps") } : {}),
    ...(value("expected") !== undefined ? { expected: value("expected") } : {}),
    ...(value("preconditions") !== undefined ? { preconditions: value("preconditions") } : {}),
    ...(value("module") !== undefined ? { module: value("module") } : {}),
    ...(value("section") !== undefined ? { section: value("section") } : {}),
    ...(value("caseId") !== undefined ? { displayId: value("caseId") } : {}),
    ...(value("testData") !== undefined ? { testData: value("testData") } : {}),
    ...(value("wireframe") !== undefined ? { wireframe: value("wireframe") } : {}),
    ...(value("relatedTc") !== undefined ? { relatedTc: value("relatedTc") } : {})
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-－–—]+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");
}

function textOfHint(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

function textOfElement(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as { label?: unknown; intent?: unknown };
  if (typeof record.label === "string" && record.label.trim() !== "") return record.label.trim();
  if (typeof record.intent === "string" && record.intent.trim() !== "") return record.intent.trim();
  return "";
}

export function parseScreenIndex(raw: unknown): DesignScreenIndexEntry[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as { screens?: unknown; nodes?: unknown };
  const isNodes = Array.isArray(record.nodes);
  const list: unknown[] = isNodes
    ? (record.nodes as unknown[])
    : Array.isArray(record.screens)
      ? (record.screens as unknown[])
      : [];
  const screens: DesignScreenIndexEntry[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const screen = item as {
      id?: unknown;
      name?: unknown;
      type?: unknown;
      textHints?: unknown;
      elements?: unknown;
    };
    const id = typeof screen.id === "string" ? screen.id.trim() : "";
    const name = typeof screen.name === "string" ? screen.name.trim() : "";
    if (id === "" || name.length < 4) continue;
    const type = typeof screen.type === "string" ? screen.type.toUpperCase() : "";
    if (isNodes && !["FRAME", "COMPONENT", "INSTANCE", "SECTION"].includes(type)) continue;
    const textHints = Array.isArray(screen.textHints)
      ? screen.textHints.map(textOfHint).filter((entry) => entry !== "")
      : [];
    const elements = Array.isArray(screen.elements)
      ? screen.elements.map(textOfElement).filter((entry) => entry !== "")
      : [];
    screens.push({ id, name, textHints, elements });
  }
  return screens;
}

export function loadDesignIndex(
  runtime: Runtime,
  args: DesignIndexArgs
): { path: string; kind: "screen-index" | "flows" | "ui-contract"; screens: DesignScreenIndexEntry[] } | { error: string } {
  const configured = args.screenIndexPath?.trim() ?? "";
  const flows = args.flowsPath?.trim() ?? "";
  const indexPath = configured !== "" ? resolveProjectPath(runtime, configured) : "";
  const flowsPath =
    flows !== ""
      ? resolveProjectPath(runtime, flows)
      : path.join(runtime.configDirAbs, "design", "flows.json");
  const contractPath = path.join(runtime.configDirAbs, "design", "ui-contract.json");
  let target = configured !== "" ? indexPath : flowsPath;
  let kind: "screen-index" | "flows" | "ui-contract" =
    configured !== "" ? "screen-index" : "flows";
  if (configured === "" && flows === "" && !fs.existsSync(target) && fs.existsSync(contractPath)) {
    target = contractPath;
    kind = "ui-contract";
  }
  if (!fs.existsSync(target)) {
    return {
      error: `设计屏索引不存在：${target}（先提取 flows/ui-contract，或传 screenIndexPath）`
    };
  }
  try {
    const screens = parseScreenIndex(JSON.parse(fs.readFileSync(target, "utf8")));
    if (screens.length === 0) return { error: `设计屏索引没有可用屏幕：${target}` };
    return { path: target, kind, screens };
  } catch (error) {
    return {
      error: `读取设计屏索引失败：${target}（${error instanceof Error ? error.message : String(error)}）`
    };
  }
}

function scoreName(a: string, b: string): number {
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return 0.8 + 0.1 * (Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  const at = new Set(a.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean));
  const bt = new Set(b.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  let overlap = 0;
  for (const token of at) if (bt.has(token)) overlap += 1;
  return overlap / Math.max(at.size, bt.size);
}

function bestScore(name: string, screen: DesignScreenIndexEntry): number {
  const wanted = normalizeName(name);
  const values = [screen.name, ...screen.textHints, ...screen.elements];
  return values.reduce((best, value) => Math.max(best, scoreName(wanted, normalizeName(value))), 0);
}

export function matchScreen(
  name: string,
  screens: DesignScreenIndexEntry[],
  threshold: number,
  maxCandidates: number
): DesignMappingMatch {
  const wanted = normalizeName(name);
  const exact = screens.filter((screen) => normalizeName(screen.name) === wanted);
  if (exact.length > 0) {
    const candidates = exact.slice(0, maxCandidates).map((screen) => ({
      id: screen.id,
      name: screen.name,
      score: 1
    }));
    if (exact.length > 1) {
      return { screen: name, status: "ambiguous", design: null, candidates };
    }
    return {
      screen: name,
      status: "exact",
      design: { id: exact[0]!.id, name: exact[0]!.name },
      matchedBy: "exact",
      candidates
    };
  }
  const allScored = screens
    .map((screen) => ({ id: screen.id, name: screen.name, score: bestScore(name, screen) }))
    .filter((entry) => entry.score >= Math.min(threshold, 0.55))
    .sort((left, right) => right.score - left.score);
  const scored = allScored.slice(0, maxCandidates);
  const top = scored[0];
  if (top !== undefined && top.score >= threshold) {
    const second = allScored[1];
    if (second !== undefined && top.score - second.score < 0.1) {
      return { screen: name, status: "ambiguous", design: null, candidates: scored };
    }
    return {
      screen: name,
      status: "near",
      design: { id: top.id, name: top.name },
      matchedBy: "near",
      candidates: scored
    };
  }
  return { screen: name, status: "unmapped", design: null, candidates: scored };
}

function parseLlmMappings(raw: string): Array<{
  screen?: string;
  screenId?: string | null;
  confidence?: number;
  reason?: string;
}> {
  const text = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is { screen?: string; screenId?: string | null; confidence?: number; reason?: string } =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
    );
  } catch {
    return [];
  }
}

function reportMarkdown(report: DesignAssistedReport): string {
  const lines = [
    "# Design-assisted Excel 映射预览",
    "",
    `- Excel: \`${report.source.excel}\` (sha8 ${report.source.excelSha8})`,
    `- 设计索引: \`${report.source.designIndex}\`（${report.source.designIndexKind}，${report.source.screenCount} 屏）`,
    `- 生成时间：${report.generatedAt}`,
    "",
    "## 汇总",
    "",
    `- 用例：${report.summary.rows}（有 Wireframe ${report.summary.withWireframe}，无 ${report.summary.withoutWireframe}）`,
    `- 唯一屏名：${report.summary.uniqueScreens}；exact ${report.summary.screenStatus.exact} / ambiguous ${report.summary.screenStatus.ambiguous} / near ${report.summary.screenStatus.near} / unmapped ${report.summary.screenStatus.unmapped}`,
    `- 行状态：matched ${report.summary.rowStatus.matched} / review ${report.summary.rowStatus.review} / unmapped ${report.summary.rowStatus.unmapped} / no-wireframe ${report.summary.rowStatus["no-wireframe"]}`,
    `- 结构候选（无 Wireframe 行，需复核）：${report.summary.structuralCandidates}`,
    `- 人工确认映射：${report.summary.humanMapped} 行`,
    `- LLM 歧义映射：${report.summary.llmMapped} 屏（调用 ${report.summary.llmCalls} 次）`,
    `- 增量：reused ${report.delta.reused} / remapped ${report.delta.remapped} / added ${report.delta.added} / removed ${report.delta.removed}`,
    "",
    "## 逐行",
    "",
    "| TC | Section | 用例 | 状态 | 屏名匹配 |",
    "|---|---|---|---|---|"
  ];
  for (const row of report.rows) {
    const detail = row.screens
      .map((match) => {
        const design = match.design === null ? "" : `（${match.design.name} [${match.design.id}]）`;
        const human = match.matchedBy === "human" ? " · human" : "";
        return `${match.screen} → ${match.status}${design}${human}`;
      })
      .join("<br>");
    const structural =
      row.structural === undefined
        ? ""
        : `<br>结构: ${row.structural.matches
            .map((match) => `${match.name} [${match.id}] ${match.score.toFixed(2)}`)
            .join("；")}`;
    lines.push(
      `| ${row.caseId} | ${row.section.replace(/\|/g, "/")} | ${row.name.replace(/\|/g, "/").slice(0, 40)} | ${row.status} | ${detail}${structural} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** P0：只读 Excel + 设计屏索引，生成逐行映射报告；不写用例集、不改 Excel。 */
export async function designAssistedImport(
  runtime: Runtime,
  args: DesignAssistedImportArgs
): Promise<
  | {
      ok: true;
      report: DesignAssistedReport;
      artifacts: { jsonPath: string; mdPath: string } | null;
      apply?: { sourceId: string; sets: unknown[]; warnings: string[] };
      needsInfo?: DesignNeedsInfo;
    }
  | {
      ok: false;
      error: string;
      report?: DesignAssistedReport;
      needs?: "info";
      category?: DesignNeedsInfo["category"];
      questions?: string[];
      context?: Record<string, unknown>;
    }
> {
  const excelPath = resolveProjectPath(runtime, args.excelPath);
  let excelSha8: string;
  try {
    excelSha8 = createHash("sha256").update(fs.readFileSync(excelPath)).digest("hex").slice(0, 8);
  } catch (error) {
    return { ok: false, error: `无法读取 Excel：${error instanceof Error ? error.message : String(error)}` };
  }
  let sheet;
  try {
    sheet = await readCaseSheet(excelPath);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const index = loadDesignIndex(runtime, args);
  if ("error" in index) return { ok: false, error: index.error };
  const overrides = loadOverrides(runtime, args, excelSha8);
  const deltaEnabled = args.delta !== false;
  const cacheFile = cacheFilePath(runtime, args);
  const cacheEntries = deltaEnabled ? readMappingCache(cacheFile) : {};
  const cacheOut = { ...cacheEntries };
  const currentById = new Map(index.screens.map((screen) => [screen.id, screen]));
  const indexFingerprint = designIndexFingerprint(index.screens);
  const seenCacheKeys = new Set<string>();
  let reused = 0;
  let remapped = 0;
  let added = 0;
  const threshold =
    typeof args.threshold === "number" && Number.isFinite(args.threshold)
      ? Math.min(1, Math.max(0, args.threshold))
      : 0.7;
  const maxCandidates =
    typeof args.maxCandidates === "number" && Number.isFinite(args.maxCandidates)
      ? Math.max(1, Math.min(10, Math.floor(args.maxCandidates)))
      : 3;

  const mapping: ExcelColumnMap = { ...suggestExcelMapping(sheet.headers) };
  const mappingRecord = mapping as Record<string, string | undefined>;
  for (const [field, header] of Object.entries(args.columns ?? {})) {
    if (typeof header === "string" && header.trim() !== "") mappingRecord[field] = header.trim();
  }
  const indexOf = (field: keyof ExcelColumnMap): number => {
    const header = mapping[field];
    if (header === undefined) return -1;
    const wanted = normalizeExcelHeader(header);
    return sheet.headers.findIndex((entry) => normalizeExcelHeader(entry) === wanted);
  };
  const columns = {
    caseId: indexOf("caseId"),
    name: indexOf("name"),
    steps: indexOf("steps"),
    expected: indexOf("expected"),
    module: indexOf("module"),
    section: indexOf("section"),
    wireframe: indexOf("wireframe")
  };
  if (columns.name < 0) {
    return { ok: false, error: `缺少用例名列；当前表头：${sheet.headers.join("、")}` };
  }

  const warnings: string[] = [];
  const rows: DesignAssistedReport["rows"] = [];
  const rowText = new Map<
    number,
    { name: string; module: string; section: string; steps: string; expected: string }
  >();
  const rowHashes = new Map<number, string>();
  const unique = new Set<string>();
  sheet.rows.forEach((cells, rowIndex) => {
    const value = (index: number): string => (index < 0 ? "" : (cells[index] ?? "").trim());
    const rowNumber = rowIndex + 2;
    const name = value(columns.name);
    if (name === "") return;
    const module = value(columns.module) || path.parse(excelPath).name;
    const section = value(columns.section) || module;
    const caseId = value(columns.caseId) || `row-${rowNumber}`;
    const stepsText = value(columns.steps);
    const expectedText = value(columns.expected);
    rowText.set(rowNumber, { name, module, section, steps: stepsText, expected: expectedText });
    const rawWireframe = value(columns.wireframe);
    const screens = parseDesignScreens(rawWireframe, warnings);
    screens.forEach((screen) => unique.add(screen));
    const rowHash = rowFingerprint({
      caseId,
      module,
      section,
      name,
      steps: stepsText,
      expected: expectedText,
      wireframe: rawWireframe
    });
    rowHashes.set(rowNumber, rowHash);
    const matches = screens.map((screen) => {
      const key = cacheKey(excelSha8, rowHash, screen);
      seenCacheKeys.add(key);
      const cached = cacheEntries[key];
      let match: DesignMappingMatch;
      if (cached !== undefined) {
        if (cached.status === "unmapped" || cached.status === "ambiguous") {
          if (cached.indexFingerprint === indexFingerprint) {
            match = {
              screen,
              status: cached.status,
              design: null,
              candidates: cached.candidates
            };
            reused += 1;
          } else {
            match = matchScreen(screen, index.screens, threshold, maxCandidates);
            remapped += 1;
          }
        } else {
          const current = currentById.get(cached.designId);
          if (current !== undefined && screenFingerprint(current) === cached.designFingerprint) {
            match = {
              screen,
              status: cached.status,
              design: { id: cached.designId, name: cached.designName },
              candidates: cached.candidates,
              ...(cached.matchedBy === undefined ? {} : { matchedBy: cached.matchedBy })
            };
            reused += 1;
          } else {
            match = matchScreen(screen, index.screens, threshold, maxCandidates);
            remapped += 1;
          }
        }
      } else {
        match = matchScreen(screen, index.screens, threshold, maxCandidates);
        remapped += 1;
        added += 1;
      }
      const current = match.design === null ? undefined : currentById.get(match.design.id);
      cacheOut[key] = {
        excelSha8,
        rowHash,
        screen,
        designId: match.design?.id ?? "",
        designName: match.design?.name ?? "",
        designFingerprint: current === undefined ? "" : screenFingerprint(current),
        status: match.status,
        ...(match.matchedBy === "exact" ||
        match.matchedBy === "near" ||
        match.matchedBy === "llm"
          ? { matchedBy: match.matchedBy }
          : {}),
        candidates: match.candidates,
        indexFingerprint,
        updatedAt: new Date().toISOString()
      };
      return match;
    });
    const effectiveMatches = matches.map((match) => {
      const override =
        overrides.get(overrideKey(rowNumber, match.screen)) ??
        overrides.get(overrideKey(undefined, match.screen));
      if (override === undefined) return match;
      return {
        screen: match.screen,
        status: "exact" as const,
        design: { id: override.screenId, name: override.screenName ?? match.screen },
        candidates: [],
        matchedBy: "human" as const
      };
    });
    const structuralMatch =
      screens.length === 0
        ? matchScreen(
            `${name} ${stepsText} ${expectedText}`,
            index.screens,
            threshold,
            maxCandidates
          )
        : null;
    const structural =
      structuralMatch !== null && structuralMatch.status !== "unmapped"
        ? {
            status: "candidate" as const,
            matches:
              structuralMatch.candidates.length > 0
                ? structuralMatch.candidates
                : structuralMatch.design === null
                  ? []
                  : [{ ...structuralMatch.design, score: threshold }]
          }
        : undefined;
    const status =
      screens.length === 0
        ? structural !== undefined
          ? "review"
          : "no-wireframe"
        : effectiveMatches.every((match) => match.status === "exact")
          ? "matched"
          : effectiveMatches.some((match) => match.status === "unmapped")
            ? "unmapped"
            : "review";
    rows.push({
      rowNumber,
      caseId,
      module,
      section,
      name,
      status,
      screens: effectiveMatches,
      ...(structural === undefined ? {} : { structural })
    });
  });

  let llmCalls = 0;
  let llmMapped = 0;
  if (args.llmMapping === "auto") {
    let chat = args.chat;
    if (chat === undefined) {
      try {
        const entry = await runtime.activeEntry();
        if (entry === null || entry.baseUrl === null || entry.apiKey === null) {
          throw new Error("active LLM 缺少 baseUrl/apiKey");
        }
        chat = makeChatFn({
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
          model: entry.model
        });
      } catch (error) {
        warnings.push(
          `LLM 歧义映射不可用：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const maxLlmCalls =
      typeof args.maxLlmCalls === "number" && Number.isFinite(args.maxLlmCalls)
        ? Math.max(0, Math.floor(args.maxLlmCalls))
        : 20;
    if (chat !== undefined) {
      for (const row of rows) {
        if (llmCalls >= maxLlmCalls) break;
        const pending = row.screens.filter(
          (match) =>
            (match.status === "unmapped" || match.status === "ambiguous") &&
            match.candidates.length > 0
        );
        if (pending.length === 0) continue;
        const text = rowText.get(row.rowNumber);
        try {
          llmCalls += 1;
          const response = await chat([
            {
              role: "system",
              content:
                "You map Excel test cases to design screens. Choose only from the provided candidate ids. " +
                "Return a JSON array only: [{\"screen\":string,\"screenId\":string|null,\"confidence\":number,\"reason\":string}]. " +
                "Never invent ids. If no candidate fits, screenId=null."
            },
            {
              role: "user",
              content: JSON.stringify({
                case: text ?? { name: row.name },
                screens: pending.map((match) => ({
                  screen: match.screen,
                  candidates: match.candidates.map((candidate) => ({
                    id: candidate.id,
                    name: candidate.name,
                    score: candidate.score
                  }))
                }))
              })
            }
          ]);
          const parsed = parseLlmMappings(response);
          for (const item of parsed) {
            if (typeof item.screen !== "string" || typeof item.screenId !== "string") continue;
            const match = pending.find((entry) => entry.screen === item.screen);
            if (match === undefined) continue;
            const candidate = match.candidates.find((entry) => entry.id === item.screenId);
            if (candidate === undefined) continue;
            const confidence =
              typeof item.confidence === "number" && Number.isFinite(item.confidence)
                ? item.confidence
                : 0;
            if (confidence < threshold) continue;
            match.status = "near";
            match.design = { id: candidate.id, name: candidate.name };
            match.matchedBy = "llm";
            llmMapped += 1;
            const rowHash = rowHashes.get(row.rowNumber);
            if (rowHash !== undefined) {
              const current = currentById.get(candidate.id);
              cacheOut[cacheKey(excelSha8, rowHash, match.screen)] = {
                excelSha8,
                rowHash,
                screen: match.screen,
                designId: candidate.id,
                designName: candidate.name,
                designFingerprint: current === undefined ? "" : screenFingerprint(current),
                status: "near",
                matchedBy: "llm",
                candidates: match.candidates,
                indexFingerprint,
                updatedAt: new Date().toISOString()
              };
            }
          }
        } catch (error) {
          warnings.push(
            `LLM 映射失败（${row.caseId}）：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      for (const row of rows) {
        if (row.screens.length === 0) continue;
        row.status = row.screens.every((match) => match.status === "exact")
          ? "matched"
          : row.screens.some((match) => match.status === "unmapped")
            ? "unmapped"
            : "review";
      }
    }
  }

  let removed = 0;
  for (const [key, entry] of Object.entries(cacheOut)) {
    if (entry.excelSha8 === excelSha8 && !seenCacheKeys.has(key)) {
      delete cacheOut[key];
      removed += 1;
    }
  }
  if (deltaEnabled && args.save !== false) {
    try {
      writeMappingCache(cacheFile, excelSha8, cacheOut);
    } catch (error) {
      warnings.push(
        `写 mapping-cache 失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const screenStatus = { exact: 0, near: 0, ambiguous: 0, unmapped: 0 };
  const seen = new Map<string, DesignMappingMatch>();
  for (const row of rows) {
    for (const match of row.screens) {
      if (!seen.has(match.screen)) {
        seen.set(match.screen, match);
        screenStatus[match.status] += 1;
      }
    }
  }
  if (screenStatus.ambiguous > 0) {
    warnings.push(
      `同名多 id/近分差过小：${screenStatus.ambiguous} 个屏 ambiguous，apply 不自动写入，需 overrides（可省略 rowNumber 做屏级确认）`
    );
  }
  const report: DesignAssistedReport = {
    schemaVersion: 1,
    mode: "preview",
    generatedAt: new Date().toISOString(),
    source: {
      excel: excelPath,
      ...(args.sourceName === undefined ? {} : { sourceName: args.sourceName }),
      excelSha8,
      designIndex: index.path,
      designIndexKind: index.kind,
      screenCount: index.screens.length
    },
    summary: {
      rows: rows.length,
      withWireframe: rows.filter((row) => row.screens.length > 0).length,
      withoutWireframe: rows.filter((row) => row.screens.length === 0).length,
      uniqueScreens: unique.size,
      screenStatus,
      rowStatus: {
        matched: rows.filter((row) => row.status === "matched").length,
        review: rows.filter((row) => row.status === "review").length,
        unmapped: rows.filter((row) => row.status === "unmapped").length,
        "no-wireframe": rows.filter((row) => row.status === "no-wireframe").length
      },
      structuralCandidates: rows.filter((row) => row.structural !== undefined).length,
      humanMapped: rows.filter((row) =>
        row.screens.some((match) => match.matchedBy === "human")
      ).length,
      llmMapped,
      llmCalls
    },
    rows,
    warnings,
    delta: { reused, remapped, added, removed }
  };

  try {
    persistOverrides(runtime, args, excelSha8, overrides);
  } catch (error) {
    report.warnings.push(
      `保存 enrich-overrides 失败：${error instanceof Error ? error.message : String(error)}`
    );
  }

  const mappingContext = {
    columns: {
      wireframe: mapping.wireframe ?? null,
      section: mapping.section ?? null
    },
    summary: report.summary,
    warnings: report.warnings,
    overridesPath: overridesFilePath(runtime, args)
  };
  const allowNear = args.allowNear === true;
  const blockingRows = rows.filter((row) =>
    row.screens.some(
      (match) =>
        match.status === "unmapped" ||
        match.status === "ambiguous" ||
        (allowNear !== true && match.status === "near")
    )
  ).length;
  const applicableScreens =
    report.summary.screenStatus.exact + (allowNear ? report.summary.screenStatus.near : 0);
  let needsInfo: DesignNeedsInfo | undefined;
  if (columns.wireframe >= 0 && report.summary.withWireframe === 0) {
    needsInfo = {
      needs: "info",
      category: "excel-wireframe-unresolved",
      questions: [
        "已识别 Wireframe/设计引用列，但没有解析出有效设计屏名；请检查该列内容，或用 columns 指定正确表头。"
      ],
      context: mappingContext
    };
  } else if (args.apply === true && args.requireAllMapped === true && blockingRows > 0) {
    needsInfo = {
      needs: "info",
      category: "excel-mapping-review",
      questions: [
        `拒绝 apply：存在 ${blockingRows} 行需要确认（unmapped ${report.summary.rowStatus.unmapped}、ambiguous ${report.summary.screenStatus.ambiguous} 屏、near ${report.summary.screenStatus.near} 屏${allowNear ? "（已开启 allowNear）" : ""}）；请用 overrides 确认，或关闭 requireAllMapped。`
      ],
      context: mappingContext
    };
  } else if (
    args.apply === true &&
    report.summary.withWireframe > 0 &&
    applicableScreens === 0
  ) {
    needsInfo = {
      needs: "info",
      category: "excel-mapping-no-exact",
      questions: [
        `Wireframe 有 ${report.summary.withWireframe} 行，但没有可应用的映射（exact ${report.summary.screenStatus.exact}，ambiguous ${report.summary.screenStatus.ambiguous}，near ${report.summary.screenStatus.near}${allowNear ? "，已开启 allowNear" : ""}）；请先用 overrides 确认 ambiguous/near，或提供更完整的设计索引。`
      ],
      context: mappingContext
    };
  } else if (args.apply === true && blockingRows > 0) {
    needsInfo = {
      needs: "info",
      category: "excel-mapping-partial",
      questions: [
        `apply 可应用 ${applicableScreens} 个屏映射；仍有 ${blockingRows} 行需要确认（unmapped/ambiguous${allowNear ? "" : "/near"}），未自动应用。`
      ],
      context: mappingContext
    };
  }
  if (needsInfo !== undefined && args.apply === true && needsInfo.category !== "excel-mapping-partial") {
    return {
      ok: false,
      error: needsInfo.questions[0] ?? needsInfo.category,
      needs: "info",
      category: needsInfo.category,
      questions: needsInfo.questions,
      context: needsInfo.context,
      report
    };
  }

  let applied: { sourceId: string; sets: unknown[]; warnings: string[] } | undefined;
  if (args.apply === true) {
    const byRow = new Map<number, DesignRowMapping>();
    for (const row of rows) {
      if (row.screens.length === 0) continue;
      byRow.set(row.rowNumber, {
        screens: row.screens.map((match) => match.screen),
        nodeIds: row.screens.map((match) => {
          const accepted =
            match.status === "exact" || (args.allowNear === true && match.status === "near");
          return accepted ? (match.design?.id ?? "") : "";
        })
      });
    }
    if (byRow.size === 0) {
      return {
        ok: false,
        error: "没有可应用的设计映射（Wireframe 全部为空/无效）",
        needs: "info",
        category: "excel-wireframe-unresolved",
        questions: ["没有可应用的 Wireframe/设计屏；请确认列内容或用 columns 指定正确表头。"],
        context: mappingContext,
        report
      };
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([...byRow.entries()].sort((left, right) => left[0] - right[0])))
      .digest("hex")
      .slice(0, 8);
    const columns = columnsForImport(args.columns);
    const imported = await importTestDocument(runtime, {
      excelPath,
      ...(args.sourceName === undefined ? {} : { sourceName: args.sourceName }),
      ...(columns === undefined ? {} : { columns }),
      sourceIdSuffix: `+design:${fingerprint}`,
      designRefsByRow: byRow
    });
    if (!imported.ok) {
      return { ok: false, error: `enriched 用例集生成失败：${imported.error}`, report };
    }
    applied = {
      sourceId: imported.sourceId,
      sets: imported.sets,
      warnings: imported.warnings
    };
  }

  if (args.save === false) {
    return {
      ok: true,
      report,
      artifacts: null,
      ...(applied === undefined ? {} : { apply: applied }),
      ...(needsInfo === undefined ? {} : { needsInfo })
    };
  }
  const outDir = path.join(runtime.configDirAbs, "design", "enrich");
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${report.source.excelSha8}-${path.parse(excelPath).name.replace(/[^\p{L}\p{N}._-]+/gu, "-")}`;
  const jsonPath = path.join(outDir, `${base}.mapping.json`);
  const mdPath = path.join(outDir, `${base}.mapping.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, reportMarkdown(report));
  return {
    ok: true,
    report,
    artifacts: { jsonPath, mdPath },
    ...(applied === undefined ? {} : { apply: applied }),
    ...(needsInfo === undefined ? {} : { needsInfo })
  };
}
