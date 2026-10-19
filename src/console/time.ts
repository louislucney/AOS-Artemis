import { escapeHtml } from "../util.js";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function relativeLabel(ms: number, nowMs: number): string {
  const diff = nowMs - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ms);
  const now = new Date(nowMs);
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function absoluteLabel(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 时间展示统一出口：相对时间（title 给完整本地时间）；空值 → —，非法值原样（转义）。
 * `nowMs` 可注入以便测试与缓存内一致。 */
export function relativeTime(value: string | null | undefined, nowMs: number = Date.now()): string {
  if (value === null || value === undefined || value === "") return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return escapeHtml(value);
  return `<time datetime="${escapeHtml(value)}" title="${escapeHtml(absoluteLabel(ms))}">${escapeHtml(
    relativeLabel(ms, nowMs)
  )}</time>`;
}
