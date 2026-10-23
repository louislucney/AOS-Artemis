import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { fireDueSchedules } from "../dist/runner/schedules.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const NOON = "2026-10-14T12:00:00.000Z";

async function setup() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { store, rootPath: runtime.project.rootDir };
}

async function seedCaseSet(store, rootPath, { key = "f-1", suffix = "一", createdAt } = {}) {
  const set = await store.recordCaseSet({
    rootPath,
    source: "pen:a.pen",
    basename: "tests",
    ...(createdAt === undefined ? {} : { createdAt }),
    features: [
      {
        key,
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: `/x/${suffix}.json`,
        mdPath: `/x/${suffix}.md`,
        xlsxPath: `/x/${suffix}.xlsx`
      }
    ]
  });
  return set;
}

function makeIo() {
  const logs = [];
  const errors = [];
  return {
    io: { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) },
    logs,
    errors
  };
}

async function addSchedule(store, rootPath, overrides = {}) {
  return store.createSchedule({
    rootPath,
    name: "夜间回归",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 60,
    createdBy: "cli",
    ...overrides
  });
}

test("fireDueSchedules: 首次到期 → 建任务（最新份引用）+ 推进窗口 + lastNote null", async () => {
  const { store, rootPath } = await setup();
  const set = await seedCaseSet(store, rootPath);
  const schedule = await addSchedule(store, rootPath, { baseline: "none" });
  const { io, logs } = makeIo();

  const fired = await fireDueSchedules({ store, rootPath, now: () => NOW, io });
  assert.equal(fired, 1);
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].refs, [{ caseSetId: set.id, featureKey: "f-1" }]);
  assert.equal(tasks[0].createdBy, "schedule:夜间回归");
  assert.deepEqual(tasks[0].platforms, ["android"]);
  assert.equal(tasks[0].baseline, "none");
  assert.equal(tasks[0].status, "pending");
  const after = await store.getSchedule(rootPath, schedule.id);
  assert.equal(after.lastFiredAt, NOON);
  assert.equal(after.lastNote, null);
  assert.ok(logs.some((line) => line.includes("触发 夜间回归")));
});

test("fireDueSchedules: 未到期/窗口边界/disabled 语义", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath);
  const schedule = await addSchedule(store, rootPath);
  const { io } = makeIo();

  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 1);
  assert.equal(
    await fireDueSchedules({ store, rootPath, now: () => NOW + 30 * 60_000, io }),
    0,
    "未到期不触发"
  );
  assert.equal(
    await fireDueSchedules({ store, rootPath, now: () => NOW + 60 * 60_000, io }),
    1,
    "恰等于窗口边界 → 触发"
  );
  await store.updateSchedule(rootPath, schedule.id, { enabled: false });
  assert.equal(
    await fireDueSchedules({ store, rootPath, now: () => NOW + 10 * 60 * 60_000, io }),
    0,
    "disabled 不触发"
  );
  assert.equal((await store.listRegressionTasks(rootPath)).length, 2);
});

test("fireDueSchedules: 引用时效——触发前写入新份 → 用最新份；旧份消失不炸", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath, { suffix: "旧" });
  await addSchedule(store, rootPath);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await seedCaseSet(store, rootPath, { suffix: "新" });
  const { io } = makeIo();

  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 1);
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks[0].refs[0].caseSetId, newer.id, "指向新份");
});

test("fireDueSchedules: 部分缺失子集建任务 + lastNote 缺项；全缺失跳过仍推进窗口", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath, { key: "f-1" });
  const partial = await addSchedule(store, rootPath, {
    name: "部分",
    featureKeys: ["f-1", "f-2"]
  });
  const { io, errors } = makeIo();
  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 1);
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks.length, 1);
  assert.deepEqual(
    tasks[0].refs.map((ref) => ref.featureKey),
    ["f-1"]
  );
  assert.match((await store.getSchedule(rootPath, partial.id)).lastNote, /缺/);
  assert.ok(errors.some((line) => line.includes("f-2")));

  const allMissing = await addSchedule(store, rootPath, {
    name: "全缺",
    featureKeys: ["f-9"]
  });
  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 0);
  const missing = await store.getSchedule(rootPath, allMissing.id);
  assert.equal(missing.lastNote, "引用用例集均不可用");
  assert.equal(missing.lastFiredAt, NOON, "窗口仍推进");
  assert.equal((await store.listRegressionTasks(rootPath)).length, 1, "不建任务");
});

