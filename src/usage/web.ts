import { USAGE_EVENT_DEFAULT_LIMIT } from "../db/usage-event.js";
import type {
  ProjectRecord,
  ProjectStore,
  UsageEventQuery,
  UsageEventRecord,
  UsageSignal
} from "../db/types.js";
import {
  USAGE_EVENT_LIST_MAX,
  usageEvents,
  usageSignals,
  usageSummary,
  type UsageSignals,
  type UsageSummary
} from "./aggregate.js";
import { USAGE_DISABLED_NOTE, usageEnabledFrom, usageEventSampleLimit } from "./capture.js";

export interface UsageWebDeps {
  store: ProjectStore;
  catalog?: readonly string[];
  storageNote?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

export interface UsageWebResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface UsageWebProjectView {
  name: string;
  rootPath: string;
  lastSeenAt: string;
}

export interface UsageWebFiltersView {
  project: string | null;
  projectRoot: string | null;
  tool: string | null;
  status: "ok" | "error" | null;
  days: number | null;
  since: string | null;
  limit: number;
  offset: number;
  refresh: number | null;
}

export interface UsageWebEventView {
  id: string;
  at: string;
  tool: string;
  family: string;
  ok: boolean;
  durationMs: number;
  errorClass: string | null;
  errorSummary: string | null;
  signals: UsageSignal[];
  argKeys: string[];
  traceId: string | null;
}

export interface UsageWebToolRow {
  tool: string;
  count: number;
  ok: number;
  error: number;
  successRate: number | null;
  p50: number | null;
  p95: number | null;
  lastCallAt: string | null;
  zeroCall: boolean;
}

export interface UsageWebView {
  ok: boolean;
  generatedAt: string;
  usage: { enabled: boolean; storage: "postgres" | "memory"; note: string | null };
  store: { kind: "postgres" | "memory"; degraded: boolean; note: string | null };
  filters: UsageWebFiltersView;
  project: UsageWebProjectView | null;
  projects: UsageWebProjectView[];
  tools: UsageWebToolRow[];
  summary: UsageSummary;
  signals: UsageSignals;
  events: {
    total: number;
    count: number;
    limit: number;
    offset: number;
    items: UsageWebEventView[];
  };
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const MAX_REFRESH_SECONDS = 86_400;
const DEFAULT_MEMORY_NOTE = "内存降级：数据仅当前进程内有效，重启后丢失。";

const PAGE_CSS = [
  ":root{color-scheme:light dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5}",
  "main,header{max-width:1120px;margin:0 auto}",
  "h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;margin:16px 0 8px}",
  "section{border:1px solid #8884;border-radius:8px;padding:16px;margin:16px 0}",
  "table{border-collapse:collapse;width:100%;font-size:13px}",
  "th,td{border-bottom:1px solid #8883;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{font-weight:600;white-space:nowrap}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
  ".cards{display:flex;flex-wrap:wrap;gap:12px}",
  ".card{border:1px solid #8884;border-radius:8px;padding:10px 16px;min-width:120px}",
  ".card .k{font-size:12px;color:#888}.card .v{font-size:20px;font-weight:600}",
  ".badges{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}",
  ".badge{border-radius:999px;padding:2px 10px;font-size:12px;border:1px solid #8886}",
  ".badge.warn{border-color:#d97706;color:#d97706}",
  ".note{font-size:13px;color:#b45309;margin:4px 0}",
  ".muted{color:#888}.empty{color:#888;font-size:13px}",
  ".chip{display:inline-block;border:1px solid #8884;border-radius:999px;padding:0 8px;margin-right:6px;font-size:12px}",
  ".switcher,.filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:8px 0}",
  ".switcher label,.filters label{display:flex;flex-direction:column;font-size:12px;gap:2px}",
  "select,input[type=text],input[type=number]{padding:4px 6px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}",
  "button{padding:5px 12px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit;cursor:pointer}",
  ".pager{display:flex;gap:12px;align-items:center;margin-top:10px;font-size:13px}",
  ".zero-call{opacity:.55}.ok{color:#15803d}.err{color:#b91c1c}",
  ".summary{max-width:280px;word-break:break-word}",
  "a{color:#2563eb}"
].join("");

class UsageWebNotFoundError extends Error {}

function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const out = value.trim();
  return out === "" ? null : out;
}

function intParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

function usageWebEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_USAGE_WEB;
  return typeof raw !== "string" || raw.trim() !== "0";
}

