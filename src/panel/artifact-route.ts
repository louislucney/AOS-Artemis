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
const JSON_VIEW_MAX_BYTES = 512 * 1024;

export interface ArtifactRequestOptions {
  /** 浏览器请求携带的 Accept；仅 text/html 时对 JSON 产物渲染只读查看器，API 客户端仍拿原始 JSON。 */
  accept?: string | null;
}

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

/** 目录浅索引：不递归、名称转义、>500 截断；空目录默认折叠，避免执行中断留下的空壳铺满页面。 */
async function renderArtifactIndex(
  root: string,
  artemisRoot: string,
  abs: string,
  projectRoot: string,
  hostId: string | null,
  showEmpty: boolean
): Promise<PanelWebResponse> {
  let entries: Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const relDir = path.relative(root, abs);
  const parentAbs = path.dirname(abs);
  const parentHref =
    abs === artemisRoot || !parentAbs.startsWith(artemisRoot + path.sep)
      ? ""
      : `<p><a href="${escapeHtml(
          artifactHref(projectRoot, path.relative(root, parentAbs), hostId)
        )}">← 上级</a></p>`;
  const infos = [];
  for (const entry of sorted.slice(0, MAX_INDEX_ENTRIES)) {
    const entryAbs = path.join(abs, entry.name);
    let size: number | null = null;
    let mtime: Date | null = null;
    let childCount: number | null = null;
    if (entry.isDirectory()) {
      try {
        childCount = (await readdir(entryAbs)).length;
      } catch {
        childCount = null;
      }
    } else if (entry.isFile()) {
      try {
        const info = await stat(entryAbs);
        size = info.size;
        mtime = info.mtime;
      } catch {
        /* 保留空元信息 */
      }
    }
    infos.push({ entry, size, mtime, childCount });
  }
  const emptyDirs = infos.filter((info) => info.entry.isDirectory() && info.childCount === 0);
  const visible = showEmpty
    ? infos
    : infos.filter((info) => !(info.entry.isDirectory() && info.childCount === 0));
  const rows = visible.map(({ entry, size, mtime, childCount }) => {
    const suffix = entry.isDirectory() ? "/" : "";
    const rel = path.relative(root, path.join(abs, entry.name)) + suffix;
    const kind = entry.isDirectory()
      ? childCount === null
        ? "目录"
        : childCount === 0
          ? "空目录"
          : `${childCount} 项`
      : path.extname(entry.name).slice(1).toUpperCase() || "文件";
    const meta = [kind, size === null ? null : formatBytes(size)]
      .filter((part): part is string => part !== null)
      .join(" · ");
    const when =
      mtime === null ? "" : `<span class="when">${escapeHtml(mtime.toLocaleString("zh-CN", { hour12: false }))}</span>`;
    return `<li><a href="${escapeHtml(artifactHref(projectRoot, rel, hostId))}"><span class="icon">${
      entry.isDirectory() ? "📁" : "📄"
    }</span><span class="name">${escapeHtml(entry.name)}${suffix}</span><span class="kind">${escapeHtml(
      meta
    )}</span>${when}</a></li>`;
  });
  const hiddenNote =
    !showEmpty && emptyDirs.length > 0
      ? `<p class="note">已折叠 ${emptyDirs.length} 个空目录（执行中断或未写入产物）。<a href="${escapeHtml(
          `${artifactHref(projectRoot, relDir, hostId)}&showEmpty=1`
        )}">显示空目录</a></p>`
      : "";
  const truncated =
    sorted.length > MAX_INDEX_ENTRIES
      ? `<p class="note">共 ${sorted.length} 项，仅显示前 ${MAX_INDEX_ENTRIES} 项。</p>`
      : "";
  const listing =
    visible.length === 0
      ? '<p class="empty-state">此目录为空。</p>'
      : `<ul class="listing">${rows.join("")}</ul>`;
  return renderViewerPage({
    rel: relDir,
    rootPath: projectRoot,
    hostId,
    title: relDir === "" ? "产物目录" : path.basename(abs),
    metaExtra: `共 ${sorted.length} 项`,
    notice: `${hiddenNote}${truncated}`,
    body: [parentHref, listing].join("")
  });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function highlightJson(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  if (value === null) return '<span class="j-lit">null</span>';
  if (typeof value === "string") return `<span class="j-str">${escapeHtml(JSON.stringify(value))}</span>`;
  if (typeof value === "number") return `<span class="j-num">${String(value)}</span>`;
  if (typeof value === "boolean") return `<span class="j-lit">${String(value)}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value
      .map((entry) => `${inner}${highlightJson(entry, depth + 1)}`)
      .join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(
        ([key, entry]) =>
          `${inner}<span class="j-key">${escapeHtml(JSON.stringify(key))}</span>: ${highlightJson(
            entry,
            depth + 1
          )}`
      )
      .join(",\n")}\n${pad}}`;
  }
  return `<span class="j-lit">${escapeHtml(String(value))}</span>`;
}

