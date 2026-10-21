import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { sweepStaleTasks } from "../dist/tasks/sweeper.js";
import { makeTempDir } from "./helpers.js";

const ROOT = "/w/sweep";
const TOOLS = { adb: true, idb: false, simctl: false, ideviceId: false, appium: false };

async function makePgStore(env = process.env) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool(), null, env);
  await store.init();
  return store;
}

async function stores(env = process.env) {
  return [new MemoryStore(null, env), await makePgStore(env)];
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

async function seedTask(store, rootPath, options = {}) {
  const task = await store.createRegressionTask(taskInput(rootPath));
  if (options.claim) {
    await store.claimRegressionTask({
      rootPath,
      runnerId: options.claim,
      platforms: ["android"],
      capabilities: ["android"],
      hostId: options.hostId ?? null,
      instanceId: options.instanceId ?? null
    });
  }
  if (options.stop) {
    await store.cancelRegressionTask({
      rootPath,
      taskId: task.id,
      source: options.source ?? "panel",
      actor: "panel",
      actorHostId: options.hostId ?? null,
      note: options.note ?? null,
      at: options.at
    });
  }
  return task;
}

async function seedRunner(store, rootPath, options = {}) {
  return store.upsertRunner({
    rootPath,
    name: options.name ?? "runner-1",
    hostname: "mac-a",
    platforms: ["android"],
    devices: [],
    tools: TOOLS,
    hostId: options.hostId ?? "h-a",
    instanceId: options.instanceId ?? "inst-1",
    ...(options.activeWithinMs === undefined ? {} : { activeWithinMs: options.activeWithinMs })
  });
}

test("离线 runner 超宽限 → cancelled（runner-offline）；在线 → 保持 stopping", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const runner = await seedRunner(scoped, ROOT);
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: runner.id,
      hostId: "h-a",
      instanceId: "inst-1",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });

    const online = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(online.cancelled, 0, "在线 runner 不抢取消");
    assert.equal((await scoped.getRegressionTask(ROOT, task.id)).status, "stopping");

    const offline = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs + 5 * 60_000,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(offline.cancelled, 1);
    const after = await scoped.getRegressionTask(ROOT, task.id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.cancelSource, "panel", "保留原取消来源");
    assert.equal(after.cancelNote, "runner-offline");
    assert.equal(after.cancelledAt, new Date(nowMs + 5 * 60_000).toISOString());
    assert.equal(after.cancelRequestedAt, new Date(nowMs - 120_000).toISOString());
  }
});

test("清扫按 claimedBy 精确取 runner（getRunner，不再全量扫描）", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const runner = await seedRunner(scoped, ROOT);
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: runner.id,
      hostId: "h-a",
      instanceId: "inst-1",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });

    assert.equal((await scoped.getRunner(ROOT, runner.id))?.id, runner.id);
    assert.equal(await scoped.getRunner(ROOT, "missing-runner"), null);

    let scans = 0;
    scoped.listRunners = async () => {
      scans += 1;
      throw new Error("listRunners should not be used by the sweeper");
    };
    scoped.scopeHost = () => scoped;
    const result = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs + 5 * 60_000,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 1);
    assert.equal(scans, 0, "只按 id 取 runner 行");
    assert.equal((await scoped.getRegressionTask(ROOT, task.id)).status, "cancelled");
  }
});

test("FileStore getRunner 精确取行且按 host 作用域隔离", async () => {
  const dir = makeTempDir("aos-file-runner-");
  const store = await FileStore.create({ homeDir: dir, env: {} });
  const scoped = store.scopeHost("h-a");
  await scoped.upsertProject({ rootPath: ROOT, name: "p" });
  const runner = await seedRunner(scoped, ROOT);
  assert.equal((await scoped.getRunner(ROOT, runner.id))?.id, runner.id);
  assert.equal(await scoped.getRunner(ROOT, "missing-runner"), null);
  assert.equal(
    await store.scopeHost("h-b").getRunner(ROOT, runner.id),
    null,
    "不同 host 视图不串"
  );
});

