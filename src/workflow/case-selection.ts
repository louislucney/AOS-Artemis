import fs from "node:fs";

import type { CaseSetRecord } from "../db/types.js";

/** 用例选择共享原语（`run_regression` 与 `verify_jira_issue` 共用）：关键词归一、
 * 最新用例集解析、现场读用例清单。 */

export interface CaseTarget {
  feature: string;
  jsonPath: string;
  cases: number;
  provenance: string;
  caseIds?: string[];
}

export function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function containsKeyword(text: string, keyword: string): boolean {
  return normalizeKeyword(text).includes(keyword);
}

export function provenanceOf(source: string): string {
  return source.startsWith("imported:") ? `导入自 ${source.slice("imported:".length)}` : `生成自 ${source}`;
}

export function readCaseSummaries(jsonPath: string): Array<{ id: string; name: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { flows?: unknown };
    const flows = Array.isArray(parsed.flows) ? parsed.flows : [];
    const summaries: Array<{ id: string; name: string }> = [];
    for (const entry of flows) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as { id?: unknown; name?: unknown };
      if (typeof record.id !== "string" || typeof record.name !== "string") continue;
      summaries.push({ id: record.id, name: record.name });
    }
    return summaries;
  } catch {
    return [];
  }
}

export function latestFeatures(sets: CaseSetRecord[]): CaseTarget[] {
  const seen = new Set<string>();
  const targets: CaseTarget[] = [];
  for (const set of sets) {
    for (const feature of set.features) {
      if (seen.has(feature.key)) continue;
      seen.add(feature.key);
      targets.push({
        feature: feature.name,
        jsonPath: feature.jsonPath,
        cases: feature.caseCount,
        provenance: provenanceOf(set.source)
      });
    }
  }
  return targets;
}

export function selectByScope(candidates: CaseTarget[], keyword: string): CaseTarget[] {
  const targets: CaseTarget[] = [];
  for (const candidate of candidates) {
    if (containsKeyword(candidate.feature, keyword)) {
      targets.push(candidate);
      continue;
    }
    const caseIds = readCaseSummaries(candidate.jsonPath)
      .filter((summary) => containsKeyword(summary.name, keyword))
      .map((summary) => summary.id);
    if (caseIds.length > 0) {
      targets.push({ ...candidate, cases: caseIds.length, caseIds });
    }
  }
  return targets;
}
