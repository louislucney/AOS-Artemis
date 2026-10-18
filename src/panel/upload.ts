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

/** 单文件 multipart 解析（Node 内置 Response.formData）：仅 .xlsx、限长、文件名只取 basename。 */
export async function parseMultipartUpload(
  body: Buffer,
  contentType: string | undefined,
  maxBytes = UPLOAD_MAX_BYTES
): Promise<{ filename: string; content: Buffer }> {
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
  for (const value of form.values()) {
    if (typeof value === "object" && value !== null && typeof (value as File).arrayBuffer === "function") {
      uploaded = value as File;
      break;
    }
  }
  if (uploaded === null) throw new UploadError(400, "未找到上传文件字段");
  const content = Buffer.from(await uploaded.arrayBuffer());
  if (content.length === 0) throw new UploadError(400, "上传文件为空");
  if (content.length > maxBytes) throw new UploadError(413, `上传超过上限（${maxBytes} 字节）`);
  const filename = path.basename(uploaded.name || "upload.xlsx");
  if (!filename.toLowerCase().endsWith(".xlsx")) throw new UploadError(400, "仅支持 .xlsx 文件");
  return { filename, content };
}
