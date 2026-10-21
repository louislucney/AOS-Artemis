import { CONSOLE_COMPAT_CSS } from "./compat.js";
import { CSDC_LOGO_DATA_URI } from "./logo.js";
import { CSDC_TOKENS_CSS } from "./tokens.js";
import { relativeTime } from "./time.js";
import { CONSOLE_NAME, PRODUCT_NAME } from "../brand.js";
import { escapeHtml } from "../util.js";

export type ConsoleNavKey =
  | "overview"
  | "project"
  | "tasks"
  | "review"
  | "stats"
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
  /** 顶栏"记录底座"常驻指示（持久层/最近写入/写失败）。 */
  storeHealth?: {
    label: string;
    lastWriteAt: string | null;
    writeIssue: string | null;
    opsHref: string | null;
  };
  /** 顶栏搜索框回显（搜索页传入当前 q）。 */
  searchQuery?: string;
  /** 顶栏项目切换器（当前项目 + 最近项目候选）。 */
  projectSwitcher?: { options: Array<{ label: string; href: string; current?: boolean }> };
  /** 品牌链接目标（独立统计进程指向 /usage；默认 /panel）。 */
  brandHref?: string;
  /** 独立进程无面板路由时隐藏全局搜索（避免提交到不存在端点）。 */
  hideSearch?: boolean;
}

let shellDefaults: {
  projectSwitcher?: ConsoleShellInput["projectSwitcher"];
  storeHealth?: ConsoleShellInput["storeHealth"];
  capabilities?: ConsoleCapabilities;
} = {};

/** 面板在渲染前注入的默认上下文（切换器 / 记录底座 / 能力）；同一次同步渲染调用内生效。 */
export function setConsoleShellDefaults(patch: typeof shellDefaults): void {
  shellDefaults = patch;
}

