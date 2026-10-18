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

export interface ConsoleShellInput {
  title: string;
  active: ConsoleNavKey;
  body: string;
  nav?: ConsoleNavItem[];
  meta?: string;
  headExtra?: string;
  /** 仅无表单的活跃列表页传入；含未提交表单的页面永不自动刷新。 */
  autoRefreshSeconds?: number;
}

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

export function renderConsoleShell(input: ConsoleShellInput): string {
  const nav = input.nav ?? DEFAULT_CONSOLE_NAV;
  const navHtml = nav
    .map((item) => {
      const current = item.key === input.active ? ' aria-current="page"' : "";
      const badge = item.badge ? `<span class="c-nav-badge">${escapeHtml(item.badge)}</span>` : "";
      return `<a class="c-nav-item"${current} href="${escapeHtml(item.href)}">${escapeHtml(item.label)}${badge}</a>`;
    })
    .join("\n");
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
    `<style>${CSDC_TOKENS_CSS}</style>`,
    input.headExtra ?? "",
    "</head>",
    '<body data-console="shell">',
    '<header class="c-topbar">',
    '<div class="c-brand"><a href="/panel">AOS 控制台</a></div>',
    input.meta ? `<div class="c-topbar-meta">${input.meta}</div>` : "",
    "</header>",
    '<div class="c-layout">',
    `<aside class="c-aside"><nav aria-label="控制台导航">${navHtml}</nav></aside>`,
    `<main class="c-main">${input.body}</main>`,
    "</div>",
    '<footer class="c-footer">AOS-ARTEMIS · 本地服务</footer>',
    "</body>",
    "</html>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}
