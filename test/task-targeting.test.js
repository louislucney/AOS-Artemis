import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  return { store, pool };
}

const REFS = [{ caseSetId: "cs-1", featureKey: "f-1" }];

function taskInput(overrides = {}) {
  return {
    rootPath: "/w/a",
    refs: REFS,
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli",
    ...overrides
  };
}

test("定向任务只被目标主机领取；非目标主机领不到", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(taskInput({ targetHostId: "h-b" }));

    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/a",
        runnerId: "r-a",
        hostId: "h-a",
        instanceId: "i-a",
        platforms: ["android"],
        capabilities: ["android"]
      }),
      null,
      "非目标主机领不到"
    );

    const claimed = await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-b",
      hostId: "h-b",
      instanceId: "i-b",
      platforms: ["android"],
      capabilities: ["android"]
    });
    assert.ok(claimed, "目标主机可领");
    assert.equal(claimed.id, task.id);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimedHostId, "h-b");
    assert.equal(claimed.claimedInstanceId, "i-b");
  }
});

test("iOS 任务不会被缺 ios 能力主机领取；具备 ios-simulator 可领", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(taskInput({ platforms: ["ios"] }));

    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/a",
        runnerId: "r-win",
        hostId: "h-win",
        instanceId: "i-win",
        platforms: ["ios"],
        capabilities: ["android"]
      }),
      null,
      "android-only 能力领不到 ios 任务"
    );
    assert.equal((await store.getRegressionTask("/w/a", task.id)).status, "pending");

    const claimed = await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-mac",
      hostId: "h-mac",
      instanceId: "i-mac",
      platforms: ["ios"],
      capabilities: ["ios-simulator", "android"]
    });
    assert.ok(claimed, "具备 ios-simulator 可领");
    assert.equal(claimed.id, task.id);
  }
});

test("claim 不增加 attempts；beginExecution 才 +1 并置 running/startedAt", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(taskInput());

    const claimed = await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-b",
      hostId: "h-b",
      instanceId: "i-b",
      platforms: ["android"],
      capabilities: ["android"]
    });
    assert.ok(claimed);
    assert.equal(claimed.attempts, 0, "claim 不增加 attempts");

    const running = await store.beginExecution({
      rootPath: "/w/a",
      taskId: claimed.id,
      runnerId: "r-b",
      instanceId: "i-b"
    });
    assert.ok(running, "beginExecution 成功");
    assert.equal(running.status, "running");
    assert.equal(running.attempts, 1, "beginExecution 才 +1");
    assert.ok(running.startedAt, "写 startedAt");
    assert.equal(running.claimedBy, "r-b", "保留领取归因");

    const reread = await store.getRegressionTask("/w/a", task.id);
    assert.equal(reread.status, "running");
    assert.equal(reread.attempts, 1);
    assert.ok(reread.startedAt);
  }
});

test("legacy 任务 targetHostId:null 仍可被任意主机领取", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    await store.createRegressionTask(taskInput());
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-x",
      hostId: "h-x",
      instanceId: "i-x",
      platforms: ["android"],
      capabilities: ["android"]
    });
    assert.ok(claimed, "legacy 任务可领");
    assert.equal(claimed.attempts, 0);
  }
});

test("beginExecution 守卫：非 claimed / instance 不符 → null", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(taskInput());

    assert.equal(
      await store.beginExecution({ rootPath: "/w/a", taskId: task.id, runnerId: "r", instanceId: "i" }),
      null,
      "pending 不能直接 beginExecution"
    );

    await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-a",
      hostId: "h-a",
      instanceId: "i-a",
      platforms: ["android"],
      capabilities: ["android"]
    });
    assert.equal(
      await store.beginExecution({ rootPath: "/w/a", taskId: task.id, runnerId: "r-a", instanceId: "i-b" }),
      null,
      "instance 不符 → null"
    );
    const running = await store.beginExecution({
      rootPath: "/w/a",
      taskId: task.id,
      runnerId: "r-a",
      instanceId: "i-a"
    });
    assert.ok(running, "instance 相符 → running");
    assert.equal(
      await store.beginExecution({ rootPath: "/w/a", taskId: task.id, runnerId: "r-a", instanceId: "i-a" }),
      null,
      "已 running 不复 beginExecution"
    );
  }
});

test("createRegressionTask 落盘新增字段：targetHostId/createdHostId/priority 可读回", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(
      taskInput({ targetHostId: "h-b", createdHostId: "h-a", priority: 7 })
    );
    assert.equal(task.targetHostId, "h-b");
    assert.equal(task.createdHostId, "h-a");
    assert.equal(task.priority, 7);
    assert.equal(task.claimedHostId, null);
    assert.equal(task.claimedInstanceId, null);
    assert.equal(task.lastProgressAt, null);
    assert.equal(task.startedAt, null);
    const reread = await store.getRegressionTask("/w/a", task.id);
    assert.equal(reread.targetHostId, "h-b");
    assert.equal(reread.createdHostId, "h-a");
    assert.equal(reread.priority, 7);
  }
});

test("部分领取：capabilities 只覆盖交集端（android 能力可领 dual 任务的 android 部分）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const dual = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/a",
      runnerId: "r-android",
      hostId: "h-a",
      instanceId: "i-a",
      platforms: ["android"],
      capabilities: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.ok(claimed, "android 能力可部分领取 android 端");
    assert.equal(claimed.id, dual.id);
    assert.equal(claimed.status, "claimed");
  }
});

test("能力门禁 fail-closed：capabilities 空/缺失 → iOS 任务领不到", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/a", name: "a" });
    const task = await store.createRegressionTask(taskInput({ platforms: ["ios"] }));
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/a",
        runnerId: "r-x",
        hostId: "h-x",
        instanceId: "i-x",
        platforms: ["ios"],
        capabilities: []
      }),
      null,
      "空 capabilities → fail-closed"
    );
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/a",
        runnerId: "r-x",
        hostId: "h-x",
        instanceId: "i-x",
        platforms: ["ios"]
      }),
      null,
      "缺 capabilities → fail-closed"
    );
    assert.equal((await store.getRegressionTask("/w/a", task.id)).status, "pending");
  }
});
