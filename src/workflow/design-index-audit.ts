import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../runtime.js";
import {
  normalizeExcelHeader,
  suggestExcelMapping,
  type ExcelColumnMap
} from "../web/excel-columns.js";
import { readCaseSheet } from "./excel.js";
import { parseDesignScreens } from "./excel-import.js";
import {
  loadDesignIndex,
  matchScreen,
  normalizeName,
  parseScreenIndex,
  resolveProjectPath,
  type DesignIndexArgs,
  type DesignMappingCandidate,
  type DesignScreenIndexEntry
} from "./design-enrich.js";

export interface DesignIndexAuditArgs extends DesignIndexArgs {
  /** 可选 Excel：审计 Wireframe 名称覆盖率。 */
  excelPath?: string;
  columns?: Record<string, string>;
  threshold?: number;
  maxCandidates?: number;
  /** 保存审计报告到 .artemis/design/enrich/index-audit.json，默认 true。 */
  save?: boolean;
  outPath?: string;
}

interface DuplicateStat {
  count: number;
  samples: string[];
}

export interface DesignIndexAuditReport {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    index: string;
    kind: "screen-index" | "flows" | "ui-contract";
    screens: number;
  };
  integrity: {
    entries: number;
    parsedScreens: number;
    filteredEntries: number;
    duplicateIds: DuplicateStat;
    duplicateNames: DuplicateStat;
    emptyIds: number;
    shortNames: number;
    wrongTypes: number;
    textHintScreens: number;
    elementScreens: number;
  };
  crossSource: {
    kind: "flows" | "ui-contract";
    path: string;
    screens: number;
    idOverlap: number;
    nameOverlap: number;
    onlyInIndex: DuplicateStat;
    onlyInReference: DuplicateStat;
  } | null;
  excel: {
    path: string;
    rows: number;
    withWireframe: number;
    withoutWireframe: number;
    uniqueScreens: number;
    exact: number;
    near: number;
    ambiguous: number;
    unmapped: number;
    screensNotReferenced: number;
    unmatched: Array<{
      screen: string;
      candidates: DesignMappingCandidate[];
    }>;
    needsReview: Array<{
      screen: string;
      candidates: DesignMappingCandidate[];
    }>;
  } | null;
  warnings: string[];
}

export type DesignIndexAuditResult =
  | {
      ok: true;
      report: DesignIndexAuditReport;
      artifacts: { jsonPath: string } | null;
    }
  | { ok: false; error: string };

function sample(values: string[], limit = 20): string[] {
  return values.slice(0, limit);
}

function duplicateStat(values: string[]): DuplicateStat {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
  return { count: duplicates.length, samples: sample(duplicates) };
}

function rawIndexStats(file: string): {
  entries: number;
  emptyIds: number;
  shortNames: number;
  wrongTypes: number;
} {
  let list: unknown[] = [];
  let isNodes = false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      screens?: unknown;
      nodes?: unknown;
    };
    isNodes = Array.isArray(raw.nodes);
    list = isNodes
      ? (raw.nodes as unknown[])
      : Array.isArray(raw.screens)
        ? (raw.screens as unknown[])
        : [];
  } catch {
    return { entries: 0, emptyIds: 0, shortNames: 0, wrongTypes: 0 };
  }
  let emptyIds = 0;
  let shortNames = 0;
  let wrongTypes = 0;
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { id?: unknown; name?: unknown; type?: unknown };
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (id === "") emptyIds += 1;
    if (name.length < 4) shortNames += 1;
    if (isNodes) {
      const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
      if (!["FRAME", "COMPONENT", "INSTANCE", "SECTION"].includes(type)) wrongTypes += 1;
    }
  }
  return { entries: list.length, emptyIds, shortNames, wrongTypes };
}