test("未超宽限的 stopping 即使 runner 离线也不清扫", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 10_000).toISOString()
    });
    const result = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 0);
    assert.equal((await scoped.getRegressionTask(ROOT, task.id)).status, "stopping");
  }
});

test("旧 stopping（无 cancel_source）→ cancelled + panel/legacy-stopping", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const task = await seedTask(scoped, ROOT);
    await scoped.updateRegressionTask(ROOT, task.id, { status: "stopping" });
    const result = await sweepStaleTasks({ store: scoped, rootPath: ROOT });
    assert.equal(result.cancelled, 1);
    const after = await scoped.getRegressionTask(ROOT, task.id);
    assert.equal(after.status, "cancelled");
    assert.equal(after.cancelSource, "panel");
    assert.equal(after.cancelNote, "legacy-stopping");
  }
});

test("两个清扫器并发只生效一次；cancelled 不会被 releaseStaleClaims 拉回 pending", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const input = {
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    };
    const [first, second] = await Promise.all([sweepStaleTasks(input), sweepStaleTasks(input)]);
    assert.equal(first.cancelled + second.cancelled, 1, "CAS 只允许一次转移");

    const stopping = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const released = await scoped.releaseStaleClaims({
      rootPath: ROOT,
      offlineBefore: new Date(nowMs + 10 * 60_000).toISOString(),
      claimedBefore: new Date(nowMs + 10 * 60_000).toISOString()
    });
    assert.equal(released, 0, "stopping 不参与失联回收");
    const after = await scoped.getRegressionTask(ROOT, task.id);
    assert.equal(after.status, "cancelled");
    assert.equal((await scoped.getRegressionTask(ROOT, stopping.id)).status, "stopping");
  }
});

test("主机隔离：h-a 的清扫器不动 h-b 同路径的 stopping", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    await store.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-b" });
    const local = store.scopeHost("h-a");
    const remote = store.scopeHost("h-b");
    const nowMs = Date.now();
    const localTask = await seedTask(local, ROOT, {
      claim: "ghost-a",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const remoteTask = await seedTask(remote, ROOT, {
      claim: "ghost-b",
      hostId: "h-b",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const result = await sweepStaleTasks({
      store: local,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 1);
    assert.equal((await local.getRegressionTask(ROOT, localTask.id)).status, "cancelled");
    assert.equal((await remote.getRegressionTask(ROOT, remoteTask.id)).status, "stopping");
  }
});

test("重启后同 runner id／新 instance：旧 stopping 视为离线并终结", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const runner = await seedRunner(scoped, ROOT, { instanceId: "inst-old" });
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: runner.id,
      hostId: "h-a",
      instanceId: "inst-old",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const restarted = await seedRunner(scoped, ROOT, {
      instanceId: "inst-new",
      activeWithinMs: -1
    });
    assert.equal(restarted.id, runner.id, "同 host/name 复用 runner 行");
    const result = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 1, "在线但 instance 已轮换 → 可清扫");
    const after = await scoped.getRegressionTask(ROOT, task.id);
    assert.equal(after.status, "cancelled");
    assert.notEqual(after.status, "pending");
  }
});

