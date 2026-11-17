import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTaskExecutionPlan,
  readTaskExecutionPlan,
  validateTaskExecutionPlan,
  writeTaskExecutionPlan,
  writeTaskExecutionPlanForTask
} from "../dist/figma/task-execution-plan.js";
import { pruneJsonSidecars } from "../dist/figma/task-sidecar-retention.js";

test("task execution plan: 写入/读取/平台覆盖校验", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-plan-"));
  try {
    const plan = buildTaskExecutionPlan({
      taskId: "task-1",
      hostId: "h-1",
      platforms: ["ios", "android"],
      env: {},
      createdAt: "2026-11-16T00:00:00.000Z"
    });
    writeTaskExecutionPlan(dir, plan);
    const read = readTaskExecutionPlan(dir, "task-1");
    assert.equal(read?.taskId, "task-1");
    assert.equal(read?.plans.length, 2);
    assert.deepEqual(
      validateTaskExecutionPlan(read, {
        platforms: ["ios", "android"],
        targetHostId: "h-1"
      }),
      []
    );
    const legacyFile = path.join(dir, ".artemis", "design", "task-plans", "legacy.json");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({ schemaVersion: 1, taskId: "legacy", hostId: null, platforms: [], plans: [] })
    );
    assert.deepEqual(readTaskExecutionPlan(dir, "legacy")?.warnings, []);
    assert.deepEqual(
      validateTaskExecutionPlan(read, {
        platforms: ["ios"],
        targetHostId: "h-2"
      }),
      ["plan-host-mismatch"]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("task execution plan: 按任务字段写旁车（供创建入口复用）", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-plan-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const written = writeTaskExecutionPlanForTask(
    dir,
    { id: "task-3", platforms: ["ios", "android"], targetHostId: "host-3" },
    { env: {}, warnings: ["fixture"] }
  );
  assert.equal(written.taskId, "task-3");
  assert.equal(written.hostId, "host-3");
  assert.deepEqual(written.platforms, ["ios", "android"]);
  const read = readTaskExecutionPlan(dir, "task-3");
  assert.deepEqual(read?.warnings, ["fixture"]);
});

test("task execution plan: iOS 标注 ios-llm；截图默认开启，0 关闭", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-plan-engine-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = buildTaskExecutionPlan({
    taskId: "task-engine",
    hostId: null,
    platforms: ["ios", "android"],
    env: {}
  });
  const ios = plan.plans.find((entry) => entry.platform === "ios");
  const android = plan.plans.find((entry) => entry.platform === "android");
  assert.equal(ios?.engine, "ios-llm");
  assert.equal(android?.engine, "proxy");
  assert.equal(ios?.evidence.screenshots, true);

  const off = buildTaskExecutionPlan({
    taskId: "task-engine-off",
    hostId: null,
    platforms: ["ios"],
    env: { AOS_RUNNER_EVIDENCE_SCREENSHOTS: "0" }
  });
  assert.equal(off.plans[0]?.evidence.screenshots, false);
});

test("task sidecar retention: 写新 plan 时按 maxFiles 驱逐旧 plan", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sidecar-wire-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeTaskExecutionPlanForTask(
    dir,
    { id: "task-old", platforms: ["android"], targetHostId: null },
    { env: { AOS_TASK_SIDECAR_MAX_FILES: "100" } }
  );
  const oldFile = path.join(dir, ".artemis", "design", "task-plans", "task-old.json");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(oldFile, old, old);
  writeTaskExecutionPlanForTask(
    dir,
    { id: "task-new", platforms: ["android"], targetHostId: null },
    { env: { AOS_TASK_SIDECAR_MAX_FILES: "1" } }
  );
  assert.equal(fs.existsSync(oldFile), false);
  assert.ok(
    fs.existsSync(path.join(dir, ".artemis", "design", "task-plans", "task-new.json"))
  );
});

test("task sidecar retention: 按年龄/数量清理 json 旁车", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-sidecar-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldFile = path.join(dir, "old.json");
  const newFile = path.join(dir, "new.json");
  const newestFile = path.join(dir, "newest.json");
  fs.writeFileSync(oldFile, "{}");
  fs.writeFileSync(newFile, "{}");
  fs.writeFileSync(newestFile, "{}");
  const old = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(oldFile, old, old);
  fs.utimesSync(newFile, new Date("2026-11-16T00:00:00.000Z"), new Date("2026-11-16T00:00:00.000Z"));
  fs.utimesSync(newestFile, new Date("2026-11-17T00:00:00.000Z"), new Date("2026-11-17T00:00:00.000Z"));

  const removedOld = pruneJsonSidecars(dir, {
    maxAgeDays: 30,
    maxFiles: 100,
    now: Date.parse("2026-11-17T00:00:00.000Z")
  });
  assert.equal(removedOld, 1);
  assert.equal(fs.existsSync(oldFile), false);

  const removedCount = pruneJsonSidecars(dir, {
    maxAgeDays: 0,
    maxFiles: 1,
    now: Date.parse("2026-11-17T00:00:00.000Z")
  });
  assert.equal(removedCount, 1);
  assert.equal(fs.existsSync(newestFile), true);
  assert.equal(fs.existsSync(newFile), false);
});

test("task execution plan: 缺平台时不通过", () => {
  const plan = buildTaskExecutionPlan({
    taskId: "task-2",
    hostId: null,
    platforms: ["ios"],
    env: {}
  });
  assert.deepEqual(
    validateTaskExecutionPlan(plan, {
      platforms: ["ios", "android"],
      targetHostId: null
    }),
    ["plan-missing-platform:android", "plan-view-missing:android"]
  );
});
