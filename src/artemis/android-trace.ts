import fs from "node:fs";
import path from "node:path";

import { logWarn } from "../log.js";

/** Android (ARTEMIS) trace observations read from the project's
 * `data_engine.db` (SQLite, written by the pinned artemis submodule):
 * per-step OCR labels and normalized tap points for element-level discovery
 * and exploration reconciliation. Degrades to `null` when the DB, the
 * `node:sqlite` module (Node >= 22.5), or the expected schema is unavailable;
 * schema drift is probed explicitly (PRAGMA table_info) and logged — the
 * bounded read-only binding is recorded in ADR-0009. */

export interface AndroidTraceStep {
  stepNumber: number;
  action: string | null;
  /** OCR texts recorded with the step's pre-action screen image. */
  preLabels: string[];
  /** OCR texts recorded with the step's post-action screen image (when present). */
  postLabels: string[];
  /** Visible texts from the step's UI tree (fallback when OCR is empty). */
  preTreeLabels: string[];
  postTreeLabels: string[];
}

export interface AndroidTraceObservations {
  steps: AndroidTraceStep[];
  /** Distinct OCR labels across the run. */
  labels: string[];
  /** Normalized (0..1) tap points (coordinate_space=normalized, 0..1000). */
  taps: Array<{ relX: number; relY: number }>;
  /** Observed screen transitions without design filtering (pre≠post label sets). */
  transitions: Array<{ fromLabels: string[]; toLabels: string[] }>;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

async function openReadOnlyDb(dbPath: string): Promise<SqliteDb | null> {
  try {
    const module = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
    };
    return new module.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  steps: ["session_id", "step_number", "action_taken", "pre_image_name", "post_image_name"],
  images: ["image_name", "ocr_result"]
};

/** 显式 schema 守卫（ADR-0009）：data_engine.db 无 user_version，只能按列探测；
 * 返回缺失清单（空数组 = 契约满足）。 */
function schemaGaps(db: SqliteDb): string[] {
  const gaps: string[] = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    let names: string[];
    try {
      const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{
        name?: unknown;
      }>;
      names = rows.map((row) => (typeof row.name === "string" ? row.name : ""));
    } catch {
      gaps.push(`${table} 不可读`);
      continue;
    }
    if (names.length === 0) {
      gaps.push(`缺表 ${table}`);
      continue;
    }
    for (const column of columns) {
      if (!names.includes(column)) gaps.push(`${table} 缺列 ${column}`);
    }
  }
  return gaps;
}

function jsonOf(value: unknown): unknown {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function ocrTextsOf(raw: unknown): string[] {
  const parsed = jsonOf(raw);
  if (!Array.isArray(parsed)) return [];
  const texts: string[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const text = (entry as { text?: unknown }).text;
    if (typeof text === "string" && text.trim() !== "") texts.push(text.trim());
  }
  return texts;
}

const UI_TREE_TEXT_KEYS = [
  "text",
  "content-desc",
  "contentDesc",
  "accessibilityText",
  "accessibility_text"
];

function uiTreeTextsOf(raw: unknown): string[] {
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      const texts = new Set<string>();
      for (const match of raw.matchAll(
        /(?:text|content-desc|contentDesc|accessibilityText|accessibility_text)="([^"]*)"/g
      )) {
        const value = match[1]?.trim() ?? "";
        if (value !== "") texts.add(value);
      }
      return [...texts];
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) return [];
  const texts = new Set<string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    for (const key of UI_TREE_TEXT_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") texts.add(value.trim());
    }
  }
  return [...texts];
}

const TAP_ACTIONS = new Set(["tap", "click", "long_press"]);

function normalizedTapOf(raw: unknown): { relX: number; relY: number } | null {
  const record = jsonOf(raw);
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const action = (record as { action?: unknown }).action;
  if (typeof action !== "string" || !TAP_ACTIONS.has(action)) return null;
  if ((record as { coordinate_space?: unknown }).coordinate_space !== "normalized") return null;
  const coordinates = (record as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const x = coordinates[0];
  const y = coordinates[1];
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    return null;
  }
  return { relX: x / 1000, relY: y / 1000 };
}

export interface AndroidTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  stepNumber: number;
}

function tokenNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

