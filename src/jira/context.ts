import { adfToText, asAdfNode } from "./adf.js";

export const AC_HEADING_PATTERN = /^(?:acceptance\s+criteria|ac|验收标准|验收条件|验收要求)\s*[:：]?$/i;
const AC_LINE_PATTERN = /^\s*(?:acceptance\s+criteria|ac|验收标准|验收条件|验收要求)\s*[:：]\s*(.+)$/i;

export interface NormalizedIssue {
  key: string;
  id: string;
  url: string;
  summary: string;
  status: string | null;
  statusCategory: string | null;
  type: string | null;
  labels: string[];
  project: string | null;
  assignee: string | null;
  reporter: string | null;
  updated: string | null;
  created: string | null;
  description: {
    text: string;
    acceptanceCriteria: string[];
    heuristic: true;
    raw: unknown;
  };
}

export interface IssueSummaryRow {
  key: string;
  id: string;
  url: string;
  summary: string;
  status: string | null;
  type: string | null;
  labels: string[];
  updated: string | null;
  assignee: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nameOf(value: unknown): string | null {
  return str(asRecord(value)?.name);
}

function personNameOf(value: unknown): string | null {
  const record = asRecord(value);
  return record !== null ? (str(record.displayName) ?? nameOf(record)) : null;
}

/** Accept a bare issue key ("AOS-123") or any URL containing /browse/<KEY>. */
export function parseIssueKey(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const browse = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i.exec(trimmed);
  if (browse) return browse[1]!.toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(trimmed)) return trimmed.toUpperCase();
  const tokens = trimmed.match(/[A-Za-z][A-Za-z0-9_]*-\d+/g);
  return tokens && tokens.length > 0 ? tokens[tokens.length - 1]!.toUpperCase() : null;
}

/** Heuristic AC extraction: heading sections (Acceptance Criteria / AC / 验收标准…) plus inline `AC:` lines. */
export function extractAcceptanceCriteria(description: unknown): string[] {
  const root = asAdfNode(description);
  if (root === null) return [];
  const out: string[] = [];
  let collecting = false;
  for (const node of root.content ?? []) {
    if (node.type === "heading") {
      collecting = AC_HEADING_PATTERN.test(adfToText(node));
      continue;
    }
    if (!collecting) continue;
    if (node.type === "bulletList" || node.type === "orderedList") {
      for (const item of node.content ?? []) {
        const text = adfToText(item).trim();
        if (text !== "") out.push(text);
      }
      continue;
    }
    const text = adfToText(node).trim();
    if (text !== "") out.push(text);
  }
  if (out.length === 0) {
    for (const line of adfToText(root).split("\n")) {
      const match = AC_LINE_PATTERN.exec(line);
      if (match) out.push(match[1]!.trim());
    }
  }
  return out;
}

export function normalizeIssue(issue: unknown, siteUrl: string): NormalizedIssue {
  const root = asRecord(issue) ?? {};
  const fields = asRecord(root.fields) ?? {};
  const status = asRecord(fields.status);
  const description = fields.description ?? null;
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((value): value is string => typeof value === "string")
    : [];
  const key = str(root.key) ?? "";
  const project = asRecord(fields.project);
  return {
    key,
    id: str(root.id) ?? "",
    url: `${siteUrl}/browse/${key}`,
    summary: str(fields.summary) ?? "",
    status: nameOf(status),
    statusCategory: nameOf(status?.statusCategory),
    type: nameOf(fields.issuetype),
    labels,
    project: project !== null ? (str(project.key) ?? nameOf(project)) : null,
    assignee: personNameOf(fields.assignee),
    reporter: personNameOf(fields.reporter),
    updated: str(fields.updated),
    created: str(fields.created),
    description: {
      text: adfToText(description),
      acceptanceCriteria: extractAcceptanceCriteria(description),
      heuristic: true,
      raw: description
    }
  };
}

export function issueSummaryRow(issue: unknown, siteUrl: string): IssueSummaryRow {
  const normalized = normalizeIssue(issue, siteUrl);
  return {
    key: normalized.key,
    id: normalized.id,
    url: normalized.url,
    summary: normalized.summary,
    status: normalized.status,
    type: normalized.type,
    labels: normalized.labels,
    updated: normalized.updated,
    assignee: normalized.assignee
  };
}
