import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";
import { buildRetentionReport, collectRetentionEntries, formatBytes } from "../dist/figma/retention.js";

const DAY = 24 * 60 * 60 * 1000;

test("buildRetentionReport: 过期阈值、分类汇总、最旧优先与上限", () => {
  const now = new Date("2026-10-08T00:00:00.000Z").getTime();
  const entries = [
    { category: "reports", path: "/p/.artemis/design/reports/a.json", sizeBytes: 100, mtimeMs: now - 100 * DAY },
    { category: "reports", path: "/p/.artemis/design/reports/b.json", sizeBytes: 200, mtimeMs: now - 10 * DAY },
    { category: "traces", path: "/p/.artemis/traces/t1/x.png", sizeBytes: 300, mtimeMs: now - 200 * DAY },
    { category: "diffs", path: "/p/.artemis/design/diffs/d/report.json", sizeBytes: 400, mtimeMs: now - 1 * DAY }
  ];
  const report = buildRetentionReport(entries, { days: 90, nowMs: now, limit: 1, projectRoot: "/p" });
  assert.equal(report.overdue.count, 2);
  assert.equal(report.overdue.totalBytes, 400);
  assert.deepEqual(
    report.items.map((item) => item.path),
    [".artemis/traces/t1/x.png"],
    "最旧优先 + limit 截断"
  );
  assert.equal(report.truncated, true);
  const reports = report.categories.find((category) => category.id === "reports");
  assert.equal(reports.total, 2);
  assert.equal(reports.overdue, 1);
  assert.equal(reports.overdueBytes, 100);
  assert.equal(report.categories.find((category) => category.id === "crashes").total, 0);
  assert.equal(formatBytes(1536), "1.5KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0MB");
});

test("buildRetentionReport: 全新鲜时无超期项", () => {
  const now = Date.now();
  const report = buildRetentionReport(
    [{ category: "reports", path: "/p/.artemis/design/reports/fresh.json", sizeBytes: 10, mtimeMs: now }],
    { days: 90, nowMs: now, limit: 20, projectRoot: "/p" }
  );
  assert.equal(report.overdue.count, 0);
  assert.equal(report.overdue.totalBytes, 0);
  assert.equal(report.truncated, false);
});

test("suite retention: case-sets 分类纳入扫描与超期计数", () => {
  const root = makeTempDir("aos-retention-");
  const dir = path.join(root, ".artemis", "design", "case-sets");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "20260101T000000_登录流程.json");
  fs.writeFileSync(file, "{}");
  const old = new Date(Date.now() - 100 * DAY);
  fs.utimesSync(file, old, old);

  const entries = collectRetentionEntries(root);
  const report = buildRetentionReport(entries, { days: 90, nowMs: Date.now(), projectRoot: root });
  const summary = report.categories.find((category) => category.id === "case-sets");
  assert.equal(summary.total, 1);
  assert.equal(summary.overdue, 1);
});
