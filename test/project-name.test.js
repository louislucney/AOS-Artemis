import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";

import { PostgresStore } from "../dist/db/postgres.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

test("project name: config project.name wins over directory basename", async () => {
  const dir = makeTempProject({
    config: baseConfig({ project: { name: "mobile-testing" } })
  });
  const store = await makePgStore();
  try {
    await loadTestRuntime(dir, { store });
    const record = await store.getProjectByPath(dir);
    assert.equal(record?.name, "mobile-testing");
  } finally {
    await store.close();
  }
});

test("project name: incidental LLM writes do not overwrite the display name", async () => {
  const dir = makeTempProject({
    config: baseConfig({ project: { name: "mobile-testing" } })
  });
  const store = await makePgStore();
  try {
    await loadTestRuntime(dir, { store });
    await store.upsertLlm(dir, {
      name: "incidental",
      provider: "custom",
      model: "deepseek-chat"
    });
    const record = await store.getProjectByPath(dir);
    assert.equal(record?.name, "mobile-testing");
  } finally {
    await store.close();
  }
});

test("project name: missing config falls back to the directory basename", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = await makePgStore();
  try {
    await loadTestRuntime(dir, { store });
    const record = await store.getProjectByPath(dir);
    assert.equal(record?.name, dir.split("/").pop());
  } finally {
    await store.close();
  }
});