/** 从 `steps.extra_metadata.token_usage` 读取逐步 token；schema 不匹配/无数据 → null。 */
export async function readAndroidTokenUsage(
  dbPath: string,
  traceId: string
): Promise<AndroidTokenUsage[] | null> {
  if (!fs.existsSync(dbPath)) return null;
  const db = await openReadOnlyDb(dbPath);
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT step_number, extra_metadata FROM steps WHERE session_id = ? ORDER BY step_number"
      )
      .all(traceId) as Array<Record<string, unknown>>;
    const out: AndroidTokenUsage[] = [];
    for (const row of rows) {
      const metadata = jsonOf(row.extra_metadata);
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const usage = (metadata as Record<string, unknown>).token_usage;
      if (usage === null || typeof usage !== "object" || Array.isArray(usage)) continue;
      const record = usage as Record<string, unknown>;
      out.push({
        stepNumber:
          typeof row.step_number === "number" ? row.step_number : out.length + 1,
        inputTokens: tokenNumber(record, ["input_tokens", "prompt_token_count"]),
        outputTokens: tokenNumber(record, ["output_tokens", "candidates_token_count"]),
        cacheCreateTokens: tokenNumber(record, [
          "cache_create_tokens",
          "cache_creation_input_tokens"
        ]),
        cacheReadTokens: tokenNumber(record, ["cache_read_tokens", "cached_content_token_count"]),
        totalTokens: tokenNumber(record, ["total_tokens"])
      });
    }
    return out.length === 0 ? null : out;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 最后一步的 post/pre 截图路径（images/ 与 data_engine.db 同级）；找不到返回 null。 */
export async function readAndroidLastScreenshot(
  dbPath: string,
  traceId: string
): Promise<string | null> {
  if (!fs.existsSync(dbPath)) return null;
  const db = await openReadOnlyDb(dbPath);
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT post_image_name, pre_image_name FROM steps WHERE session_id = ? ORDER BY step_number DESC"
      )
      .all(traceId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      for (const key of ["post_image_name", "pre_image_name"] as const) {
        const name = row[key];
        if (typeof name !== "string" || name === "") continue;
        const file = path.join(path.dirname(dbPath), "images", `${name}.jpg`);
        if (fs.existsSync(file)) return file;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function readAndroidTraceObservations(
  dbPath: string,
  traceId: string
): Promise<AndroidTraceObservations | null> {
  if (!fs.existsSync(dbPath)) return null;
  const db = await openReadOnlyDb(dbPath);
  if (!db) return null;
  try {
    const gaps = schemaGaps(db);
    if (gaps.length > 0) {
      logWarn(`android 对账读取跳过：data_engine schema 不匹配（${gaps.join("；")}）`);
      return null;
    }
    const rows = db
      .prepare(
        "SELECT step_number, action_taken, pre_image_name, post_image_name FROM steps WHERE session_id = ? ORDER BY step_number"
      )
      .all(traceId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const imageStatement = db.prepare("SELECT ocr_result FROM images WHERE image_name = ?");
    let treeStatement: SqliteStatement | null = null;
    try {
      const columns = db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all("images") as Array<{ name?: unknown }>;
      if (columns.some((row) => row.name === "ui_tree")) {
        treeStatement = db.prepare("SELECT ui_tree FROM images WHERE image_name = ?");
      }
    } catch {
      treeStatement = null;
    }
    const labelsOfImage = (name: unknown): string[] => {
      if (typeof name !== "string" || name === "") return [];
      const imageRow = imageStatement.all(name)[0] as Record<string, unknown> | undefined;
      return ocrTextsOf(imageRow?.ocr_result);
    };
    const treeLabelsOfImage = (name: unknown): string[] => {
      if (treeStatement === null || typeof name !== "string" || name === "") return [];
      const imageRow = treeStatement.all(name)[0] as Record<string, unknown> | undefined;
      return uiTreeTextsOf(imageRow?.ui_tree);
    };
    const steps: AndroidTraceStep[] = [];
    const labels = new Set<string>();
    const taps: Array<{ relX: number; relY: number }> = [];
    const transitions: Array<{ fromLabels: string[]; toLabels: string[] }> = [];
    const seenTransitions = new Set<string>();
    for (const row of rows) {
      const preLabels = labelsOfImage(row.pre_image_name);
      const postLabels = labelsOfImage(row.post_image_name);
      const preTreeLabels = treeLabelsOfImage(row.pre_image_name);
      const postTreeLabels = treeLabelsOfImage(row.post_image_name);
      for (const text of [...preLabels, ...postLabels]) labels.add(text);
      const action = jsonOf(row.action_taken);
      const tap = normalizedTapOf(row.action_taken);
      if (tap) taps.push(tap);
      if (preLabels.length > 0 && postLabels.length > 0) {
        const fromKey = [...preLabels].sort().join("\u0000");
        const toKey = [...postLabels].sort().join("\u0000");
        if (fromKey !== toKey) {
          const pairKey = `${fromKey}\u0001${toKey}`;
          if (!seenTransitions.has(pairKey)) {
            seenTransitions.add(pairKey);
            transitions.push({ fromLabels: preLabels, toLabels: postLabels });
          }
        }
      }
      steps.push({
        stepNumber: typeof row.step_number === "number" ? row.step_number : steps.length + 1,
        action:
          action && typeof action === "object" && !Array.isArray(action) &&
          typeof (action as { action?: unknown }).action === "string"
            ? ((action as { action: string }).action)
            : null,
        preLabels,
        postLabels,
        preTreeLabels,
        postTreeLabels
      });
    }
    return { steps, labels: [...labels], taps, transitions };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* best effort */
    }
  }
}