function projectView(project: ProjectRecord): UsageWebProjectView {
  return { name: project.name, rootPath: project.rootPath, lastSeenAt: project.lastSeenAt };
}

function eventView(event: UsageEventRecord): UsageWebEventView {
  return {
    id: event.id,
    at: event.at,
    tool: event.tool,
    family: event.family,
    ok: event.ok,
    durationMs: event.durationMs,
    errorClass: event.errorClass,
    errorSummary: event.errorSummary,
    signals: event.signals.map((signal) => ({ ...signal })),
    argKeys: [...event.argKeys],
    traceId: event.traceId
  };
}

function resolveProject(projects: readonly ProjectRecord[], key: string): ProjectRecord | null {
  return (
    projects.find((project) => project.rootPath === key) ??
    projects.find((project) => project.name === key) ??
    null
  );
}

async function buildView(url: URL, deps: UsageWebDeps): Promise<UsageWebView> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const params = url.searchParams;
  const catalog = deps.catalog
    ? [...new Set(deps.catalog)].filter((name) => name !== "aos_usage").sort()
    : undefined;

  const projects = await deps.store.listProjects();
  const projectKey = trimmed(params.get("project"));
  const requested = projectKey === null ? null : resolveProject(projects, projectKey);
  if (projectKey !== null && requested === null) {
    throw new UsageWebNotFoundError(`未知项目 "${projectKey}"`);
  }
  const project = projectKey === null ? (projects[0] ?? null) : requested;

  const tool = trimmed(params.get("tool"));
  const statusRaw = trimmed(params.get("status"));
  const status = statusRaw === "ok" || statusRaw === "error" ? statusRaw : null;
  const daysRaw = intParam(params, "days");
  const days = daysRaw !== null && daysRaw >= 1 ? daysRaw : null;
  const refreshRaw = intParam(params, "refresh");
  const refresh =
    refreshRaw !== null && refreshRaw >= 1 && refreshRaw <= MAX_REFRESH_SECONDS
      ? refreshRaw
      : null;
  const limitRaw = intParam(params, "limit");
  const limit =
    limitRaw !== null && limitRaw >= 1
      ? Math.min(limitRaw, USAGE_EVENT_LIST_MAX)
      : USAGE_EVENT_DEFAULT_LIMIT;
  const offsetRaw = intParam(params, "offset");
  const offset = offsetRaw !== null && offsetRaw > 0 ? offsetRaw : 0;
  const since = days === null ? null : new Date(now - days * 86_400_000).toISOString();

  const query: UsageEventQuery = { limit: usageEventSampleLimit(deps.env ?? process.env) };
  if (tool !== null) query.tool = tool;
  if (status !== null) query.status = status;
  if (since !== null) query.since = since;

  const stored = project ? await deps.store.listUsageEvents(project.rootPath, query) : [];
  const summary = usageSummary(stored, catalog);
  const signals = usageSignals(stored);
  const newest = usageEvents(stored, { ...query, limit: USAGE_EVENT_LIST_MAX });
  const items = newest.slice(offset, offset + limit);

  const lastCall = new Map<string, string>();
  for (const event of stored) {
    const current = lastCall.get(event.tool);
    if (current === undefined || event.at > current) lastCall.set(event.tool, event.at);
  }
  const tools: UsageWebToolRow[] = summary.byTool.map((row) => ({
    ...row,
    lastCallAt: lastCall.get(row.tool) ?? null,
    zeroCall: false
  }));
  for (const name of summary.zeroCallTools) {
    tools.push({
      tool: name,
      count: 0,
      ok: 0,
      error: 0,
      successRate: null,
      p50: null,
      p95: null,
      lastCallAt: null,
      zeroCall: true
    });
  }

  const enabled = usageEnabledFrom(env);
  const storage = deps.store.kind;
  const storageNote =
    deps.storageNote?.trim() || (storage === "memory" ? DEFAULT_MEMORY_NOTE : null);

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    usage: enabled
      ? { enabled, storage, note: null }
      : { enabled, storage, note: USAGE_DISABLED_NOTE },
    store: { kind: storage, degraded: storage === "memory", note: storageNote },
    filters: {
      project: project?.name ?? null,
      projectRoot: project?.rootPath ?? null,
      tool,
      status,
      days,
      since,
      limit,
      offset,
      refresh
    },
    project: project ? projectView(project) : null,
    projects: projects.map(projectView),
    tools,
    summary,
    signals,
    events: { total: summary.total, count: items.length, limit, offset, items: items.map(eventView) }
  };
}

