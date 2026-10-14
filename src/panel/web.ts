import fs from "node:fs";
import path from "node:path";

import type { ProjectStore, RunnerTools } from "../db/types.js";
import { formatBytes } from "../figma/retention.js";
import { escapeHtml } from "../util.js";
import {
  buildPanelBatchDetail,
  buildPanelOverview,
  buildPanelProjectDetail,
  buildPanelReviewQueue,
  buildPanelStatsView,
  buildPanelTaskDetail,
  PANEL_BATCH_LIMIT_DEFAULT,
  PANEL_BATCH_LIMIT_MAX,
  type PanelBatchDetail,
  type PanelBatchRow,
  type PanelDeps,
  type PanelImprovementItem,
  type PanelOverview,
  type PanelProjectDetail,
  type PanelProjectRow,
  type PanelReviewItem,
  type PanelStandaloneRow,
  type PanelStatsView,
  type PanelTaskDetail
} from "./overview.js";
import { PANEL_IOS_PROBE_TTL_MS, type PanelDeepProbe } from "./deep.js";

/** 总览面板 Web 处理（overview-panel T3/T4，DESIGN §13.97/§13.98）：
 * 服务端渲染 HTML（内联 CSS、零依赖）+ 同源 JSON；只读、默认 loopback；
 * 进程内短缓存（TTL 默认 5s，`AOS_PANEL_CACHE_MS` 可配）；`AOS_PANEL_WEB=0` 关闭。 */

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const PROJECT_KEY_RE = /^[A-Za-z0-9._-]+$/;

export const PANEL_CACHE_TTL_DEFAULT_MS = 5_000;

export interface PanelWebDeps {
  store: ProjectStore;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string | null;
  serviceRepo?: string;
  buildStale?: boolean | null;
  now?: () => number;
  cache?: PanelWebCache | null;
  /** 深探层（HTTP 模式注入；懒建 Runtime 纯读子集）。 */
  deep?: PanelDeepProbe | null;
}

export interface PanelWebResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface PanelWebCache {
  get(key: string): PanelWebResponse | undefined;
  set(key: string, response: PanelWebResponse): void;
  /** 动作层写后失效：POST 成功后 reload 立即看到新状态。 */
  clear(): void;
}

export function createPanelWebCache(ttlMs: number, now: () => number = Date.now): PanelWebCache {
  const entries = new Map<string, { at: number; response: PanelWebResponse }>();
  return {
    get(key: string): PanelWebResponse | undefined {
      if (!(ttlMs > 0)) return undefined;
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.response;
    },
    set(key: string, response: PanelWebResponse): void {
      if (!(ttlMs > 0)) return;
      entries.set(key, { at: now(), response });
    },
    clear(): void {
      entries.clear();
    }
  };
}

export function panelWebEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AOS_PANEL_WEB;
  return typeof raw !== "string" || raw.trim() !== "0";
}

export function panelCacheTtlFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.AOS_PANEL_CACHE_MS?.trim();
  if (!raw) return PANEL_CACHE_TTL_DEFAULT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : PANEL_CACHE_TTL_DEFAULT_MS;
}

type PanelView =
  | { kind: "overview"; overview: PanelOverview }
  | { kind: "project"; rootPath: string; detail: PanelProjectDetail }
  | { kind: "task"; rootPath: string; detail: PanelTaskDetail }
  | { kind: "review"; rootPath: string; detail: { items: PanelReviewItem[]; warnings: string[] } }
  | { kind: "stats"; rootPath: string; detail: PanelStatsView }
  | { kind: "batch"; rootPath: string; detail: PanelBatchDetail };

class PanelNotFoundError extends Error {}

function notFound(message = "not found"): PanelWebResponse {
  return { status: 404, contentType: JSON_CONTENT_TYPE, body: JSON.stringify({ error: message }) };
}

function trimmed(value: string | null): string | null {
  if (value === null) return null;
  const out = value.trim();
  return out === "" ? null : out;
}

function intParam(params: URLSearchParams, key: string): number | null {
  const raw = trimmed(params.get(key));
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

export async function resolveProjectKey(
  deps: PanelWebDeps,
  key: string
): Promise<{ rootPath: string; name: string } | null> {
  let projects: Array<{ name: string; rootPath: string }> = [];
  try {
    projects = await deps.store.listProjects();
  } catch {
    projects = [];
  }
  const byPath = projects.find((project) => project.rootPath === key);
  if (byPath) return { rootPath: byPath.rootPath, name: byPath.name };
  const byName = projects.find((project) => project.name === key);
  if (byName) return { rootPath: byName.rootPath, name: byName.name };
  if (deps.workspaceRoot && PROJECT_KEY_RE.test(key) && key !== "." && key !== "..") {
    const rootPath = path.join(deps.workspaceRoot, key);
    try {
      if (fs.statSync(rootPath).isDirectory()) return { rootPath, name: key };
    } catch {
      /* fall through */
    }
  }
  return null;
}

async function buildView(url: URL, deps: PanelWebDeps): Promise<PanelView> {
  const panelDeps: PanelDeps = {
    store: deps.store,
    env: deps.env ?? process.env,
    workspaceRoot: deps.workspaceRoot ?? null,
    ...(deps.serviceRepo !== undefined ? { serviceRepo: deps.serviceRepo } : {}),
    buildStale: deps.buildStale ?? null,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.deep !== undefined ? { deepProbe: deps.deep } : {})
  };
  const projectKey = trimmed(url.searchParams.get("project"));
  if (projectKey === null) {
    return { kind: "overview", overview: await buildPanelOverview(panelDeps) };
  }
  const resolved = await resolveProjectKey(deps, projectKey);
  if (!resolved) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);

  const taskId = trimmed(url.searchParams.get("task"));
  if (taskId !== null) {
    const detail = await buildPanelTaskDetail(panelDeps, resolved.rootPath, taskId);
    if (!detail) throw new PanelNotFoundError(`未知回归任务 "${taskId}"`);
    return { kind: "task", rootPath: resolved.rootPath, detail };
  }

  const batchFile = trimmed(url.searchParams.get("batch"));
  if (batchFile !== null) {
    const detail = await buildPanelBatchDetail(panelDeps, resolved.rootPath, batchFile);
    if (!detail) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);
    return { kind: "batch", rootPath: resolved.rootPath, detail };
  }

  if (trimmed(url.searchParams.get("view")) === "review") {
    const detail = await buildPanelReviewQueue(panelDeps, resolved.rootPath, { limit: 10 });
    return { kind: "review", rootPath: resolved.rootPath, detail };
  }

  if (trimmed(url.searchParams.get("view")) === "stats") {
    const detail = await buildPanelStatsView(panelDeps, resolved.rootPath);
    return { kind: "stats", rootPath: resolved.rootPath, detail };
  }

  const limitRaw = intParam(url.searchParams, "limit");
  const batchLimit = Math.min(Math.max(limitRaw ?? PANEL_BATCH_LIMIT_DEFAULT, 1), PANEL_BATCH_LIMIT_MAX);
  const detail = await buildPanelProjectDetail(panelDeps, resolved.rootPath, {
    batchLimit,
    iosProbe: trimmed(url.searchParams.get("ios")) === "1"
  });
  if (!detail) throw new PanelNotFoundError(`未知项目 "${projectKey}"`);
  return { kind: "project", rootPath: resolved.rootPath, detail };
}

