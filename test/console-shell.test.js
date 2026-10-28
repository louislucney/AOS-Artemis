import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONSOLE_NAV, renderConsoleShell } from "../dist/console/shell.js";

test("console shell: CSDC chrome, active nav, escaped title, no refresh by default", () => {
  const html = renderConsoleShell({
    title: "<b>总览</b>",
    active: "overview",
    body: "<p>内容</p>",
    meta: "<code>/w/demo</code>"
  });
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /data-console="shell"/);
  assert.match(html, /--color-accent:\s*#FFE600/);
  assert.match(html, /aria-label="控制台导航"/);
  assert.match(html, /aria-current="page"/);
  assert.ok(!html.includes("<b>总览</b>"), "title 必须转义");
  assert.match(html, /<title>&lt;b&gt;总览&lt;\/b&gt; · mobile-testing 控制台<\/title>/);
  assert.ok(!html.includes('http-equiv="refresh"'));
});

test("console shell: 自动刷新＝局部轮询（无整页刷新；缩小动画偏好关）", () => {
  const html = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    autoRefreshSeconds: 15,
    nav: [{ key: "tasks", label: "任务", href: "/panel?section=tasks" }]
  });
  assert.ok(!html.includes('http-equiv="refresh"'), "不再使用 meta 整页刷新");
  assert.match(html, /id="aos-live-note"[^>]*>自动刷新中（每 15 秒）/, "刷新可见标注");
  assert.match(html, /id="aos-live-toggle"/, "暂停/继续控制");
  assert.match(html, /clearInterval\(timer\)/, "暂停可生效");
  assert.match(html, /DOMParser/, "轮询替换 console-main 局部内容");
  assert.match(html, /if\(reduced\)\{/, "缩小动画偏好分支");
  assert.match(html, /else\{start\(\)/, "未偏好时启动轮询");
  assert.match(html, /aosOnRefresh/, "替换后回调重绑钩子（任务动作不失效）");
  assert.match(html, /e\.target\.id!=="aos-live-toggle"/, "暂停按钮文档级委托（替换免疫）");
  assert.ok(!html.includes("总览"), "显式 nav 子集生效");
});

test("console shell: 默认 nav 覆盖控制台版块", () => {
  const keys = DEFAULT_CONSOLE_NAV.map((item) => item.key);
  for (const expected of ["project", "review", "dispatch", "library", "archive", "ops", "usage"]) {
    assert.ok(keys.includes(expected), expected);
  }
  for (const removed of ["overview", "tasks", "runners", "schedules", "stats", "audit"]) {
    assert.ok(!keys.includes(removed), `${removed} 已并入同级版块，不再占一级导航`);
  }
});