test("allHosts：中心视图忽略本机过滤，清扫 h-a／h-b 同路径任务", async () => {
  for (const store of await stores()) {
    await store.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    await store.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-b" });
    const local = store.scopeHost("h-a");
    const remote = store.scopeHost("h-b");
    const nowMs = Date.now();
    const localTask = await seedTask(local, ROOT, {
      claim: "ghost-a",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const remoteTask = await seedTask(remote, ROOT, {
      claim: "ghost-b",
      hostId: "h-b",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const result = await sweepStaleTasks({
      store: local,
      rootPath: ROOT,
      allHosts: true,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 2);
    assert.equal((await local.getRegressionTask(ROOT, localTask.id)).status, "cancelled");
    assert.equal((await remote.getRegressionTask(ROOT, remoteTask.id)).status, "cancelled");
  }
});

test("listStoppingTasks：只取 stopping 且按 deadline 过滤（NULL 时间保留）", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const nowMs = Date.now();
    const oldTask = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const freshTask = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 10_000).toISOString()
    });
    const legacy = await seedTask(scoped, ROOT);
    await scoped.updateRegressionTask(ROOT, legacy.id, { status: "stopping" });
    const pending = await seedTask(scoped, ROOT);

    const due = await scoped.listStoppingTasks({
      rootPath: ROOT,
      deadline: new Date(nowMs - 90_000).toISOString()
    });
    const ids = new Set(due.map((task) => task.id));
    assert.ok(ids.has(oldTask.id), "超宽限命中");
    assert.ok(ids.has(legacy.id), "无 cancelRequestedAt 的 legacy 命中");
    assert.ok(!ids.has(freshTask.id), "宽限内不命中");
    assert.ok(!ids.has(pending.id), "非 stopping 不命中");

    const all = await scoped.listStoppingTasks({ rootPath: ROOT });
    assert.equal(all.length, 3);
  }
});

test("自动终结在既有备注后追加 runner-offline", async () => {
  for (const store of await stores()) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    const nowMs = Date.now();
    const task = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      note: "面板取消",
      at: new Date(nowMs - 120_000).toISOString()
    });
    const result = await sweepStaleTasks({
      store: scoped,
      rootPath: ROOT,
      now: () => nowMs,
      graceMs: 90_000,
      runnerTtlMs: 90_000
    });
    assert.equal(result.cancelled, 1);
    const after = await scoped.getRegressionTask(ROOT, task.id);
    assert.equal(after.cancelNote, "面板取消; runner-offline");
  }
});

test("清扫器顺带清理过期接入会话；清理失败不阻断任务清扫", async () => {
  const nowMs = Date.parse("2026-10-21T10:00:00.000Z");
  for (const store of await stores({ AOS_CLIENT_SESSION_RETENTION_DAYS: "7" })) {
    const scoped = store.scopeHost("h-a");
    await scoped.upsertProject({ rootPath: ROOT, name: "p", hostId: "h-a" });
    await scoped.upsertHost({ id: "h-a", hostname: "mac-a" });
    await scoped.touchHostSession({
      id: "s-old",
      hostId: "h-a",
      projectId: null,
      rootPath: ROOT,
      username: "louis",
      client: "cursor",
      clientVersion: "1.0",
      pid: 1,
      at: "2026-09-01T10:00:00.000Z"
    });
    await scoped.endHostSession("s-old", "2026-09-01T10:01:00.000Z");
    await scoped.touchHostSession({
      id: "s-current",
      hostId: "h-a",
      projectId: null,
      rootPath: ROOT,
      username: "louis",
      client: "cursor",
      clientVersion: "1.0",
      pid: 2,
      at: "2026-10-21T09:59:00.000Z"
    });

    await sweepStaleTasks({ store: scoped, now: () => nowMs });
    assert.equal(
      await scoped.pruneHostSessions({ now: nowMs, retentionDays: 7 }),
      0,
      "清扫器应已删除过期已结束会话"
    );
    assert.deepEqual(
      (await scoped.listHostSessions("h-a")).map((session) => session.id),
      ["s-current"]
    );

    const task = await seedTask(scoped, ROOT, {
      claim: "ghost-runner",
      hostId: "h-a",
      stop: true,
      at: new Date(nowMs - 120_000).toISOString()
    });
    const failing = Object.create(scoped);
    failing.pruneHostSessions = async () => {
      throw new Error("prune boom");
    };
    const result = await sweepStaleTasks({ store: failing, now: () => nowMs });
    assert.equal(result.cancelled, 1, "会话清理失败不影响任务取消清扫");
    assert.equal(
      (await scoped.getRegressionTask(ROOT, task.id)).status,
      "cancelled"
    );
  }
});
