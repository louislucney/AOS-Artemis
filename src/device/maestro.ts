import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedMaestro {
  path: string | null;
  source: "env" | "path" | "candidate" | "missing";
}

/** maestro CLI 解析链：`AOS_MAESTRO_PATH` → PATH → 常见安装位置；全部缺失 → null（探测降级 false）。 */
export function resolveMaestroPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync
): ResolvedMaestro {
  const explicit = env.AOS_MAESTRO_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const trimmed = dir.trim();
    if (trimmed === "") continue;
    const candidate = path.join(trimmed, "maestro");
    if (exists(candidate)) return { path: candidate, source: "path" };
  }
  for (const candidate of [
    path.join(os.homedir(), ".maestro", "bin", "maestro"),
    "/opt/homebrew/bin/maestro",
    "/usr/local/bin/maestro"
  ]) {
    if (exists(candidate)) return { path: candidate, source: "candidate" };
  }
  return { path: null, source: "missing" };
}
