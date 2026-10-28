import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore, WebAssetKind, WebAssetRecord } from "../db/types.js";
import { writeFileAtomic } from "../util.js";

export const WEB_ASSET_MAX_BYTES = 20 * 1024 * 1024;

/** 当前仅 Excel 原件可上传；materials/package 的解析与扩展名白名单在后续任务补齐。 */
const EXTENSIONS_BY_KIND: Record<WebAssetKind, string[]> = {
  excel: [".xlsx"],
  materials: [],
  package: []
};

export type WebAssetErrorCode =
  | "unsupported-kind"
  | "invalid-extension"
  | "empty-file"
  | "too-large";

export class WebAssetError extends Error {
  readonly code: WebAssetErrorCode;

  constructor(code: WebAssetErrorCode, message: string) {
    super(message);
    this.name = "WebAssetError";
    this.code = code;
  }
}

export interface StoreWebAssetInput {
  store: ProjectStore;
  rootPath: string;
  kind: WebAssetKind;
  filename: string;
  buffer: Buffer;
  uploadedBy?: string | null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 安全文件名：只取 basename；空名拒绝。扩展名由 kind 白名单决定（大小写不敏感）。 */
function safeFilename(kind: WebAssetKind, rawFilename: string): { filename: string; extension: string } {
  const filename = path.basename(rawFilename.trim());
  if (filename === "" || filename === "." || filename === "..") {
    throw new WebAssetError("invalid-extension", "文件名无效");
  }
  const allowed = EXTENSIONS_BY_KIND[kind] ?? [];
  const extension = path.extname(filename).toLowerCase();
  if (allowed.length === 0) {
    throw new WebAssetError("unsupported-kind", `暂不支持 ${kind} 类型的资产上传（当前仅 excel）`);
  }
  if (!allowed.includes(extension)) {
    throw new WebAssetError(
      "invalid-extension",
      `仅支持 ${allowed.join("、")} 文件（当前 ${extension === "" ? "无扩展名" : extension}）`
    );
  }
  return { filename, extension };
}

/** 内容寻址写入：`<root>/.artemis/web/assets/<kind>/<sha256><ext>`；同内容已存在则复用文件。 */
export async function storeWebAsset(input: StoreWebAssetInput): Promise<WebAssetRecord> {
  const { filename, extension } = safeFilename(input.kind, input.filename);
  if (input.buffer.length === 0) {
    throw new WebAssetError("empty-file", "上传文件为空");
  }
  if (input.buffer.length > WEB_ASSET_MAX_BYTES) {
    throw new WebAssetError(
      "too-large",
      `上传超过上限（${WEB_ASSET_MAX_BYTES} 字节）`
    );
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const rootPath = path.resolve(input.rootPath);
  const storageDir = path.join(rootPath, ".artemis", "web", "assets", input.kind);
  const storagePath = path.join(storageDir, `${sha256}${extension}`);

  // 顺序固定：先写内容寻址文件，再登记版本行。若 store 失败，文件保留不删：
  // 路径由 sha256 决定，后续重试或同内容上传会直接复用，只补一行版本；删除可能误删其他
  // 版本共用的内容。因此失败最多留下可回收的 CAS 文件，不会产生“有行无文件”。
  await mkdir(rootPath, { recursive: true });
  if (!(await pathExists(storagePath))) {
    writeFileAtomic(storagePath, input.buffer);
  }

  const web = await input.store.getWebProject(rootPath);
  return input.store.createWebAsset({
    rootPath,
    kind: input.kind,
    filename,
    sha256,
    size: input.buffer.length,
    storagePath,
    uploadedBy: input.uploadedBy ?? null,
    projectId: web?.projectId ?? null,
    metadata: {}
  });
}

export async function listWebAssets(
  store: ProjectStore,
  rootPath: string,
  kind?: WebAssetKind
): Promise<WebAssetRecord[]> {
  return store.listWebAssets(path.resolve(rootPath), kind);
}
