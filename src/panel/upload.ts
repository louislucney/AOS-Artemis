import path from "node:path";

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface ParseMultipartUploadOptions {
  /** 单文件上限（默认 `UPLOAD_MAX_BYTES`）。 */
  maxBytes?: number;
  /** 允许的扩展名后缀（大小写不敏感；默认 `[".xlsx"]`）。 */
  extensions?: readonly string[];
  /** 上传未提供文件名时的兜底名（默认按第一个扩展名生成）。 */
  defaultFilename?: string;
}

/** 单文件 multipart 解析（Node 内置 Response.formData）：扩展名白名单、限长、文件名只取 basename。
 * 额外收集文本字段（project/kind 等），供资产上传等动作复用。第三参数兼容旧的数字 `maxBytes`。 */
export async function parseMultipartUpload(
  body: Buffer,
  contentType: string | undefined,
  options: number | ParseMultipartUploadOptions = {}
): Promise<{ filename: string; content: Buffer; fields: Record<string, string> }> {
  const maxBytes = typeof options === "number" ? options : (options.maxBytes ?? UPLOAD_MAX_BYTES);
  const extensions =
    typeof options === "number" ? [".xlsx"] : (options.extensions ?? [".xlsx"]);
  if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new UploadError(400, "仅支持 multipart/form-data 上传");
  }
  if (body.length > maxBytes) {
    throw new UploadError(413, `上传超过上限（${maxBytes} 字节）`);
  }
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    throw new UploadError(400, `multipart 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  let uploaded: File | null = null;
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      if (!Object.hasOwn(fields, key)) fields[key] = value;
      continue;
    }
    if (uploaded === null && typeof (value as File).arrayBuffer === "function") {
      uploaded = value as File;
    }
  }
  if (uploaded === null) throw new UploadError(400, "未找到上传文件字段");
  const content = Buffer.from(await uploaded.arrayBuffer());
  if (content.length === 0) throw new UploadError(400, "上传文件为空");
  if (content.length > maxBytes) throw new UploadError(413, `上传超过上限（${maxBytes} 字节）`);
  const fallbackName =
    (typeof options === "object" && options.defaultFilename) ||
    `upload${extensions[0] ?? ""}`;
  const filename = path.basename(uploaded.name || fallbackName);
  const normalizedFilename = filename.toLowerCase();
  if (!extensions.some((extension) => normalizedFilename.endsWith(extension.toLowerCase()))) {
    throw new UploadError(
      400,
      extensions.length === 0
        ? "不支持的文件类型"
        : `仅支持 ${extensions.join("、")} 文件`
    );
  }
  return { filename, content, fields };
}
