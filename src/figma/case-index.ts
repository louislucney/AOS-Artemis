import { readTestsDocument } from "./design-store.js";

/** taskDesc → caseId 回填（经 design-store 单一读取，DESIGN §13.84）。 */
export function findGeneratedCaseId(
  configDirAbs: string,
  taskDesc: string | null | undefined
): string | null {
  if (!taskDesc) return null;
  const document = readTestsDocument(configDirAbs);
  if (document === null) return null;
  for (const record of document.records) {
    if (record.taskDesc === taskDesc) return record.id;
  }
  return null;
}
