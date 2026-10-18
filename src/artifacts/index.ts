import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface ArtifactRecord {
  kind: "run" | "case-set" | "report" | "diff" | "crash" | "trace";
  /** 项目根相对路径。 */
  path: string;
  title: string;
  /** 文件 mtime（ISO）。 */
  at: string;
  /** bytes；目录＝0。 */
  size: number;
  meta?: Record<string, string>;
}

export interface ArtifactQuery {
  kind?: ArtifactRecord["kind"];
  since?: string;
  q?: string;
  limit?: number;
}

/** 资产族与保留期（src/figma/retention.ts）同源；浅扫一层，文件/目录均入索引。 */
const FAMILIES: Array<{ kind: ArtifactRecord["kind"]; dir: string[] }> = [
  { kind: "run", dir: [".artemis", "design", "runs"] },
  { kind: "case-set", dir: [".artemis", "design", "case-sets"] },
  { kind: "report", dir: [".artemis", "design", "reports"] },
  { kind: "diff", dir: [".artemis", "design", "diffs"] },
  { kind: "crash", dir: [".artemis", "crashes"] },
  { kind: "trace", dir: [".artemis", "traces"] }
];

export async function listArtifacts(
  rootPath: string,
  query: ArtifactQuery = {}
): Promise<ArtifactRecord[]> {
  const out: ArtifactRecord[] = [];
  for (const family of FAMILIES) {
    if (query.kind !== undefined && query.kind !== family.kind) continue;
    const dir = path.join(rootPath, ...family.dir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".") || name.includes(".tmp-")) continue;
      const abs = path.join(dir, name);
      try {
        const info = await stat(abs);
        out.push({
          kind: family.kind,
          path: path.relative(rootPath, abs),
          title: name,
          at: info.mtime.toISOString(),
          size: info.isDirectory() ? 0 : info.size,
          ...(info.isDirectory() ? { meta: { type: "dir" } } : {})
        });
      } catch {
        /* 单项不可读：跳过 */
      }
    }
  }
  const needle = query.q?.toLowerCase() ?? null;
  const filtered = out
    .filter((record) => query.since === undefined || record.at >= query.since)
    .filter((record) => {
      if (needle === null) return true;
      return (
        record.title.toLowerCase().includes(needle) || record.path.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path));
  return typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
    ? filtered.slice(0, Math.floor(query.limit))
    : filtered;
}
