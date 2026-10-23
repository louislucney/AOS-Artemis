import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { designDir } from "../figma/design-store.js";
import { writeFileAtomic } from "../util.js";

/** 设计流水线截图资产（DESIGN §13.99，design-screenshots T1）：
 * figma / pen 通道共用的落盘原语——命名转义、PNG 校验、sha256 幂等、
 * 原子替换；截图仅为 md 展示层增强，不改 taskDesc/门禁语义。 */

export const SCREENSHOT_SKIPPED = "screenshot-skipped";
export const SCREENSHOT_RENDER_UNAVAILABLE = "screenshot-render-unavailable";
export const SCREENSHOT_MAPPING_MISSING = "screenshot-mapping-missing";
export const SCREENSHOT_DISABLED = "screens-disabled";
export const SCREENSHOT_EMBED_MISMATCH = "screenshot-embed-mismatch";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ScreenStoreResult {
  id: string;
  status: "written" | "skipped" | "invalid";
  path: string;
  sha256: string | null;
}

/** 节点 id → 文件名安全形式（`:` 等转 `-`；空结果回退 `screen`）。 */
export function sanitizeScreenId(raw: string): string {
  const sanitized = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return sanitized === "" ? "screen" : sanitized;
}

export function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

/** PNG IHDR 宽高（渲染尺寸即设计坐标系，scale 1）；非 PNG/结构不符返回 null。 */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (!isPngBuffer(bytes)) return null;
  if (bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function screenFileName(nodeId: string): string {
  return `${sanitizeScreenId(nodeId)}.png`;
}

/** 已落盘且通过 PNG 校验的屏幕图路径；缺失/损坏 → null（生成阶段复用，避免重复下载/渲染）。
 * 只读魔术头，不整文件读盘。 */
export function existingScreenPath(targetDir: string, nodeId: string): string | null {
  const file = path.join(targetDir, screenFileName(nodeId));
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const magic = Buffer.alloc(PNG_MAGIC.length);
    const read = fs.readSync(fd, magic, 0, magic.length, 0);
    return read === magic.length && isPngBuffer(magic) ? file : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

export function screensRoot(configDirAbs: string): string {
  return path.join(designDir(configDirAbs), "screens");
}

export function figmaScreensDir(configDirAbs: string, fileKey: string): string {
  return path.join(screensRoot(configDirAbs), `figma-${sanitizeScreenId(fileKey)}`);
}

export function penScreensDir(configDirAbs: string, penFile: string): string {
  const slug = path.basename(penFile, path.extname(penFile));
  return path.join(screensRoot(configDirAbs), `pen-${sanitizeScreenId(slug)}`);
}

/** md 引用用相对路径（POSIX 分隔符；md 与 screens/ 同级、原地预览）。 */
export function relativeScreenPath(designDirAbs: string, filePath: string): string {
  return path.relative(designDirAbs, filePath).split(path.sep).join("/");
}

/** `screens:false` 显式关；`screens:true` 覆盖 `AOS_SCREENS=0`（arg 优先）；未传时看 env。 */
export function screensEnabledFrom(env: NodeJS.ProcessEnv, arg?: boolean): boolean {
  if (arg === false) return false;
  if (arg === true) return true;
  return env.AOS_SCREENS !== "0";
}

function readPngState(file: string): { sha256: string; validPng: boolean } | null {
  try {
    const buffer = fs.readFileSync(file);
    return { sha256: sha256Hex(buffer), validPng: isPngBuffer(buffer) };
  } catch {
    return null;
  }
}

/** 幂等入库：同内容跳过（保留 mtime）；损坏/变更内容原子覆盖；非法 buffer 不落盘。 */
export function storeScreenPng(targetDir: string, nodeId: string, png: Buffer): ScreenStoreResult {
  const file = path.join(targetDir, screenFileName(nodeId));
  if (!isPngBuffer(png)) {
    return { id: nodeId, status: "invalid", path: file, sha256: null };
  }
  const sha256 = sha256Hex(png);
  const existing = readPngState(file);
  if (existing !== null && existing.validPng && existing.sha256 === sha256) {
    return { id: nodeId, status: "skipped", path: file, sha256 };
  }
  writeFileAtomic(file, png);
  return { id: nodeId, status: "written", path: file, sha256 };
}

/** pen 通道：CLI 直写到私有临时目录后，经校验原子入库并清理临时文件。 */
export function importScreenFile(tempFile: string, targetDir: string, nodeId: string): ScreenStoreResult {
  const file = path.join(targetDir, screenFileName(nodeId));
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(tempFile);
  } catch {
    return { id: nodeId, status: "invalid", path: file, sha256: null };
  }
  const result = storeScreenPng(targetDir, nodeId, buffer);
  try {
    fs.rmSync(tempFile, { force: true });
  } catch {
    /* best effort */
  }
  return result;
}
