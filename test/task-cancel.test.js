import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

async function stores() {
  return [new MemoryStore(), await makePgStore()];
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

test("pending 取消 → cancelled + 元数据；重复取消幂等不覆盖", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const task = await store.createRegressionTask(taskInput("/w/p1"));
    const first = await store.cancelRegressionTask({
      rootPath: "/w/p1",
      taskId: task.id,
      source: "local-cli",
      actor: "louis",
      actorHostId: "h-a",
      note: "手动取消",
      at: "2026-10-21T08:00:00.000Z"
    });
    assert.equal(first.status, "cancelled");
    assert.equal(first.cancelSource, "local-cli");
    assert.equal(first.cancelledBy, "louis");
    assert.equal(first.cancelledHostId, "h-a");
    assert.equal(first.cancelNote, "手动取消");
    assert.equal(first.cancelledAt, "2026-10-21T08:00:00.000Z");
    assert.equal(first.cancelRequestedAt, "2026-10-21T08:00:00.000Z");

    const again = await store.cancelRegressionTask({
      rootPath: "/w/p1",
      taskId: task.id,
      source: "panel",
      actor: "panel",
      actorHostId: "h-b",
      note: "重复取消",
      at: "2026-10-21T09:00:00.000Z"
    });
    assert.equal(again.status, "cancelled");
    assert.equal(again.cancelledBy, "louis", "首次取消人不被覆盖");
    assert.equal(again.cancelSource, "local-cli");
    assert.equal(again.cancelNote, "手动取消");
    assert.equal(again.cancelledAt, first.cancelledAt);
    assert.equal(again.cancelRequestedAt, first.cancelRequestedAt);

    const listed = await store.listRegressionTasks("/w/p1");
    assert.equal(listed[0].status, "cancelled");
    assert.equal(listed[0].cancelledBy, "louis");
  }
});

test("claimed/running 取消 → stopping + 元数据（无 cancelledAt）；runner 确认 → cancelled", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
    const claimedTask = await store.createRegressionTask(taskInput("/w/p2"));
    await store.claimRegressionTask({
      rootPath: "/w/p2",
      runnerId: "runner-1",
      platforms: ["android"],
      capabilities: ["android"],
      instanceId: "inst-1"
    });
    const requested = await store.cancelRegressionTask({
      rootPath: "/w/p2",
      taskId: claimedTask.id,
      source: "panel",
      actor: "panel",
      actorHostId: "h-a",
      note: "面板取消",
      at: "2026-10-21T08:10:00.000Z"
    });
    assert.equal(requested.status, "stopping");
    assert.equal(requested.cancelSource, "panel");
    assert.equal(requested.cancelledBy, "panel");
    assert.equal(requested.cancelledHostId, "h-a");
    assert.equal(requested.cancelNote, "面板取消");
    assert.equal(requested.cancelRequestedAt, "2026-10-21T08:10:00.000Z");
    assert.equal(requested.cancelledAt, null, "执行中取消先请求，不写完成时间");

    const repeat = await store.cancelRegressionTask({
      rootPath: "/w/p2",
      taskId: claimedTask.id,
      source: "runner",
      actor: "runner",
      actorHostId: "h-a",
      note: "覆盖尝试",
      at: "2026-10-21T08:20:00.000Z"
    });
    assert.equal(repeat.status, "stopping");
    assert.equal(repeat.cancelSource, "panel", "先写先赢");
    assert.equal(repeat.cancelNote, "面板取消");

    const acked = await store.ackCancellation({
      rootPath: "/w/p2",
      taskId: claimedTask.id,
      at: "2026-10-21T08:30:00.000Z"
    });
    assert.equal(acked.status, "cancelled");
    assert.equal(acked.cancelledBy, "panel", "取消元数据保留");
    assert.equal(acked.cancelSource, "panel");
    assert.equal(acked.cancelRequestedAt, "2026-10-21T08:10:00.000Z");
    assert.equal(acked.cancelledAt, "2026-10-21T08:30:00.000Z");

    const runningTask = await store.createRegressionTask(taskInput("/w/p2"));
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p2",
      runnerId: "runner-1",
      platforms: ["android"],
      capabilities: ["android"],
      instanceId: "inst-2"
    });
    assert.equal(claimed.id, runningTask.id);
    await store.beginExecution({
      rootPath: "/w/p2",
      taskId: runningTask.id,
      runnerId: "runner-1",
      instanceId: "inst-2",
      at: "2026-10-21T08:40:00.000Z"
    });
    const runningCancel = await store.cancelRegressionTask({
      rootPath: "/w/p2",
      taskId: runningTask.id,
      source: "local-mcp",
      actor: "agent",
      actorHostId: null,
      at: "2026-10-21T08:41:00.000Z"
    });
    assert.equal(runningCancel.status, "stopping");
    assert.equal(runningCancel.cancelledAt, null);
  }
});

