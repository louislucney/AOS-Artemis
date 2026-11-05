import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolvedMaestro {
  path: string | null;
  source: "env" | "path" | "candidate" | "missing";
}

/** maestro CLI 解析链：`AOS_MAESTRO_PATH` → PATH → 常见安装位置；全部缺失 → null（探测降级 false）。
 * Windows 的 Maestro 通常是 `.cmd`/`.bat`（Node 的 spawn 不会自动补 PATHEXT）。 */
export function resolveMaestroPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform
): ResolvedMaestro {
  const explicit = env.AOS_MAESTRO_PATH?.trim();
  if (explicit) return { path: explicit, source: "env" };
  const names =
    platform === "win32" ? ["maestro.exe", "maestro.cmd", "maestro.bat", "maestro"] : ["maestro"];
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const trimmed = dir.trim();
    if (trimmed === "") continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      if (exists(candidate)) return { path: candidate, source: "path" };
    }
  }
  const home = os.homedir();
  const candidates =
    platform === "win32"
      ? [
          path.join(home, ".maestro", "bin", "maestro.exe"),
          path.join(home, ".maestro", "bin", "maestro.cmd"),
          path.join(home, ".maestro", "bin", "maestro.bat"),
          path.join(home, ".maestro", "bin", "maestro")
        ]
      : [
          path.join(home, ".maestro", "bin", "maestro"),
          "/opt/homebrew/bin/maestro",
          "/usr/local/bin/maestro"
        ];
  for (const candidate of candidates) {
    if (exists(candidate)) return { path: candidate, source: "candidate" };
  }
  return { path: null, source: "missing" };
}
