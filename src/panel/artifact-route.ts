import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import { AmbiguousProjectError } from "../db/types.js";
import { errorMessage, escapeHtml } from "../util.js";
import { resolveProjectKey, type PanelWebDeps, type PanelWebResponse } from "./web.js";

import { listArtifacts, type ArtifactRecord } from "../artifacts/index.js";

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

const MAX_INDEX_ENTRIES = 500;

function jsonError(status: number, message: string): PanelWebResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ error: message })
  };
}

function artifactHref(rootPath: string, rel: string, hostId: string | null): string {
  return `/panel/artifact?project=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(rel)}${
    hostId === null ? "" : `&host=${encodeURIComponent(hostId)}`
  }`;
}

/** 目录浅索引：不递归、名称转义、>500 截断（与 `runner/artifact-server` 一致）。 */
async function renderArtifactIndex(
  root: string,
  artemisRoot: string,
  abs: string,
  projectRoot: string,
  hostId: string | null
): Promise<PanelWebResponse> {
  let entries: Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const relDir = path.relative(root, abs);
  const parentAbs = path.dirname(abs);
  const parentHref =
    abs === artemisRoot || !parentAbs.startsWith(artemisRoot + path.sep)
      ? ""
      : `<p><a href="${escapeHtml(
          artifactHref(projectRoot, path.relative(root, parentAbs), hostId)
        )}">← 上级</a></p>`;
  const rows = sorted.slice(0, MAX_INDEX_ENTRIES).map((entry) => {
    const suffix = entry.isDirectory() ? "/" : "";
    const rel = path.relative(root, path.join(abs, entry.name)) + suffix;
    return `<li><a href="${escapeHtml(artifactHref(projectRoot, rel, hostId))}">${escapeHtml(
      entry.name
    )}${suffix}</a></li>`;
  });
  const truncated =
    sorted.length > MAX_INDEX_ENTRIES
      ? `<p>共 ${sorted.length} 项，仅显示前 ${MAX_INDEX_ENTRIES} 项。</p>`
      : "";
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>产物索引 · ${escapeHtml(relDir === "" ? "/" : relDir)}</title>`,
    "<style>body{font-family:system-ui;padding:24px}li{margin:4px 0}</style>",
    "</head><body>",
    `<h1>${escapeHtml(relDir === "" ? "/" : `/${relDir}`)}</h1>`,
    parentHref,
    `<ul>${rows.join("")}</ul>`,
    truncated,
    "</body></html>"
  ].join("");
  return { status: 200, contentType: "text/html; charset=utf-8", body: html };
}

/** 只读产物服务（档案页"打开"入口）：仅允许 `<项目>/.artemis/` 范围内白名单类型；无目录穿越。
 * 目录返回浅索引（与 runner 产物服务同口径），供证据链的 trace/notes 目录直接下钻。 */
export async function handleArtifactRequest(
  url: URL,
  deps: PanelWebDeps
): Promise<PanelWebResponse> {
  const project = (url.searchParams.get("project") ?? "").trim();
  if (project === "") return jsonError(400, "缺少 project");
  const hostParam = (url.searchParams.get("host") ?? "").trim();
  let resolved: { rootPath: string; name: string; hostId: string | null } | null;
  try {
    resolved = await resolveProjectKey(deps, project, hostParam === "" ? undefined : hostParam);
  } catch (error) {
    if (error instanceof AmbiguousProjectError) {
      return {
        status: 409,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          error: error.message,
          candidates: error.candidates.map((candidate) => ({
            hostId: candidate.hostId,
            rootPath: candidate.rootPath,
            name: candidate.name
          }))
        })
      };
    }
    throw error;
  }
  if (!resolved) return jsonError(404, `未知项目 "${project}"`);
  if (url.searchParams.get("format") === "csv") {
    const kindRaw = (url.searchParams.get("kind") ?? "").trim();
    const kind =
      kindRaw !== "" && ["run", "case-set", "report", "diff", "crash", "trace"].includes(kindRaw)
        ? (kindRaw as ArtifactRecord["kind"])
        : undefined;
    const q = (url.searchParams.get("q") ?? "").trim();
    const since = (url.searchParams.get("since") ?? "").trim();
    const records = await listArtifacts(resolved.rootPath, {
      ...(kind === undefined ? {} : { kind }),
      ...(q === "" ? {} : { q }),
      ...(since === "" ? {} : { since }),
      limit: 1000
    });
    const lines = [
      "kind,path,title,at,size",
      ...records.map((record) =>
        [record.kind, record.path, record.title, record.at, String(record.size)]
          .map((value) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
          .join(",")
      )
    ];
    return {
      status: 200,
      contentType: "text/csv; charset=utf-8",
      body: `${lines.join("\n")}\n`
    };
  }
  const rel = (url.searchParams.get("path") ?? "").trim();
  if (rel === "") return jsonError(400, "缺少 path");
  if (rel.includes("..") || path.isAbsolute(rel)) return jsonError(400, "非法路径");
  const root = path.resolve(resolved.rootPath);
  const abs = path.resolve(root, rel);
  const artemisRoot = path.join(root, ".artemis");
  if (!(abs === artemisRoot || abs.startsWith(artemisRoot + path.sep))) {
    return jsonError(403, "仅可访问项目 .artemis 范围内的产物");
  }
  const ext = path.extname(abs).toLowerCase();
  let info: Stats;
  try {
    info = await stat(abs);
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
  if (info.isDirectory()) {
    return await renderArtifactIndex(root, artemisRoot, abs, resolved.rootPath, resolved.hostId);
  }
  if (!info.isFile()) return jsonError(404, "产物不可读：不是文件");
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) return jsonError(400, `不支持的产物类型 ${ext || "(无扩展名)"}`);
  try {
    const data = await readFile(abs);
    return { status: 200, contentType: mime, body: data };
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
}