test("console shell: 项目导航项、切换器与任务锚点", () => {
  const html = renderConsoleShell({
    title: "项目",
    active: "project",
    body: "",
    project: "/w/p",
    projectSwitcher: {
      options: [
        { label: "A", href: "/panel?project=%2Fw%2Fa", current: true },
        { label: "B", href: "/panel?project=%2Fw%2Fb" }
      ]
    }
  });
  assert.match(html, /aria-current="page"[^>]*>项目</);
  assert.match(html, /c-switcher/);
  assert.match(html, /aria-label="切换项目"/);
  assert.match(html, /<option value="\/panel\?project=%2Fw%2Fa" selected>A<\/option>/, "当前项目预选");
  assert.match(
    html,
    /"tasks":"\/panel\?project=%2Fw%2Fp&section=tasks#tasks"/,
    "任务锚点仍可由快捷键触达"
  );
  assert.doesNotMatch(html, /section=tasks#regression/);
  assert.match(html, /g j<\/span> 项目/, "项目快捷键 j");
  assert.match(html, /window\.aosInlineConfirm=function/, "站内确认助手随壳提供");
  assert.match(html, /\.c-confirm-inline\{display:inline-flex/, "站内确认条样式");
});

test("console shell: 独立统计进程（品牌指 /usage，隐藏全局搜索）", () => {
  const html = renderConsoleShell({
    title: "使用统计",
    active: "usage",
    body: "",
    nav: [{ key: "usage", label: "使用统计", href: "/usage" }],
    brandHref: "/usage",
    hideSearch: true
  });
  assert.match(html, /class="c-brand"><a href="\/usage"/, "品牌链接不指向不存在的 /panel");
  assert.ok(!html.includes('role="search"'), "无面板路由时不做全局搜索");
  assert.ok(!html.includes('action="/panel"'), "无死链表单");
});

test("console shell: 窄屏布局（顶栏换行/主区收宽/表格容器）", () => {
  const html = renderConsoleShell({ title: "x", active: "overview", body: "" });
  assert.match(html, /@media \(max-width:960px\)/);
  assert.match(html, /\.c-topbar\{flex-wrap:wrap/, "顶栏允许换行");
  assert.match(html, /\.c-layout\{flex-direction:column;align-items:stretch\}/, "列向拉伸（主区不再被内容撑宽）");
  assert.match(html, /\.c-table-wrap\{overflow-x:auto/, "表格横向滚动容器");
  assert.match(html, /\.c-button\{min-height:44px\}/, "移动触达高度 ≥44px");
});

test("console shell: 快捷键（? 帮助 / g 跳转 / reduced-motion 豁免刷新）", () => {
  const html = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    project: "/w/p",
    autoRefreshSeconds: 10
  });
  assert.match(html, /id="console-shortcuts"/);
  assert.match(html, /c-shortcuts-open/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /role="search"/, "顶栏全局搜索");
  assert.match(html, /name="q"[^>]*aria-label="全局搜索/, "搜索框可访问名");
  assert.match(html, /name="section" value="search"/, "搜索提交到结果页");
  assert.match(html, /按 <span class="c-kbd">\?<\/span> 查看快捷键/);
  assert.match(html, /g t<\/span> 任务/, "跳转键表");
  assert.ok(!html.includes("g o</span>"), "总览跳转键已移除");
  assert.match(html, /术语/, "帮助面板含术语表");
  assert.match(html, /用例集<\/strong>：一次生成或导入登记的一个用例版本/, "用例集就地定义");
  assert.match(html, /记录底座<\/strong>/, "记录底座术语");
  assert.match(html, /门禁<\/strong>：批次通过判定/, "术语表补门禁");
  assert.match(html, /设备运行<\/strong>：一次用例集×设备执行/, "术语表补设备运行");
  assert.match(html, /积压<\/strong>：待执行队列/, "术语表补积压");
});

test("console shell: 顶栏不再显示存储/最近写入（信息只在运维页）", () => {
  const html = renderConsoleShell({
    title: "项目",
    active: "project",
    body: "",
    project: "/w/p",
    storeHealth: {
      label: "文件台账",
      lastWriteAt: "2026-10-18T12:03:44.000Z",
      writeIssue: "写失败 2 次",
      opsHref: "/panel?project=%2Fw%2Fp&section=ops"
    }
  });
  assert.ok(!html.includes("c-store-chip"), "顶栏不再有存储状态胶囊");
  assert.ok(!html.includes("最近写入"), "顶栏不再有最近写入");
  assert.match(html, /color-scheme:light/, "CSDC 强制亮色");
  assert.match(html, /<meta name="color-scheme" content="light">/, "UA 控件也按亮色");
  assert.ok(!html.includes("data-theme=\"dark\""), "不再跟随系统暗色");
});

test("console shell: CSDC 官方徽标、全宽布局与组件母版", () => {
  const html = renderConsoleShell({ title: "总览", active: "overview", body: "" });
  assert.match(html, /data:image\/svg\+xml;base64,/, "顶栏使用 CSDC 官方徽标（内联 data URI）");
  assert.ok(!html.includes('<div class="c-nav-group-title">'), "侧栏分组标题已移除");
  assert.ok(
    html.includes(".c-layout{display:flex;align-items:flex-start;width:100%;max-width:none;margin:0}"),
    "布局全宽，不再 1320 居中"
  );
  assert.ok(html.includes(".c-aside{width:220px;flex:0 0 220px;"), "侧栏 220px（CSDC 标准）");
  assert.ok(html.includes(".c-main{flex:1;min-width:0;padding:20px 36px 80px;background:var(--color-surface-white)}"), "主区白底");
  assert.ok(html.includes(".c-card-header{"), "卡片黄色分区头");
  assert.ok(html.includes(".c-table th{background:var(--color-surface-light);"), "表格浅灰表头");
  assert.ok(html.includes(".c-table--fixed{table-layout:fixed}"), "固定列宽表格");
  assert.ok(
    html.includes("#console-main > section:not(.c-plain):not(.c-card) .c-table-wrap"),
    "表格在区块内不再嵌套卡片"
  );
  assert.ok(html.includes("border-radius:var(--radius-pill)"), "按钮/徽章胶囊圆角");
});

test("console shell: 内联脚本可解析（防语法回归）", () => {
  const html = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    project: "/w/p",
    capabilities: { actions: false, usage: false, mode: "standalone" }
  });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 2, "shell 含快捷键与 flash 两段脚本");
  for (const code of scripts) {
    assert.doesNotThrow(() => new Function(code), "脚本不得有语法错误");
  }
});

