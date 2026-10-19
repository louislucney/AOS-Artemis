import { escapeHtml } from "../util.js";

export interface CCardInput {
  title?: string;
  subtitle?: string;
  tone?: "default" | "accent";
  actions?: string;
  body: string;
}

export function cCard(input: CCardInput): string {
  const toneClass = input.tone === "accent" ? " c-card-accent" : "";
  const title = input.title ? `<h2 class="c-card-title">${escapeHtml(input.title)}</h2>` : "";
  const subtitle = input.subtitle
    ? `<p class="c-card-subtitle">${escapeHtml(input.subtitle)}</p>`
    : "";
  const actions = input.actions ? `<div class="c-card-actions">${input.actions}</div>` : "";
  return `<section class="c-card${toneClass}">${title}${subtitle}${actions}<div class="c-card-body">${input.body}</div></section>`;
}

export interface CBadgeInput {
  label: string;
  tone: "neutral" | "accent" | "success" | "error" | "warning";
  /** 悬停原文（如机器枚举），保留可追溯。 */
  title?: string;
}

export function cBadge(input: CBadgeInput): string {
  const toneClass = input.tone === "neutral" ? "" : ` c-badge-${input.tone}`;
  const titleAttr = input.title === undefined ? "" : ` title="${escapeHtml(input.title)}"`;
  return `<span class="c-badge${toneClass}"${titleAttr}>${escapeHtml(input.label)}</span>`;
}

export interface CBannerInput {
  tone: "info" | "accent" | "warn";
  title: string;
  body?: string;
  actions?: string;
}

export function cBanner(input: CBannerInput): string {
  const body = input.body ? `<p>${escapeHtml(input.body)}</p>` : "";
  const actions = input.actions ? `<div class="c-banner-actions">${input.actions}</div>` : "";
  return `<div class="c-banner c-banner-${input.tone}"><strong>${escapeHtml(input.title)}</strong>${body}${actions}</div>`;
}

export interface CTableInput {
  columns: string[];
  /** 已构建 HTML（仅限组件行，如链接/按钮）。 */
  rows?: string[][];
  /** 自动转义通道：数据字段默认走这里（rowsText 优先于 rows）。 */
  rowsText?: string[][];
  empty?: string;
  caption?: string;
}

export function cTable(input: CTableInput): string {
  const rows =
    input.rowsText !== undefined
      ? input.rowsText.map((row) => row.map((cell) => escapeHtml(cell)))
      : (input.rows ?? []);
  const head = input.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("");
  const caption = input.caption ? `<caption>${escapeHtml(input.caption)}</caption>` : "";
  const body =
    rows.length === 0
      ? `<tr><td class="c-empty-cell" colspan="${input.columns.length}">${escapeHtml(input.empty ?? "暂无数据")}</td></tr>`
      : rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<div class="c-table-wrap"><table class="c-table">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export interface CStatInput {
  label: string;
  value: string;
  hint?: string;
}

export function cStat(input: CStatInput): string {
  const hint = input.hint ? `<div class="c-stat-hint">${escapeHtml(input.hint)}</div>` : "";
  return `<div class="c-stat"><div class="c-stat-label">${escapeHtml(input.label)}</div><div class="c-stat-value">${escapeHtml(input.value)}</div>${hint}</div>`;
}

export interface CEmptyInput {
  title: string;
  body: string;
  action?: string;
}

export function cEmpty(input: CEmptyInput): string {
  const action = input.action ? `<div class="c-empty-action">${input.action}</div>` : "";
  return `<div class="c-empty"><h2>${escapeHtml(input.title)}</h2><p>${escapeHtml(input.body)}</p>${action}</div>`;
}
