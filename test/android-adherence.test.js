import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { computeAndroidScriptAdherence } from "../dist/artemis/android-adherence.js";
import { parseTestSummary } from "../dist/artemis/task-result.js";

const sqlite = await import("node:sqlite").catch(() => null);
const sqliteSkip = sqlite ? false : "node:sqlite unavailable (Node < 22.5)";

function makeDb(dbPath, traceId) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE steps (
    step_id TEXT PRIMARY KEY,
    session_id TEXT,
    step_number INTEGER,
    pre_image_name TEXT,
    post_image_name TEXT,
    action_taken TEXT
  )`);
  db.exec(`CREATE TABLE images (
    image_name TEXT PRIMARY KEY,
    ocr_result TEXT
  )`);
  const insertStep = db.prepare(
    "INSERT INTO steps (step_id, session_id, step_number, pre_image_name, post_image_name, action_taken) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insertStep.run(
    "s1",
    traceId,
    1,
    "img1",
    "img2",
    JSON.stringify({ action: "tap", coordinates: [500, 800], coordinate_space: "normalized" })
  );
  insertStep.run(
    "s2",
    traceId,
    2,
    "img2",
    "img3",
    JSON.stringify({ action: "tap", coordinates: [500, 800], coordinate_space: "normalized" })
  );
  const insertImage = db.prepare("INSERT INTO images (image_name, ocr_result) VALUES (?, ?)");
  insertImage.run("img1", JSON.stringify([{ text: "首頁" }, { text: "登入" }]));
  insertImage.run("img2", JSON.stringify([{ text: "首頁" }, { text: "我的" }]));
  insertImage.run("img3", JSON.stringify([{ text: "訂單列表" }]));
  db.close();
}

const TASK_WITH_PLAN = [
  "打开 App 并走一遍主流程",
  '【AOS-EXPECT】{"start":{"screen":"首頁","hints":["首頁"]},"steps":[{"index":1,"screen":"首頁","hints":["我的"]},{"index":2,"screen":"訂單列表","hints":["訂單列表"]},{"index":3,"screen":"設定","hints":["設定"]},{"index":4,"screen":"探索屏","hints":[],"kind":"explore"}]}'
].join("\n");

test("android adherence: OCR 事后核对命中/未命中/探索", { skip: sqliteSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aos-android-adh-"));
  const dbPath = path.join(dir, "data_engine.db");
  makeDb(dbPath, "trace-adh");

  const result = await computeAndroidScriptAdherence({
    dbPath,
    traceId: "trace-adh",
    taskDesc: TASK_WITH_PLAN
  });
  assert.ok(result);
  assert.equal(result.degraded, null);
  assert.equal(result.steps, 2);
  assert.deepEqual(result.start, {
    screen: "首頁",
    hints: ["首頁"],
    status: "matched"
  });
  assert.equal(result.adherence.checkable, 3);
  assert.equal(result.adherence.satisfied, 2);
  assert.equal(result.adherence.unchecked, 0);
  assert.equal(result.adherence.unresolved.length, 1);
  assert.equal(result.adherence.unresolved[0].screen, "設定");
  assert.deepEqual(result.adherence.deferred, { total: 1, reached: 0 });
});

test("android adherence: 缺 DB 显式降级，不伪造命中", { skip: sqliteSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aos-android-adh-"));
  const result = await computeAndroidScriptAdherence({
    dbPath: path.join(dir, "missing.db"),
    traceId: "trace-adh",
    taskDesc: TASK_WITH_PLAN
  });
  assert.ok(result);
  assert.equal(result.degraded, "observations-unavailable");
  assert.equal(result.steps, 0);
  assert.equal(result.start.status, "unchecked");
  assert.equal(result.adherence.unresolved.length, 3);
  assert.equal(result.adherence.satisfied, 0);
});

test("android adherence: 起始屏不符标 unmatched；无 AOS-EXPECT 返回 null", { skip: sqliteSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aos-android-adh-"));
  const dbPath = path.join(dir, "data_engine.db");
  makeDb(dbPath, "trace-adh");
  const mismatched = TASK_WITH_PLAN.replace('"hints":["首頁"]', '"hints":["不存在"]');
  const result = await computeAndroidScriptAdherence({
    dbPath,
    traceId: "trace-adh",
    taskDesc: mismatched
  });
  assert.ok(result);
  assert.equal(result.start.status, "unmatched");
  assert.equal(
    await computeAndroidScriptAdherence({
      dbPath,
      traceId: "trace-adh",
      taskDesc: "没有脚本断言的普通任务"
    }),
    null
  );
});

test("android adherence: OCR 为空时用 UI tree 文本兜底", { skip: sqliteSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "aos-android-adh-"));
  const dbPath = path.join(dir, "data_engine.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE steps (
    step_id TEXT PRIMARY KEY,
    session_id TEXT,
    step_number INTEGER,
    pre_image_name TEXT,
    post_image_name TEXT,
    action_taken TEXT
  )`);
  db.exec(`CREATE TABLE images (image_name TEXT PRIMARY KEY, ocr_result TEXT, ui_tree TEXT)`);
  db.prepare(
    "INSERT INTO steps (step_id, session_id, step_number, pre_image_name, post_image_name, action_taken) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("s1", "trace-tree", 1, "img1", "img2", JSON.stringify({ action: "tap" }));
  const insert = db.prepare("INSERT INTO images (image_name, ocr_result, ui_tree) VALUES (?, ?, ?)");
  insert.run(
    "img1",
    null,
    JSON.stringify([{ text: "首页" }, { "content-desc": "登录" }])
  );
  insert.run(
    "img2",
    null,
    JSON.stringify([{ text: "我的" }, { accessibilityText: "设置" }])
  );
  db.close();
  const plan =
    '【AOS-EXPECT】{"start":{"screen":"首页","hints":["首页"]},"steps":[{"index":1,"screen":"首页","hints":["我的","设置"]}]}';

  const result = await computeAndroidScriptAdherence({
    dbPath,
    traceId: "trace-tree",
    taskDesc: plan
  });
  assert.ok(result);
  assert.equal(result.degraded, null);
  assert.equal(result.start.status, "matched");
  assert.equal(result.adherence.checkable, 1);
  assert.equal(result.adherence.satisfied, 1);
  assert.equal(result.adherence.unresolved.length, 0);
});

test("task-result: adherence 明细 checkable/satisfied/unchecked 可读", () => {
  const summary = parseTestSummary({
    adherence: {
      checkable: 3,
      satisfied: 2,
      unchecked: 1,
      unresolved: [{ index: 3 }],
      deferred: { total: 1, reached: 0 }
    }
  });
  assert.ok(summary);
  assert.equal(summary.adherence.checkable, 3);
  assert.equal(summary.adherence.satisfied, 2);
  assert.equal(summary.adherence.unchecked, 1);
  assert.equal(summary.adherence.unresolved, 1);
});
