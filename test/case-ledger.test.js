import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { findGeneratedCaseId } from "../dist/figma/case-index.js";
import { generateTestCases } from "../dist/figma/test-gen.js";
import { aosTasks } from "../dist/tools/llm.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function minimalGraph() {
  return {
    screens: [
      { id: "s1", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] },
      { id: "s2", name: "Checkout", suggestedRoute: "/checkout", childNames: [], textHints: [] }
    ],
    edges: [
      {
        from: { id: "s1", name: "Home" },
        to: { id: "s2", name: "Checkout" },
        element: { id: "e1", name: "CTA", type: "INSTANCE" },
        textHints: ["Buy now"],
        trigger: "ON_CLICK",
        actionType: "NODE"
      }
    ],
    entryScreens: ["Home"],
    unresolvedDestinations: []
  };
}

test("generateTestCases: ids are stable across runs and distinct per case", () => {
  const first = generateTestCases(minimalGraph());
  const second = generateTestCases(minimalGraph());
  assert.equal(first.length, 1);
  assert.match(first[0].id, /^case-[0-9a-f]{12}$/);
  assert.deepEqual(
    first.map((entry) => entry.id),
    second.map((entry) => entry.id)
  );

  const renamed = minimalGraph();
  renamed.edges[0].to = { id: "s3", name: "Success" };
  renamed.screens.push({
    id: "s3",
    name: "Success",
    suggestedRoute: "/success",
    childNames: [],
    textHints: []
  });
  assert.notEqual(generateTestCases(renamed)[0].id, first[0].id);
});

test("findGeneratedCaseId: exact taskDesc match, null otherwise", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: false }) });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "tests.json"),
    JSON.stringify({ flows: [{ id: "case-aaaaaaaaaaaa", taskDesc: "do a thing" }] })
  );

  assert.equal(findGeneratedCaseId(runtime.configDirAbs, "do a thing"), "case-aaaaaaaaaaaa");
  assert.equal(findGeneratedCaseId(runtime.configDirAbs, "do a thing "), null);
  assert.equal(findGeneratedCaseId(runtime.configDirAbs, null), null);
  assert.equal(findGeneratedCaseId(path.join(runtime.configDirAbs, "nope"), "do a thing"), null);
});

test("recordTaskResult: matched caseId, terminal error rows, local trace fallback", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    store
  });
  const designDir = path.join(runtime.configDirAbs, "design");
  fs.mkdirSync(designDir, { recursive: true });
  const taskDesc = "【设计流程端到端验证】Home → Checkout";
  fs.writeFileSync(
    path.join(designDir, "tests.json"),
    JSON.stringify({ flows: [{ id: "case-1234567890ab", taskDesc }] })
  );

  await runtime.recordTaskResult({ isError: false, traceId: "trace-1", model: "Flash", taskDesc });
  let tasks = await store.listTasks(dir, 10);
  const submitted = tasks.find((task) => task.traceId === "trace-1");
  assert.equal(submitted.caseId, "case-1234567890ab");
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.profile, null);
  assert.equal(submitted.finishedAt, null);

  await runtime.recordTaskResult({ isError: true, taskDesc });
  tasks = await store.listTasks(dir, 10);
  const errored = tasks.find((task) => task.status === "failed" && task.taskDesc === taskDesc);
  assert.ok(errored);
  assert.match(errored.traceId, /^local-/);
  assert.ok(errored.finishedAt);
  assert.equal(errored.caseId, "case-1234567890ab");

  const pending = await store.listPendingTasks(dir, 10);
  assert.deepEqual(
    pending.map((task) => task.traceId),
    ["trace-1"]
  );
});

test("aos_tasks: exposes case_id from the ledger", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    store
  });
  await runtime.recordTaskSubmission({ traceId: "trace-9", caseId: "case-feedfacecafe" });

  const payload = parseToolResult(await aosTasks(runtime, { sync: false }));
  assert.equal(payload.tasks[0].case_id, "case-feedfacecafe");
});
