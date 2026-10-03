import fs from "node:fs";
import path from "node:path";

export function findGeneratedCaseId(
  configDirAbs: string,
  taskDesc: string | null | undefined
): string | null {
  if (!taskDesc) return null;
  const testsPath = path.join(configDirAbs, "design", "tests.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf-8")) as {
      flows?: Array<{ id?: unknown; taskDesc?: unknown }>;
    };
    for (const entry of parsed.flows ?? []) {
      if (typeof entry.id === "string" && entry.taskDesc === taskDesc) return entry.id;
    }
    return null;
  } catch {
    /* tests.json not generated yet */
    return null;
  }
}
