import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../util.js";
import { designDir } from "./design-store.js";

/** 用例集归档（DESIGN：回归服务 §5.2）：一份功能段 = 三件套同 basename
 * （`<YYYYMMDD_HHmmss>_<功能>.json|md|xlsx`，UTC 紧凑时间戳），供回归引用与追溯。 */
export const CASE_SETS_DIR = "case-sets";

export function caseSetsDir(configDirAbs: string): string {
  return path.join(designDir(configDirAbs), CASE_SETS_DIR);
}

export function caseSetStem(name: string, now: Date, taken: Set<string>): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
  const cleaned = name
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = `${stamp}_${cleaned === "" ? "feature" : cleaned}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export interface CaseSetFilesInput {
  json: string;
  markdown: string;
  xlsx: Buffer;
}

export async function saveCaseSetFiles(
  dir: string,
  stem: string,
  files: CaseSetFilesInput
): Promise<{ jsonPath: string; mdPath: string; xlsxPath: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, `${stem}.json`);
  const mdPath = path.join(dir, `${stem}.md`);
  const xlsxPath = path.join(dir, `${stem}.xlsx`);
  writeFileAtomic(jsonPath, files.json);
  writeFileAtomic(mdPath, files.markdown);
  writeFileAtomic(xlsxPath, files.xlsx);
  return { jsonPath, mdPath, xlsxPath };
}
