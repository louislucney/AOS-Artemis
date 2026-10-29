import { createHash } from "node:crypto";
import { access, chmod, stat } from "node:fs/promises";
import path from "node:path";

import type { ProjectStore, WebAssetKind, WebAssetRecord } from "../db/types.js";
import { writeFileAtomic } from "../util.js";
import { CsvError, decodeCsv } from "./csv.js";

export type { WebAssetKind };

/** excel/scripts 的旧上限；按类型取上限请用 `webAssetMaxBytes(kind)`。 */
export const WEB_ASSET_MAX_BYTES = 20 * 1024 * 1024;

const MB = 1024 * 1024;

const MAX_BYTES_BY_KIND: Record<WebAssetKind, number> = {
  excel: WEB_ASSET_MAX_BYTES,
  materials: 50 * MB,
  package: 200 * MB,
  scripts: WEB_ASSET_MAX_BYTES
};

const EXTENSIONS_BY_KIND: Record<WebAssetKind, readonly string[]> = {
  excel: [".xlsx", ".csv"],
  materials: [".zip", ".json", ".csv", ".txt"],
  package: [".apk", ".ipa"],
  scripts: [".zip"]
};

export const WEB_ASSET_KINDS: readonly WebAssetKind[] = [
  "excel",
  "materials",
  "package",
  "scripts"
];

export function isWebAssetKind(value: string): value is WebAssetKind {
  return (WEB_ASSET_KINDS as readonly string[]).includes(value);
}

export function webAssetMaxBytes(kind: WebAssetKind): number {
  return MAX_BYTES_BY_KIND[kind];
}

export function webAssetExtensions(kind: WebAssetKind): readonly string[] {
  return EXTENSIONS_BY_KIND[kind];
}

export type WebAssetErrorCode =
  | "unsupported-kind"
  | "invalid-extension"
  | "invalid-filename"
  | "empty-file"
  | "too-large"
  | "unsupported-encoding"
  | "project-root-missing";

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
  /** 资产附带标记（如 materials 的 `secret=true`）；缺省写空对象。 */
  metadata?: Record<string, unknown>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 安全文件名：只取 basename；空名/含 Windows 路径分隔符拒绝。扩展名由 kind 白名单决定（大小写不敏感）。 */
function safeFilename(kind: WebAssetKind, rawFilename: string): { filename: string; extension: string } {
  const trimmed = rawFilename.trim();
  if (trimmed.includes("\\")) {
    throw new WebAssetError("invalid-filename", "文件名不得包含路径分隔符");
  }
  const filename = path.basename(trimmed);
  if (filename === "" || filename === "." || filename === "..") {
    throw new WebAssetError("invalid-extension", "文件名无效");
  }
  const allowed = isWebAssetKind(kind) ? EXTENSIONS_BY_KIND[kind] : [];
  const extension = path.extname(filename).toLowerCase();
  if (allowed.length === 0) {
    throw new WebAssetError(
      "unsupported-kind",
      `未知 kind "${String(kind)}"（仅支持 ${WEB_ASSET_KINDS.join("、")}）`
    );
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
  const maxBytes = webAssetMaxBytes(input.kind);
  if (input.buffer.length > maxBytes) {
    throw new WebAssetError(
      "too-large",
      `${input.kind} 资产超过上限（${maxBytes} 字节）`
    );
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.kind === "excel" && extension === ".csv") {
    // CSV 原件保持原字节只读；编码检测结论写进元数据，后续生成工作副本时可直接复用。
    metadata.format = "csv";
    try {
      metadata.encoding = decodeCsv(input.buffer).encoding;
    } catch (error) {
      if (error instanceof CsvError && error.code === "unsupported-encoding") {
        throw new WebAssetError("unsupported-encoding", `CSV 编码不受支持：${error.message}`);
      }
      throw error;
    }
  }
  const rootPath = path.resolve(input.rootPath);
  // 只写已存在的托管项目目录：不代用户 mkdir，避免请求路径在服务端凭空长出新项目。
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      throw new WebAssetError("project-root-missing", `项目目录不是目录：${rootPath}`);
    }
  } catch (error) {
    if (error instanceof WebAssetError) throw error;
    throw new WebAssetError(
      "project-root-missing",
      `项目目录不存在（请先在项目机创建项目）：${rootPath}`
    );
  }
  const storageDir = path.join(rootPath, ".artemis", "web", "assets", input.kind);
  const storagePath = path.join(storageDir, `${sha256}${extension}`);

  // 顺序固定：先写内容寻址文件，再登记版本行。若 store 失败，文件保留不删：
  // 路径由 sha256 决定，后续重试或同内容上传会直接复用，只补一行版本；删除可能误删其他
  // 版本共用的内容。因此失败最多留下可回收的 CAS 文件，不会产生“有行无文件”。
  if (!(await pathExists(storagePath))) {
    writeFileAtomic(storagePath, input.buffer);
  }
  if (input.kind === "materials" && input.metadata?.secret === true) {
    // secret materials 落盘即最小权限：目录 0700、文件 0600（禁止其它用户读取）。
    await chmod(storageDir, 0o700);
    await chmod(storagePath, 0o600);
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
    // 未知时省略，由 store 从 upsertProject 解析，避免把 NULL 钉死在资产行上。
    ...(web?.projectId ? { projectId: web.projectId } : {}),
    metadata
  });
}

export async function listWebAssets(
  store: ProjectStore,
  rootPath: string,
  kind?: WebAssetKind
): Promise<WebAssetRecord[]> {
  return store.listWebAssets(path.resolve(rootPath), kind);
}
