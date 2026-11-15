import fs from "node:fs";
import path from "node:path";

export interface EvidenceScreenshot {
  name: string;
  contentBase64: string;
}

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const DEFAULT_MAX_SHOTS = 3;
const MAX_FILE_BYTES = 200 * 1024;

function enabled(env: NodeJS.ProcessEnv): boolean {
  return (env.AOS_RUNNER_EVIDENCE_SCREENSHOTS ?? "1").trim() !== "0";
}

function maxShots(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.AOS_RUNNER_EVIDENCE_MAX_SHOTS ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_MAX_SHOTS;
  return Math.min(raw, 5);
}

function imageCandidates(traceDir: string): string[] {
  const dirs = [path.join(traceDir, "shots"), path.join(traceDir, "screenshots")];
  const files: string[] = [];
  for (const dir of dirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!IMAGE_EXT.test(name)) continue;
        files.push(path.join(dir, name));
      }
    } catch {
      /* no screenshots */
    }
  }
  return files
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { file: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);
}

/** 失败证据截图：默认开启，仅上传最近 N 张且 <=200KB 的本地截图。
 * 截图可能包含敏感内容，可用 AOS_RUNNER_EVIDENCE_SCREENSHOTS=0 关闭。 */
export function collectEvidenceScreenshots(
  traceDir: string,
  env: NodeJS.ProcessEnv = process.env
): EvidenceScreenshot[] {
  if (!enabled(env)) return [];
  const out: EvidenceScreenshot[] = [];
  for (const file of imageCandidates(traceDir)) {
    if (out.length >= maxShots(env)) break;
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length === 0 || buffer.length > MAX_FILE_BYTES) continue;
      const ext = path.extname(file).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(file).toLowerCase();
      out.push({
        name: `evidence-shot-${out.length + 1}${ext}`,
        contentBase64: buffer.toString("base64")
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
