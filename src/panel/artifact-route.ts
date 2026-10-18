import { readFile } from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../util.js";
import { resolveProjectKey, type PanelWebDeps, type PanelWebResponse } from "./web.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

/** 只读产物服务（档案页"打开"入口）：仅允许 `<项目>/.artemis/` 范围内白名单类型；无目录穿越。 */
export async function handleArtifactRequest(
  url: URL,
  deps: PanelWebDeps
): Promise<PanelWebResponse> {
  const jsonError = (status: number, message: string): PanelWebResponse => ({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ error: message })
  });
  const project = (url.searchParams.get("project") ?? "").trim();
  const rel = (url.searchParams.get("path") ?? "").trim();
  if (project === "" || rel === "") return jsonError(400, "缺少 project 或 path");
  const resolved = await resolveProjectKey(deps, project);
  if (!resolved) return jsonError(404, `未知项目 "${project}"`);
  if (rel.includes("..") || path.isAbsolute(rel)) return jsonError(400, "非法路径");
  const root = path.resolve(resolved.rootPath);
  const abs = path.resolve(root, rel);
  const artemisRoot = path.join(root, ".artemis");
  if (!(abs === artemisRoot || abs.startsWith(artemisRoot + path.sep))) {
    return jsonError(403, "仅可访问项目 .artemis 范围内的产物");
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) return jsonError(400, `不支持的产物类型 ${ext || "(无扩展名)"}`);
  try {
    const data = await readFile(abs);
    return { status: 200, contentType: mime, body: data };
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
}
