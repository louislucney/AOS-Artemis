import type { IncomingMessage } from "node:http";

export interface MultipartFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Map<string, string>;
  files: Map<string, MultipartFile>;
}

/** Parse multipart/form-data via the platform FormData implementation. */
export async function parseMultipart(
  body: Buffer,
  contentType: string
): Promise<MultipartResult> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    throw new Error(`multipart 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = new Map<string, string>();
  const files = new Map<string, MultipartFile>();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      fields.set(key, value);
      continue;
    }
    const file = value as File;
    files.set(key, {
      filename: file.name,
      contentType: file.type,
      data: Buffer.from(await file.arrayBuffer())
    });
  }
  return { fields, files };
}

export function isMultipart(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").toLowerCase().includes("multipart/form-data");
}

export function isJson(request: IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").toLowerCase().includes("application/json");
}
