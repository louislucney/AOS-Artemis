import assert from "node:assert/strict";
import test from "node:test";

import {
  cBadge,
  cBanner,
  cCard,
  cConfirmForm,
  cEmpty,
  cStat,
  cTable
} from "../dist/console/components.js";

test("cCard: 标题/副题/强调底/动作区与原文 body", () => {
  const html = cCard({
    title: "项目",
    subtitle: "demo",
    tone: "accent",
    actions: '<a href="/x">详情</a>',
    body: "<p>原文</p>"
  });
  assert.match(html, /class="c-card c-card-accent"/);
  assert.match(html, /<h3 class="c-card-title">项目<\/h3>/);
  assert.match(html, /c-card-subtitle">demo</);
  assert.match(html, /<a href="\/x">详情<\/a>/);
  assert.match(html, /<p>原文<\/p>/);
});

test("cBadge: 语义类名与转义", () => {
  assert.match(cBadge({ label: "通过", tone: "success" }), /c-badge-success">通过</);
  assert.match(cBadge({ label: "失败", tone: "error" }), /c-badge-error">失败</);
  assert.match(cBadge({ label: "a<b>", tone: "neutral" }), /a&lt;b&gt;/);
});

test("cBanner: 三档语气与标题转义", () => {
  assert.match(cBanner({ tone: "accent", title: "焦点", body: "说明" }), /c-banner-accent/);
  assert.match(cBanner({ tone: "warn", title: "注意" }), /c-banner-warn/);
  assert.match(cBanner({ tone: "info", title: "<x>" }), /&lt;x&gt;/);
});

test("cTable: rowsText 自动转义 / rows 原样 / 空态 / 语义表头", () => {
  const text = cTable({ columns: ["项目", "备注"], rowsText: [["<b>demo</b>", "a&b"]] });
  assert.match(text, /<th scope="col">项目<\/th>/);
  assert.ok(text.includes("&lt;b&gt;demo&lt;/b&gt;"), "rowsText 必须转义");
  assert.ok(text.includes("a&amp;b"), "rowsText 必须转义 &");

  const raw = cTable({ columns: ["x"], rows: [['<a href="/y">链接</a>']] });
  assert.ok(raw.includes('<a href="/y">链接</a>'), "rows 保持已构建 HTML");

  const empty = cTable({ columns: ["x", "y"], rowsText: [], empty: "暂无项目" });
  assert.match(empty, /colspan="2"[^>]*>暂无项目</);
});

test("cStat / cEmpty: 结构与转义", () => {
  const stat = cStat({ label: "通过率", value: "87%", hint: "近 7 天" });
  assert.match(stat, /c-stat-label">通过率</);
  assert.match(stat, /c-stat-value">87%</);
  const empty = cEmpty({ title: "还没有数据", body: "先下发一次", action: '<a href="/d">去下发</a>' });
  assert.match(empty, /<h3>还没有数据<\/h3>/);
  assert.match(empty, /<a href="\/d">去下发<\/a>/);
});

test("cConfirmForm: 隐藏字段转义、确认短语、危险态", () => {
  const html = cConfirmForm({
    action: "/panel/api/tasks/release",
    project: '/w/"q"',
    fields: { taskId: "t1" },
    label: "释放重跑",
    confirm: "确认释放？",
    danger: true
  });
  assert.match(html, /action="\/panel\/api\/tasks\/release"/);
  assert.ok(html.includes('value="/w/&quot;q&quot;"'), "project 转义");
  assert.ok(html.includes('name="taskId" value="t1"'), "字段隐藏传递");
  assert.match(html, /data-confirm="确认释放？"/);
  assert.match(html, /data-danger="1"/);
  assert.match(html, /c-button-danger/);
  assert.match(html, /aosConfirmForm/);
});
