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
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".apk": "application/vnd.android.package-archive",
  ".ipa": "application/octet-stream",
  ".zip": "application/zip",
  ".pen": "application/octet-stream"
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
  /** Markdown 文档用正文 h1 作为标题，避免与文件名 h1 重复。 */
  hideTitle?: boolean;
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
.md-doc{max-width:920px;margin:0 auto}
.md-title{font-size:26px;line-height:1.25;letter-spacing:-.02em;margin:2px 0 14px}
.md-meta{background:#fff9cc;border:1px solid #ffe600;border-radius:12px;padding:12px 16px;margin:0 0 22px;color:#1d1d1f;font-size:13px;line-height:1.65}
.md-meta p{margin:2px 0}
.md-case{border-top:1px solid var(--border);padding:22px 0 4px;margin:0}
.md-case:first-of-type{border-top:0;padding-top:4px}
.md-case h2{font-size:18px;line-height:1.35;margin:0 0 12px;padding-left:12px;border-left:4px solid #ffe600}
.md-case h3{font-size:15px;margin:16px 0 8px}
.md-list{margin:0 0 12px;padding-left:22px;line-height:1.75}
.md-list li{margin:4px 0}
.md-run{border:1px solid var(--border);border-radius:12px;background:#fbfbfd;margin:14px 0 2px;overflow:hidden}
.md-run summary{cursor:pointer;padding:10px 14px;font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:8px;list-style:none}
.md-run summary::-webkit-details-marker{display:none}
.md-run summary::before{content:"▸";color:#86868b;transition:transform .15s}
.md-run[open] summary::before{transform:rotate(90deg)}
.md-run-hint{margin-left:auto;font-size:11px;color:#86868b}
.md-run pre{margin:0;padding:14px 16px;border-top:1px solid var(--border);background:#fff;font-family:var(--mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.md-code{background:#fbfbfd;border:1px solid var(--border);border-radius:10px;padding:14px 16px;font-family:var(--mono);font-size:12.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.md-doc p{margin:8px 0 12px;line-height:1.75}
.md-doc code{background:#f5f5f7;border-radius:5px;padding:1px 4px;font-family:var(--mono);font-size:12.5px}
.md-doc a{color:var(--link)}
.cs-case{background:#fff;border:1px solid var(--border);border-radius:16px;padding:20px 22px;margin:0 0 16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.cs-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
.cs-num{flex:0 0 32px;width:32px;height:32px;border-radius:10px;background:#ffe600;color:#1d1d1f;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}
.cs-title{font-size:17px;line-height:1.4;margin:0 0 6px}
.cs-module{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:#f5f5f7;border:1px solid #e5e5ea;color:#6e6e73;font-size:11.5px}
.cs-pre{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#6e6e73;margin:8px 0 0;padding:8px 10px;background:#fbfbfd;border-radius:8px;line-height:1.6}
.cs-label{flex:0 0 auto;color:#86868b;font-weight:600}
.cs-steps{list-style:none;counter-reset:cs;margin:14px 0 0;padding:0}
.cs-step{position:relative;padding:0 0 14px 38px;line-height:1.65;font-size:14px}
.cs-step:last-child{padding-bottom:0}
.cs-step::before{counter-increment:cs;content:counter(cs);position:absolute;left:0;top:1px;width:26px;height:26px;border-radius:50%;background:#fff9cc;border:1px solid #ffe600;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700}
.cs-step:not(:last-child)::after{content:"";position:absolute;left:12.5px;top:29px;bottom:0;width:1px;background:#ececf0}
.cs-expected{margin:16px 0 0;padding:12px 14px;background:#fff9cc;border:1px solid #ffe600;border-radius:12px}
.cs-expected-label{font-size:11px;letter-spacing:.08em;color:#6e6e73;margin-bottom:6px}
.cs-expected-body{font-size:13.5px;line-height:1.7}
.cs-expected-body p{margin:2px 0}
.cs-sub{position:relative;padding-left:16px;margin:2px 0;color:#4b4b50}
.cs-sub::before{content:"·";position:absolute;left:4px;color:#b0b0b6}
.cs-case .md-run{margin-top:16px}
@media (max-width:640px){main{padding:16px}.md-title{font-size:22px}.md-case{padding-top:18px}.cs-case{padding:16px;border-radius:12px}.cs-step{padding-left:34px}.cs-num{width:28px;height:28px;flex-basis:28px;font-size:13px}}
</style></head><body>`,
    `<div class="bar"><span class="crumbs"><a href="${escapeHtml(projectHref)}">← 返回项目</a></span><span class="actions">${actions}</span></div>`,
    '<main><section class="card">',
    input.hideTitle === true ? "" : `<h1>${escapeHtml(name)}</h1>`,
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

function inlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return out;
}

function renderExpectedLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const main = /^\d+[.)]\s*(.*)$/.exec(line.trim());
      if (main !== null) {
        const value = main[1]!.trim();
        return value === "" ? "" : `<p>${inlineMarkdown(value)}</p>`;
      }
      const sub = /^([ivxlcdm]+)[.)]\s*(.*)$/i.exec(line.trim());
      if (sub !== null) {
        const value = sub[2]!.trim();
        return value === "" ? "" : `<div class="cs-sub">${inlineMarkdown(value)}</div>`;
      }
      const value = line.trim();
      return value === "" ? "" : `<p>${inlineMarkdown(value)}</p>`;
    })
    .join("");
}

/**
 * 轻量 Markdown 阅读器：标题/引用/列表/代码围栏。`mobile_run_task` 围栏折叠为
 * “执行器指令”，避免把长 taskDesc 直接铺满页面；原始 HTML 一律转义。
 */
function renderMarkdownDocument(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let caseOpen = false;
  const closeCase = (): void => {
    if (caseOpen) {
      out.push("</section>");
      caseOpen = false;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }
    if (/^<\/?details>$/.test(trimmed) || /^<summary>[\s\S]*<\/summary>$/.test(trimmed)) {
      i += 1;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const info = trimmed.slice(3).trim().toLowerCase();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        code.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const body = escapeHtml(code.join("\n"));
      if (info.includes("mobile_run_task") || code[0]?.trim().startsWith("用例：")) {
        out.push(
          `<details class="md-run"><summary><span>执行器指令</span><span class="md-run-hint">agent 读取</span></summary><pre>${body}</pre></details>`
        );
      } else {
        out.push(`<pre class="md-code">${body}</pre>`);
      }
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      const level = heading[1]!.length;
      const text = inlineMarkdown(heading[2]!.trim());
      if (level === 1) {
        closeCase();
        out.push(`<h1 class="md-title">${text}</h1>`);
      } else if (level === 2) {
        closeCase();
        out.push('<section class="md-case">');
        caseOpen = true;
        out.push(`<h2>${text}</h2>`);
      } else {
        out.push(`<h${level}>${text}</h${level}>`);
      }
      i += 1;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        items.push(inlineMarkdown(lines[i]!.trim().replace(/^>\s?/, "")));
        i += 1;
      }
      out.push(
        `<blockquote class="md-meta">${items.map((item) => `<p>${item}</p>`).join("")}</blockquote>`
      );
      continue;
    }
    const unordered = /^[-*]\s+/.test(trimmed);
    const ordered = /^\d+\.\s+/.test(trimmed);
    if (unordered || ordered) {
      const marker = unordered ? /^[-*]\s+/ : /^\d+\.\s+/;
      const items: string[] = [];
      let current: string | null = null;
      while (i < lines.length) {
        const candidate = lines[i]!.trim();
        if (candidate === "") break;
        if (marker.test(candidate)) {
          if (current !== null) items.push(current);
          current = inlineMarkdown(candidate.replace(marker, ""));
          i += 1;
          continue;
        }
        if (/^```|^#{1,6}\s|^>\s?/.test(candidate)) break;
        if (current !== null) {
          current += `<br>${inlineMarkdown(candidate)}`;
          i += 1;
          continue;
        }
        break;
      }
      if (current !== null) items.push(current);
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag} class="md-list">${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i]!.trim();
      if (
        candidate === "" ||
        /^```|^#{1,6}\s|^>\s?|^[-*]\s+|^\d+\.\s+/.test(candidate)
      ) {
        break;
      }
      paragraph.push(inlineMarkdown(candidate));
      i += 1;
    }
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join("<br>")}</p>`);
    } else {
      i += 1;
    }
  }
  closeCase();
  return `<div class="md-doc">${out.join("\n")}</div>`;
}

interface ParsedCaseSetCase {
  number: string;
  title: string;
  module: string | null;
  preconditions: string[];
  steps: string[];
  expected: string | null;
  taskDesc: string | null;
}

function parseCaseSetDocument(
  source: string
): { meta: string[]; cases: ParsedCaseSetCase[] } | null {
  if (!/^#\s+导入测试用例集/m.test(source)) return null;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const meta: string[] = [];
  const cases: Array<{ title: string; body: string[] }> = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      if (current !== null) cases.push(current);
      current = { title: line.slice(3).trim(), body: [] };
      continue;
    }
    if (current === null) {
      const value = line.replace(/^>\s?/, "").trim();
      if (value !== "") meta.push(value);
    } else {
      current.body.push(line);
    }
  }
  if (current !== null) cases.push(current);
  if (cases.length === 0) return null;

  const parsed: ParsedCaseSetCase[] = [];
  for (const [index, entry] of cases.entries()) {
    const heading = /^(\d+)\.\s*(.*)$/.exec(entry.title);
    const number = heading?.[1] ?? String(index + 1);
    const title = (heading?.[2] ?? entry.title).trim();
    let module: string | null = null;
    const preconditions: string[] = [];
    const taskDescLines: string[] = [];
    const rest: string[] = [];
    let inTaskDesc = false;
    for (const line of entry.body) {
      if (/^\s*```mobile_run_task\s*$/.test(line)) {
        inTaskDesc = true;
        continue;
      }
      if (inTaskDesc) {
        if (/^\s*```\s*$/.test(line)) {
          inTaskDesc = false;
          continue;
        }
        taskDescLines.push(line);
        continue;
      }
      const moduleMatch = /^-\s*模块：(.+)$/.exec(line.trim());
      if (moduleMatch !== null) {
        module = moduleMatch[1]!.trim();
        continue;
      }
      const preMatch = /^-\s*前置：(.+)$/.exec(line.trim());
      if (preMatch !== null) {
        preconditions.push(preMatch[1]!.trim());
        continue;
      }
      rest.push(line);
    }
    const joined = rest.join("\n").trim();
    const execute = /- 执行「([\s\S]*?)」，应出现「([\s\S]*?)」/.exec(joined);
    let steps: string[];
    let expected: string | null;
    if (execute !== null) {
      steps = execute[1]!
        .split("\n")
        .map((step) => step.trim().replace(/^\d+[.)]\s*/, ""))
        .filter((step) => step !== "");
      expected = execute[2]!
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join("\n");
    } else {
      const explore = /- 探索：([\s\S]*)/.exec(joined);
      if (explore === null) return null;
      steps = explore[1]!
        .split("\n")
        .map((step) => step.trim())
        .filter((step) => step !== "");
      expected = null;
    }
    if (steps.length === 0) return null;
    parsed.push({
      number,
      title,
      module,
      preconditions,
      steps,
      expected,
      taskDesc: taskDescLines.length > 0 ? taskDescLines.join("\n").trim() : null
    });
  }
  return { meta, cases: parsed };
}

function renderCaseSetDocument(
  parsed: { meta: string[]; cases: ParsedCaseSetCase[] }
): string {
  const meta = parsed.meta
    .map((line) => `<p>${inlineMarkdown(line)}</p>`)
    .join("");
  const cases = parsed.cases
    .map((entry) => {
      const pre =
        entry.preconditions.length === 0
          ? ""
          : `<div class="cs-pre"><span class="cs-label">前置</span><span>${entry.preconditions
              .map((item) => inlineMarkdown(item))
              .join("；")}</span></div>`;
      const steps = entry.steps
        .map((step) => `<li class="cs-step">${inlineMarkdown(step)}</li>`)
        .join("");
      const expected =
        entry.expected === null
          ? ""
          : `<div class="cs-expected"><div class="cs-expected-label">预期结果</div><div class="cs-expected-body">${renderExpectedLines(entry.expected)}</div></div>`;
      const taskDesc =
        entry.taskDesc === null
          ? ""
          : `<details class="md-run"><summary><span>执行器指令</span><span class="md-run-hint">agent 读取</span></summary><pre>${escapeHtml(entry.taskDesc)}</pre></details>`;
      return `<article class="cs-case"><header class="cs-head"><span class="cs-num">${escapeHtml(entry.number)}</span><div><h2 class="cs-title">${inlineMarkdown(entry.title)}</h2>${entry.module === null ? "" : `<span class="cs-module">${escapeHtml(entry.module)}</span>`}</div></header>${pre}<ol class="cs-steps">${steps}</ol>${expected}${taskDesc}</article>`;
    })
    .join("");
  return `<div class="md-doc"><h1 class="md-title">导入测试用例集</h1>${meta === "" ? "" : `<div class="md-meta">${meta}</div>`}${cases}</div>`;
}

/** Markdown 产物阅读器：正文 h1 作为标题，原始 Markdown 仍可从 raw 入口获取。 */
function renderMarkdownViewer(input: {
  rel: string;
  rootPath: string;
  hostId: string | null;
  data: Buffer;
  size: number;
  mtime: Date;
  rawHref: string;
}): PanelWebResponse {
  const text = input.data.toString("utf-8");
  const parsed = parseCaseSetDocument(text);
  return renderViewerPage({
    rel: input.rel,
    rootPath: input.rootPath,
    hostId: input.hostId,
    size: input.size,
    mtime: input.mtime,
    rawHref: input.rawHref,
    copyLabel: "复制 Markdown",
    rawLabel: "原始 Markdown",
    metaExtra: "Markdown",
    hideTitle: true,
    body: `<div id="viewer-body">${
      parsed === null ? renderMarkdownDocument(text) : renderCaseSetDocument(parsed)
    }</div>`
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
    if (wantsHtml && ext === ".md") {
      return renderMarkdownViewer({
        rel,
        rootPath: resolved.rootPath,
        hostId: resolved.hostId,
        data,
        size: info.size,
        mtime: info.mtime,
        rawHref
      });
    }
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
