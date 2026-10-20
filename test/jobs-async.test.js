import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { jobStatus, startAsyncJob } from "../dist/jobs/async.js";
import { makeTempDir } from "./helpers.js";

async function makeRuntime() {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-jobs-");
  await store.upsertProject({ rootPath: dir, name: "demo" });
  return { runtime: { project: { rootDir: dir }, store, storeNote: null }, dir, store };
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function waitForJob(runtime, jobId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await jobStatus(runtime, jobId);
    const payload = JSON.parse(result.content[0].text);
    if (payload.status !== "running" || Date.now() >= deadline) return payload;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("async job: 立即返回 jobId，完成后可查结果与事件", async () => {
  const { runtime } = await makeRuntime();
  const tool = {
    name: "fake_tool",
    description: "",
    schema: null,
    handler: async () => textResult({ ok: true, value: 42 })
  };
  const started = JSON.parse(
    (await startAsyncJob(runtime, tool, { async: true, input: "x" })).content[0].text
  );
  assert.equal(started.async, true);
  assert.equal(started.status, "running");
  assert.match(started.jobId, /^job-/);

  const done = await waitForJob(runtime, started.jobId);
  assert.equal(done.status, "passed");
  assert.equal(done.tool, "fake_tool");
  assert.ok(done.resultPath.endsWith(`${started.jobId}.json`));
  assert.equal(fs.existsSync(done.resultPath), true);
  assert.equal(done.result.result.content[0].text.includes('"value":42'), true);
  assert.deepEqual(
    done.events.map((event) => event.type),
    ["run.started", "run.finished"]
  );
});

test("async job: 抛错记为 error，未知 job 显式 404", async () => {
  const { runtime } = await makeRuntime();
  const tool = {
    name: "boom_tool",
    description: "",
    schema: null,
    handler: async () => {
      throw new Error("boom");
    }
  };
  const started = JSON.parse((await startAsyncJob(runtime, tool, { async: true })).content[0].text);
  const done = await waitForJob(runtime, started.jobId);
  assert.equal(done.status, "error");

  const missing = JSON.parse((await jobStatus(runtime, "job-missing")).content[0].text);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "job-not-found");
});
