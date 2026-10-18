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
  const title = input.title ? `<h3 class="c-card-title">${escapeHtml(input.title)}</h3>` : "";
  const subtitle = input.subtitle
    ? `<p class="c-card-subtitle">${escapeHtml(input.subtitle)}</p>`
    : "";
  const actions = input.actions ? `<div class="c-card-actions">${input.actions}</div>` : "";
  return `<section class="c-card${toneClass}">${title}${subtitle}${actions}<div class="c-card-body">${input.body}</div></section>`;
}

export interface CBadgeInput {
  label: string;
  tone: "neutral" | "accent" | "success" | "error" | "warning";
}

export function cBadge(input: CBadgeInput): string {
  const toneClass = input.tone === "neutral" ? "" : ` c-badge-${input.tone}`;
  return `<span class="c-badge${toneClass}">${escapeHtml(input.label)}</span>`;
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
  return `<table class="c-table">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
  return `<div class="c-empty"><h3>${escapeHtml(input.title)}</h3><p>${escapeHtml(input.body)}</p>${action}</div>`;
}

export interface CConfirmFormInput {
  action: string;
  project: string;
  fields: Record<string, string>;
  label: string;
  confirm: string;
  danger?: boolean;
}

export function cConfirmForm(input: CConfirmFormInput): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
  const fields = Object.entries(input.fields)
    .map(([name, value]) => hidden(name, value))
    .join("");
  const dangerAttrs = input.danger
    ? ` data-danger="1" data-danger-phrase="${escapeHtml(input.confirm)}"`
    : "";
  const buttonClass = input.danger ? "c-button c-button-danger" : "c-button";
  return [
    `<form class="c-confirm" method="post" action="${escapeHtml(input.action)}" data-confirm="${escapeHtml(input.confirm)}"${dangerAttrs} onsubmit="return window.aosConfirmForm?window.aosConfirmForm(this):true">`,
    hidden("project", input.project),
    fields,
    `<button class="${buttonClass}" type="submit">${escapeHtml(input.label)}</button>`,
    "<script>if(!window.aosConfirmForm){window.aosConfirmForm=function(f){var msg=f.getAttribute('data-confirm');if(msg&&!window.confirm(msg))return false;var phrase=f.getAttribute('data-danger')==='1'?f.getAttribute('data-danger-phrase'):null;if(phrase){var v=window.prompt('输入“'+phrase+'”以确认');if(v!==phrase)return false;}return true;};}</script>",
    "</form>"
  ].join("");
}