test("fireDueSchedules: 窗口被抢先（另一 runner 已领）→ 不重复消费", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath);
  const schedule = await addSchedule(store, rootPath);
  const { io } = makeIo();
  await store.claimScheduleWindow({
    rootPath,
    scheduleId: schedule.id,
    firedAt: NOON,
    cutoff: NOON
  });

  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 0);
  assert.equal((await store.listRegressionTasks(rootPath)).length, 0);
});

test("fireDueSchedules: 用例集读取失败 → 不消费窗口（lastFiredAt 不变）", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath);
  const schedule = await addSchedule(store, rootPath);
  store.listCaseSets = async () => {
    throw new Error("sets down");
  };
  const { io, errors } = makeIo();
  assert.equal(await fireDueSchedules({ store, rootPath, now: () => NOW, io }), 0);
  const after = await store.getSchedule(rootPath, schedule.id);
  assert.equal(after.lastFiredAt, null, "不消费窗口");
  assert.equal(after.lastNote, null);
  assert.ok(errors.some((line) => line.includes("sets down")));
});

test("fireDueSchedules: store 抛错 → 0 且不抛（best-effort）；建任务抛错 → lastNote+窗口已消费", async () => {
  const first = await setup();
  const failing = first.store;
  failing.listSchedules = async () => {
    throw new Error("db down");
  };
  const { io, errors } = makeIo();
  assert.equal(
    await fireDueSchedules({ store: failing, rootPath: first.rootPath, now: () => NOW, io }),
    0
  );
  assert.ok(errors.some((line) => line.includes("db down")));

  const second = await setup();
  await seedCaseSet(second.store, second.rootPath);
  const schedule = await addSchedule(second.store, second.rootPath);
  second.store.createRegressionTask = async () => {
    throw new Error("insert fail");
  };
  const secondIo = makeIo();
  assert.equal(
    await fireDueSchedules({
      store: second.store,
      rootPath: second.rootPath,
      now: () => NOW,
      io: secondIo.io
    }),
    0
  );
  const after = await second.store.getSchedule(second.rootPath, schedule.id);
  assert.equal(after.lastFiredAt, NOON, "窗口已消费");
  assert.match(after.lastNote, /触发失败/);
  assert.ok(secondIo.errors.some((line) => line.includes("insert fail")));
});

test("fireDueSchedules: >50 份时仍解析视野外的引用用例集（全量扫描，不静默停摆）", async () => {
  const { store, rootPath } = await setup();
  const base = Date.parse("2026-10-01T00:00:00.000Z");
  const oldest = await seedCaseSet(store, rootPath, {
    key: "f-old",
    suffix: "old",
    createdAt: new Date(base).toISOString()
  });
  for (let index = 0; index < 55; index += 1) {
    await seedCaseSet(store, rootPath, {
      key: `f-fill-${index}`,
      suffix: `fill-${index}`,
      createdAt: new Date(base + (index + 1) * 60_000).toISOString()
    });
  }
  await addSchedule(store, rootPath, { name: "老功能", featureKeys: ["f-old"] });
  const { io } = makeIo();
  const fired = await fireDueSchedules({ store, rootPath, now: () => NOW, io });
  assert.equal(fired, 1, "不被 50 上限截断");
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks[0].refs[0].caseSetId, oldest.id, "解析到视野外的份");
});

test("fireDueSchedules: CAS 抛错 → 仅跳过该 schedule（其余照常，窗口未消费）", async () => {
  const { store, rootPath } = await setup();
  await seedCaseSet(store, rootPath);
  const failing = await addSchedule(store, rootPath, { name: "甲" });
  const healthy = await addSchedule(store, rootPath, { name: "乙" });
  const original = store.claimScheduleWindow.bind(store);
  store.claimScheduleWindow = async (input) => {
    if (input.scheduleId === failing.id) throw new Error("cas down");
    return original(input);
  };
  const { io, errors } = makeIo();
  const fired = await fireDueSchedules({ store, rootPath, now: () => NOW, io });
  store.claimScheduleWindow = original;
  assert.equal(fired, 1, "其余 schedule 照常触发");
  assert.equal(
    (await store.getSchedule(rootPath, failing.id)).lastFiredAt,
    null,
    "失败者窗口未消费"
  );
  assert.equal((await store.getSchedule(rootPath, healthy.id)).lastFiredAt, NOON);
  assert.ok(errors.some((line) => line.includes("窗口抢占失败")));
});
