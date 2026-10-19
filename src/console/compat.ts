/** 遗留标记兼容层（合并自原 panel/usage PAGE_CSS；颜色/圆角统一 CSDC token，单一 <style> 注入）。
 * 不再包含 body/:root/链接色/标题字号等与外壳冲突的规则；color-scheme 交由 tokens（亮色基准＋暗色跟随系统）。 */
export const CONSOLE_COMPAT_CSS = `
section:not(.c-plain){border:1px solid var(--color-border-subtle);border-radius:var(--radius-md);padding:16px;margin:16px 0}
.c-plain{border:0;border-radius:0;padding:0;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border-bottom:1px solid var(--color-border-subtle);padding:6px 8px;text-align:left;vertical-align:top}
th{font-weight:600;white-space:nowrap}
code{font-family:var(--font-family-mono);font-size:12px}
.cards{display:flex;flex-wrap:wrap;gap:12px}
.card{border:1px solid var(--color-border-subtle);border-radius:var(--radius-sm);padding:10px 16px;min-width:120px}
.card .k{font-size:12px;color:var(--color-text-secondary)}.card .v{font-size:20px;font-weight:600}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.badge{border-radius:999px;padding:2px 10px;font-size:12px;border:1px solid var(--color-border);display:inline-block}
.badge.warn{border-color:#B45309;color:#B45309}
.note{font-size:13px;color:#B45309;margin:4px 0}
.muted{color:var(--color-text-secondary)}.empty{color:var(--color-text-secondary);font-size:13px}
.chip{display:inline-block;border:1px solid var(--color-border-subtle);border-radius:999px;padding:0 8px;margin:0 6px 6px 0;font-size:12px}
.lamp{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.lamp-red{background:var(--color-error)}.lamp-yellow{background:var(--color-warning)}.lamp-green{background:var(--color-success)}.lamp-gray{background:var(--color-text-tertiary)}
.gate-pass{color:#15803d}.gate-fail{color:#B91C1C}
.spark{display:block}
.spark polyline{fill:none;stroke:var(--color-link);stroke-width:1.5}
.spark circle{fill:var(--color-link)}
.ok{color:#15803d}.err{color:#B91C1C}
ul{margin:6px 0;padding-left:20px}
.switcher,.filters{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:8px 0}
.switcher label,.filters label{display:flex;flex-direction:column;font-size:12px;gap:2px}
select,input[type=text],input[type=number]{padding:4px 6px;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface-white);color:var(--color-text-primary)}
button{padding:5px 12px;border:1px solid var(--color-border);border-radius:6px;background:transparent;color:var(--color-text-primary);cursor:pointer}
.pager{display:flex;gap:12px;align-items:center;margin-top:10px;font-size:13px}
.zero-call{color:var(--color-text-secondary)}
.summary{max-width:280px;word-break:break-word}
`;
