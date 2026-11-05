import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadDotenvValues } from "../config/loader.js";
import type { ProjectStore, WebAssetRecord } from "../db/types.js";
import { penEnvFrom } from "../pen/cli.js";
import { loadPenDocument } from "../pen/paths.js";
import { summarizePen } from "../pen/read.js";
import {
  renderPenScreens,
  type PenScreenRenderInput,
  type PenScreenRenderResult
} from "../pen/render.js";
import { errorMessage, writeFileAtomic } from "../util.js";
import { storeWebAsset } from "./assets.js";

export class PenReferenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PenReferenceError";
    this.code = code;
  }
}

export interface PenReferenceDeps {
  render?: (input: PenScreenRenderInput) => Promise<PenScreenRenderResult>;
}

export interface PenReferenceResult {
  assets: WebAssetRecord[];
  sourcePath: string;
  sourceSha256: string;
  screenCount: number;
  missing: string[];
  warnings: string[];
}

function screenLabel(screen: { id: string; name: string }, index: number): string {
  const label = screen.name.trim() || screen.id;
  const safe = [...label]
    .map((char) => (char.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(char) ? "_" : char))
    .join("")
    .slice(0, 60);
  return safe || `screen-${index + 1}`;
}

/**
 * `.pen` 参考图上传：保存源文件 → 解析顶层 screen → pen CLI 渲染 PNG →
 * 每个 screen 登记为一个 reference 资产（L2 仍只消费 PNG）。
 */
export async function storePenReference(input: {
  store: ProjectStore;
  rootPath: string;
  filename: string;
  buffer: Buffer;
  uploadedBy: string | null;
  deps?: PenReferenceDeps;
}): Promise<PenReferenceResult> {
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const sourceDir = path.join(
    path.resolve(input.rootPath),
    ".artemis",
    "web",
    "assets",
    "reference-sources"
  );
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, `${sha256}.pen`);
  if (!fs.existsSync(sourcePath)) writeFileAtomic(sourcePath, input.buffer);

  let screens: Array<{ id: string; name: string }>;
  try {
    const summary = summarizePen(loadPenDocument(sourcePath));
    screens = summary.screens
      .filter((screen): screen is { id: string; name: string } => typeof screen.id === "string")
      .map((screen) => ({ id: screen.id, name: screen.name }));
  } catch (error) {
    throw new PenReferenceError(
      "pen-parse-failed",
      `无法解析 .pen：${errorMessage(error)}`
    );
  }
  if (screens.length === 0) {
    throw new PenReferenceError(
      "pen-no-screens",
      ".pen 没有顶层 screen/frame；请把要作为参考的页面做成顶层 frame"
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-pen-reference-"));
  let rendered: PenScreenRenderResult;
  try {
    rendered = await (input.deps?.render ?? renderPenScreens)({
      target: sourcePath,
      screenIds: screens.map((screen) => screen.id),
      env: penEnvFrom(loadDotenvValues(input.rootPath), process.env),
      outDir: tempDir
    });
  } catch (error) {
    throw new PenReferenceError(
      "pen-render-failed",
      `pen CLI 渲染失败：${errorMessage(error)}`
    );
  }

  const assets: WebAssetRecord[] = [];
  const missing: string[] = [];
  const base = path.basename(input.filename, path.extname(input.filename));
  try {
    for (const [index, screen] of screens.entries()) {
      const file = rendered.files.get(screen.id);
      if (!file || !fs.existsSync(file)) {
        missing.push(screen.name || screen.id);
        continue;
      }
      const buffer = fs.readFileSync(file);
      const filename = `${base}-${screenLabel(screen, index)}-${screen.id.slice(0, 6)}.png`;
      const asset = await storeWebAsset({
        store: input.store,
        rootPath: input.rootPath,
        kind: "reference",
        filename,
        buffer,
        uploadedBy: input.uploadedBy,
        metadata: {
          sourceType: "pen",
          sourceFile: path.relative(input.rootPath, sourcePath),
          sourceSha256: sha256,
          screenId: screen.id,
          screenName: screen.name,
          screenCount: screens.length
        }
      });
      assets.push(asset);
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  if (assets.length === 0) {
    throw new PenReferenceError(
      "pen-no-output",
      rendered.error ?? "pen CLI 没有产出任何 PNG"
    );
  }
  return {
    assets,
    sourcePath,
    sourceSha256: sha256,
    screenCount: screens.length,
    missing,
    warnings: missing.length === 0 ? [] : [`${missing.length} 个 screen 未渲染：${missing.join("、")}`]
  };
}
