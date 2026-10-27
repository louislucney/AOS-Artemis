import fs from "node:fs";

import { writeFileAtomic } from "../util.js";
import type { UiParityFinding } from "./parity.js";
import { normalizeUiText } from "./semantics.js";

export type UiParityBaselineTool = "ui-parity" | "check-dynamic";

export interface UiParityBaselineEntry {
  tool: UiParityBaselineTool;
  screenId?: string;
  caseId?: string;
  kind: string;
  text: string;
  role?: string;
}

export interface UiParityBaselineFile {
  version: 1;
  entries: UiParityBaselineEntry[];
}

export interface UiParityBaselineLoadResult {
  file: UiParityBaselineFile | null;
  path: string;
  errors: string[];
}

const TOOLS = new Set<UiParityBaselineTool>(["ui-parity", "check-dynamic"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function baselineEntryKey(entry: UiParityBaselineEntry): string {
  const tool = entry.tool;
  const screen = (entry.screenId ?? "").trim().toLowerCase();
  const caseId = (entry.caseId ?? "").trim().toLowerCase();
  const kind = entry.kind.trim();
  const text = normalizeUiText(entry.text);
  const role = (entry.role ?? "").trim().toLowerCase();
  return [tool, screen, caseId, kind, text, role].join("\u0000");
}

export function loadUiParityBaseline(file: string): UiParityBaselineLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { file: null, path: file, errors: [`baseline not found: ${file}`] };
    }
    return {
      file: null,
      path: file,
      errors: [`cannot read baseline ${file}: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      file: null,
      path: file,
      errors: [`baseline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  if (!isObject(parsed)) {
    return { file: null, path: file, errors: ["baseline root must be an object"] };
  }
  if (parsed.version !== 1) {
    return { file: null, path: file, errors: ["baseline version: expected 1"] };
  }
  if (!Array.isArray(parsed.entries)) {
    return { file: null, path: file, errors: ["baseline entries: expected array"] };
  }
  const errors: string[] = [];
  const entries: UiParityBaselineEntry[] = [];
  for (const [index, entry] of parsed.entries.entries()) {
    if (!isObject(entry)) {
      errors.push(`entries[${index}]: expected object`);
      continue;
    }
    const tool = stringOrUndefined(entry.tool);
    const kind = stringOrUndefined(entry.kind);
    const text = stringOrUndefined(entry.text);
    const screenId = stringOrUndefined(entry.screenId);
    const caseId = stringOrUndefined(entry.caseId);
    const role = stringOrUndefined(entry.role);
    if (tool === undefined || tool === null || !TOOLS.has(tool as UiParityBaselineTool)) {
      errors.push(`entries[${index}].tool: expected ui-parity | check-dynamic`);
      continue;
    }
    if (kind === undefined || kind === null) {
      errors.push(`entries[${index}].kind: expected non-empty string`);
      continue;
    }
    if (text === undefined || text === null) {
      errors.push(`entries[${index}].text: expected non-empty string`);
      continue;
    }
    if (screenId === null || caseId === null || role === null) {
      errors.push(`entries[${index}]: optional fields must be strings when present`);
      continue;
    }
    entries.push({
      tool: tool as UiParityBaselineTool,
      kind,
      text,
      ...(screenId !== undefined ? { screenId } : {}),
      ...(caseId !== undefined ? { caseId } : {}),
      ...(role !== undefined ? { role } : {})
    });
  }
  if (errors.length > 0) return { file: null, path: file, errors };
  return { file: { version: 1, entries }, path: file, errors: [] };
}

export function writeUiParityBaseline(file: string, entries: readonly UiParityBaselineEntry[]): void {
  const byKey = new Map<string, UiParityBaselineEntry>();
  for (const entry of entries) {
    const key = baselineEntryKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  const sorted = [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry);
  writeFileAtomic(file, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
}

export function partitionByBaseline(
  findings: readonly UiParityFinding[],
  file: UiParityBaselineFile,
  context: { screenId: string; tool: "ui-parity" }
): { fresh: UiParityFinding[]; baselined: UiParityFinding[] } {
  const keys = new Set(file.entries.map((entry) => baselineEntryKey(entry)));
  const fresh: UiParityFinding[] = [];
  const baselined: UiParityFinding[] = [];
  for (const finding of findings) {
    if (finding.severity === "info") {
      fresh.push(finding);
      continue;
    }
    const key = baselineEntryKey({
      tool: context.tool,
      screenId: context.screenId,
      kind: finding.kind,
      text: finding.designText ?? finding.text,
      ...(finding.role !== undefined ? { role: finding.role } : {})
    });
    if (keys.has(key)) {
      baselined.push({ ...finding, baselined: true });
    } else {
      fresh.push(finding);
    }
  }
  return { fresh, baselined };
}
