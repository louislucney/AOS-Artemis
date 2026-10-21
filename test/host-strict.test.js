import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { hostStrictFrom } from "../dist/host/strict.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { makeTempProject } from "./helpers.js";

const STRICT_ENV = { AOS_HOST_STRICT: "1" };

async function makePgStore(env) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool(), null, env);
  await store.init();
  return store;
}

function taskInput(rootPath) {
  return {
    rootPath,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  };
}

function claimInput(rootPath, overrides = {}) {
  return {
    rootPath,
    runnerId: "r-1",
    platforms: ["android"],
    instanceId: "i-1",
    capabilities: ["android"],
    ...overrides
  };
}

test("hostStrictFrom 只认字面 1/true", () => {
  assert.equal(hostStrictFrom({}), false);
  assert.equal(hostStrictFrom({ AOS_HOST_STRICT: "0" }), false);
  assert.equal(hostStrictFrom({ AOS_HOST_STRICT: "yes" }), false);
  assert.equal(hostStrictFrom({ AOS_HOST_STRICT: "1" }), true);
  assert.equal(hostStrictFrom({ AOS_HOST_STRICT: "true" }), true);
  assert.equal(hostStrictFrom({ AOS_HOST_STRICT: " true " }), true);
});

for (const [name, factory] of [
  ["Memory", () => new MemoryStore(null, STRICT_ENV)],
  ["Postgres", () => makePgStore(STRICT_ENV)]
]) {
  test(`[${name}] strict：claim 缺 hostId → null；带 hostId → claimed`, async () => {
    const store = await factory();
    await store.upsertProject({ rootPath: "/w/app", name: "app" });
    await store.createRegressionTask(taskInput("/w/app"));

    assert.equal(await store.claimRegressionTask(claimInput("/w/app")), null);
    const claimed = await store.claimRegressionTask(claimInput("/w/app", { hostId: "h-1" }));
    assert.ok(claimed);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimedHostId, "h-1");
    await store.close();
  });
}

test("strict 缺省关闭：无 hostId 的旧调用方仍可领取", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/app", name: "app" });
  await store.createRegressionTask(taskInput("/w/app"));
  const claimed = await store.claimRegressionTask(claimInput("/w/app"));
  assert.ok(claimed);
  assert.equal(claimed.claimedHostId, null);
});

test("FileStore 委托 strict 判定", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aos-strict-"));
  const rootPath = path.join(home, "app");
  try {
    const store = await FileStore.create({ homeDir: home, env: STRICT_ENV });
    await store.upsertProject({ rootPath, name: "app" });
    await store.createRegressionTask(taskInput(rootPath));
    assert.equal(await store.claimRegressionTask(claimInput(rootPath)), null);
    const claimed = await store.claimRegressionTask(claimInput(rootPath, { hostId: "h-1" }));
    assert.ok(claimed);
    assert.equal(claimed.claimedHostId, "h-1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function stubRuntime(rootPath, store) {
  return {
    project: { rootDir: rootPath },
    store,
    hostIdentity: null,
    projectSummary: () => null
  };
}

async function seedTask() {
  const dir = makeTempProject();
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: dir, name: "app" });
  const task = await store.createRegressionTask(taskInput(dir));
  return { dir, store, task };
}

function runWith(runtime, argv, env) {
  const logs = [];
  const errors = [];
  return runSuiteCommand(argv, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    env
  }).then((code) => ({ code, logs, errors }));
}

test("strict + suite run --task 无本机身份 → exit 2", async () => {
  const { dir, store, task } = await seedTask();
  const runtime = stubRuntime(dir, store);
  const { code, errors } = await runWith(
    runtime,
    ["run", "--task", task.id, "--device", "emulator-5554"],
    STRICT_ENV
  );
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /AOS_HOST_STRICT=1：本机主机身份未知/);
  assert.equal((await store.getRegressionTask(dir, task.id)).status, "pending");
});

test("strict + suite task cancel 无本机身份 → exit 2", async () => {
  const { dir, store, task } = await seedTask();
  const runtime = stubRuntime(dir, store);
  const { code, errors } = await runWith(runtime, ["task", "cancel", task.id], STRICT_ENV);
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /AOS_HOST_STRICT=1：本机主机身份未知/);
  assert.equal((await store.getRegressionTask(dir, task.id)).status, "pending");
});

test("strict 缺省时无本机身份的本地命令保持旧行为", async () => {
  const { dir, store, task } = await seedTask();
  const runtime = stubRuntime(dir, store);
  const { code, errors } = await runWith(runtime, ["task", "cancel", task.id], {});
  assert.equal(code, 0, errors.join("\n"));
  assert.equal((await store.getRegressionTask(dir, task.id)).status, "cancelled");
});
