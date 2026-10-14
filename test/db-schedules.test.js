import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

function scheduleInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    name: "夜间回归",
    featureKeys: ["f-登录-aaaa1111", "f-下单-bbbb2222"],
    platforms: ["ios", "android"],
    baseline: "latest",
    everyMinutes: 720,
    createdBy: "cli",
    ...overrides
  };
}

test("createSchedule/listSchedules：落库初值 + 新→旧 + limit（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const first = await store.createSchedule(scheduleInput());
    assert.ok(first.id);
    assert.ok(first.projectId);
    assert.equal(first.name, "夜间回归");
    assert.deepEqual(first.featureKeys, ["f-登录-aaaa1111", "f-下单-bbbb2222"]);
    assert.deepEqual(first.platforms, ["ios", "android"]);
    assert.equal(first.baseline, "latest");
    assert.equal(first.everyMinutes, 720);
    assert.equal(first.enabled, true);
    assert.equal(first.lastFiredAt, null);
    assert.equal(first.lastNote, null);
    assert.ok(first.createdAt);
    assert.equal(first.createdBy, "cli");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.createSchedule(scheduleInput({ name: "更晚" }));

    const all = await store.listSchedules("/w/p1");
    assert.deepEqual(
      all.map((entry) => entry.name),
      ["更晚", "夜间回归"],
      "createdAt 新→旧"
    );
    assert.equal((await store.listSchedules("/w/p1", 1)).length, 1);
    assert.deepEqual(await store.listSchedules("/w/p2"), []);
  }
});

test("createSchedule：未注册项目 → 抛错（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await assert.rejects(store.createSchedule(scheduleInput()), /未注册/);
  }
});

test("get/update/delete：键缺省不动 / null 显式置空；删除后再查 null（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const record = await store.createSchedule(scheduleInput());
    const got = await store.getSchedule("/w/p1", record.id);
    assert.equal(got.id, record.id);
    assert.equal(await store.getSchedule("/w/p1", "nope"), null);

    assert.equal(await store.updateSchedule("/w/p1", record.id, { enabled: false }), true);
    const disabled = await store.getSchedule("/w/p1", record.id);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.everyMinutes, 720, "键缺省不动");

    assert.equal(await store.updateSchedule("/w/p1", record.id, { everyMinutes: 60 }), true);
    assert.equal((await store.getSchedule("/w/p1", record.id)).everyMinutes, 60);

    assert.equal(await store.updateSchedule("/w/p1", record.id, { lastNote: "缺 f-x" }), true);
    assert.equal((await store.getSchedule("/w/p1", record.id)).lastNote, "缺 f-x");
    assert.equal(await store.updateSchedule("/w/p1", record.id, { lastNote: null }), true);
    assert.equal((await store.getSchedule("/w/p1", record.id)).lastNote, null, "null 显式置空");

    assert.equal(await store.updateSchedule("/w/p1", "nope", { enabled: true }), false);

    assert.equal(await store.deleteSchedule("/w/p1", record.id), true);
    assert.equal(await store.getSchedule("/w/p1", record.id), null);
    assert.deepEqual(await store.listSchedules("/w/p1"), []);
    assert.equal(await store.deleteSchedule("/w/p1", record.id), false);
  }
});

test("claimScheduleWindow：首次/未到期/边界/disabled/未知（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), await makePgStore()];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const record = await store.createSchedule(scheduleInput());
    const firedAt = "2026-10-14T10:00:00.000Z";

    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p1",
        scheduleId: record.id,
        firedAt,
        cutoff: "2026-10-14T09:59:00.000Z"
      }),
      true,
      "首次触发"
    );
    assert.equal((await store.getSchedule("/w/p1", record.id)).lastFiredAt, firedAt);

    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p1",
        scheduleId: record.id,
        firedAt: "2026-10-14T10:05:00.000Z",
        cutoff: "2026-10-14T09:59:59.999Z"
      }),
      false,
      "未到期"
    );
    assert.equal(
      (await store.getSchedule("/w/p1", record.id)).lastFiredAt,
      firedAt,
      "false 时 last_fired_at 不变"
    );

    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p1",
        scheduleId: record.id,
        firedAt: "2026-10-14T11:00:00.000Z",
        cutoff: firedAt
      }),
      true,
      "恰等于窗口边界 → 触发"
    );

    await store.updateSchedule("/w/p1", record.id, { enabled: false });
    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p1",
        scheduleId: record.id,
        firedAt: "2026-10-14T12:00:00.000Z",
        cutoff: "2026-10-14T11:59:00.000Z"
      }),
      false,
      "disabled 不触发"
    );

    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p1",
        scheduleId: "nope",
        firedAt,
        cutoff: firedAt
      }),
      false
    );
    await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
    assert.equal(
      await store.claimScheduleWindow({
        rootPath: "/w/p2",
        scheduleId: record.id,
        firedAt,
        cutoff: firedAt
      }),
      false,
      "跨项目不触发"
    );
  }
});
