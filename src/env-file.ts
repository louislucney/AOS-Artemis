import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "./util.js";

export const ENV_FILE = ".env";

/** Upsert KEY=value lines while preserving comments and unrelated entries. */
export function upsertEnvContent(existing: string, updates: Record<string, string>): string {
  const keys = new Set(Object.keys(updates));
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  const handled = new Set<string>();
  const output = lines.map((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!keys.has(key)) return line;
    handled.add(key);
    return `${key}=${updates[key]!}`;
  });
  for (const key of keys) {
    if (!handled.has(key)) output.push(`${key}=${updates[key]!}`);
  }
  // Ensure the file ends with exactly one trailing newline.
  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  return output.join("\n") + "\n";
}

export function writeEnvUpdates(rootDir: string, updates: Record<string, string>): string {
  const envPath = path.join(rootDir, ENV_FILE);
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const next = upsertEnvContent(existing, updates);
  writeFileAtomic(envPath, next);
  return envPath;
}