function loadReferenceIndex(
  runtime: Runtime,
  args: DesignIndexAuditArgs
): { path: string; kind: "flows" | "ui-contract"; screens: DesignScreenIndexEntry[] } | null {
  const flows = args.flowsPath?.trim() ?? "";
  const flowsPath =
    flows !== ""
      ? resolveProjectPath(runtime, flows)
      : path.join(runtime.configDirAbs, "design", "flows.json");
  const contractPath = path.join(runtime.configDirAbs, "design", "ui-contract.json");
  const target = fs.existsSync(flowsPath)
    ? flowsPath
    : fs.existsSync(contractPath)
      ? contractPath
      : null;
  if (target === null) return null;
  try {
    const screens = parseScreenIndex(JSON.parse(fs.readFileSync(target, "utf8")));
    if (screens.length === 0) return null;
    return {
      path: target,
      kind: target === contractPath ? "ui-contract" : "flows",
      screens
    };
  } catch {
    return null;
  }
}

function crossSourceAudit(
  indexPath: string,
  index: DesignScreenIndexEntry[],
  reference: { path: string; kind: "flows" | "ui-contract"; screens: DesignScreenIndexEntry[] } | null
): DesignIndexAuditReport["crossSource"] {
  if (reference === null || reference.path === indexPath) return null;
  const indexIds = new Set(index.map((screen) => screen.id));
  const referenceIds = new Set(reference.screens.map((screen) => screen.id));
  const indexNames = new Set(index.map((screen) => normalizeName(screen.name)));
  const referenceNames = new Set(reference.screens.map((screen) => normalizeName(screen.name)));
  const onlyInIndex = index.filter((screen) => !referenceIds.has(screen.id)).map((screen) => screen.name);
  const onlyInReference = reference.screens
    .filter((screen) => !indexIds.has(screen.id))
    .map((screen) => screen.name);
  let idOverlap = 0;
  for (const id of indexIds) if (referenceIds.has(id)) idOverlap += 1;
  let nameOverlap = 0;
  for (const name of indexNames) if (referenceNames.has(name)) nameOverlap += 1;
  return {
    kind: reference.kind,
    path: reference.path,
    screens: reference.screens.length,
    idOverlap,
    nameOverlap,
    onlyInIndex: { count: onlyInIndex.length, samples: sample(onlyInIndex) },
    onlyInReference: { count: onlyInReference.length, samples: sample(onlyInReference) }
  };
}

async function auditExcel(
  runtime: Runtime,
  args: DesignIndexAuditArgs,
  index: DesignScreenIndexEntry[],
  warnings: string[]
): Promise<DesignIndexAuditReport["excel"] | { error: string }> {
  if (args.excelPath === undefined || args.excelPath.trim() === "") return null;
  const excelPath = resolveProjectPath(runtime, args.excelPath);
  let sheet;
  try {
    sheet = await readCaseSheet(excelPath);
  } catch (error) {
    return { error: `无法读取 Excel：${error instanceof Error ? error.message : String(error)}` };
  }
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
  const wireframe = indexOf("wireframe");
  if (wireframe < 0) {
    warnings.push(`未识别 Wireframe 列；当前表头：${sheet.headers.join("、")}`);
  }
  const threshold =
    typeof args.threshold === "number" && Number.isFinite(args.threshold)
      ? Math.min(1, Math.max(0, args.threshold))
      : 0.7;
  const maxCandidates =
    typeof args.maxCandidates === "number" && Number.isFinite(args.maxCandidates)
      ? Math.max(1, Math.min(10, Math.floor(args.maxCandidates)))
      : 3;
  const seen = new Set<string>();
  const screens: string[] = [];
  let withWireframe = 0;
  sheet.rows.forEach((cells) => {
    const raw = wireframe < 0 ? "" : (cells[wireframe] ?? "");
    if (raw !== "") withWireframe += 1;
    for (const screen of parseDesignScreens(raw, warnings)) {
      const key = screen.trim();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      screens.push(screen);
    }
  });
  const matches = screens.map((screen) =>
    matchScreen(screen, index, threshold, maxCandidates)
  );
  const exact = matches.filter((match) => match.status === "exact").length;
  const near = matches.filter((match) => match.status === "near").length;
  const ambiguous = matches.filter((match) => match.status === "ambiguous").length;
  const unmapped = matches.filter((match) => match.status === "unmapped").length;
  const referenced = new Set(screens.map((screen) => normalizeName(screen)));
  const screensNotReferenced = index.filter(
    (screen) => !referenced.has(normalizeName(screen.name))
  ).length;
  return {
    path: excelPath,
    rows: sheet.rows.length,
    withWireframe,
    withoutWireframe: sheet.rows.length - withWireframe,
    uniqueScreens: screens.length,
    exact,
    near,
    ambiguous,
    unmapped,
    screensNotReferenced,
    unmatched: matches
      .filter((match) => match.status === "unmapped")
      .map((match) => ({ screen: match.screen, candidates: match.candidates })),
    needsReview: matches
      .filter((match) => match.status === "ambiguous")
      .map((match) => ({ screen: match.screen, candidates: match.candidates }))
  };
}

