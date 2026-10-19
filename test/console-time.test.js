import assert from "node:assert/strict";
import test from "node:test";

import { relativeTime } from "../dist/console/time.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

test("relativeTime: 相对档位（刚刚/分钟/小时/天）", () => {
  assert.match(relativeTime("2026-10-19T11:59:40.000Z", NOW), />刚刚</);
  assert.match(relativeTime("2026-10-19T11:55:00.000Z", NOW), />5 分钟前</);
  assert.match(relativeTime("2026-10-19T09:00:00.000Z", NOW), />3 小时前</);
  assert.match(relativeTime("2026-10-17T12:00:00.000Z", NOW), />2 天前</);
});

test("relativeTime: 超过 7 天同年给月日时分、跨年给日期", () => {
  assert.match(relativeTime("2026-10-01T08:30:00.000Z", NOW).replace(/title="[^"]*"/, ""), />10月1日 \d{2}:\d{2}</);
  assert.match(relativeTime("2025-12-31T08:30:00.000Z", NOW), />2025-12-31</);
});

test("relativeTime: title 给完整本地时间；datetime 保留原值", () => {
  const html = relativeTime("2026-10-19T11:55:00.000Z", NOW);
  assert.match(html, /^<time datetime="2026-10-19T11:55:00\.000Z" title="2026-10-19 \d{2}:\d{2}:\d{2}">/);
});

test("relativeTime: 空值 — ／非法值原样转义", () => {
  assert.equal(relativeTime(null, NOW), "—");
  assert.equal(relativeTime(undefined, NOW), "—");
  assert.equal(relativeTime("", NOW), "—");
  assert.equal(relativeTime("not-a-date", NOW), "not-a-date");
  assert.equal(relativeTime('<script>x</script>', NOW), "&lt;script&gt;x&lt;/script&gt;");
});