function toJsonView(view: PanelView): Record<string, unknown> {
  if (view.kind === "overview") return { ...view.overview, view: "overview" };
  if (view.kind === "project") return { ok: true, view: "project", ...view.detail };
  if (view.kind === "task") return { ok: true, view: "task", ...view.detail };
  if (view.kind === "review") return { ok: true, view: "review", ...view.detail };
  if (view.kind === "stats") return { ok: true, view: "stats", ...view.detail };
  return { ok: true, view: "batch", ...view.detail };
}

export async function handlePanelRequest(url: URL, deps: PanelWebDeps): Promise<PanelWebResponse> {
  const env = deps.env ?? process.env;
  if (!panelWebEnabled(env)) return notFound();
  if (url.pathname !== "/panel" && url.pathname !== "/panel.json") return notFound();

  const cacheKey = `${url.pathname}${url.search}`;
  const cached = deps.cache?.get(cacheKey);
  if (cached) return cached;

  let view: PanelView;
  try {
    view = await buildView(url, deps);
  } catch (error) {
    if (error instanceof PanelNotFoundError) return notFound(error.message);
    throw error;
  }

  const response: PanelWebResponse =
    url.pathname === "/panel.json"
      ? { status: 200, contentType: JSON_CONTENT_TYPE, body: JSON.stringify(toJsonView(view), null, 2) }
      : { status: 200, contentType: HTML_CONTENT_TYPE, body: renderPanelHtml(view) };
  deps.cache?.set(cacheKey, response);
  return response;
}

// ---------------------------------------------------------------------------
// HTML rendering

const PAGE_CSS = [
  ":root{color-scheme:light dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5}",
  "main,header{max-width:1120px;margin:0 auto}",
  "h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin:0 0 12px}",
  "section{border:1px solid #8884;border-radius:8px;padding:16px;margin:16px 0}",
  "table{border-collapse:collapse;width:100%;font-size:13px}",
  "th,td{border-bottom:1px solid #8883;padding:6px 8px;text-align:left;vertical-align:top}",
  "th{font-weight:600;white-space:nowrap}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
  ".cards{display:flex;flex-wrap:wrap;gap:12px}",
  ".card{border:1px solid #8884;border-radius:8px;padding:10px 16px;min-width:120px}",
  ".card .k{font-size:12px;color:#888}.card .v{font-size:20px;font-weight:600}",
  ".badge{border-radius:999px;padding:2px 10px;font-size:12px;border:1px solid #8886;display:inline-block}",
  ".badge.warn{border-color:#d97706;color:#d97706}",
  ".note{font-size:13px;color:#b45309;margin:4px 0}",
  ".muted{color:#888}.empty{color:#888;font-size:13px}",
  ".chip{display:inline-block;border:1px solid #8884;border-radius:999px;padding:0 8px;margin:0 6px 6px 0;font-size:12px}",
  ".lamp{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}",
  ".lamp-red{background:#dc2626}.lamp-yellow{background:#d97706}.lamp-green{background:#16a34a}.lamp-gray{background:#6b7280}",
  ".gate-pass{color:#15803d}.gate-fail{color:#b91c1c}",
  ".ok{color:#15803d}.err{color:#b91c1c}",
  "a{color:#2563eb}",
  "ul{margin:6px 0;padding-left:20px}"
].join("");

function renderTable(headers: string[], rows: string[][], emptyText: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function projectHref(rootPath: string): string {
  return `/panel?project=${encodeURIComponent(rootPath)}`;
}

function batchHref(rootPath: string, file: string): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&batch=${encodeURIComponent(file)}`;
}

function taskHref(rootPath: string, taskId: string): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&task=${encodeURIComponent(taskId)}`;
}

