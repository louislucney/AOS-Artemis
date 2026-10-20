import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { scanVisionHealth } from "../dist/ios/vision-health.js";
import { makeTempDir } from "./helpers.js";

function writeRun(root, name, payload) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (payload !== null) fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(payload), "utf-8");
}

test("vision health: scans recent iOS traces and groups degradation reasons", () => {
  const root = makeTempDir("aos-vision-health-");
  writeRun(root, "ios-a", {
    trace_id: "ios-a",
    model: "deepseek-flash",
    status: "completed",
    started_at: "2026-10-20T10:00:00.000Z",
    vision_degraded: "多模态决策调用失败：LLM 响应缺少 choices[0].message.content"
  });
  writeRun(root, "ios-b", {
    trace_id: "ios-b",
    model: "deepseek-flash",
    status: "completed",
    started_at: "2026-10-20T11:00:00.000Z"
  });
  writeRun(root, "ios-c", null);

  const health = scanVisionHealth(root, { limit: 50, recentLimit: 5 });
  assert.equal(health.checked, 2);
  assert.equal(health.degraded, 1);
  assert.deepEqual(health.byReason, [
    { reason: "多模态决策调用失败：LLM 响应缺少 choices[0].message.content", count: 1 }
  ]);
  assert.equal(health.recent[0].traceId, "ios-a");
  assert.equal(health.recent[0].model, "deepseek-flash");
});

test("vision health: missing traces directory is empty, not an error", () => {
  const health = scanVisionHealth(path.join(makeTempDir("aos-vision-missing-"), "nope"));
  assert.equal(health.checked, 0);
  assert.equal(health.degraded, 0);
  assert.deepEqual(health.recent, []);
});