test("stopped 旧行读作 cancelled（legacy 元数据，不臆造取消时间）", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p3", name: "p3" });
    const task = await store.createRegressionTask(taskInput("/w/p3"));
    await store.claimRegressionTask({
      rootPath: "/w/p3",
      runnerId: "runner-1",
      platforms: ["android"],
      capabilities: ["android"],
      instanceId: "inst-legacy"
    });
    await store.beginExecution({
      rootPath: "/w/p3",
      taskId: task.id,
      runnerId: "runner-1",
      instanceId: "inst-legacy",
      at: "2026-10-21T07:00:00.000Z"
    });
    await store.updateRegressionTask("/w/p3", task.id, {
      status: "stopped",
      claimedAt: "2026-10-21T07:00:00.000Z"
    });
    const [listed] = await store.listRegressionTasks("/w/p3");
    assert.equal(listed.status, "cancelled", "旧 stopped 对外读作 cancelled");
    assert.equal(listed.cancelSource, "panel");
    assert.equal(listed.cancelNote, "legacy stopped");
    assert.equal(listed.cancelledAt, null, "有 startedAt 也不臆造取消时间");

    const fetched = await store.getRegressionTask("/w/p3", task.id);
    assert.equal(fetched.status, "cancelled");
    const noop = await store.cancelRegressionTask({
      rootPath: "/w/p3",
      taskId: task.id,
      source: "local-cli",
      actor: "louis",
      actorHostId: "h-a",
      note: "补取消"
    });
    assert.equal(noop.status, "cancelled");
    assert.equal(noop.cancelSource, "panel", "历史行不覆盖来源");
    assert.equal(noop.cancelNote, "legacy stopped");
  }
});

test("cancelled 终态再取消保持原状；未知任务返回 null", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p4", name: "p4" });
    const task = await store.createRegressionTask(taskInput("/w/p4"));
    await store.cancelRegressionTask({
      rootPath: "/w/p4",
      taskId: task.id,
      source: "admin",
      actor: "ops",
      actorHostId: "h-ops",
      at: "2026-10-21T06:00:00.000Z"
    });
    const again = await store.cancelRegressionTask({
      rootPath: "/w/p4",
      taskId: task.id,
      source: "local-cli",
      actor: "louis",
      actorHostId: "h-a"
    });
    assert.equal(again.status, "cancelled");
    assert.equal(again.cancelledBy, "ops");
    assert.equal(await store.cancelRegressionTask({
      rootPath: "/w/p4",
      taskId: "task-missing",
      source: "local-cli",
      actor: "louis",
      actorHostId: "h-a"
    }), null);
  }
});

test("审计写入 actor/actor_host_id/channel 并可读回", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p5", name: "p5" });
    await store.recordAudit("/w/p5", {
      domain: "suite",
      action: "action.tasks.cancel",
      result: "ok",
      summary: "取消任务",
      refs: { taskId: "t-1" },
      actor: "louis",
      actorHostId: "h-a",
      channel: "cli",
      at: "2026-10-21T05:00:00.000Z"
    });
    const [event] = await store.listAudit("/w/p5", { domain: "suite" });
    assert.equal(event.actor, "louis");
    assert.equal(event.actorHostId, "h-a");
    assert.equal(event.channel, "cli");
  }
});

test("stopping 不被失联领取回收为 pending（保留给离线取消确认）", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p6", name: "p6" });
    const task = await store.createRegressionTask(taskInput("/w/p6"));
    await store.claimRegressionTask({
      rootPath: "/w/p6",
      runnerId: "runner-offline",
      platforms: ["android"],
      capabilities: ["android"],
      instanceId: "inst-offline"
    });
    await store.cancelRegressionTask({
      rootPath: "/w/p6",
      taskId: task.id,
      source: "panel",
      actor: "panel",
      actorHostId: "h-a",
      note: "离线取消"
    });
    const reclaimed = await store.releaseStaleClaims({
      rootPath: "/w/p6",
      offlineBefore: "2030-01-01T00:00:00.000Z",
      claimedBefore: "2030-01-01T00:00:00.000Z"
    });
    assert.equal(reclaimed, 0, "stopping 不在回收范围");
    const after = await store.getRegressionTask("/w/p6", task.id);
    assert.equal(after.status, "stopping");
    assert.equal(after.cancelNote, "离线取消");
    assert.equal(after.cancelRequestedAt !== null, true);
  }
});