export async function handleUsageRequest(
  url: URL,
  deps: UsageWebDeps
): Promise<UsageWebResponse> {
  const env = deps.env ?? process.env;
  if (!usageWebEnabled(env)) {
    return { status: 404, contentType: JSON_CONTENT_TYPE, body: '{"error":"not found"}' };
  }
  if (url.pathname !== "/usage" && url.pathname !== "/usage.json") {
    return { status: 404, contentType: JSON_CONTENT_TYPE, body: '{"error":"not found"}' };
  }
  let view: UsageWebView;
  try {
    view = await buildView(url, deps);
  } catch (error) {
    if (error instanceof UsageWebNotFoundError) {
      return {
        status: 404,
        contentType: JSON_CONTENT_TYPE,
        body: JSON.stringify({ error: error.message })
      };
    }
    throw error;
  }
  if (url.pathname === "/usage.json") {
    return { status: 200, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(view, null, 2) };
  }
  return { status: 200, contentType: HTML_CONTENT_TYPE, body: renderUsageHtml(view) };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`;
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  emptyText: string
): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderSwitcher(view: UsageWebView): string {
  if (view.projects.length === 0) {
    return '<p class="muted">暂无已注册项目</p>';
  }
  const options = view.projects
    .map((project) => {
      const selected = view.project?.rootPath === project.rootPath ? " selected" : "";
      return `<option value="${escapeHtml(project.rootPath)}"${selected}>${escapeHtml(project.name)}</option>`;
    })
    .join("");
  const hidden: string[] = [];
  if (view.filters.tool !== null) {
    hidden.push(`<input type="hidden" name="tool" value="${escapeHtml(view.filters.tool)}">`);
  }
  if (view.filters.status !== null) {
    hidden.push(`<input type="hidden" name="status" value="${escapeHtml(view.filters.status)}">`);
  }
  if (view.filters.days !== null) {
    hidden.push(`<input type="hidden" name="days" value="${view.filters.days}">`);
  }
  if (view.filters.refresh !== null) {
    hidden.push(`<input type="hidden" name="refresh" value="${view.filters.refresh}">`);
  }
  return [
    '<form class="switcher" method="get" action="/usage">',
    `<label>项目 <select name="project">${options}</select></label>`,
    hidden.join(""),
    '<button type="submit">切换</button>',
    "</form>"
  ].join("");
}

function renderBadges(view: UsageWebView): string {
  const storageLabel = view.store.kind === "postgres" ? "PostgreSQL" : "内存降级";
  const storageClass = view.store.kind === "postgres" ? "badge" : "badge warn";
  const usageLabel = view.usage.enabled ? "采集已开启" : "采集已关闭（AOS_USAGE=0）";
  const usageClass = view.usage.enabled ? "badge" : "badge warn";
  const parts = [
    `<p class="badges"><span class="${storageClass}" data-storage="${view.store.kind}">存储：${escapeHtml(storageLabel)}</span>`,
    `<span class="${usageClass}" data-usage="${view.usage.enabled ? "on" : "off"}">${escapeHtml(usageLabel)}</span></p>`
  ];
  if (view.store.note) parts.push(`<p class="note">${escapeHtml(view.store.note)}</p>`);
  if (view.usage.note) parts.push(`<p class="note">${escapeHtml(view.usage.note)}</p>`);
  return parts.join("");
}

function renderOverview(view: UsageWebView): string {
  const families =
    view.summary.byFamily
      .map((entry) => `<span class="chip">${escapeHtml(entry.family)} ${entry.count}</span>`)
      .join("") || '<span class="muted">暂无</span>';
  return [
    '<section id="overview">',
    "<h2>概览</h2>",
    '<div class="cards">',
    `<div class="card"><div class="k">事件总数</div><div class="v">${view.summary.total}</div></div>`,
    `<div class="card"><div class="k">成功率</div><div class="v">${formatPercent(view.summary.successRate)}</div></div>`,
    `<div class="card"><div class="k">p50</div><div class="v">${formatMs(view.summary.p50)}</div></div>`,
    `<div class="card"><div class="k">p95</div><div class="v">${formatMs(view.summary.p95)}</div></div>`,
    "</div>",
    `<p class="muted">项目：${escapeHtml(view.project?.name ?? "未注册项目")} · 过滤后事件：${view.summary.total} 条 · 家族：${families}</p>`,
    "</section>"
  ].join("\n");
}

function renderTools(view: UsageWebView): string {
  const rows = view.tools
    .map((row) => {
      const classes = row.zeroCall ? "zero-call" : "";
      const rate = row.successRate === null ? "—" : formatPercent(row.successRate);
      const zero = row.zeroCall ? ' <span class="muted">零调用</span>' : "";
      return [
        `<tr class="${classes}" data-tool="${escapeHtml(row.tool)}" data-zero-call="${row.zeroCall ? "1" : "0"}">`,
        `<td><code>${escapeHtml(row.tool)}</code>${zero}</td>`,
        `<td>${row.count}</td>`,
        `<td>${rate}</td>`,
        `<td>${formatMs(row.p95)}</td>`,
        `<td>${escapeHtml(row.lastCallAt ?? "—")}</td>`,
        "</tr>"
      ].join("");
    })
    .join("");
  const table =
    view.tools.length === 0
      ? '<p class="empty">暂无数据</p>'
      : `<table><thead><tr><th>工具</th><th>调用</th><th>成功率</th><th>p95</th><th>最近调用</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<section id="tools">\n<h2>工具表</h2>\n${table}\n</section>`;
}

function renderSignals(view: UsageWebView): string {
  const { errorClasses, unclassified, signalCodes, degradations, argKeys } = view.signals;
  return [
    '<section id="signals">',
    "<h2>信号面板</h2>",
    "<h3>错误类分布</h3>",
    renderTable(
      ["错误类", "次数"],
      errorClasses.map((entry) => [entry.errorClass ?? "（无错误）", String(entry.count)]),
      "暂无数据"
    ),
    "<h3>未分类错误模板</h3>",
    renderTable(
      ["模板", "次数", "工具"],
      unclassified.map((entry) => [entry.template, String(entry.count), entry.tools.join(", ")]),
      "暂无数据"
    ),
    "<h3>信号码分布</h3>",
    renderTable(
      ["code", "field", "次数"],
      signalCodes.map((entry) => [entry.code, entry.field ?? "—", String(entry.count)]),
      "暂无数据"
    ),
    "<h3>降级标记</h3>",
    renderTable(
      ["code", "次数"],
      degradations.map((entry) => [entry.code, String(entry.count)]),
      "暂无数据"
    ),
    "<h3>参数键频次</h3>",
    renderTable(
      ["工具", "参数键"],
      argKeys.map((entry) => [
        entry.tool,
        entry.keys.map((key) => `${key.key}×${key.count}`).join(", ") || "—"
      ]),
      "暂无数据"
    ),
    "</section>"
  ].join("\n");
}

function eventsPageHref(view: UsageWebView, offset: number): string {
  const params = new URLSearchParams();
  if (view.project) params.set("project", view.project.rootPath);
  if (view.filters.tool !== null) params.set("tool", view.filters.tool);
  if (view.filters.status !== null) params.set("status", view.filters.status);
  if (view.filters.days !== null) params.set("days", String(view.filters.days));
  if (view.filters.refresh !== null) params.set("refresh", String(view.filters.refresh));
  params.set("limit", String(view.filters.limit));
  if (offset > 0) params.set("offset", String(offset));
  return `/usage?${params.toString()}`;
}

function renderEvents(view: UsageWebView): string {
  const fields: string[] = [];
  if (view.project) {
    fields.push(
      `<input type="hidden" name="project" value="${escapeHtml(view.project.rootPath)}">`
    );
  }
  fields.push(
    `<label>工具 <input type="text" name="tool" value="${escapeHtml(view.filters.tool ?? "")}"></label>`
  );
  const statusOptions = [
    `<option value=""${view.filters.status === null ? " selected" : ""}>全部</option>`,
    `<option value="ok"${view.filters.status === "ok" ? " selected" : ""}>ok</option>`,
    `<option value="error"${view.filters.status === "error" ? " selected" : ""}>error</option>`
  ].join("");
  fields.push(`<label>状态 <select name="status">${statusOptions}</select></label>`);
  fields.push(
    `<label>天数 <input type="number" name="days" min="1" value="${view.filters.days ?? ""}"></label>`
  );
  fields.push(
    `<label>每页 <input type="number" name="limit" min="1" max="200" value="${view.filters.limit}"></label>`
  );
  if (view.filters.refresh !== null) {
    fields.push(`<input type="hidden" name="refresh" value="${view.filters.refresh}">`);
  }
  const resetParams = new URLSearchParams();
  if (view.project) resetParams.set("project", view.project.rootPath);
  if (view.filters.refresh !== null) resetParams.set("refresh", String(view.filters.refresh));
  const resetQuery = resetParams.toString();
  fields.push('<button type="submit">筛选</button>');
  fields.push(`<a class="reset" href="${escapeHtml(`/usage${resetQuery === "" ? "" : `?${resetQuery}`}`)}">重置</a>`);

  const rows = view.events.items
    .map((event) => {
      const result = event.ok ? '<span class="ok">成功</span>' : '<span class="err">失败</span>';
      const signals =
        event.signals
          .map((signal) => (signal.field ? `${signal.code}:${signal.field}` : signal.code))
          .join(", ") || "—";
      return [
        `<tr class="${event.ok ? "ok" : "err"}" data-tool="${escapeHtml(event.tool)}">`,
        `<td><div>${escapeHtml(event.at)}</div><code class="muted" title="${escapeHtml(event.id)}">${escapeHtml(event.id.slice(0, 8))}</code></td>`,
        `<td><code>${escapeHtml(event.tool)}</code></td>`,
        `<td>${escapeHtml(event.family)}</td>`,
        `<td>${result}</td>`,
        `<td>${event.durationMs} ms</td>`,
        `<td>${escapeHtml(event.errorClass ?? "—")}</td>`,
        `<td class="summary">${escapeHtml(event.errorSummary ?? "—")}</td>`,
        `<td>${escapeHtml(signals)}</td>`,
        `<td>${escapeHtml(event.argKeys.join(", ") || "—")}</td>`,
        `<td>${escapeHtml(event.traceId ?? "—")}</td>`,
        "</tr>"
      ].join("");
    })
    .join("");
  const table =
    view.events.items.length === 0
      ? '<p class="empty">暂无事件</p>'
      : `<table><thead><tr><th>时间</th><th>工具</th><th>家族</th><th>结果</th><th>耗时</th><th>错误类</th><th>摘要</th><th>信号</th><th>参数键</th><th>trace</th></tr></thead><tbody>${rows}</tbody></table>`;

  const visibleTotal = Math.min(view.events.total, USAGE_EVENT_LIST_MAX);
  const start = view.events.count === 0 ? 0 : view.filters.offset + 1;
  const end = view.filters.offset + view.events.count;
  const pager = [
    view.events.count === 0
      ? '<span class="muted">暂无匹配事件</span>'
      : `<span class="muted">第 ${start}-${end} 条 / 共 ${view.events.total} 条</span>`
  ];
  if (view.events.total > USAGE_EVENT_LIST_MAX) {
    pager.push(`<span class="muted">（仅最近 ${USAGE_EVENT_LIST_MAX} 条可翻页）</span>`);
  }
  if (view.filters.offset > 0) {
    pager.push(
      `<a href="${escapeHtml(eventsPageHref(view, Math.max(0, view.filters.offset - view.filters.limit)))}">上一页</a>`
    );
  }
  if (end < visibleTotal) {
    pager.push(
      `<a href="${escapeHtml(eventsPageHref(view, view.filters.offset + view.filters.limit))}">下一页</a>`
    );
  }

  return [
    '<section id="events">',
    "<h2>事件流水</h2>",
    `<form class="filters" method="get" action="/usage">${fields.join("")}</form>`,
    table,
    `<div class="pager">${pager.join("")}</div>`,
    "</section>"
  ].join("\n");
}

export function renderUsageHtml(view: UsageWebView): string {
  const projectLabel = view.project?.name ?? "未注册项目";
  const refreshMeta =
    view.filters.refresh === null
      ? ""
      : `<meta http-equiv="refresh" content="${view.filters.refresh}">`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>使用统计 · ${escapeHtml(projectLabel)}</title>`,
    refreshMeta,
    `<style>${PAGE_CSS}</style>`,
    "</head>",
    "<body>",
    "<header>",
    "<h1>使用统计</h1>",
    renderSwitcher(view),
    renderBadges(view),
    "</header>",
    "<main>",
    renderOverview(view),
    renderTools(view),
    renderSignals(view),
    renderEvents(view),
    "</main>",
    "</body>",
    "</html>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}
