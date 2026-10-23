import fs from "node:fs";

export interface ParityCase {
  semanticId: string;
  displayId: string | null;
  name: string;
  screens: string[];
  humanSteps: string[];
  preconditions: string[];
  expectations: unknown[];
  testData: string[];
  section: string | null;
  module: string | null;
  /** 旧产物没有 humanSteps，标记后给 warning。 */
  legacySteps: boolean;
}

export interface ParityDoc {
  path: string;
  designFingerprint: string | null;
  flowsFingerprint: string | null;
  cases: ParityCase[];
}

export interface ParityDiff {
  kind: "fingerprint" | "missing" | "extra" | "field";
  semanticId: string | null;
  field?: string;
  a?: unknown;
  b?: unknown;
  message: string;
}

export interface ParityReport {
  ok: boolean;
  a: { path: string; cases: number; designFingerprint: string | null; flowsFingerprint: string | null };
  b: { path: string; cases: number; designFingerprint: string | null; flowsFingerprint: string | null };
  diffs: ParityDiff[];
  warnings: string[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readCase(raw: unknown): ParityCase | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const semanticId = stringOrNull(record.semanticId);
  const legacySteps = !Array.isArray(record.humanSteps);
  const humanSteps = legacySteps ? stringArray(record.steps) : stringArray(record.humanSteps);
  if (semanticId === null) {
    // 旧产物没有 semanticId：用 id 作为 fallback，但调用方会给出 warning。
  }
  return {
    semanticId: semanticId ?? stringOrNull(record.id) ?? "",
    displayId: stringOrNull(record.displayId),
    name: stringOrNull(record.displayName) ?? stringOrNull(record.name) ?? "",
    screens: stringArray(record.screens),
    humanSteps,
    preconditions: stringArray(record.preconditions),
    expectations: Array.isArray(record.expectations) ? record.expectations : [],
    testData: stringArray(record.testData),
    section: stringOrNull(record.section),
    module: stringOrNull(record.module),
    legacySteps
  };
}

export function readParityDoc(filePath: string): ParityDoc {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const flows = Array.isArray(parsed.flows) ? parsed.flows : [];
  return {
    path: filePath,
    designFingerprint: stringOrNull(parsed.designFingerprint),
    flowsFingerprint: stringOrNull(parsed.flowsFingerprint),
    cases: flows.map(readCase).filter((entry): entry is ParityCase => entry !== null)
  };
}

function normalizeExpectations(value: unknown[]): unknown[] {
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return {
      screen: record.screen ?? null,
      hints: stringArray(record.hints),
      kind: record.kind ?? null,
      provenance: record.provenance ?? null
    };
  });
}

function compareField(
  diffs: ParityDiff[],
  semanticId: string,
  field: string,
  a: unknown,
  b: unknown
): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  diffs.push({
    kind: "field",
    semanticId,
    field,
    a,
    b,
    message: `${semanticId} 的 ${field} 不一致`
  });
}

export function compareParityDocs(a: ParityDoc, b: ParityDoc): ParityReport {
  const diffs: ParityDiff[] = [];
  const warnings: string[] = [];
  if (a.designFingerprint !== null && b.designFingerprint !== null && a.designFingerprint !== b.designFingerprint) {
    diffs.push({
      kind: "fingerprint",
      semanticId: null,
      field: "designFingerprint",
      a: a.designFingerprint,
      b: b.designFingerprint,
      message: "设计源指纹不一致：两端不是同一设计源/版本"
    });
  }
  if (a.flowsFingerprint !== null && b.flowsFingerprint !== null && a.flowsFingerprint !== b.flowsFingerprint) {
    diffs.push({
      kind: "fingerprint",
      semanticId: null,
      field: "flowsFingerprint",
      a: a.flowsFingerprint,
      b: b.flowsFingerprint,
      message: "flows 指纹不一致：两端使用了不同 flows（replanned/inferred 或版本不同）"
    });
  }
  if (a.cases.some((entry) => entry.legacySteps) || b.cases.some((entry) => entry.legacySteps)) {
    warnings.push("存在旧产物（无 humanSteps）：使用机器 steps 比较，可能受平台 i18n/a11y 影响");
  }
  if (a.cases.some((entry) => entry.semanticId === "") || b.cases.some((entry) => entry.semanticId === "")) {
    warnings.push("存在旧产物（无 semanticId）：使用 id 作为 fallback");
  }
  const byA = new Map(a.cases.map((entry) => [entry.semanticId, entry]));
  const byB = new Map(b.cases.map((entry) => [entry.semanticId, entry]));
  for (const entry of a.cases) {
    if (!byB.has(entry.semanticId)) {
      diffs.push({
        kind: "missing",
        semanticId: entry.semanticId,
        message: `B 缺少用例 ${entry.semanticId}（${entry.name}）`
      });
    }
  }
  for (const entry of b.cases) {
    if (!byA.has(entry.semanticId)) {
      diffs.push({
        kind: "extra",
        semanticId: entry.semanticId,
        message: `B 多出用例 ${entry.semanticId}（${entry.name}）`
      });
    }
  }
  for (const entry of a.cases) {
    const other = byB.get(entry.semanticId);
    if (!other) continue;
    compareField(diffs, entry.semanticId, "displayId", entry.displayId, other.displayId);
    compareField(diffs, entry.semanticId, "name", entry.name, other.name);
    compareField(diffs, entry.semanticId, "screens", entry.screens, other.screens);
    compareField(diffs, entry.semanticId, "humanSteps", entry.humanSteps, other.humanSteps);
    compareField(diffs, entry.semanticId, "preconditions", entry.preconditions, other.preconditions);
    compareField(
      diffs,
      entry.semanticId,
      "expectations",
      normalizeExpectations(entry.expectations),
      normalizeExpectations(other.expectations)
    );
    compareField(diffs, entry.semanticId, "testData", entry.testData, other.testData);
    compareField(diffs, entry.semanticId, "section", entry.section, other.section);
    compareField(diffs, entry.semanticId, "module", entry.module, other.module);
  }
  return {
    ok: diffs.length === 0,
    a: {
      path: a.path,
      cases: a.cases.length,
      designFingerprint: a.designFingerprint,
      flowsFingerprint: a.flowsFingerprint
    },
    b: {
      path: b.path,
      cases: b.cases.length,
      designFingerprint: b.designFingerprint,
      flowsFingerprint: b.flowsFingerprint
    },
    diffs,
    warnings
  };
}