test("ackCancellation 幂等：重复确认不改首次 cancelledAt/元数据", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p7", name: "p7" });
    const task = await store.createRegressionTask(taskInput("/w/p7"));
    await store.claimRegressionTask({
      rootPath: "/w/p7",
      runnerId: "runner-1",
      platforms: ["android"],
      capabilities: ["android"],
      instanceId: "inst-ack"
    });
    await store.cancelRegressionTask({
      rootPath: "/w/p7",
      taskId: task.id,
      source: "local-cli",
      actor: "louis",
      actorHostId: "h-a",
      note: "确认幂等",
      at: "2026-10-21T01:00:00.000Z"
    });
    const first = await store.ackCancellation({
      rootPath: "/w/p7",
      taskId: task.id,
      at: "2026-10-21T01:10:00.000Z"
    });
    assert.equal(first.status, "cancelled");
    assert.equal(first.cancelledAt, "2026-10-21T01:10:00.000Z");
    const again = await store.ackCancellation({
      rootPath: "/w/p7",
      taskId: task.id,
      at: "2026-10-21T02:00:00.000Z"
    });
    assert.equal(again.status, "cancelled");
    assert.equal(again.cancelledAt, first.cancelledAt);
    assert.equal(again.cancelRequestedAt, "2026-10-21T01:00:00.000Z");
    assert.equal(again.cancelNote, "确认幂等");
  }
});

test("FileStore: ackCancellation 落盘并在重启后保留", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-cancel-ack-"));
  const rootPath = join(home, "proj");
  await mkdir(rootPath, { recursive: true });
  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath, name: "p" });
  const task = await store.createRegressionTask(taskInput(rootPath));
  await store.claimRegressionTask({
    rootPath,
    runnerId: "runner-file",
    platforms: ["android"],
    capabilities: ["android"],
    instanceId: "inst-file"
  });
  await store.cancelRegressionTask({
    rootPath,
    taskId: task.id,
    source: "panel",
    actor: "panel",
    actorHostId: "h-file",
    note: "文件确认",
    at: "2026-10-21T00:00:00.000Z"
  });
  const acked = await store.ackCancellation({
    rootPath,
    taskId: task.id,
    at: "2026-10-21T00:05:00.000Z"
  });
  assert.equal(acked.status, "cancelled");

  const reopened = await FileStore.create({ homeDir: home });
  const after = await reopened.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancelSource, "panel");
  assert.equal(after.cancelledBy, "panel");
  assert.equal(after.cancelNote, "文件确认");
  assert.equal(after.cancelledAt, "2026-10-21T00:05:00.000Z");
  const again = await reopened.ackCancellation({
    rootPath,
    taskId: task.id,
    at: "2026-10-21T00:30:00.000Z"
  });
  assert.equal(again.cancelledAt, "2026-10-21T00:05:00.000Z");
});

test("updateRegressionTask：空 patch 也执行 expectStatuses 守卫", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: "/w/p8", name: "p8" });
    const task = await store.createRegressionTask(taskInput("/w/p8"));
    assert.equal(
      await store.updateRegressionTask("/w/p8", task.id, { expectStatuses: ["pending"] }),
      true
    );
    assert.equal(
      await store.updateRegressionTask("/w/p8", task.id, { expectStatuses: ["claimed"] }),
      false
    );
    assert.equal(
      await store.updateRegressionTask("/w/p8", "task-missing", { expectStatuses: ["pending"] }),
      false
    );
    assert.equal(
      (await store.getRegressionTask("/w/p8", task.id)).status,
      "pending",
      "空 patch 不写状态"
    );
  }
});

test("FileStore: cancelled 与取消元数据落盘并在重启后保留", async () => {
  const home = await mkdtemp(join(tmpdir(), "aos-cancel-"));
  const rootPath = join(home, "proj");
  await mkdir(rootPath, { recursive: true });
  const store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath, name: "p" });
  const task = await store.createRegressionTask(taskInput(rootPath));
  const cancelled = await store.cancelRegressionTask({
    rootPath,
    taskId: task.id,
    source: "local-cli",
    actor: "louis",
    actorHostId: null,
    note: "文件台账取消",
    at: "2026-10-21T04:00:00.000Z"
  });
  assert.equal(cancelled.status, "cancelled");

  const reopened = await FileStore.create({ homeDir: home });
  const after = await reopened.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancelledBy, "louis");
  assert.equal(after.cancelNote, "文件台账取消");
  assert.equal(after.cancelledAt, "2026-10-21T04:00:00.000Z");
});
