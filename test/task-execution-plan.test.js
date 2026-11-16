import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildTaskExecutionPlan,
  readTaskExecutionPlan,
  validateTaskExecutionPlan,
  writeTaskExecutionPlan
} from "../dist/figma/task-execution-plan.js";

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
