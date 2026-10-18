/** CSDC 开发者设计系统 tokens 子集＋控制台基础样式（web-console/DESIGN.md 为规范记录）。
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
  --font-size-title-1:2.25rem; --font-size-title-2:1.5rem; --font-size-title-3:1.125rem;
  --font-size-body:0.9375rem; --font-size-callout:0.8125rem; --font-size-caption:0.75rem;
  --line-height-tight:1.15; --line-height-title:1.25; --line-height-body:1.55;
  --font-weight-regular:400; --font-weight-medium:500; --font-weight-semibold:600; --font-weight-bold:700;
  --tracking-title:-0.018em; --tracking-body:-0.006em;
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
.c-topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;padding:10px 24px;
  background:rgba(255,255,255,0.72);backdrop-filter:var(--blur-header);-webkit-backdrop-filter:var(--blur-header);
  border-bottom:1px solid var(--color-border)}
.c-brand{font-weight:var(--font-weight-semibold);font-size:var(--font-size-title-3);letter-spacing:var(--tracking-title)}
.c-brand a{color:inherit}
.c-topbar-meta{margin-left:auto;color:var(--color-text-secondary);font-size:var(--font-size-callout)}
.c-layout{display:flex;align-items:flex-start;max-width:1320px;margin:0 auto}
.c-aside{width:196px;flex-shrink:0;padding:16px 8px;position:sticky;top:56px;align-self:flex-start}
.c-aside nav{display:flex;flex-direction:column;gap:2px}
.c-nav-item{display:block;padding:7px 12px;border-radius:var(--radius-sm);color:var(--color-text-primary);
  font-size:var(--font-size-callout)}
.c-nav-item:hover{background:var(--color-surface-subtle);text-decoration:none;color:var(--color-text-primary)}
.c-nav-item[aria-current="page"]{background:var(--color-accent);font-weight:var(--font-weight-medium)}
.c-main{flex:1;min-width:0;padding:18px 24px 56px}
.c-footer{max-width:1320px;margin:0 auto;padding:14px 24px 24px;color:var(--color-text-secondary);font-size:var(--font-size-caption)}
@media (max-width:960px){
  .c-layout{flex-direction:column}
  .c-aside{width:100%;position:static;padding:8px 16px;border-bottom:1px solid var(--color-border-subtle)}
  .c-aside nav{flex-direction:row;overflow-x:auto;gap:6px}
  .c-nav-item{white-space:nowrap}
  .c-main{padding:14px 16px 48px}
}
:focus-visible{outline:2px solid var(--color-link);outline-offset:2px}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
.c-stats-row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin:0 0 16px}
.c-card{background:var(--color-surface-white);border:1px solid var(--color-border-subtle);border-radius:var(--radius-card);box-shadow:var(--shadow-card);padding:16px 18px;margin:0 0 16px}
.c-card-accent{background:var(--color-accent-subtle);border-color:var(--color-accent)}
.c-card-title{margin:0 0 4px}
.c-card-subtitle{color:var(--color-text-secondary);font-size:var(--font-size-callout);margin:0 0 8px}
.c-card-actions{float:right}
.c-card-body::after{content:"";display:block;clear:both}
.c-badge{display:inline-block;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:1px 8px;font-size:var(--font-size-caption);color:var(--color-text-secondary);background:var(--color-surface-white)}
.c-badge-accent{border-color:var(--color-accent);background:var(--color-accent);color:var(--color-text-primary)}
.c-badge-success{border-color:var(--color-success);background:var(--color-success-bg)}
.c-badge-error{border-color:var(--color-error);background:var(--color-error-bg)}
.c-badge-warning{border-color:var(--color-warning);background:var(--color-warning-bg)}
.c-banner{border-radius:var(--radius-md);padding:12px 14px;margin:0 0 16px;font-size:var(--font-size-callout)}
.c-banner p{margin:4px 0 0}
.c-banner-info{background:var(--color-surface-subtle);border:1px solid var(--color-border)}
.c-banner-accent{background:var(--color-accent-surface);border:1px solid var(--color-accent)}
.c-banner-warn{background:var(--color-warning-bg);border:1px solid var(--color-warning)}
.c-table{width:100%;border-collapse:collapse;font-size:var(--font-size-callout);background:var(--color-surface-white);border-radius:var(--radius-md);overflow:hidden;border:1px solid var(--color-border-subtle)}
.c-table th{text-align:left;font-weight:var(--font-weight-medium);color:var(--color-text-secondary);border-bottom:1px solid var(--color-border);padding:8px 10px;white-space:nowrap}
.c-table td{border-bottom:1px solid var(--color-border-subtle);padding:8px 10px;vertical-align:top}
.c-table tr:last-child td{border-bottom:none}
.c-table caption{text-align:left;padding:8px 10px;color:var(--color-text-secondary);font-size:var(--font-size-caption)}
.c-empty-cell{color:var(--color-text-secondary);text-align:center;padding:16px}
.c-stat{display:inline-block;background:var(--color-surface-white);border-radius:var(--radius-md);border:1px solid var(--color-border-subtle);padding:10px 16px;margin:0 8px 8px 0;min-width:120px}
.c-stat-label{font-size:var(--font-size-caption);color:var(--color-text-secondary)}
.c-stat-value{font-size:var(--font-size-title-2);font-weight:var(--font-weight-semibold)}
.c-stat-hint{font-size:var(--font-size-caption);color:var(--color-text-secondary)}
.c-empty{text-align:center;padding:32px 16px;background:var(--color-surface-white);border-radius:var(--radius-card);border:1px dashed var(--color-border)}
.c-empty p{color:var(--color-text-secondary);margin:6px 0 0}
.c-empty-action{margin-top:12px}
.c-button{appearance:none;border:1px solid var(--color-border);background:var(--color-surface-white);border-radius:var(--radius-sm);padding:7px 14px;font-size:var(--font-size-callout);cursor:pointer;color:var(--color-text-primary);font-family:inherit}
.c-button:hover{border-color:var(--color-text-secondary)}
.c-button-primary{background:var(--color-accent);border-color:var(--color-accent);font-weight:var(--font-weight-medium)}
.c-button-danger{border-color:var(--color-error);color:var(--color-error)}
.c-confirm{display:inline-block}
`;
