/** CSDC 开发者设计系统 tokens 子集＋控制台基础样式（web-console/DESIGN.md 为规范记录）。
 * CSDC 7.4 是纯浅色体系：控制台强约束亮色，不跟随系统暗色（用户明确要求统一 CSDC 风格）。
 * 对比度口径：正文级次要文字用 --color-text-secondary（#6E6E73，对白底 ≈5.1:1）；
 * --color-text-tertiary（#86868B，≈3.6:1）仅限装饰/大字号，不得用于正文。
 * 偏差：--color-link-hover 采用 CSDC 链接色 #0066CC（CSDC 原值 #0077ED 对白底 4.3:1，低于 AA）。 */
export const CSDC_TOKENS_CSS = `
:root{
  --color-accent:#FFE600; --color-accent-hover:#FFF9CC; --color-accent-surface:#FFF9CC; --color-accent-subtle:#FFFDE6; --color-accent-border:#FFE600;
  --color-text-primary:#1D1D1F; --color-text-secondary:#6E6E73; --color-text-tertiary:#86868B;
  --color-surface-light:#F5F5F7; --color-surface-white:#FFFFFF; --color-surface-subtle:#EFEFF2;
  --color-border:#D2D2D7; --color-border-subtle:rgba(0,0,0,0.08);
  --color-link:#0066CC; --color-link-hover:#0066CC;
  --color-success:#34C759; --color-success-bg:#EBF9EE; --color-error:#FF3B30; --color-error-bg:#FFEEEE; --color-warning:#FF9500; --color-warning-bg:#FFF8EC;
  --font-family-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","PingFang SC","Hiragino Sans GB","Helvetica Neue",sans-serif;
  --font-family-mono:"SF Mono",Menlo,Monaco,Consolas,"Fira Code",monospace;
  --font-size-hero:3rem; --font-size-title-1:2.25rem; --font-size-title-2:1.5rem; --font-size-title-3:1.125rem;
  --font-size-body:0.9375rem; --font-size-callout:0.8125rem; --font-size-caption:0.75rem;
  --font-size-xs:var(--font-size-caption); --font-size-sm:var(--font-size-callout); --font-size-base:var(--font-size-body); --font-size-md:var(--font-size-title-3);
  --line-height-tight:1.15; --line-height-title:1.25; --line-height-body:1.55;
  --font-weight-regular:400; --font-weight-medium:500; --font-weight-semibold:600; --font-weight-bold:700;
  --tracking-title:-0.018em; --tracking-body:-0.006em; --tracking-normal:-0.006em; --tracking-tight:-0.022em;
  --radius-xs:6px; --radius-sm:10px; --radius-md:14px; --radius-card:18px; --radius-pill:980px;
  --shadow-card:0 4px 20px rgba(0,0,0,0.04); --shadow-hover:0 10px 30px rgba(0,0,0,0.07);
  --blur-header:blur(20px);
  color-scheme:light;
}
*{box-sizing:border-box}
body{margin:0;background:var(--color-surface-light);color:var(--color-text-primary);
  font-family:var(--font-family-sans);font-size:var(--font-size-body);line-height:var(--line-height-body);
  letter-spacing:var(--tracking-body);-webkit-font-smoothing:antialiased}
a{color:var(--color-link);text-decoration:none}
a:hover{color:var(--color-link-hover);text-decoration:underline}
code,kbd{font-family:var(--font-family-mono);font-size:0.85em}
h1,h2,h3{letter-spacing:var(--tracking-title);line-height:var(--line-height-title)}
h1{font-size:var(--font-size-title-2);font-weight:var(--font-weight-semibold);margin:0 0 12px}
h2{font-size:var(--font-size-title-3);font-weight:var(--font-weight-semibold);margin:0 0 10px}
h3{font-size:var(--font-size-body);font-weight:var(--font-weight-semibold);margin:0 0 8px}

/* ── CSDC 毛玻璃顶栏 ─────────────────────────────────────────────── */
.c-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:12px 36px;
  background:rgba(255,255,255,0.85);backdrop-filter:var(--blur-header);-webkit-backdrop-filter:var(--blur-header);
  border-bottom:1px solid var(--color-border-subtle)}
.c-brand{font-weight:var(--font-weight-semibold);font-size:var(--font-size-title-3);letter-spacing:var(--tracking-title);flex-shrink:0}
.c-brand a{display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none}
.c-brand img{height:32px;width:auto;display:block}
.c-brand-product{padding-left:12px;border-left:1px solid var(--color-border);color:var(--color-text-secondary);
  font-size:var(--font-size-callout);font-weight:var(--font-weight-semibold);white-space:nowrap}
.c-topbar-meta{margin-left:auto;color:var(--color-text-secondary);font-size:var(--font-size-callout)}

/* ── CSDC 标准布局：顶栏 + Aside(220) + Main(白) + Footer ──────── */
.c-layout{display:flex;align-items:flex-start;width:100%;max-width:none;margin:0}
.c-aside{width:220px;flex:0 0 220px;padding:18px 14px;position:sticky;top:72px;align-self:flex-start;
  background:var(--color-surface-light);border-right:1px solid var(--color-border)}
.c-aside nav{display:flex;flex-direction:column;gap:4px}
.c-nav-group-title{padding:8px 10px 6px;font-size:11px;line-height:1.4;color:var(--color-text-secondary);
  font-weight:var(--font-weight-semibold);letter-spacing:.08em;text-transform:uppercase}
.c-nav-item{display:block;padding:8px 12px;border-radius:var(--radius-sm);color:var(--color-text-secondary);
  font-size:var(--font-size-callout);font-weight:var(--font-weight-medium);transition:all .15s ease}
.c-nav-item:hover{background:var(--color-accent-hover);text-decoration:none;color:var(--color-text-primary)}
.c-nav-item[aria-current="page"]{background:var(--color-accent);color:var(--color-text-primary);font-weight:var(--font-weight-semibold)}
.c-main{flex:1;min-width:0;padding:20px 36px 80px;background:var(--color-surface-white)}
.c-main .muted{color:var(--color-text-secondary)}
.c-footer{width:100%;padding:14px 36px 24px;background:var(--color-surface-light);border-top:1px solid var(--color-border);
  color:var(--color-text-secondary);font-size:var(--font-size-caption)}

/* ── CSDC 区块与卡片：黄色 Section Header + 白色卡片 ───────────── */
#console-main > section:not(.c-plain):not(.c-card){background:var(--color-surface-white);border:1px solid var(--color-border-subtle);
  border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:20px 24px 24px;margin:0 0 20px;overflow:hidden}
#console-main > section:not(.c-plain):not(.c-card) > h2:first-child{margin:-20px -24px 18px;padding:12px 22px;
  background:var(--color-accent-surface);border-bottom:1.5px solid var(--color-accent-border);
  border-radius:calc(var(--radius-card) - 1px) calc(var(--radius-card) - 1px) 0 0;
  font-size:17px;font-weight:800;letter-spacing:-.01em;color:var(--color-text-primary)}
#console-main > section.c-plain > h2:first-child{background:var(--color-accent-surface);border:1.5px solid var(--color-accent-border);
  border-radius:var(--radius-md);padding:12px 20px;margin-bottom:16px;font-size:17px;font-weight:800;letter-spacing:-.01em}
.c-card{background:var(--color-surface-white);border:1px solid var(--color-border-subtle);border-radius:var(--radius-card);
  box-shadow:var(--shadow-card);padding:28px;margin:0 0 20px;overflow:hidden}
.c-card-accent{background:var(--color-accent-subtle);border-color:var(--color-accent-border);box-shadow:0 4px 20px rgba(255,230,0,.15)}
.c-card-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;
  margin:-28px -28px 20px;padding:12px 22px;background:var(--color-accent-surface);
  border-bottom:1.5px solid var(--color-accent-border)}
.c-card-title{margin:0;font-size:17px;font-weight:800;letter-spacing:-.01em;color:var(--color-text-primary)}
.c-card-subtitle{color:var(--color-text-secondary);font-size:var(--font-size-callout);margin:0 0 14px}
.c-card-actions{float:none;display:flex;gap:8px;flex-wrap:wrap}
.c-card-body::after{content:"";display:block;clear:both}

/* ── CSDC 按钮：胶囊形，主行动黄底 ─────────────────────────────── */
.c-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;
  border:1px solid var(--color-border);background:var(--color-surface-white);border-radius:var(--radius-pill);
  padding:5px 12px;font-size:var(--font-size-callout);font-weight:var(--font-weight-semibold);
  line-height:1.2;cursor:pointer;color:var(--color-text-primary);font-family:inherit;white-space:nowrap;
  transition:all .2s cubic-bezier(.16,1,.3,1);text-decoration:none}
.c-button:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover);color:var(--color-text-primary);text-decoration:none}
.c-button:active{transform:scale(.97)}
.c-button-primary{background:var(--color-accent);border-color:var(--color-accent);font-weight:var(--font-weight-semibold);color:var(--color-text-primary)}
.c-button-primary:hover{background:var(--color-accent-hover);border-color:var(--color-accent-hover);color:var(--color-text-primary);box-shadow:0 2px 12px rgba(255,230,0,.35)}
.c-button-danger{border-color:#B91C1C;color:#B91C1C}
.c-button-danger:hover{background:var(--color-error-bg);border-color:#B91C1C;color:#B91C1C}
button:disabled,.c-button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.55;cursor:not-allowed}

/* ── CSDC 表格：外层卡片 + 浅灰表头 + 宽松行距 ─────────────────── */
.c-table-wrap{overflow-x:auto;max-width:100%;background:var(--color-surface-white);
  border:1px solid var(--color-border-subtle);border-radius:var(--radius-card);box-shadow:var(--shadow-card)}
.c-table{width:100%;border-collapse:collapse;font-size:var(--font-size-callout);background:var(--color-surface-white);text-align:left}
.c-table th{background:var(--color-surface-light);padding:14px 22px;font-weight:var(--font-weight-semibold);
  font-size:12px;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border-subtle);
  letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}
.c-table td{padding:16px 22px;border-bottom:1px solid rgba(0,0,0,.05);color:var(--color-text-secondary);vertical-align:top}
.c-table tr:last-child td{border-bottom:none}
.c-table tr:hover td{background:#FAFAFB}
.c-table caption{text-align:left;padding:14px 22px;color:var(--color-text-secondary);font-size:var(--font-size-caption);
  letter-spacing:.02em;text-transform:uppercase;background:var(--color-surface-white)}
.c-table--fixed{table-layout:fixed}
.c-empty-cell{color:var(--color-text-secondary);text-align:center;padding:32px 16px}
.c-nowrap{white-space:nowrap}
.c-run-id{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--color-text-secondary)}
.c-batch-cell{display:flex;flex-direction:column;gap:2px;min-width:0}
.c-batch-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.c-batch-time{color:var(--color-text-secondary);font-size:12px;overflow-wrap:anywhere}
.c-project-link{display:inline-flex;align-items:center;gap:8px;font-weight:var(--font-weight-semibold);color:var(--color-link)}
.c-project-arrow{color:var(--color-text-tertiary);font-size:14px;transition:transform .15s ease,color .15s ease}
.c-project-link:hover .c-project-arrow{transform:translateX(2px);color:var(--color-link)}
#console-main > section:not(.c-plain):not(.c-card) .c-table-wrap,
.c-card .c-table-wrap{border:0;border-radius:0;box-shadow:none;background:transparent}

/* ── 徽章 / 横幅 / 统计贴片 ─────────────────────────────────────── */
.c-badge{display:inline-block;border:1px solid var(--color-border);border-radius:var(--radius-pill);
  padding:2px 10px;font-size:var(--font-size-caption);font-weight:var(--font-weight-medium);color:var(--color-text-secondary);
  background:var(--color-surface-white)}
.c-badge-accent{border-color:var(--color-accent);background:var(--color-accent);color:var(--color-text-primary)}
.c-badge-success{border-color:var(--color-success);background:var(--color-success-bg)}
.c-badge-error{border-color:var(--color-error);background:var(--color-error-bg)}
.c-badge-warning{border-color:var(--color-warning);background:var(--color-warning-bg)}
.c-banner{border-radius:var(--radius-md);padding:12px 16px;margin:0 0 16px;font-size:var(--font-size-callout);overflow-wrap:anywhere}
.c-banner p{margin:4px 0 0}
.c-banner-info{background:var(--color-surface-subtle);border:1px solid var(--color-border)}
.c-banner-accent{background:var(--color-accent-surface);border:1.5px solid var(--color-accent-border)}
.c-banner-warn{background:var(--color-warning-bg);border:1px solid var(--color-warning)}
.c-banner-actions{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.c-stats-row{display:flex;flex-wrap:wrap;gap:12px;align-items:stretch;margin:0 0 18px}
.c-stat{display:inline-flex;flex-direction:column;gap:2px;background:var(--color-surface-white);
  border-radius:var(--radius-md);border:1px solid var(--color-border-subtle);box-shadow:var(--shadow-card);
  padding:14px 20px;min-width:160px;flex:1 1 160px}
.c-stats-row>.c-card{margin-bottom:0;flex:1 1 280px}
.c-stat-label{font-size:var(--font-size-caption);color:var(--color-text-secondary)}
.c-stat-value{font-size:var(--font-size-title-2);font-weight:var(--font-weight-semibold);line-height:1.2}
.c-stat-hint{font-size:var(--font-size-caption);color:var(--color-text-secondary)}
.c-empty{text-align:center;padding:36px 20px;background:var(--color-surface-white);border-radius:var(--radius-card);border:1px dashed var(--color-border)}
.c-empty p{color:var(--color-text-secondary);margin:6px 0 0}
.c-empty-action{margin-top:14px}

/* ── 表单 / 导航辅助 / 其他 ────────────────────────────────────── */
.c-fieldset{border:0;margin:0;padding:0}
.c-fieldset>legend{font-size:13px;color:var(--color-text-secondary);padding:0;margin-bottom:4px}
.c-main code{overflow-wrap:anywhere}
.c-nav-item-disabled{color:var(--color-text-tertiary);cursor:not-allowed}
.c-nav-item-disabled:hover{background:transparent;text-decoration:none;color:var(--color-text-tertiary)}
.c-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}
.c-tabs a{padding:5px 14px;border:1px solid var(--color-border);border-radius:var(--radius-pill);font-size:var(--font-size-callout);font-weight:var(--font-weight-medium);color:var(--color-text-secondary)}
.c-tabs a:hover{background:var(--color-accent-hover);text-decoration:none;color:var(--color-text-primary)}
.c-tabs a[aria-current="page"]{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-text-primary);font-weight:var(--font-weight-semibold)}
.c-nav-hint{font-size:12px;color:var(--color-text-secondary);padding:8px 4px;line-height:1.5}
.c-nav-badge{display:inline-block;margin-left:6px;min-width:16px;padding:0 5px;border-radius:var(--radius-pill);background:var(--color-accent);font-size:11px;text-align:center}
.c-confirm-inline{display:inline-flex;align-items:center;gap:6px;background:var(--color-accent-surface);border:1.5px solid var(--color-accent-border);border-radius:var(--radius-sm);padding:5px 10px;font-size:12px;margin-left:8px;flex-wrap:wrap}
.c-search{display:flex;gap:6px;align-items:center;margin-left:16px}
.c-search input[type=search]{padding:6px 10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-white);color:var(--color-text-primary);font-size:12px;min-width:200px}
.c-search button{padding:5px 12px;font-size:12px}
.c-switcher{margin-left:16px}
.c-switcher select{padding:6px 10px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-white);color:var(--color-text-primary);font-size:12px;max-width:220px}
.c-thumb{height:24px;width:auto;border-radius:4px;vertical-align:middle;margin-right:6px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
details.c-details{margin:16px 0;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:10px 14px;background:var(--color-surface-white)}
details.c-details>summary{cursor:pointer;font-size:14px;font-weight:var(--font-weight-medium);padding:4px 0}
::placeholder{color:var(--color-text-secondary);opacity:1}
.bulk-tools{display:flex;gap:8px;align-items:center;margin:8px 0}
#console-shortcuts{display:none;margin:0 0 16px}
body.c-shortcuts-open #console-shortcuts{display:block}
.c-kbd{display:inline-block;border:1px solid var(--color-border);border-radius:var(--radius-xs);padding:0 6px;font-family:var(--font-family-mono);font-size:11px;background:var(--color-surface-subtle)}
.dispatch-option{display:inline-flex;align-items:center;gap:4px;margin-right:12px}

:focus-visible{outline:2px solid var(--color-link);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
.c-skip-link{position:absolute;left:-9999px;top:0}
.c-skip-link:focus{left:12px;top:8px;background:var(--color-accent);color:var(--color-text-primary);padding:8px 12px;border-radius:var(--radius-sm);z-index:99}

@media (max-width:960px){
  .c-layout{flex-direction:column;align-items:stretch}
  .c-aside{width:100%;flex-basis:auto;position:static;padding:8px 16px;border-right:0;border-bottom:1px solid var(--color-border);background:var(--color-surface-white)}
  .c-aside nav{flex-direction:row;overflow-x:auto;gap:6px}
  .c-nav-group-title{display:none}
  .c-nav-item{white-space:nowrap}
  .c-main{padding:16px 16px 48px;width:100%;max-width:100%}
  .c-footer{padding:12px 16px 20px}
  .c-topbar{flex-wrap:wrap;row-gap:8px;padding:10px 16px;align-items:flex-start}
  .c-search{margin-left:0;flex:1 1 100%;order:4}
  .c-search input[type=search]{min-width:0;width:100%}
  .c-switcher{margin-left:0;max-width:100%}
  .c-switcher select{max-width:100%}
  .c-card{min-width:0;max-width:100%}
  .c-table-wrap{max-width:100%}
  .c-topbar-meta{width:100%;max-width:100%;margin-left:0;overflow-wrap:anywhere}
  .c-button{min-height:44px}
  .c-nav-item{padding:10px 8px}
}
@media (max-width:768px){
  html,body{width:100%;overflow-x:hidden}
  .c-topbar{padding:10px 12px}
  .c-brand-product{display:none}
  .c-main{padding:12px 12px 48px}
  #console-main > section:not(.c-plain):not(.c-card){padding:16px;margin-bottom:16px}
  #console-main > section:not(.c-plain):not(.c-card) > h2:first-child{margin:-16px -16px 16px;padding:10px 14px;font-size:16px}
  .c-card{padding:18px 16px;border-radius:var(--radius-md)}
  .c-card-header{margin:-18px -16px 16px;padding:10px 14px}
  .c-card-title{font-size:16px}
  .c-table{min-width:720px}
  .c-table th,.c-table td{padding:12px 14px}
  .c-footer{padding:12px 12px 20px}
}
`;