function reviewHref(rootPath: string): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&view=review`;
}

function statsHref(rootPath: string): string {
  return `/panel?project=${encodeURIComponent(rootPath)}&view=stats`;
}

function gateSpan(gate: "pass" | "fail" | null): string {
  if (gate === null) return '<span class="muted">—</span>';
  return gate === "pass"
    ? '<span class="gate-pass">通过</span>'
    : '<span class="gate-fail">未通过</span>';
}

const LAMP_LABELS: Record<PanelProjectRow["lamp"], string> = {
  red: "红",
  yellow: "黄",
  green: "绿",
  gray: "灰"
};

function lampSpan(lamp: PanelProjectRow["lamp"]): string {
  return `<span class="lamp lamp-${lamp}"></span>${LAMP_LABELS[lamp]}`;
}

function renderProjectCell(row: PanelProjectRow): string {
  const reasons =
    row.lampReasons.length > 0
      ? `<div class="muted">${row.lampReasons.map((reason) => escapeHtml(reason)).join("；")}</div>`
      : "";
  return `<span>${lampSpan(row.lamp)}</span>${reasons}`;
}

function renderLatestBatchCell(row: PanelProjectRow): string {
  const batch = row.latestBatch;
  if (batch === null) return '<span class="muted">无批次记录</span>';
  const summary =
    batch.summary === null
      ? ""
      : ` · 通过 ${batch.summary.passed ?? "—"}/${batch.summary.total ?? "—"}`;
  const note = batch.note !== null ? ` · ${escapeHtml(batch.note)}` : "";
  return [
    gateSpan(batch.gate),
    `<code>${escapeHtml(batch.runId ?? "（不可读）")}</code>`,
    `<div class="muted">${escapeHtml(batch.finishedAt ?? "—")}${summary}${note}</div>`
  ].join("<br>");
}

function renderOverviewPage(view: PanelOverview, cacheNote: string): string {
  const store = view.store.degraded
    ? `<span class="badge warn" data-storage="memory">存储：内存降级</span>`
    : `<span class="badge" data-storage="postgres">存储：PostgreSQL</span>`;
  const rows = view.projects.map((row) => [
    `<a href="${escapeHtml(projectHref(row.rootPath))}"><code>${escapeHtml(row.name)}</code></a>`,
    renderProjectCell(row),
    escapeHtml(row.stacks.join("、") || "—"),
    escapeHtml(row.lastSeenAt ?? "—"),
    renderLatestBatchCell(row),
    escapeHtml(row.warnings.join("；") || "—")
  ]);
  return page(
    "多项目总览",
    [
      "<header>",
      "<h1>多项目总览</h1>",
      `<p class="badges">${store}<span class="badge">宿主 deps：${escapeHtml(view.host.deps)}</span>` +
        `<span class="badge">构建：${
          view.host.buildStale === null ? "未知" : view.host.buildStale ? "陈旧（需重启）" : "最新"
        }</span></p>`,
      `<p class="muted">生成时间 ${escapeHtml(view.generatedAt)} · 项目 ${view.projects.length} 个 · ${escapeHtml(cacheNote)}</p>`,
      "</header>",
      "<main>",
      '<section id="projects">',
      "<h2>项目</h2>",
      renderTable(["项目", "接入健康", "栈", "最后活跃", "最新批次", "备注"], rows, "暂无项目"),
      "</section>",
      "</main>"
    ].join("\n")
  );
}

function renderCredentialRows(detail: PanelProjectDetail): string[][] {
  const integration = detail.integration;
  if (integration === null) return [];
  const { figma, jira, penKey } = integration.credentials;
  return [
    ["Figma token", figma ? "已配置" : "未配置", "—"],
    [
      "Jira",
      jira.configured ? "已配置" : "未配置",
      jira.siteUrl ?? (jira.missing.length > 0 ? `缺 ${jira.missing.join("、")}` : "—")
    ],
    ["pen CLI key", penKey ? "已配置" : "未配置", "—"]
  ];
}

function renderIntegration(detail: PanelProjectDetail): string {
  const integration = detail.integration;
  if (integration === null) {
    return [
      '<section id="integration">',
      "<h2>接入信息</h2>",
      '<p class="note">磁盘不可达：集成软读不可用（仅台账视图）。</p>',
      "</section>"
    ].join("\n");
  }
  const deviceHosts = integration.deviceHosts.configured
    ? [
        integration.deviceHosts.iosAppiumUrl !== null
          ? `iOS Appium：<code>${escapeHtml(integration.deviceHosts.iosAppiumUrl)}</code>`
          : null,
        integration.deviceHosts.androidAdbHost !== null
          ? `Android adbHost：<code>${escapeHtml(integration.deviceHosts.androidAdbHost)}</code>`
          : null
      ]
        .filter((line): line is string => line !== null)
        .join("<br>")
    : '<span class="muted">未配置</span>';
  const validation = [
    ...integration.validation.errors.map((message) => `<p class="note">错误：${escapeHtml(message)}</p>`),
    ...integration.validation.warnings.map((message) => `<p class="note">警告：${escapeHtml(message)}</p>`)
  ].join("");
  const assets = integration.assets.map((asset) => [
    escapeHtml(asset.id),
    `<code>${escapeHtml(asset.path)}</code>`,
    asset.present ? '<span class="ok">存在</span>' : '<span class="muted">缺失</span>',
    escapeHtml(asset.modifiedAt ?? "—")
  ]);
  return [
    '<section id="integration">',
    "<h2>接入信息</h2>",
    '<div class="cards">',
    `<div class="card"><div class="k">LLM 条目</div><div class="v">${integration.llm.entries}</div></div>`,
    `<div class="card"><div class="k">active</div><div class="v">${escapeHtml(integration.llm.activeName ?? "—")}</div></div>`,
    `<div class="card"><div class="k">LLM 可用</div><div class="v">${integration.llm.usable ? "是" : "否"}</div></div>`,
    "</div>",
    integration.llm.usable
      ? ""
      : `<p class="note">缺项：${escapeHtml(integration.llm.missing.slice(0, 5).join("；"))}</p>`,
    renderTable(["凭证", "状态", "备注"], renderCredentialRows(detail), "—"),
    validation,
    `<h3>设备宿主</h3><p>${deviceHosts}</p>`,
    `<h3>宿主</h3><p class="muted">deps：${escapeHtml(integration.host.deps)} · 构建：${
      integration.host.buildStale === null ? "未知" : integration.host.buildStale ? "陈旧（需重启）" : "最新"
    }</p>`,
    `<h3>设计资产</h3>`,
    renderTable(["资产", "路径", "状态", "更新时间"], assets, "暂无资产"),
    "</section>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderBatches(detail: PanelProjectDetail, rootPath: string): string {
  const rows = detail.batches.map((batch: PanelBatchRow) => [
    escapeHtml(batch.startedAt ?? "—"),
    escapeHtml(batch.finishedAt ?? "—"),
    escapeHtml(batch.source ?? "—"),
    gateSpan(batch.gate),
    batch.summary === null
      ? "—"
      : `${batch.summary.passed ?? "—"}/${batch.summary.total ?? "—"}`,
    batch.failureDomains === null
      ? "—"
      : escapeHtml(
          Object.entries(batch.failureDomains)
            .map(([domain, count]) => `${domain}×${count}`)
            .join("、") || "—"
        ),
    `<a href="${escapeHtml(batchHref(rootPath, batch.file))}"><code>${escapeHtml(batch.file)}</code></a>` +
      (batch.note !== null ? `<div class="muted">${escapeHtml(batch.note)}</div>` : "")
  ]);
  const empty =
    detail.emptyState === null
      ? "暂无批次记录"
      : `暂无批次记录（可能原因：${detail.emptyState.causes.map((cause) => escapeHtml(cause)).join("；")}）`;
  const trend = detail.trend;
  const trendLine =
    trend === null
      ? ""
      : [
          `<p class="muted">趋势（旧→新${
            trend.points.length > 20 ? "，仅最近 20 批" : ""
          }）：${trend.points
            .slice(-20)
            .map(
              (point) =>
                `<span class="${point.gate === "fail" ? "gate-fail" : "gate-pass"}">${
                  point.passed ?? "—"
                }/${point.total ?? "—"}</span>`
            )
            .join(" → ")}</p>`,
          Object.keys(trend.domainTotals).length > 0
            ? `<p>${Object.entries(trend.domainTotals)
                .map(([domain, count]) => `<span class="chip">${escapeHtml(domain)} × ${count}</span>`)
                .join("")}</p>`
            : ""
        ].join("\n");
  return [
    '<section id="batches">',
    "<h2>测试批次</h2>",
    trendLine,
    renderTable(["开始", "结束", "来源", "门禁", "通过/总数", "失败域", "清单"], rows, empty),
    "</section>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function renderStandalones(detail: PanelProjectDetail): string {
  const outcomeLabel: Record<PanelStandaloneRow["outcome"], string> = {
    passed: '<span class="ok">通过</span>',
    failed: '<span class="err">失败</span>',
    pending: "运行中"
  };
  const rows = detail.standalones.map((row) => [
    `<code>${escapeHtml(row.traceId)}</code>`,
    escapeHtml(row.caseId ?? "—"),
    outcomeLabel[row.outcome],
    escapeHtml(row.status),
    escapeHtml(row.model ?? "—"),
    escapeHtml(row.submittedAt),
    escapeHtml(row.finishedAt ?? "—")
  ]);
  return [
    '<section id="standalones">',
    "<h2>独立运行</h2>",
    renderTable(["trace", "用例", "结果", "台账状态", "模型", "提交", "完成"], rows, "暂无独立运行"),
    "</section>"
  ].join("\n");
}

function renderDeepSection(detail: PanelProjectDetail): string {
  const deep = detail.deep;
  if (deep === null) return "";
  const child = deep.artemis.child;
  const rows: string[][] = [
    ["active Profile", escapeHtml(deep.activeProfile ?? "—")],
    ["LLM 条目", String(deep.llmEntries)],
    ["setup required", deep.setupRequired ? "是" : "否"],
    [
      "存储",
      escapeHtml(
        `${deep.store.kind}${deep.store.degraded ? "（降级）" : ""}${
          deep.store.note ? ` · ${deep.store.note}` : ""
        }`
      )
    ],
    [
      "artemis 子进程",
      child.running
        ? `运行中（pid ${child.pid ?? "—"} · 重启 ${child.restarts}）`
        : `未运行（重启 ${child.restarts}）`
    ],
    ...(child.lastError !== null
      ? [["子进程错误", escapeHtml(child.lastError)] as string[]]
      : []),
    [
      "artemis python",
      deep.artemis.python.found
        ? escapeHtml(deep.artemis.python.path ?? "已找到")
        : escapeHtml(
            `未找到${deep.artemis.python.hint ? `（${deep.artemis.python.hint.split("\n")[0]}）` : ""}`
          )
    ],
    [
      "Figma 桥",
      escapeHtml(
        `${deep.figma.bridge.status}${
          deep.figma.bridge.port !== null ? `（:${deep.figma.bridge.port}）` : ""
        }`
      )
    ],
    ["构建", deep.build.stale ? '<span class="gate-fail">陈旧（需重启会话）</span>' : "最新"],
    ["日志", deep.logs.file === null ? "—" : `<code>${escapeHtml(deep.logs.file)}</code>`]
  ];
  const ios = deep.iosProbe;
  const iosBlock =
    ios === null
      ? `<p class="muted">iOS 环境检测未执行（URL 加 <code>?ios=1</code> 显式检测；会调用本地 appium CLI）</p>`
      : ios.error !== null
        ? `<p class="note">iOS 环境检测失败：${escapeHtml(ios.error)}</p>`
        : [
            `<p class="muted">检测时间 ${escapeHtml(ios.probedAt)}（缓存 ${Math.round(
              PANEL_IOS_PROBE_TTL_MS / 1000
            )}s）</p>`,
            renderTable(
              ["项", "状态"],
              [
                [
                  "appium CLI",
                  ios.appium.found
                    ? `已安装${ios.appium.version ? `（${escapeHtml(ios.appium.version)}）` : ""}`
                    : "未检测到"
                ],
                [
                  "xcuitest 驱动",
                  ios.xcuitest.installed
                    ? `已安装${ios.xcuitest.version ? `（${escapeHtml(ios.xcuitest.version)}）` : ""}`
                    : "未安装"
                ]
              ],
              "—"
            ),
            ios.guidance.length > 0
              ? `<ul>${ios.guidance.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`
              : ""
          ]
            .filter((part) => part !== "")
            .join("\n");
  return [
    '<section id="deep">',
    "<h2>深探信息</h2>",
    renderTable(["项", "值"], rows, "—"),
    "<h3>iOS 环境检测</h3>",
    iosBlock,
    "</section>"
  ].join("\n");
}

function renderDiskAssets(detail: PanelProjectDetail): string {
  const assets = detail.diskAssets;
  if (assets === null) return "";
  const crashes =
    assets.crashes === null
      ? '<p class="empty">不可用</p>'
      : [
          renderTable(
            ["签名", "类型", "包名", "异常", "次数", "最近出现"],
            assets.crashes.recent.slice(0, 5).map((record) => [
              `<code>${escapeHtml(record.id)}</code>`,
              escapeHtml(record.kind),
              escapeHtml(record.package),
              escapeHtml(record.exceptionClass),
              String(record.occurrences),
              escapeHtml(record.lastSeenAt)
            ]),
            "无崩溃签名"
          ),
          assets.crashes.total > 0 ? `<p class="muted">共 ${assets.crashes.total} 个签名</p>` : ""
        ]
          .filter((part) => part !== "")
          .join("\n");
  const reconciliation =
    assets.reconciliation === null || !assets.reconciliation.present
      ? '<p class="empty">无对账资产</p>'
      : `<p class="muted">边 ${assets.reconciliation.edges} · 升级 ${assets.reconciliation.byStatus.upgraded} · 待审 ${assets.reconciliation.byStatus.pending} · 已确认 ${assets.reconciliation.byStatus.confirmed} · 已驳回 ${assets.reconciliation.byStatus.rejected} · 逆向观测 ${assets.reconciliation.runtimeOnly} · 更新 ${escapeHtml(
          assets.reconciliation.updatedAt ?? "—"
        )}</p>`;
  const baselines =
    assets.baselines === null
      ? '<p class="empty">不可用</p>'
      : renderTable(
          ["设备", "用例", "步骤", "区域", "类别"],
          assets.baselines.hotspots.map((hotspot) => [
            `<code>${escapeHtml(hotspot.serial)}</code>`,
            escapeHtml(hotspot.caseId),
            String(hotspot.step),
            String(hotspot.regions),
            escapeHtml(hotspot.categories.join("、") || "—")
          ]),
          "无未消除热点"
        );
  const retention =
    assets.retention === null
      ? '<p class="empty">不可用</p>'
      : [
          `<p class="muted">≥${assets.retention.days} 天：${assets.retention.overdue.count} 项 / ${formatBytes(
            assets.retention.overdue.totalBytes
          )}（只读，不删除）</p>`,
          `<p>${assets.retention.categories
            .map(
              (category) =>
                `<span class="chip">${escapeHtml(category.id)} ${category.overdue}/${category.total}</span>`
            )
            .join("")}</p>`
        ].join("\n");
  const warnings = assets.warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  return [
    '<section id="disk-assets">',
    "<h2>磁盘资产</h2>",
    "<h3>崩溃签名</h3>",
    crashes,
    "<h3>对账资产</h3>",
    reconciliation,
    "<h3>设备基线热点</h3>",
    baselines,
    "<h3>保留期</h3>",
    retention,
    warnings,
    "</section>"
  ].join("\n");
}

function renderRegressionBlock(rootPath: string, detail: PanelProjectDetail): string {
  const refs = detail.regressionRefs;
  if (refs.length === 0) {
    return [
      '<section id="regression">',
      "<h2>新建回归测试</h2>",
      '<p class="empty">暂无可引用的用例份（先运行 figma_generate_tests 生成并登记用例集）</p>',
      "</section>"
    ].join("\n");
  }
  const rootJson = JSON.stringify(rootPath).replace(/</g, "\\u003c");
  const rows = refs.map((ref) => [
    `<input type="checkbox" name="ref" value="${escapeHtml(`${ref.caseSetId}|${ref.featureKey}`)}">`,
    `<code>${escapeHtml(ref.createdAt)}</code>`,
    escapeHtml(ref.featureName),
    String(ref.caseCount),
    ref.lastPassRate === null
      ? '<span class="muted">—</span>'
      : `${Math.round(ref.lastPassRate * 100)}%`,
    `<span class="muted">${escapeHtml(ref.source)}</span>`
  ]);
  return [
    '<section id="regression">',
    "<h2>新建回归测试</h2>",
    '<p class="muted">勾选要引用的用例份（可多份），选择目标端与基线策略后创建回归任务。</p>',
    '<form id="regression-form" onsubmit="return createRegressionTask(event)">',
    renderTable(["引用", "时间", "功能", "用例", "最近通过率", "来源"], rows, "暂无可引用的用例份"),
    "<p><label>目标端：</label>",
    '<label><input type="checkbox" name="platform" value="ios" checked> iOS</label> ',
    '<label><input type="checkbox" name="platform" value="android" checked> Android</label></p>',
    "<p><label>基线：</label><select name=\"baseline\">",
    '<option value="latest" selected>最近一次（同份）</option>',
    '<option value="none">不对比（重建基准）</option>',
    "</select></p>",
    '<p><button type="submit">创建回归任务</button> <span id="regression-status" class="muted"></span></p>',
    '<p class="note">需启用 JavaScript 提交（或使用 <code>suite task create</code>）。</p>',
    "</form>",
    "<script>",
    "function createRegressionTask(event){",
    "  event.preventDefault();",
    "  var form=event.target;",
    "  var refs=Array.prototype.slice.call(form.querySelectorAll('input[name=ref]:checked')).map(function(el){var parts=el.value.split('|');return {caseSetId:parts[0],featureKey:parts[1]};});",
    "  var platforms=Array.prototype.slice.call(form.querySelectorAll('input[name=platform]:checked')).map(function(el){return el.value;});",
    "  var baseline=form.querySelector('select[name=baseline]').value;",
    "  var status=document.getElementById('regression-status');",
    "  if(refs.length===0){status.textContent='请先勾选至少一份';return false;}",
    "  status.textContent='提交中…';",
    "  fetch('/panel/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:" +
      rootJson +
      ",refs:refs,platforms:platforms,baseline:baseline})})",
    "    .then(function(response){return response.json().then(function(payload){if(!response.ok){throw new Error(payload.error||('HTTP '+response.status));}location.href='/panel?project='+encodeURIComponent(" +
      rootJson +
      ")+'&task='+encodeURIComponent(payload.task.id);});})",
    "    .catch(function(error){status.textContent='创建失败：'+error.message;});",
    "  return false;",
    "}",
    "</script>",
    "</section>"
  ].join("\n");
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "待执行",
  claimed: "已领取",
  running: "执行中",
  completed: "已完成",
  partial: "部分失败",
  failed: "失败"
};

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

function toolBadges(tools: RunnerTools): string {
  const entries: Array<[string, boolean]> = [
    ["adb", tools.adb],
    ["idb", tools.idb],
    ["simctl", tools.simctl],
    ["idevice_id", tools.ideviceId],
    ["appium", tools.appium]
  ];
  return entries
    .map(
      ([name, ok]) =>
        `<span class="chip"${ok ? "" : ' style="opacity:.45"'}>${escapeHtml(name)} ${ok ? "✓" : "✗"}</span>`
    )
    .join(" ");
}

function renderRunners(detail: PanelProjectDetail): string {
  if (detail.runners.length === 0) {
    return [
      '<section id="runners">',
      "<h2>执行机（runner）</h2>",
      '<p class="empty">暂无 runner 心跳（在项目机运行 <code>node dist/cli.js suite runner</code>）</p>',
      "</section>"
    ].join("\n");
  }
  const rows = detail.runners.map((runner) => [
    `${lampSpan(runner.online ? "green" : "gray")}<code>${escapeHtml(runner.name)}</code>`,
    escapeHtml(runner.hostname),
    runner.devices.length === 0
      ? '<span class="muted">—</span>'
      : runner.devices
          .map((device) => {
            const label =
              device.name === ""
                ? `${device.platform}:${device.serial}`
                : `${device.platform}:${device.name}(${device.serial})`;
            return `<span class="chip">${escapeHtml(label)}</span>`;
          })
          .join(""),
    toolBadges(runner.tools),
    `<code>${escapeHtml(runner.lastSeenAt)}</code>`,
    runner.artifactBaseUrl === null ? "—" : `<code>${escapeHtml(runner.artifactBaseUrl)}</code>`
  ]);
  return [
    '<section id="runners">',
    "<h2>执行机（runner）</h2>",
    renderTable(["名称", "主机", "设备", "工具", "最后心跳", "产物基址"], rows, "暂无 runner"),
    "</section>"
  ].join("\n");
}

function renderTaskList(rootPath: string, detail: PanelProjectDetail): string {
  const rows = detail.tasks.map((task) => [
    `<a href="${escapeHtml(taskHref(rootPath, task.id))}"><code>${escapeHtml(task.id)}</code></a>`,
    escapeHtml(taskStatusLabel(task.status)),
    String(task.refs),
    escapeHtml(task.platforms.join(", ")),
    String(task.runIds),
    escapeHtml(task.createdAt)
  ]);
  return [
    '<section id="tasks">',
    "<h2>回归任务</h2>",
    renderTable(
      ["任务", "状态", "引用份数", "目标端", "运行数", "创建时间"],
      rows,
      "暂无回归任务（上方「新建回归测试」创建）"
    ),
    "</section>"
  ].join("\n");
}

function renderTaskPage(view: { rootPath: string; detail: PanelTaskDetail }): string {
  const { detail } = view;
  const task = detail.task;
  const refRows = detail.refs.map((ref) => [
    escapeHtml(ref.featureName ?? ref.featureKey),
    `<code>${escapeHtml(ref.caseSetId)}</code>`,
    ref.caseCount === null ? "—" : String(ref.caseCount),
    ref.jsonPath === null
      ? '<span class="muted">（份已清理）</span>'
      : `${
          ref.jsonUrl === null
            ? `<code>${escapeHtml(ref.jsonPath)}</code>`
            : `<a href="${escapeHtml(ref.jsonUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(ref.jsonPath)}</code></a>`
        }${
          ref.xlsxUrl === null
            ? ""
            : ` · <a href="${escapeHtml(ref.xlsxUrl)}" target="_blank" rel="noreferrer">xlsx</a>`
        }`
  ]);
  const runRows = detail.runs.map((run) => [
    escapeHtml(run.platform),
    escapeHtml(run.device ?? "—"),
    escapeHtml(run.status),
    `${run.passed}/${run.total}`,
    run.failed === 0 ? "0" : `<span class="err">${run.failed}</span>`,
    Object.keys(run.failureDomains).length === 0
      ? "—"
      : Object.entries(run.failureDomains)
          .map(([domain, count]) => `<span class="chip">${escapeHtml(domain)} × ${count}</span>`)
          .join(""),
    run.comparison === null
      ? "—"
      : `${escapeHtml(run.comparison.baseline === "established" ? "基准建立" : "对比")}：修复 ${run.comparison.fixed} · 回归 ${run.comparison.regressed}`,
    run.manifestPath === null
      ? "—"
      : run.artifacts.manifestUrl === null
        ? `<code>${escapeHtml(run.manifestPath)}</code>`
        : `<a href="${escapeHtml(run.artifacts.manifestUrl)}" target="_blank" rel="noreferrer"><code>${escapeHtml(run.manifestPath)}</code></a>`,
    escapeHtml(run.createdAt)
  ]);
  const crossRows = detail.crossPlatform.map((delta) => [
    `<code>${escapeHtml(delta.caseId)}</code>`,
    escapeHtml(delta.name),
    Object.entries(delta.results)
      .map(([platform, outcome]) => `${escapeHtml(platform)}=${escapeHtml(outcome)}`)
      .join(" · ")
  ]);
  const warnings = detail.warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  const active =
    task.status === "pending" || task.status === "claimed" || task.status === "running";
  const claimLine =
    task.claimedBy === null
      ? ""
      : detail.runner === null
        ? ` · 领取：<code>${escapeHtml(task.claimedBy)}</code>（未知执行机）`
        : ` · 领取：「${escapeHtml(detail.runner.name)}」（${detail.runner.online ? "在线" : "失联"}）`;
  const covered = detail.runners.some(
    (entry) =>
      entry.online && task.platforms.every((platform) => entry.platforms.includes(platform))
  );
  const coverageHint =
    task.status === "pending" && !covered
      ? '<p class="note">当前无在线 runner 完整覆盖任务目标端（双端任务需单机双端 runner）；可手动执行或等待 runner 上线。</p>'
      : "";
  return page(
    `回归任务 · ${task.id}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath))}">项目</a></p>`,
      `<h1>回归任务 <code>${escapeHtml(task.id)}</code></h1>`,
      `<p>状态：${escapeHtml(taskStatusLabel(task.status))}（<code>${escapeHtml(task.status)}</code>）${claimLine} · 目标端 ${escapeHtml(task.platforms.join(", "))} · 基线 ${escapeHtml(task.baseline)} · 创建 ${escapeHtml(task.createdAt)} · 共 ${detail.runs.length} 个子运行${task.attempts > 1 ? ` · 已尝试 ${task.attempts} 次` : ""}</p>`,
      coverageHint,
      warnings,
      "</header>",
      "<main>",
      '<section id="refs">',
      "<h2>引用份</h2>",
      renderTable(["功能", "用例集", "用例数", "存档路径"], refRows, "无引用"),
      "</section>",
      '<section id="runs">',
      "<h2>子运行</h2>",
      renderTable(
        ["端", "设备", "状态", "通过", "失败", "失败域", "对比", "清单", "时间"],
        runRows,
        "暂无运行（触发执行见下方指引）"
      ),
      "</section>",
      '<section id="cross">',
      "<h2>跨端差异</h2>",
      renderTable(["用例", "名称", "结果"], crossRows, "两端结果一致（或仅单端运行）"),
      "</section>",
      '<section id="run-hint">',
      "<h2>触发执行</h2>",
      `<p class="muted">在线 runner 会自动领取执行；也可手动：<code>node dist/cli.js suite run --task ${escapeHtml(task.id)} --device &lt;serial&gt;</code>。产物在项目机磁盘（上方清单路径），中心侧仅展示路径。</p>`,
      "</section>",
      "</main>"
    ].join("\n"),
    active ? 10 : undefined
  );
}