export async function auditDesignIndex(
  runtime: Runtime,
  args: DesignIndexAuditArgs
): Promise<DesignIndexAuditResult> {
  const index = loadDesignIndex(runtime, args);
  if ("error" in index) return { ok: false, error: index.error };
  const warnings: string[] = [];
  const raw = rawIndexStats(index.path);
  const reference =
    args.screenIndexPath !== undefined && args.screenIndexPath.trim() !== ""
      ? loadReferenceIndex(runtime, args)
      : null;
  const excel = await auditExcel(runtime, args, index.screens, warnings);
  if (excel !== null && "error" in excel) return { ok: false, error: excel.error };
  const report: DesignIndexAuditReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      index: index.path,
      kind: index.kind,
      screens: index.screens.length
    },
    integrity: {
      entries: raw.entries,
      parsedScreens: index.screens.length,
      filteredEntries: Math.max(0, raw.entries - index.screens.length),
      duplicateIds: duplicateStat(index.screens.map((screen) => screen.id)),
      duplicateNames: duplicateStat(index.screens.map((screen) => screen.name)),
      emptyIds: raw.emptyIds,
      shortNames: raw.shortNames,
      wrongTypes: raw.wrongTypes,
      textHintScreens: index.screens.filter((screen) => screen.textHints.length > 0).length,
      elementScreens: index.screens.filter((screen) => screen.elements.length > 0).length
    },
    crossSource: crossSourceAudit(index.path, index.screens, reference),
    excel,
    warnings
  };
  if (report.integrity.duplicateIds.count > 0) {
    warnings.push(`设计索引存在重复 id：${report.integrity.duplicateIds.count} 个`);
  }
  if (report.integrity.duplicateNames.count > 0) {
    warnings.push(`设计索引存在重复屏名：${report.integrity.duplicateNames.count} 个`);
  }
  if (report.crossSource !== null && report.crossSource.onlyInIndex.count > 0) {
    warnings.push(
      `显式索引有 ${report.crossSource.onlyInIndex.count} 屏不在 ${report.crossSource.kind} 中`
    );
  }
  if (excel !== null && excel.ambiguous > 0) {
    warnings.push(`Excel Wireframe 有 ${excel.ambiguous} 个屏同名多 id（ambiguous，需人工确认）`);
  }
  if (excel !== null && excel.unmapped > 0) {
    warnings.push(`Excel Wireframe 有 ${excel.unmapped} 个屏未映射`);
  }
  let artifacts: { jsonPath: string } | null = null;
  if (args.save !== false) {
    const outPath =
      args.outPath !== undefined && args.outPath.trim() !== ""
        ? resolveProjectPath(runtime, args.outPath)
        : path.join(runtime.configDirAbs, "design", "enrich", "index-audit.json");
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
      artifacts = { jsonPath: outPath };
    } catch (error) {
      warnings.push(
        `写 index-audit 报告失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { ok: true, report, artifacts };
}
