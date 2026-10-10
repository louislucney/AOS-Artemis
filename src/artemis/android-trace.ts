import fs from "node:fs";

/** Android (ARTEMIS) trace observations read from the project's
 * `data_engine.db` (SQLite, written by the pinned artemis submodule):
 * per-step OCR labels and normalized tap points for element-level discovery
 * and exploration reconciliation. Degrades to `null` when the DB, the
 * `node:sqlite` module (Node >= 22.5), or the expected schema is unavailable. */

export interface AndroidTraceStep {
  stepNumber: number;
  action: string | null;
  /** OCR texts recorded with the step's screen image. */
  labels: string[];
}

export interface AndroidTraceObservations {
  steps: AndroidTraceStep[];
  /** Distinct OCR labels across the run. */
  labels: string[];
  /** Normalized (0..1) tap points (coordinate_space=normalized, 0..1000). */
  taps: Array<{ relX: number; relY: number }>;
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

export async function readAndroidTraceObservations(
  dbPath: string,
  traceId: string
): Promise<AndroidTraceObservations | null> {
  if (!fs.existsSync(dbPath)) return null;
  const db = await openReadOnlyDb(dbPath);
  if (!db) return null;
  try {
    const rows = db
      .prepare(
        "SELECT step_number, action_taken, pre_image_name, post_image_name FROM steps WHERE session_id = ? ORDER BY step_number"
      )
      .all(traceId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return null;
    const imageStatement = db.prepare("SELECT ocr_result FROM images WHERE image_name = ?");
    const steps: AndroidTraceStep[] = [];
    const labels = new Set<string>();
    const taps: Array<{ relX: number; relY: number }> = [];
    for (const row of rows) {
      const imageName =
        typeof row.pre_image_name === "string" && row.pre_image_name !== ""
          ? row.pre_image_name
          : typeof row.post_image_name === "string" && row.post_image_name !== ""
            ? row.post_image_name
            : null;
      let texts: string[] = [];
      if (imageName) {
        const imageRow = imageStatement.all(imageName)[0] as Record<string, unknown> | undefined;
        texts = ocrTextsOf(imageRow?.ocr_result);
      }
      for (const text of texts) labels.add(text);
      const action = jsonOf(row.action_taken);
      const tap = normalizedTapOf(row.action_taken);
      if (tap) taps.push(tap);
      steps.push({
        stepNumber: typeof row.step_number === "number" ? row.step_number : steps.length + 1,
        action:
          action && typeof action === "object" && !Array.isArray(action) &&
          typeof (action as { action?: unknown }).action === "string"
            ? ((action as { action: string }).action)
            : null,
        labels: texts
      });
    }
    return { steps, labels: [...labels], taps };
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
