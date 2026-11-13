import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { probeCenterLlm } from "../dist/llm/center.js";
import { TaskProgressReporter } from "../dist/runner/progress.js";
import { baseConfig, makeTempProject } from "./helpers.js";

async function taskFixture() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: dir, name: "progress" });
  const task = await store.createRegressionTask({
    rootPath: dir,
    refs: [{ caseSetId: "set-1", featureKey: "feature-1" }],
    platforms: ["android"],
    baseline: "latest"
  });
  return { dir, store, task };
}

test("TaskProgressReporter: persists monotonic progress snapshots", async () => {
  const { dir, store, task } = await taskFixture();
  const reporter = new TaskProgressReporter({ store, project: { rootDir: dir } }, task);
  await reporter.report("preflight", 5, { message: "环境预检" });
  await reporter.report("acting", 50, { caseId: "case-1", message: "执行用例" });
  await reporter.report("acting", 30, { caseId: "case-1", message: "不应倒退" });
  const saved = await store.getRegressionTask(dir, task.id);
  assert.equal(saved.progress.seq, 3);
  assert.equal(saved.progress.percent, 50);
  assert.equal(saved.progress.message, "不应倒退");
  assert.equal(saved.progress.caseId, "case-1");
});

test("TaskProgressReporter: first report sets startedAt; done sets finishedAt", async () => {
  const { dir, store, task } = await taskFixture();
  const reporter = new TaskProgressReporter({ store, project: { rootDir: dir } }, task);
  await reporter.report("preflight", 5);
  await reporter.report("done", 100);
  const saved = await store.getRegressionTask(dir, task.id);
  assert.ok(saved.startedAt, "first progress writes test start time");
  assert.ok(saved.finishedAt, "done writes test end time");
  assert.equal(saved.startedAt, reporter.startedAtIso());
  assert.ok(saved.finishedAt >= saved.startedAt);
});

test("TaskProgressReporter: center failure does not throw", async () => {
  const { dir, task } = await taskFixture();
  const store = {
    updateRegressionTask: async () => {
      throw new Error("center down");
    }
  };
  const reporter = new TaskProgressReporter({ store, project: { rootDir: dir } }, task);
  await reporter.report("preflight", 5);
});

test("probeCenterLlm: success and connection failure are explicit", async () => {
  const entry = {
    provider: "custom",
    model: "deepseek-flash",
    baseUrl: "http://192.168.3.91:8765/proxy",
    apiKey: "runner-token"
  };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    assert.equal(await probeCenterLlm(entry), null);

    globalThis.fetch = async () => {
      throw new Error("Connection error.");
    };
    assert.match(await probeCenterLlm(entry), /Connection error/);

    assert.match(
      await probeCenterLlm({ ...entry, baseUrl: null }),
      /baseUrl/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
