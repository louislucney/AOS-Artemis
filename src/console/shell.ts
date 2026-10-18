import { CONSOLE_COMPAT_CSS } from "./compat.js";
import { CSDC_TOKENS_CSS } from "./tokens.js";
import { escapeHtml } from "../util.js";

export type ConsoleNavKey =
  | "overview"
  | "project"
  | "tasks"
  | "dispatch"
  | "library"
  | "archive"
  | "runners"
  | "schedules"
  | "ops"
  | "audit"
  | "usage";

export interface ConsoleNavItem {
  key: ConsoleNavKey;
  label: string;
  href: string;
  badge?: string;
}

/** 能力标记：写动作是否可用、统计页是否由本进程提供、承载模式。页面据此渲染横幅/禁用态/导航子集。 */
export interface ConsoleCapabilities {
  actions: boolean;
  usage: boolean;
  mode: "http" | "standalone" | "stdio";
}

export const DEFAULT_CAPABILITIES: ConsoleCapabilities = { actions: true, usage: true, mode: "http" };

export interface ConsoleShellInput {
  title: string;
  active: ConsoleNavKey | null;
  body: string;
  nav?: ConsoleNavItem[];
  meta?: string;
  headExtra?: string;
  /** 仅无表单的活跃列表页传入；含未提交表单的页面永不自动刷新。 */
  autoRefreshSeconds?: number;
  /** 当前项目根路径：项目级导航项据此携带 project 上下文；缺省时项目级项渲染为禁用。 */
  project?: string | null;
  capabilities?: ConsoleCapabilities;
}

/** 项目级导航键（需要 project 上下文；无上下文时禁用而非误指总览）。 */
const PROJECT_SCOPED: ReadonlySet<ConsoleNavKey> = new Set([
  "tasks",
  "dispatch",
  "library",
  "archive",
  "runners",
  "schedules",
  "ops",
  "audit"
]);

export const DEFAULT_CONSOLE_NAV: ConsoleNavItem[] = [
  { key: "overview", label: "总览", href: "/panel" },
  { key: "tasks", label: "任务", href: "/panel?section=tasks" },
  { key: "dispatch", label: "下发", href: "/panel?section=dispatch" },
  { key: "library", label: "用例库", href: "/panel?section=library" },
  { key: "archive", label: "档案与产物", href: "/panel?section=archive" },
  { key: "runners", label: "运行机", href: "/panel?section=runners" },
  { key: "schedules", label: "计划", href: "/panel?section=schedules" },
  { key: "ops", label: "运维与数据", href: "/panel?section=ops" },
  { key: "audit", label: "审计", href: "/panel?section=audit" },
  { key: "usage", label: "统计", href: "/usage" }
];

export const USAGE_STANDALONE_NAV: ConsoleNavItem[] = [
  { key: "usage", label: "统计", href: "/usage" }
];

function navHref(item: ConsoleNavItem, project: string | null): string | null {
  if (!PROJECT_SCOPED.has(item.key)) return item.href;
  if (project === null || project === "") return null;
  const params = new URLSearchParams({ project, section: item.key });
  if (item.key === "tasks") return `/panel?${params.toString()}#regression`;
  if (item.key === "runners") return `/panel?${params.toString()}#runners`;
  if (item.key === "schedules") return `/panel?${params.toString()}#schedules`;
  return `/panel?${params.toString()}`;
}

export function renderConsoleShell(input: ConsoleShellInput): string {
  const capabilities = input.capabilities ?? DEFAULT_CAPABILITIES;
  const project = input.project ?? null;
  const nav = input.nav ?? DEFAULT_CONSOLE_NAV;
  const navHtml = nav
    .map((item) => {
      const current = item.key === input.active ? ' aria-current="page"' : "";
      const badge = item.badge ? `<span class="c-nav-badge">${escapeHtml(item.badge)}</span>` : "";
      const href = item.key === "usage" && !capabilities.usage ? null : navHref(item, project);
      if (href === null) {
        const reason = item.key === "usage" ? "本进程不提供统计页（独立统计服务：usage --web）" : "先进入项目后再使用";
        return `<span class="c-nav-item c-nav-item-disabled" aria-disabled="true" title="${escapeHtml(reason)}">${escapeHtml(item.label)}${badge}</span>`;
      }
      return `<a class="c-nav-item"${current} href="${escapeHtml(href)}">${escapeHtml(item.label)}${badge}</a>`;
    })
    .join("\n");
  const actionsBanner = capabilities.actions
    ? ""
    : `<div class="c-banner c-banner-warn" role="status">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback 访问；或使用 HTTP 模式（<code>serve --http</code>，见 README 接入指南）。当前页面为只读。</div>`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(input.autoRefreshSeconds !== undefined
      ? [`<meta http-equiv="refresh" content="${input.autoRefreshSeconds}">`]
      : []),
    `<title>${escapeHtml(input.title)} · AOS 控制台</title>`,
    `<style>${CSDC_TOKENS_CSS}\n${CONSOLE_COMPAT_CSS}</style>`,
    input.headExtra ?? "",
    "</head>",
    '<body data-console="shell">',
    '<a class="c-skip-link" href="#console-main">跳到主内容</a>',
    '<header class="c-topbar">',
    '<div class="c-brand"><a href="/panel">AOS 控制台</a></div>',
    input.meta ? `<div class="c-topbar-meta">${input.meta}</div>` : "",
    "</header>",
    actionsBanner,
    '<div class="c-layout">',
    `<aside class="c-aside"><nav aria-label="控制台导航">${navHtml}</nav></aside>`,
    `<main class="c-main" id="console-main">${input.body}</main>`,
    "</div>",
    '<footer class="c-footer">AOS-ARTEMIS · 本地服务</footer>',
    "</body>",
    "</html>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}
