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
  assert.match(html, /<title>&lt;b&gt;总览&lt;\/b&gt; · AOS 控制台<\/title>/);
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
  assert.match(html, /setInterval/, "轮询脚本存在");
  assert.match(html, /DOMParser/, "轮询替换 console-main 局部内容");
  assert.match(html, /prefers-reduced-motion: reduce[\s\S]*setInterval/, "缩小动画偏好时不启动轮询");
  assert.ok(!html.includes("总览"), "显式 nav 子集生效");
});

test("console shell: 默认 nav 覆盖控制台版块", () => {
  const keys = DEFAULT_CONSOLE_NAV.map((item) => item.key);
  for (const expected of ["overview", "project", "tasks", "dispatch", "library", "archive", "runners", "schedules", "ops", "audit", "usage"]) {
    assert.ok(keys.includes(expected), expected);
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
    /href="\/panel\?project=%2Fw%2Fp&amp;section=tasks#tasks"/,
    "任务锚点指向任务列表"
  );
  assert.doesNotMatch(html, /section=tasks#regression/);
  assert.match(html, /g j<\/span> 项目/, "项目快捷键 j");
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
  assert.match(html, /g o<\/span> 总览|g t<\/span> 任务/, "跳转键表");
  assert.match(html, /术语/, "帮助面板含术语表");
  assert.match(html, /份<\/strong>：一次生成或导入登记的用例集版本/, "份就地定义");
  assert.match(html, /记录底座<\/strong>/, "记录底座术语");
});

test("console shell: 顶栏记录底座指示器（持久层/最近写入/写失败）", () => {
  const html = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    project: "/w/p",
    storeHealth: {
      label: "文件台账",
      lastWriteAt: "2026-10-18T12:03:44.000Z",
      writeIssue: "写失败 2 次",
      opsHref: "/panel?project=%2Fw%2Fp&section=ops"
    }
  });
  assert.match(html, /c-store-chip/);
  assert.match(html, /文件台账/);
  assert.match(html, /最近写入 10-18 12:03/);
  assert.match(html, /c-badge-error">写失败 2 次/);
  assert.match(html, /section=ops/);
  assert.match(html, /:root\[data-theme="dark"\]/, "暗色主题 token（属性态）");
  assert.match(html, /--color-surface-light:#1C1C1E/, "暗色面色映射");
  assert.match(html, /setAttribute\("data-theme","dark"\)/, "按系统偏好应用暗色");
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

  const bare = renderConsoleShell({ title: "总览", active: "overview", body: "" });
  assert.ok(
    bare.includes('aria-disabled="true"') && bare.includes('title="先进入项目后再使用"'),
    "无项目上下文时项目级导航禁用而非误指总览"
  );
  assert.ok(!bare.includes('tabindex="0"'), "禁用导航不可聚焦（键盘 Tab 不穿过）");
  assert.match(bare, /role="link" aria-disabled="true"/, "禁用语义保留（屏幕阅读器可播报）");

  const off = renderConsoleShell({
    title: "总览",
    active: "overview",
    body: "",
    capabilities: { actions: false, usage: false, mode: "standalone" }
  });
  assert.ok(off.includes("写动作未启用"), "能力横幅出现");
  assert.ok(off.includes("本进程不提供统计页"), "统计导航按能力禁用");
  assert.ok(!off.includes('href="/usage"'), "统计不再是无用链接");
});
