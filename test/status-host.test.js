import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { aosStatus } from "../dist/tools/llm.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  TEST_HOST_IDENTITY
} from "./helpers.js";

test("aos_status.host 形状", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    store,
    hostIdentity: { ...TEST_HOST_IDENTITY, id: "h1" }
  });

  await store.upsertHost({
    id: "h1",
    hostname: "MacBook-A",
    osPlatform: "darwin",
    kind: "mac",
    clientSeenAt: new Date().toISOString()
  });
  await store.createRegressionTask({
    rootPath: runtime.project.rootDir,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });

  const result = await aosStatus(runtime);
  const payload = parseToolResult(result);
  assert.equal(payload.host.identity.id, "h1");
  assert.equal(typeof payload.host.clientOnline, "boolean");
  assert.equal(typeof payload.host.runnerOnline, "boolean");
  assert.equal(typeof payload.host.clientSessions, "number");
  assert.equal(typeof payload.host.queue.pending, "number");
  assert.equal(payload.host.clientOnline, true);
  assert.equal(payload.host.queue.pending, 1);
});