test("console shell: 项目上下文与能力标记（导航禁用/横幅）", () => {
  const withProject = renderConsoleShell({
    title: "下发",
    active: "dispatch",
    body: "",
    project: "/w/p",
    capabilities: { actions: true, usage: true, mode: "http" }
  });
  assert.ok(withProject.includes("section=dispatch"), "带项目上下文");
  assert.ok(withProject.includes("project=%2Fw%2Fp"), "项目参数编码");
  assert.ok(!withProject.includes('aria-disabled="true"'), "能力全开时无禁用项");
  const hostScoped = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    project: "/w/p",
    projectHostId: "h-b",
    capabilities: { actions: true, usage: true, mode: "http" }
  });
  assert.match(
    hostScoped,
    /href="\/usage\?project=%2Fw%2Fp&amp;host=h-b"/,
    "统计导航携带项目与主机"
  );
  assert.match(withProject, /aos-last-project/, "项目页记录上次项目（localStorage）");

  const bare = renderConsoleShell({ title: "总览", active: "overview", body: "" });
  assert.ok(
    !bare.includes('aria-disabled="true"'),
    "无项目上下文：项目级导航隐藏而非渲染死项"
  );
  assert.ok(!bare.includes("section=dispatch"), "项目级项不渲染");
  assert.ok(bare.includes('class="c-brand"><a href="/panel"'), "品牌链接仍可回到总览");
  assert.ok(!bare.includes('c-nav-item" href="/panel"'), "侧栏不再渲染总览项");
  assert.match(bare, /进入任一项目后显示项目级版块/, "隐藏原因就地说明");
  assert.ok(!bare.includes('tabindex="0"'), "无不可聚焦残留");
  assert.ok(!bare.includes("aos-last-project"), "无项目上下文不写上次项目");

  const off = renderConsoleShell({
    title: "总览",
    active: "overview",
    body: "",
    capabilities: { actions: false, usage: false, mode: "standalone" }
  });
  assert.ok(off.includes("只读模式"), "能力横幅出现");
  assert.ok(off.includes("本进程不提供统计页"), "统计导航按能力禁用");
  assert.ok(!off.includes('href="/usage"'), "统计不再是无用链接");
});

test("console shell: 顶栏显示进程级角色", () => {
  const html = renderConsoleShell({
    title: "项目",
    active: "project",
    body: "",
    meta: "<code>/w/p</code>",
    capabilities: {
      actions: true,
      usage: true,
      mode: "http",
      role: "dispatcher",
      scopes: { dispatch: true, tasks: true, verdicts: false }
    }
  });
  assert.match(html, /角色：派发/);
  assert.match(html, /AOS_PANEL_ROLE/);
});