/** 项目级导航键（需要 project 上下文；无上下文时禁用而非误指总览）。 */
const PROJECT_SCOPED: ReadonlySet<ConsoleNavKey> = new Set([
  "project",
  "tasks",
  "review",
  "stats",
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
  { key: "project", label: "项目", href: "/panel" },
  { key: "tasks", label: "任务", href: "/panel?section=tasks" },
  { key: "review", label: "归因", href: "/panel" },
  { key: "stats", label: "回归统计", href: "/panel" },
  { key: "dispatch", label: "下发", href: "/panel?section=dispatch" },
  { key: "library", label: "用例库", href: "/panel?section=library" },
  { key: "archive", label: "档案与产物", href: "/panel?section=archive" },
  { key: "runners", label: "执行机", href: "/panel?section=runners" },
  { key: "schedules", label: "计划", href: "/panel?section=schedules" },
  { key: "ops", label: "运维与数据", href: "/panel?section=ops" },
  { key: "audit", label: "审计", href: "/panel?section=audit" },
  { key: "usage", label: "使用统计", href: "/usage" }
];

export const USAGE_STANDALONE_NAV: ConsoleNavItem[] = [
  { key: "usage", label: "使用统计", href: "/usage" }
];

function navHref(item: ConsoleNavItem, project: string | null): string | null {
  if (!PROJECT_SCOPED.has(item.key)) return item.href;
  if (project === null || project === "") return null;
  if (item.key === "project") return `/panel?project=${encodeURIComponent(project)}`;
  if (item.key === "review") {
    return `/panel?project=${encodeURIComponent(project)}&view=review`;
  }
  if (item.key === "stats") {
    return `/panel?project=${encodeURIComponent(project)}&view=stats`;
  }
  const params = new URLSearchParams({ project, section: item.key });
  if (item.key === "tasks") return `/panel?${params.toString()}#tasks`;
  if (item.key === "runners") return `/panel?${params.toString()}#runners`;
  if (item.key === "schedules") return `/panel?${params.toString()}#schedules`;
  return `/panel?${params.toString()}`;
}

export function renderConsoleShell(input: ConsoleShellInput): string {
  const capabilities = input.capabilities ?? shellDefaults.capabilities ?? DEFAULT_CAPABILITIES;
  const project = input.project ?? null;
  const nav = input.nav ?? DEFAULT_CONSOLE_NAV;
  const navParts: string[] = [];
  let hiddenScoped = 0;
  for (const item of nav) {
    const current = item.key === input.active ? ' aria-current="page"' : "";
    const badge = item.badge ? `<span class="c-nav-badge">${escapeHtml(item.badge)}</span>` : "";
    const href = item.key === "usage" && !capabilities.usage ? null : navHref(item, project);
    if (href === null) {
      if (PROJECT_SCOPED.has(item.key)) {
        hiddenScoped += 1;
        continue;
      }
      const reason = "本进程不提供统计页（独立统计服务：usage --web）";
      navParts.push(
        `<span class="c-nav-item c-nav-item-disabled" role="link" aria-disabled="true" aria-label="${escapeHtml(item.label)}（${escapeHtml(reason)}）" title="${escapeHtml(reason)}">${escapeHtml(item.label)}${badge}</span>`
      );
      continue;
    }
    navParts.push(`<a class="c-nav-item"${current} href="${escapeHtml(href)}">${escapeHtml(item.label)}${badge}</a>`);
  }
  const navHtml = navParts.join("\n");
  const navHint =
    hiddenScoped === 0
      ? ""
      : `<div class="c-nav-hint muted">进入任一项目后显示项目级版块（任务/下发/用例库/…）</div>`;
  const actionsBanner = capabilities.actions
    ? ""
    : `<div class="c-banner c-banner-warn" role="status" id="capability-banner">写动作未启用：独立进程需 <code>AOS_PANEL_ACTIONS=1</code> 且仅 loopback 访问；或使用 HTTP 模式（<code>serve --http</code>，见 README 接入指南）。当前页面为只读。 <button class="c-button" type="button" id="capability-dismiss">知道了</button></div>`;
  const navTargets: Record<string, string> = {};
  for (const item of nav) {
    const href = item.key === "usage" && !capabilities.usage ? null : navHref(item, project);
    if (href !== null) navTargets[item.key] = href;
  }
  const shortcutKeys: Array<[string, ConsoleNavKey, string]> = [
    ["o", "overview", "总览"],
    ["j", "project", "项目"],
    ["t", "tasks", "任务"],
    ["v", "review", "归因"],
    ["y", "stats", "回归统计"],
    ["d", "dispatch", "下发"],
    ["l", "library", "用例库"],
    ["f", "archive", "档案"],
    ["r", "runners", "执行机"],
    ["s", "schedules", "计划"],
    ["p", "ops", "运维"],
    ["a", "audit", "审计"],
    ["u", "usage", "使用统计"]
  ];
  const shortcutRows = shortcutKeys
    .filter(([, key]) => navTargets[key] !== undefined)
    .map(([letter, , label]) => `<li><span class="c-kbd">g ${letter}</span> ${escapeHtml(label)}</li>`)
    .join("");
  const shortcutsScript = `<script>(function(){var targets=${JSON.stringify(navTargets).replace(/</g, "\\u003c")};var g=false;var seqTimer=null;function editable(el){if(!el)return false;var t=el.tagName;return t==="INPUT"||t==="TEXTAREA"||t==="SELECT"||el.isContentEditable;}document.addEventListener("keydown",function(e){if(e.metaKey||e.ctrlKey||e.altKey)return;if(e.key==="Escape"){document.body.classList.remove("c-shortcuts-open");return;}if(e.key==="?"&&!editable(e.target)){e.preventDefault();document.body.classList.toggle("c-shortcuts-open");return;}if(e.key==="/"&&!editable(e.target)){var box=document.querySelector('input[name="q"],input[name="keyword"],input[name="domain"],input[name="tool"],select[name="tool"]');if(box){e.preventDefault();box.focus();if(box.select)box.select();}return;}if(e.key==="g"&&!editable(e.target)){g=true;clearTimeout(seqTimer);seqTimer=setTimeout(function(){g=false;},1200);return;}if(g&&!editable(e.target)){var href=targets[({j:"project",t:"tasks",v:"review",y:"stats",d:"dispatch",l:"library",f:"archive",r:"runners",s:"schedules",p:"ops",a:"audit",u:"usage",o:"overview"})[e.key]];g=false;if(href){e.preventDefault();location.href=href;}}},true);if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches){var m=document.querySelector('meta[http-equiv=refresh]');if(m)m.parentNode.removeChild(m);}})();</script>`;
  const brandHref = input.brandHref ?? "/panel";
  const searchForm =
    input.hideSearch === true
      ? ""
      : `<form class="c-search" method="get" action="/panel" role="search"><input type="hidden" name="section" value="search"><input type="search" name="q" aria-label="全局搜索（项目/用例集/任务）" placeholder="搜索项目 / 用例集 / 任务" value="${escapeHtml(input.searchQuery ?? "")}"><button class="c-button" type="submit">搜索</button></form>`;
  const health = input.storeHealth ?? shellDefaults.storeHealth;
  const healthChip =
    health === undefined
      ? ""
      : `<div class="c-store-chip" title="${
          health.opsHref === null
            ? "记录底座：持久层与最近写入"
            : "记录底座：持久层与最近写入（点击进入运维与数据）"
        }">${health.opsHref === null ? "" : `<a href="${escapeHtml(health.opsHref)}">`}${escapeHtml(health.label)}${health.opsHref === null ? "" : "</a>"}${
          health.lastWriteAt === null
            ? ""
            : ` · 最近写入 ${relativeTime(health.lastWriteAt)}`
        }${health.writeIssue === null ? "" : ` <span class="c-badge c-badge-error">${escapeHtml(health.writeIssue)}</span>`}</div>`;
  const switcherOptions = (input.projectSwitcher ?? shellDefaults.projectSwitcher)?.options ?? [];
  const switcher =
    switcherOptions.length === 0
      ? ""
      : `<nav class="c-switcher" aria-label="项目切换"><select name="project-switcher" aria-label="切换项目" onchange="if(this.value)location.href=this.value"><option value="">切换项目…</option>${switcherOptions
          .map(
            (option) =>
              `<option value="${escapeHtml(option.href)}"${option.current === true ? " selected" : ""}>${escapeHtml(option.label)}</option>`
          )
          .join("")}</select></nav>`;
  const glossaryRows = [
    ["份", "一次生成或导入登记的用例集版本（其 tests.json 可直接执行）"],
    ["裁决", "对失败用例的定性：案例问题/执行偏差/应用缺陷/不确定"],
    ["失败域", "失败归因分类（应用缺陷/环境/数据环境/行为或设计/设计推断/用例缺陷…）"],
    ["基线", "对比参照：latest＝与该份最近批次比；none＝重立基准"],
    ["执行机", "运行用例的机器（runner；自动领取任务并在设备上执行）"],
    ["隔离", "quarantine：经 owner 签字暂时不计门禁的用例"],
    ["记录底座", "服务对结果/过程/数据的强制持久台账（顶栏指示器）"],
    ["门禁", "批次通过判定：全部用例通过（隔离项不计）才算通过；空运行不计门禁"],
    ["子运行", "一次份×设备执行产生的运行记录（一个任务下可有多个）"],
    ["领取", "执行机从队列取走待执行任务（claimed → running）"],
    ["积压", "待执行队列中的任务数（等待在线执行机）"],
    ["flaky", "同一用例时好时坏（重复采样判定）"]
  ];
  const glossaryHtml = `<h2 class="c-card-title">术语</h2><ul>${glossaryRows
    .map(([term, meaning]) => `<li><strong>${escapeHtml(term)}</strong>：${escapeHtml(meaning)}</li>`)
    .join("")}</ul>`;
  const shortcutsPanel = `<div class="c-card" id="console-shortcuts" role="region" aria-label="快捷键与术语"><h2 class="c-card-title">快捷键</h2><ul><li><span class="c-kbd">?</span> 开关本帮助</li><li><span class="c-kbd">/</span> 聚焦筛选框</li>${shortcutRows}</ul>${glossaryHtml}</div>`;
  const liveNote =
    input.autoRefreshSeconds === undefined
      ? ""
      : `<p class="muted" id="aos-live-note" role="status">自动刷新中（每 ${Math.max(1, Math.floor(input.autoRefreshSeconds))} 秒） <button type="button" class="c-button" id="aos-live-toggle">暂停</button></p>`;
  const livePollScript =
    input.autoRefreshSeconds === undefined
      ? ""
      : `<script>(function(){var ms=${Math.max(1, Math.floor(input.autoRefreshSeconds))}*1000;var timer=null;var note=document.getElementById("aos-live-note");var toggle=document.getElementById("aos-live-toggle");function tick(){if(document.hidden)return;var cur=document.getElementById("console-main");if(cur&&cur.contains(document.activeElement)&&document.activeElement!==document.body)return;fetch(location.href).then(function(r){return r.ok?r.text():null;}).then(function(html){if(!html)return;var doc=new DOMParser().parseFromString(html,"text/html");var fresh=doc.getElementById("console-main");var now=document.getElementById("console-main");if(fresh&&now&&!now.contains(document.activeElement)){now.replaceChildren.apply(now,Array.prototype.slice.call(fresh.childNodes));try{window.aosOnRefresh&&window.aosOnRefresh();}catch(e){}}}).catch(function(){});}function start(){if(timer!==null)return;timer=setInterval(tick,ms);var t=document.getElementById("aos-live-toggle");if(t)t.textContent="暂停";}function stop(){if(timer!==null){clearInterval(timer);timer=null;}var t=document.getElementById("aos-live-toggle");if(t)t.textContent="继续";}var reduced=false;try{reduced=!!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);}catch(e){}if(reduced){if(note)note.textContent="已按系统偏好关闭自动刷新";if(toggle)toggle.hidden=true;}else{start();document.addEventListener("click",function(e){if(!e.target||e.target.id!=="aos-live-toggle")return;if(timer===null){start();}else{stop();}});}})();</script>`;
  const recordLastProject =
    project === null || project === ""
      ? ""
      : `<script>try{localStorage.setItem("aos-last-project",${JSON.stringify(project).replace(/</g, "\\u003c")});}catch(e){}</script>`;
  const inlineConfirmScript = `<script>(function(){window.aosInlineConfirm=function(button,message,onConfirm){var host=button.parentNode;var box=document.createElement('span');box.className='c-confirm-inline';box.setAttribute('role','status');var text=document.createElement('span');text.textContent=message;var yes=document.createElement('button');yes.type='button';yes.className='c-button c-button-primary';yes.textContent='确认';var no=document.createElement('button');no.type='button';no.className='c-button';no.textContent='取消';box.appendChild(text);box.appendChild(document.createTextNode(' '));box.appendChild(yes);box.appendChild(document.createTextNode(' '));box.appendChild(no);host.insertBefore(box,button.nextSibling);button.disabled=true;var closed=false;function close(){if(closed)return;closed=true;if(box.parentNode)box.parentNode.removeChild(box);button.disabled=false;document.removeEventListener('keydown',onKey,true);}function onKey(e){if(e.key==='Escape'){e.preventDefault();close();if(button.focus)button.focus();}}yes.addEventListener('click',function(){close();onConfirm();});no.addEventListener('click',function(){close();if(button.focus)button.focus();});document.addEventListener('keydown',onKey,true);yes.focus();};})();</script>`;
  const flashScript = `<script>(function(){window.aosFlash=function(message){try{sessionStorage.setItem("aos-flash",message);}catch(e){}};var raw=null;try{raw=sessionStorage.getItem("aos-flash");}catch(e){}if(raw){try{sessionStorage.removeItem("aos-flash");}catch(e){}var main=document.getElementById("console-main");if(main){var box=document.createElement("div");box.className="c-banner c-banner-accent";box.setAttribute("role","status");var text=document.createTextNode(raw);box.appendChild(text);var params=new URLSearchParams(location.search);var project=params.get("project");if(project){box.appendChild(document.createTextNode(" "));var host=params.get("host");var a=document.createElement("a");a.href="/panel?project="+encodeURIComponent(project)+"&section=audit"+(host?"&host="+encodeURIComponent(host):"");a.textContent="查看审计";box.appendChild(a);}var sheet=document.getElementById("console-shortcuts");main.insertBefore(box,sheet?sheet.nextSibling:main.firstChild);}}var dismiss=document.getElementById("capability-dismiss");if(dismiss){dismiss.addEventListener("click",function(){try{sessionStorage.setItem("aos-cap-dismissed","1");}catch(e){}var b=document.getElementById("capability-banner");if(b)b.parentNode.removeChild(b);});}if(function(){try{return sessionStorage.getItem("aos-cap-dismissed")==="1";}catch(e){return false;}}()){var b=document.getElementById("capability-banner");if(b)b.parentNode.removeChild(b);}})();</script>`;
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(input.title)} · ${CONSOLE_NAME}</title>`,
    `<style>${CSDC_TOKENS_CSS}\n${CONSOLE_COMPAT_CSS}</style>`,
    input.headExtra ?? "",
    "</head>",
    '<body data-console="shell">',
    '<a class="c-skip-link" href="#console-main">跳到主内容</a>',
    '<header class="c-topbar">',
    `<div class="c-brand"><a href="${escapeHtml(brandHref)}"><img src="${escapeHtml(CSDC_LOGO_DATA_URI)}" alt="CSDC 智能交付中心"><span class="c-brand-product">${CONSOLE_NAME}</span></a></div>`,
    switcher,
    healthChip,
    searchForm,
    input.meta ? `<div class="c-topbar-meta">${input.meta}</div>` : "",
    "</header>",
    actionsBanner,
    '<div class="c-layout">',
    `<aside class="c-aside"><div class="c-nav-group-title">工作区</div><nav aria-label="控制台导航">${navHtml}${navHint}</nav></aside>`,
    `<main class="c-main" id="console-main">${liveNote}${shortcutsPanel}${input.body}</main>`,
    "</div>",
    `<footer class="c-footer">${PRODUCT_NAME} · 本地服务 · 按 <span class="c-kbd">?</span> 查看快捷键</footer>`,
    shortcutsScript,
    livePollScript,
    recordLastProject,
    inlineConfirmScript,
    flashScript,
    "</body>",
    "</html>"
  ]
    .filter((part) => part !== "")
    .join("\n");
}
