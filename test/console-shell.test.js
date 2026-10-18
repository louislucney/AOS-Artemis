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

test("console shell: auto refresh only when asked; nav subset supported", () => {
  const html = renderConsoleShell({
    title: "任务",
    active: "tasks",
    body: "",
    autoRefreshSeconds: 15,
    nav: [{ key: "tasks", label: "任务", href: "/panel?section=tasks" }]
  });
  assert.match(html, /<meta http-equiv="refresh" content="15">/);
  assert.ok(!html.includes("总览"), "显式 nav 子集生效");
});

test("console shell: 默认 nav 覆盖控制台版块", () => {
  const keys = DEFAULT_CONSOLE_NAV.map((item) => item.key);
  for (const expected of ["overview", "tasks", "dispatch", "library", "archive", "runners", "schedules", "ops", "audit", "usage"]) {
    assert.ok(keys.includes(expected), expected);
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
