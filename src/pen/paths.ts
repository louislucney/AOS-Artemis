import fs from "node:fs";
import path from "node:path";

import type { Runtime } from "../runtime.js";
import { parsePenText, type PenDocument } from "./read.js";

export const PEN_HINT =
  "先获得 .pen 文件（pen.dev 桌面/IDE 导入 .fig 或从 Figma 粘贴后保存到项目；本仓库 scripts/figma-to-pen.mjs 也可从 Figma REST 转换），或在 path 里显式指定文件。";

export function newestPen(designDir: string): string | null {
  if (!fs.existsSync(designDir)) return null;
  const files = fs
    .readdirSync(designDir)
    .filter((name) => name.endsWith(".pen"))
    .map((name) => path.join(designDir, name));
  if (!files.length) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0]!;
}

export function resolvePenTarget(runtime: Runtime, explicit?: string): string | null {
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(runtime.project.rootDir, explicit);
  }
  return newestPen(path.join(runtime.configDirAbs, "design"));
}

export function loadPenDocument(target: string): PenDocument {
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${target}`);
  return parsePenText(fs.readFileSync(target, "utf-8"));
}

export function penRelativePath(runtime: Runtime, target: string): string {
  return path.relative(runtime.project.rootDir, target);
}
