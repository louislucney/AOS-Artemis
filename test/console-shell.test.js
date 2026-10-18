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

test("console shell: default nav covers console sections", () => {
  const keys = DEFAULT_CONSOLE_NAV.map((item) => item.key);
  for (const expected of ["overview", "tasks", "dispatch", "library", "archive", "runners", "schedules", "ops", "audit", "usage"]) {
    assert.ok(keys.includes(expected), expected);
  }
});