function renderReviewPage(view: {
  rootPath: string;
  detail: { items: PanelReviewItem[]; warnings: string[] };
}): string {
  const { items, warnings } = view.detail;
  const rootJson = JSON.stringify(view.rootPath).replace(/</g, "\\u003c");
  const evidenceCell = (item: PanelReviewItem): string => {
    if (item.evidencePath === null) return "—";
    let present = false;
    try {
      present = fs.statSync(item.evidencePath).isDirectory();
    } catch {
      present = false;
    }
    const link =
      item.evidenceUrl === null
        ? ""
        : ` <a href="${escapeHtml(item.evidenceUrl)}" target="_blank" rel="noreferrer">打开证据</a>`;
    return present
      ? `<code>${escapeHtml(item.evidencePath)}</code>${link}`
      : `<code>${escapeHtml(item.evidencePath)}</code> <span class="muted">[已清理]</span>${link}`;
  };
  const rows = items.map((item) => [
    `<input type="checkbox" name="item" value="${escapeHtml(`${item.runId}|${item.caseId}`)}">`,
    `<code>${escapeHtml(item.caseId)}</code>`,
    escapeHtml(item.name),
    escapeHtml(item.featureName ?? "—"),
    escapeHtml(item.platform),
    escapeHtml(item.device ?? "—"),
    escapeHtml(item.status),
    item.failureDomain === null
      ? "—"
      : `<span class="chip">${escapeHtml(item.failureDomain)}</span>${
          item.failureConfidence === null
            ? ""
            : ` <span class="muted">${escapeHtml(item.failureConfidence)}</span>`
        }`,
    escapeHtml(item.failureReason ?? "—"),
    evidenceCell(item),
    item.verdict === null
      ? '<span class="muted">未裁决</span>'
      : `<span class="chip">${escapeHtml(item.verdict)}</span>${
          item.verdictBy === null ? "" : ` <span class="muted">${escapeHtml(item.verdictBy)}</span>`
        }${item.verdictNote === null ? "" : `<br><span class="muted">${escapeHtml(item.verdictNote)}</span>`}`
  ]);
  const undecided = items.filter((item) => item.verdict === null).length;
  const warningsHtml =
    warnings.length > 0
      ? warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";
  const body =
    items.length === 0
      ? [
          '<section id="queue">',
          "<h2>失败用例</h2>",
          '<p class="empty">暂无失败用例（最近 10 次运行全部通过）</p>',
          "</section>"
        ]
      : [
          '<form id="verdict-form" onsubmit="return submitVerdicts(event)">',
          renderTable(
            [
              "选择",
              "用例",
              "名称",
              "功能",
              "端",
              "设备",
              "状态",
              "初判",
              "理由",
              "证据",
              "裁决"
            ],
            rows,
            "暂无失败用例"
          ),
          "<p>裁决：",
          '<label><input type="radio" name="verdict" value="case-defect" checked> 案例问题</label> ',
          '<label><input type="radio" name="verdict" value="execution-deviation"> 执行偏差</label> ',
          '<label><input type="radio" name="verdict" value="app-defect"> 应用缺陷</label> ',
          '<label><input type="radio" name="verdict" value="uncertain"> 不确定</label>',
          "</p>",
          '<p><label>备注：<input type="text" name="note" size="40" placeholder="可选（写入裁决历史）"></label></p>',
          '<p><button type="submit">提交裁决</button> <span id="verdict-status" class="muted"></span></p>',
          '<p class="note">需启用 JavaScript 提交；勾选多条 → 同一裁决批量写入。</p>',
          "</form>",
          "<script>",
          "function submitVerdicts(event){",
          "  event.preventDefault();",
          "  var form=event.target;",
          "  var items=Array.prototype.slice.call(form.querySelectorAll('input[name=item]:checked')).map(function(el){var parts=el.value.split('|');return {runId:parts[0],caseId:parts[1]};});",
          "  var verdict=form.querySelector('input[name=verdict]:checked').value;",
          "  var note=form.querySelector('input[name=note]').value;",
          "  var status=document.getElementById('verdict-status');",
          "  if(items.length===0){status.textContent='请先勾选至少一条失败用例';return false;}",
          "  status.textContent='提交中…';",
          "  fetch('/panel/api/verdicts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:" +
            rootJson +
            ",items:items,verdict:verdict,note:note})})",
          "    .then(function(response){return response.json().then(function(payload){if(!response.ok){throw new Error(payload.error||('HTTP '+response.status));}location.reload();});})",
          "    .catch(function(error){status.textContent='提交失败：'+error.message;});",
          "  return false;",
          "}",
          "</script>"
        ];
  return page(
    `归因队列 · ${path.basename(view.rootPath)}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath))}">项目</a></p>`,
      "<h1>归因队列</h1>",
      `<p class="muted">最近 10 次运行的失败用例 · 共 ${items.length} 条 · 未裁决 ${undecided} 条</p>`,
      warningsHtml,
      "</header>",
      "<main>",
      ...body,
      '<section id="run-hint">',
      "<h2>动作指引</h2>",
      '<p class="muted">重跑：<code>node dist/cli.js suite run --task &lt;task-id&gt; --device &lt;serial&gt;</code>（整任务）或 <code>node dist/cli.js suite run --tests &lt;tests.json&gt; --case &lt;caseId&gt; --device &lt;serial&gt;</code>（单用例）。</p>',
      '<p class="muted">隔离：写入 <code>.artemis/design/quarantine.json</code>（owner 签字名单；suite run 默认跳过，<code>--no-quarantine</code> 严格跑）。</p>',
      '<p class="muted">口径：仅份血统运行参与统计与改进出口/生成建议；无份运行（<code>suite run --tests</code>）的裁决仅存档。</p>',
      "</section>",
      "</main>"
    ].join("\n")
  );
}