const TEXT_VIEW_MAX_LINES = 5000;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function renderViewerPage(input: {
  rel: string;
  rootPath: string;
  hostId: string | null;
  size?: number;
  mtime?: Date;
  rawHref?: string;
  copyLabel?: string;
  rawLabel?: string;
  metaExtra?: string;
  notice?: string;
  body: string;
  title?: string;
}): PanelWebResponse {
  const name = input.title ?? (path.basename(input.rel) || "/");
  const projectHref = `/panel?project=${encodeURIComponent(input.rootPath)}${
    input.hostId === null ? "" : `&host=${encodeURIComponent(input.hostId)}`
  }`;
  const meta = [
    input.rel === "" ? "/" : input.rel,
    input.size === undefined ? undefined : formatBytes(input.size),
    input.metaExtra,
    input.mtime === undefined ? undefined : input.mtime.toLocaleString("zh-CN", { hour12: false })
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" · ");
  const actions = [
    input.copyLabel === undefined
      ? ""
      : `<button class="btn" type="button" id="copy-body">${escapeHtml(input.copyLabel)}</button>`,
    input.rawHref === undefined || input.rawLabel === undefined
      ? ""
      : `<a class="btn" href="${escapeHtml(input.rawHref)}">${escapeHtml(input.rawLabel)}</a>`
  ]
    .filter((part) => part !== "")
    .join("");
  const html = [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(name)} · 产物</title>`,
    `<style>
:root{color-scheme:light;--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#6e6e73;--border:#e5e5ea;--link:#0066cc;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 24px;background:#fff;border-bottom:1px solid var(--border)}
.crumbs a,.btn{color:var(--link);text-decoration:none;font-size:13px}.btn{border:1px solid var(--border);border-radius:999px;padding:6px 12px;background:#fff;cursor:pointer}
.actions{display:flex;align-items:center;gap:8px}
main{max-width:1280px;margin:0 auto;padding:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px 24px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
h1{font-size:20px;margin:0 0 4px;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:12px;margin:0 0 16px}
pre.json,pre.log{background:#fbfbfd;border:1px solid var(--border);border-radius:10px;padding:16px;overflow:visible;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-family:var(--mono);font-size:12.5px;line-height:1.55;margin:0}
.j-key{color:#0b5cad}.j-str{color:#1a7f37}.j-num{color:#9a6700}.j-lit{color:#8250df}
.log-error{color:#b91c1c;background:#fef2f2}.log-warn{color:#92400e;background:#fffbeb}
.note{background:#fff9cc;border:1px solid #ffe600;border-radius:8px;padding:8px 12px;font-size:13px;margin:0 0 12px}
.listing{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.listing li+li{border-top:1px solid var(--border)}
.listing a{display:flex;align-items:center;gap:10px;padding:10px 14px;text-decoration:none;color:var(--text)}
.listing a:hover{background:#f5f5f7}
.listing .icon{width:20px;text-align:center}
.listing .name{flex:1;min-width:0;overflow-wrap:anywhere;font-family:var(--mono);font-size:13px}
.listing .kind,.listing .when{color:var(--muted);font-size:12px;white-space:nowrap}
.empty-state{color:var(--muted);padding:24px 0;text-align:center}
</style></head><body>`,
    `<div class="bar"><span class="crumbs"><a href="${escapeHtml(projectHref)}">← 返回项目</a></span><span class="actions">${actions}</span></div>`,
    '<main><section class="card">',
    `<h1>${escapeHtml(name)}</h1>`,
    `<p class="meta">${escapeHtml(meta)}</p>`,
    input.notice ?? "",
    input.body,
    `<script>(function(){var b=document.getElementById("copy-body"),p=document.getElementById("viewer-body");if(!b||!p)return;var label=b.textContent;b.addEventListener("click",function(){var t=p.textContent||"";function ok(){b.textContent="已复制";setTimeout(function(){b.textContent=label;},1500);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){fallback();});}else{fallback();}function fallback(){var a=document.createElement("textarea");a.value=t;a.setAttribute("readonly","");a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();try{document.execCommand("copy");ok();}catch(e){}a.remove();}});})();</script>`,
    "</section></main></body></html>"
  ].join("");
  return { status: 200, contentType: "text/html; charset=utf-8", body: html };
}

/** JSON 产物只读查看器：语法高亮、文件元信息、返回项目与原始文件入口。 */
function renderJsonViewer(input: {
  rel: string;
  rootPath: string;
  hostId: string | null;
  data: Buffer;
  size: number;
  mtime: Date;
  rawHref: string;
}): PanelWebResponse {
  const text = input.data.toString("utf-8");
  let content: string;
  let notice = "";
  if (input.size > JSON_VIEW_MAX_BYTES) {
    content = escapeHtml(text);
    notice = `<p class="note">文件较大（${formatBytes(input.size)}），已按纯文本展示；可打开原始文件查看。</p>`;
  } else {
    try {
      content = highlightJson(JSON.parse(text));
    } catch {
      content = escapeHtml(text);
      notice = '<p class="note">该文件不是合法 JSON，已按纯文本展示。</p>';
    }
  }
  return renderViewerPage({
    rel: input.rel,
    rootPath: input.rootPath,
    hostId: input.hostId,
    size: input.size,
    mtime: input.mtime,
    rawHref: input.rawHref,
    copyLabel: "复制 JSON",
    rawLabel: "原始 JSON",
    notice,
    body: `<pre class="json" id="viewer-body">${content}</pre>`
  });
}

/** 日志/文本产物只读查看器：等宽、自动换行、ERROR/WARN 行高亮。 */
function renderTextViewer(input: {
  rel: string;
  rootPath: string;
  hostId: string | null;
  data: Buffer;
  size: number;
  mtime: Date;
  rawHref: string;
}): PanelWebResponse {
  const text = input.data.toString("utf-8").replace(ANSI_ESCAPE, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const shown = lines.slice(0, TEXT_VIEW_MAX_LINES);
  const truncated = lines.length > TEXT_VIEW_MAX_LINES;
  const body = shown
    .map((line) => {
      const escaped = escapeHtml(line);
      if (/\b(ERROR|FATAL|CRITICAL|EXCEPTION|TRACEBACK|PANIC)\b/i.test(line)) {
        return `<span class="log-line log-error">${escaped}</span>`;
      }
      if (/\b(WARN|WARNING)\b/i.test(line)) {
        return `<span class="log-line log-warn">${escaped}</span>`;
      }
      return `<span class="log-line">${escaped}</span>`;
    })
    .join("\n");
  const notice = truncated
    ? `<p class="note">日志共 ${lines.length} 行，仅展示前 ${TEXT_VIEW_MAX_LINES} 行；完整内容请打开原始日志。</p>`
    : "";
  return renderViewerPage({
    rel: input.rel,
    rootPath: input.rootPath,
    hostId: input.hostId,
    size: input.size,
    mtime: input.mtime,
    rawHref: input.rawHref,
    copyLabel: "复制日志",
    rawLabel: "原始日志",
    metaExtra: `${lines.length} 行`,
    notice,
    body: `<pre class="log" id="viewer-body">${body}</pre>`
  });
}

/** 只读产物服务（档案页"打开"入口）：仅允许 `<项目>/.artemis/` 范围内白名单类型；无目录穿越。
 * 目录返回浅索引（与 runner 产物服务同口径），供证据链的 trace/notes 目录直接下钻。 */
export async function handleArtifactRequest(
  url: URL,
  deps: PanelWebDeps,
  options: ArtifactRequestOptions = {}
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
    return await renderArtifactIndex(
      root,
      artemisRoot,
      abs,
      resolved.rootPath,
      resolved.hostId,
      url.searchParams.get("showEmpty") === "1"
    );
  }
  if (!info.isFile()) return jsonError(404, "产物不可读：不是文件");
  const mime = MIME_BY_EXT[ext];
  if (mime === undefined) return jsonError(400, `不支持的产物类型 ${ext || "(无扩展名)"}`);
  try {
    const data = await readFile(abs);
    const wantsHtml =
      (options.accept ?? "").toLowerCase().includes("text/html") &&
      url.searchParams.get("raw") !== "1";
    const rawHref = `${artifactHref(resolved.rootPath, rel, resolved.hostId)}&raw=1`;
    if (wantsHtml && ext === ".json") {
      return renderJsonViewer({
        rel,
        rootPath: resolved.rootPath,
        hostId: resolved.hostId,
        data,
        size: info.size,
        mtime: info.mtime,
        rawHref
      });
    }
    if (wantsHtml && [".log", ".txt", ".csv", ".xml"].includes(ext)) {
      return renderTextViewer({
        rel,
        rootPath: resolved.rootPath,
        hostId: resolved.hostId,
        data,
        size: info.size,
        mtime: info.mtime,
        rawHref
      });
    }
    return { status: 200, contentType: mime, body: data };
  } catch (error) {
    return jsonError(404, `产物不可读：${errorMessage(error)}`);
  }
}