function renderStatsPage(view: { rootPath: string; detail: PanelStatsView }): string {
  const { stats, improvement, guidance, warnings } = view.detail;
  const featureRows = stats.features.map((feature) => [
    `<code>${escapeHtml(feature.featureKey)}</code>`,
    escapeHtml(feature.featureName ?? "—"),
    String(feature.runs),
    feature.passRate === null ? "—" : `${Math.round(feature.passRate * 100)}%`,
    feature.trend
      .map((entry) => (entry === "pass" ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'))
      .join(" "),
    Object.entries(feature.failureDomains)
      .map(([domain, count]) => `<span class="chip">${escapeHtml(domain)} × ${count}</span>`)
      .join(" ") || "—",
    Object.entries(feature.verdicts)
      .map(([verdict, count]) => `<span class="chip">${escapeHtml(verdict)} × ${count}</span>`)
      .join(" ") || "—"
  ]);
  const caseRows = stats.unstableCases.map((entry) => [
    `<code>${escapeHtml(entry.caseId)}</code>`,
    escapeHtml(entry.name),
    escapeHtml(entry.featureName ?? "—"),
    String(entry.runs),
    entry.failed === 0 ? "0" : `<span class="err">${entry.failed}</span>`,
    String(entry.consecutiveFailures),
    String(entry.flaky),
    escapeHtml(entry.lastStatus ?? "—"),
    escapeHtml(entry.lastFailureDomain ?? "—"),
    entry.verdict === null ? '<span class="muted">未裁决</span>' : escapeHtml(entry.verdict)
  ]);
  const crossRows = stats.crossPlatform.map((delta) => [
    `<code>${escapeHtml(delta.caseId)}</code>`,
    escapeHtml(delta.name),
    Object.entries(delta.results)
      .map(([platform, outcome]) => `${escapeHtml(platform)}=${escapeHtml(outcome)}`)
      .join(" · ")
  ]);
  const improvementList = (title: string, items: PanelImprovementItem[]): string => {
    const body =
      items.length === 0
        ? '<p class="empty">（空）</p>'
        : `<ul>${items
            .map(
              (item) =>
                `<li><code>${escapeHtml(item.caseId)}</code> ${escapeHtml(item.name)}${
                  item.featureName === null ? "" : ` · ${escapeHtml(item.featureName)}`
                }</li>`
            )
            .join("")}</ul>`;
    return `<h3>${escapeHtml(title)}</h3>${body}`;
  };
  const guidanceHtml = guidance
    .map((line) => `<p class="muted">${escapeHtml(line)}</p>`)
    .join("");
  const warningsHtml = warnings
    .map((warning) => `<p class="note">${escapeHtml(warning)}</p>`)
    .join("");
  return page(
    `回归统计 · ${path.basename(view.rootPath)}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath))}">项目</a></p>`,
      "<h1>回归统计</h1>",
      warningsHtml,
      "</header>",
      "<main>",
      '<section id="features">',
      "<h2>功能维度</h2>",
      renderTable(
        ["功能", "名称", "运行", "通过率", "趋势", "失败域", "归因构成"],
        featureRows,
        "暂无份血统运行（先创建回归任务并执行）"
      ),
      "</section>",
      '<section id="cases">',
      "<h2>最不稳用例</h2>",
      renderTable(
        ["用例", "名称", "功能", "运行", "失败", "连败", "flaky", "最近状态", "最近失败域", "裁决"],
        caseRows,
        "暂无用例数据"
      ),
      "</section>",
      '<section id="cross">',
      "<h2>跨端差异</h2>",
      renderTable(["用例", "名称", "结果"], crossRows, "两端结果一致（或仅单端运行）"),
      "</section>",
      '<section id="improvement">',
      "<h2>改进出口</h2>",
      improvementList("案例问题（case-defect）→ 修订期望 / 重新生成", improvement.caseDefects),
      improvementList("执行偏差（execution-deviation）→ 环境核对 / 重跑", improvement.environment),
      improvementList("应用缺陷（app-defect）→ 建单（Jira）", improvement.appDefects),
      guidanceHtml,
      "</section>",
      "</main>"
    ].join("\n")
  );
}

function renderProjectPage(view: { rootPath: string; detail: PanelProjectDetail }, cacheNote: string): string {
  const { detail } = view;
  const row = detail.project;
  const reasons =
    row.lampReasons.length > 0
      ? `<ul>${row.lampReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
      : "";
  const warnings =
    detail.warnings.length > 0
      ? detail.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";
  return page(
    `项目 · ${row.name}`,
    [
      "<header>",
      '<p><a href="/panel">← 多项目总览</a></p>',
      `<h1>${lampSpan(row.lamp)} ${escapeHtml(row.name)}</h1>`,
      `<p class="muted"><code>${escapeHtml(row.rootPath)}</code> · 最后活跃 ${escapeHtml(row.lastSeenAt ?? "—")} · ${
        row.diskReachable ? "磁盘可达" : "磁盘不可达"
      }</p>`,
      reasons,
      warnings,
      `<p class="muted">生成时间 ${escapeHtml(detail.generatedAt)} · ${escapeHtml(cacheNote)}</p>`,
      `<p><a href="${escapeHtml(reviewHref(view.rootPath))}">归因队列</a> · <a href="${escapeHtml(statsHref(view.rootPath))}">统计</a></p>`,
      "</header>",
      "<main>",
      renderIntegration(detail),
      renderDeepSection(detail),
      renderBatches(detail, view.rootPath),
      renderRegressionBlock(view.rootPath, detail),
      renderTaskList(view.rootPath, detail),
      renderRunners(detail),
      renderDiskAssets(detail),
      renderStandalones(detail),
      "</main>"
    ].join("\n"),
    detail.runners.length > 0 ? 30 : undefined
  );
}

function renderEvidence(links: PanelBatchDetail["cases"][number]["evidence"]): string {
  if (links.length === 0) return '<span class="muted">—</span>';
  return links
    .map((link) => {
      const status = link.status === "present" ? "" : ' <span class="muted">[已清理]</span>';
      return `${escapeHtml(link.kind)}: <code>${escapeHtml(link.path)}</code>${status}`;
    })
    .join("<br>");
}

function renderBatchPage(view: { rootPath: string; detail: PanelBatchDetail }): string {
  const { detail } = view;
  const meta = [
    `来源 ${escapeHtml(detail.source ?? "—")}`,
    `开始 ${escapeHtml(detail.startedAt ?? "—")}`,
    `结束 ${escapeHtml(detail.finishedAt ?? "—")}`,
    detail.taxonomyVersion === null ? "分类原判版本 —" : `分类原版 v${detail.taxonomyVersion}`
  ].join(" · ");

  if (detail.read !== "ok") {
    return page(
      `批次 · ${detail.file}`,
      [
        "<header>",
        `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath))}">项目</a></p>`,
        `<h1>批次 ${escapeHtml(detail.runId ?? detail.file)}</h1>`,
        `<p class="muted">${meta}</p>`,
        "</header>",
        "<main>",
        '<section id="batch">',
        "<h2>批次详情</h2>",
        `<p class="note">读取结果：${escapeHtml(detail.read)}${
          detail.note !== null ? ` · ${escapeHtml(detail.note)}` : ""
        }</p>`,
        "</section>",
        "</main>"
      ].join("\n")
    );
  }

  const summary = detail.summary;
  const failureDomains =
    detail.failureDomains === null || Object.keys(detail.failureDomains).length === 0
      ? '<p class="empty">无失败域汇总</p>'
      : `<p>${Object.entries(detail.failureDomains)
          .map(([domain, count]) => `<span class="chip">${escapeHtml(domain)} × ${count}</span>`)
          .join("")}</p>`;
  const gate = detail.gate;
  const cases = detail.cases.map((entry) => [
    `<code>${escapeHtml(entry.caseId)}</code>`,
    escapeHtml(entry.name),
    entry.status === "passed" ? '<span class="ok">通过</span>' : `<span class="err">${escapeHtml(entry.status)}</span>`,
    entry.failure === null
      ? '<span class="muted">—</span>'
      : `${escapeHtml(entry.failure.domain)}（${escapeHtml(entry.failure.confidence)}）<div class="muted">${escapeHtml(
          entry.failure.reason
        )}</div>`,
    entry.scriptProvenance === null
      ? "—"
      : `断言 ${entry.scriptProvenance.asserts} / 探索 ${entry.scriptProvenance.explores}`,
    [entry.quarantined ? "隔离" : null, entry.flaky ? "flaky" : null]
      .filter((tag): tag is string => tag !== null)
      .join("、") || "—",
    renderEvidence(entry.evidence)
  ]);
  const options = detail.options;
  const optionRows: string[][] = options
    ? [
        ["模型", options.model ?? "—"],
        ["设备", options.deviceSerial ?? "—"],
        ["应用", options.lockedAppPackage ?? "—"],
        ["maxCases", options.maxCases === null ? "—" : String(options.maxCases)],
        ["stopOnFailure", options.stopOnFailure ? "是" : "否"],
        ["strict", options.strict ? "是" : "否"],
        ["failOnUncovered", options.failOnUncovered ? "是" : "否"],
        ["retry", String(options.retry)],
        ["隔离用例", options.quarantinedCaseIds.length === 0 ? "—" : options.quarantinedCaseIds.join("、")]
      ]
    : [];
  const tests = detail.tests;
  const warnings =
    detail.warnings.length > 0
      ? detail.warnings.map((warning) => `<p class="note">${escapeHtml(warning)}</p>`).join("")
      : "";

  return page(
    `批次 · ${detail.runId ?? detail.file}`,
    [
      "<header>",
      `<p><a href="/panel">← 多项目总览</a> · <a href="${escapeHtml(projectHref(view.rootPath))}">项目</a></p>`,
      `<h1>批次 ${escapeHtml(detail.runId ?? detail.file)}</h1>`,
      `<p class="muted">${meta}</p>`,
      gate === null
        ? ""
        : `<p>门禁：${gateSpan(gate.result === "pass" ? "pass" : "fail")}（exit ${gate.exitCode}${
            gate.reasons.length > 0 ? ` · ${gate.reasons.map((reason) => escapeHtml(reason)).join("、")}` : ""
          }）</p>`,
      warnings,
      "</header>",
      "<main>",
      '<section id="summary">',
      "<h2>归纳分类</h2>",
      summary === null
        ? ""
        : [
            '<div class="cards">',
            `<div class="card"><div class="k">用例</div><div class="v">${summary.total ?? "—"}</div></div>`,
            `<div class="card"><div class="k">通过</div><div class="v">${summary.passed ?? "—"}</div></div>`,
            `<div class="card"><div class="k">失败</div><div class="v">${summary.failed ?? "—"}</div></div>`,
            "</div>"
          ].join(""),
      "<h3>失败域汇总</h3>",
      failureDomains,
      "</section>",
      '<section id="cases">',
      "<h2>用例结果</h2>",
      renderTable(["用例", "名称", "状态", "失败域", "脚本来源", "标记", "证据"], cases, "暂无用例"),
      "</section>",
      '<section id="context">',
      "<h2>批次上下文</h2>",
      optionRows.length === 0 ? "" : renderTable(["选项", "值"], optionRows, "—"),
      tests === null
        ? ""
        : `<p class="muted">tests：<code>${escapeHtml(tests.path)}</code> · sha256 ${
            tests.sha256 === null ? "—" : escapeHtml(tests.sha256.slice(0, 12))
          } · 生成 ${escapeHtml(tests.generatedAt ?? "—")}</p>`,
      "</section>",
      "</main>"
    ]
      .filter((part) => part !== "")
      .join("\n")
  );
}

function page(title: string, bodyParts: string, refreshSeconds?: number): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(refreshSeconds !== undefined
      ? [`<meta http-equiv="refresh" content="${refreshSeconds}">`]
      : []),
    `<title>${escapeHtml(title)} · AOS 总览面板</title>`,
    `<style>${PAGE_CSS}</style>`,
    "</head>",
    "<body>",
    bodyParts,
    "</body>",
    "</html>"
  ].join("\n");
}

function renderPanelHtml(view: PanelView): string {
  const cacheNote = "缓存 TTL 内数据可能滞后（AOS_PANEL_CACHE_MS）";
  if (view.kind === "overview") return renderOverviewPage(view.overview, cacheNote);
  if (view.kind === "project") return renderProjectPage(view, cacheNote);
  if (view.kind === "task") return renderTaskPage(view);
  if (view.kind === "review") return renderReviewPage(view);
  if (view.kind === "stats") return renderStatsPage(view);
  return renderBatchPage(view);
}
