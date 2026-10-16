import assert from "node:assert/strict";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  RUNNER_TTL_DEFAULT_MS,
  isRunnerOnline,
  runnerTtlFrom
} from "../dist/runner/status.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const store = new PostgresStore(pool);
  await store.init();
  return { store, pool };
}

const DEVICES = [
  {
    serial: "emulator-5554",
    name: "",
    platform: "android",
    kind: "emulator",
    state: "device"
  },
  {
    serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
    name: "iPhone Louis",
    platform: "ios",
    kind: "device",
    state: "Booted"
  }
];

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };

function runnerInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    name: "runner-a",
    hostname: "mac-a.local",
    platforms: ["android", "ios"],
    devices: DEVICES,
    tools: TOOLS,
    artifactBaseUrl: "http://mac-a.local:8770",
    version: "0.1.0",
    ...overrides
  };
}

test("upsertRunner: 首次落库 + 二次更新同一条（id 稳定、devices 覆盖、createdAt 不变、lastSeenAt 变新）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const first = await store.upsertRunner(runnerInput());
    assert.ok(first.id);
    assert.ok(first.projectId);
    assert.equal(first.name, "runner-a");
    assert.equal(first.hostname, "mac-a.local");
    assert.deepEqual(first.platforms, ["android", "ios"]);
    assert.deepEqual(first.devices, DEVICES);
    assert.deepEqual(first.tools, TOOLS);
    assert.equal(first.artifactBaseUrl, "http://mac-a.local:8770");
    assert.equal(first.version, "0.1.0");
    assert.ok(first.lastSeenAt);
    assert.equal(first.createdAt, first.lastSeenAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.upsertRunner(
      runnerInput({
        platforms: ["android"],
        devices: [DEVICES[0]],
        tools: { ...TOOLS, appium: true },
        artifactBaseUrl: null,
        version: null
      })
    );
    assert.equal(second.id, first.id, "同项目同名 → 同一行");
    assert.equal(second.createdAt, first.createdAt, "createdAt 不随心跳变化");
    assert.notEqual(second.lastSeenAt, first.lastSeenAt, "lastSeenAt 刷新");
    assert.deepEqual(second.platforms, ["android"]);
    assert.deepEqual(second.devices, [DEVICES[0]]);
    assert.equal(second.tools.appium, true);
    assert.equal(second.artifactBaseUrl, null);
    assert.equal(second.version, null);

    const listed = await store.listRunners("/w/p1");
    assert.equal(listed.length, 1, "同名 upsert 不产生新行");
  }
});

test("upsertRunner: 未注册项目 → 抛错（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await assert.rejects(store.upsertRunner(runnerInput()), /未注册/);
  }
});

test("listRunners: 按 lastSeenAt 新→旧 + limit；未知项目 → []", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.upsertRunner(runnerInput({ name: "old" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.upsertRunner(runnerInput({ name: "new" }));
    const all = await store.listRunners("/w/p1");
    assert.deepEqual(
      all.map((entry) => entry.name),
      ["new", "old"]
    );
    assert.equal((await store.listRunners("/w/p1", 1)).length, 1);
    assert.deepEqual(await store.listRunners("/w/p2"), []);
  }
});

test("runners: devices.name 与 tools 往返一致；PG 侧旧格式行宽容解析（tools 全 false、name 空串）", async () => {
  const { store, pool } = await makePgStore();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  const seeded = await store.upsertRunner(runnerInput({ name: "seed" }));
  assert.equal(seeded.devices[1].name, "iPhone Louis");
  assert.deepEqual(seeded.tools, TOOLS);

  await pool.query(
    `INSERT INTO runners
       (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, last_seen_at, created_at)
     VALUES ('r-legacy', $1, 'legacy', 'host-b', '["android"]',
             '[{"serial":"x1","platform":"android","kind":"device","state":"device"}]',
             '{}', NULL, NULL, $2, $2)`,
    [seeded.projectId, "2026-10-14T00:00:00.000Z"]
  );
  const listed = await store.listRunners("/w/p1");
  const legacy = listed.find((entry) => entry.name === "legacy");
  assert.ok(legacy);
  assert.equal(legacy.devices[0].name, "", "缺 name → 空串");
  assert.deepEqual(legacy.tools, {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false
  });
  assert.equal(legacy.artifactBaseUrl, null);
  assert.equal(legacy.version, null);
});

test("isRunnerOnline: TTL 边界；runnerTtlFrom: 默认与合法值", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  assert.equal(isRunnerOnline("2026-10-14T11:58:30.000Z", now, 90_000), true, "恰等于 TTL 在线");
  assert.equal(isRunnerOnline("2026-10-14T11:58:29.999Z", now, 90_000), false, "超 1ms 离线");
  assert.equal(isRunnerOnline("2026-10-14T12:00:30.000Z", now, 90_000), true, "未来时间视为在线");
  assert.equal(isRunnerOnline("not-a-date", now, 90_000), false, "非法时间 → 离线");
  assert.equal(runnerTtlFrom({}), RUNNER_TTL_DEFAULT_MS);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "60000" }), 60_000);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "abc" }), RUNNER_TTL_DEFAULT_MS);
  assert.equal(runnerTtlFrom({ AOS_RUNNER_TTL_MS: "0" }), RUNNER_TTL_DEFAULT_MS);
});

function taskInput(overrides = {}) {
  return {
    rootPath: "/w/p1",
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli",
    ...overrides
  };
}

test("claimRegressionTask: 最旧可领 pending → claimed（端子集条件）；缺端/无 pending → null", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const androidTask = await store.createRegressionTask(taskInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const iosTask = await store.createRegressionTask(taskInput({ platforms: ["ios"] }));

    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-android",
      platforms: ["android"]
    });
    assert.ok(claimed);
    assert.equal(claimed.id, androidTask.id, "最旧可领");
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimedBy, "r-android");
    assert.ok(claimed.claimedAt);

    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-android",
        platforms: ["android"]
      }),
      null,
      "ios-only 任务缺端不领"
    );

    const dual = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-dual",
      platforms: ["ios", "android"]
    });
    assert.ok(dual);
    assert.equal(dual.id, iosTask.id);
    assert.equal(dual.claimedBy, "r-dual");

    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-late",
        platforms: ["ios", "android"]
      }),
      null,
      "全被领走 → null"
    );
  }
});

test("claimRegressionTask: 单任务被领后不复领（第二个 runner → null）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.createRegressionTask(taskInput());
    const first = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-1",
      platforms: ["android"]
    });
    assert.ok(first);
    assert.equal(first.attempts, 1, "领取累加 attempts");
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-2",
        platforms: ["android"]
      }),
      null
    );
  }
});

test("releaseRegressionTask: to='failed' 终态化；runnerId=null 仅命中 claimed_by 空行（memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const normal = await store.createRegressionTask(taskInput());
    const weird = await store.createRegressionTask(taskInput());
    await store.updateRegressionTask("/w/p1", weird.id, {
      status: "claimed",
      claimedBy: null,
      claimedAt: null
    });

    const claimedNormal = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-1",
      platforms: ["android"]
    });
    assert.equal(claimedNormal.id, normal.id);

    assert.equal(
      await store.releaseRegressionTask({ rootPath: "/w/p1", runnerId: null, taskId: normal.id }),
      false,
      "runnerId=null 不动正常持有行"
    );
    assert.equal(
      await store.releaseRegressionTask({ rootPath: "/w/p1", runnerId: null, taskId: weird.id }),
      true
    );
    assert.equal((await store.getRegressionTask("/w/p1", weird.id)).status, "pending");

    assert.equal(
      await store.releaseRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-1",
        taskId: normal.id,
        to: "failed"
      }),
      true
    );
    const failed = await store.getRegressionTask("/w/p1", normal.id);
    assert.equal(failed.status, "failed", "to='failed' 终态化");
    assert.equal(failed.claimedBy, null);
  }
});

test("claimRegressionTask: 无候选窗截断（>50 条缺端任务不饿死后续可领任务；memory + pg-mem）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    for (let index = 0; index < 55; index += 1) {
      await store.createRegressionTask(taskInput({ platforms: ["ios"] }));
    }
    const android = await store.createRegressionTask(taskInput());
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-android",
      platforms: ["android"]
    });
    assert.ok(claimed, "更晚的 android 任务不被头部缺端任务饿死");
    assert.equal(claimed.id, android.id);
  }
});

test("claimRegressionTask: 无新参数 → 严格子集（不部分领取）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-android",
        platforms: ["android"]
      }),
      null,
      "无 allowPartial → 严格子集，部分交集不领"
    );
  }
});

test("claimRegressionTask: 完全覆盖优先（较新完全覆盖 vs 较旧部分可领）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const older = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await store.createRegressionTask(taskInput({ platforms: ["android"] }));

    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-self",
      platforms: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.ok(claimed);
    assert.equal(claimed.id, newer.id, "完全覆盖者优先于部分可领");
    assert.equal((await store.getRegressionTask("/w/p1", older.id)).status, "pending");
  }
});

test("claimRegressionTask 部分领取：无他者在线全覆盖 → 领最早交集≥1 候选", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const dual = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-self",
      platforms: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.ok(claimed, "交集≥1 且无他者全覆盖 → 部分领取");
    assert.equal(claimed.id, dual.id);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.attempts, 1);
  }
});

test("claimRegressionTask 部分领取：他者在线全覆盖 → null 等待", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    await store.upsertRunner(runnerInput({ name: "other", platforms: ["android", "ios"] }));
    const dual = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-self",
      platforms: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.equal(claimed, null, "他者在线全覆盖 → 等待该 runner 领取");
    assert.equal((await store.getRegressionTask("/w/p1", dual.id)).status, "pending");
  }
});

test("claimRegressionTask 部分领取：self 自身 runner 行不阻塞（排除 self，按 input.platforms 判定）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const self = await store.upsertRunner(
      runnerInput({ name: "self", platforms: ["android", "ios"] })
    );
    const dual = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: self.id,
      platforms: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.ok(claimed, "self 的 DB 行（含 ios）不视为他者，排除 self 后无他者全覆盖 → 部分领取");
    assert.equal(claimed.id, dual.id);
  }
});

test("claimRegressionTask: allowPartial:false 或 onlineBefore 缺省 → 严格（null）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const dual = await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-android",
        platforms: ["android"],
        onlineBefore,
        allowPartial: false
      }),
      null,
      "allowPartial:false → 严格"
    );
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-android",
        platforms: ["android"],
        allowPartial: true
      }),
      null,
      "onlineBefore 缺省 → 严格"
    );
    assert.equal((await store.getRegressionTask("/w/p1", dual.id)).status, "pending");
  }
});

test("claimRegressionTask 部分领取：交集 0 → null", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    const iosOnly = await store.createRegressionTask(taskInput({ platforms: ["ios"] }));
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-android",
        platforms: ["android"],
        onlineBefore,
        allowPartial: true
      }),
      null,
      "交集 0 → 不领"
    );
    assert.equal((await store.getRegressionTask("/w/p1", iosOnly.id)).status, "pending");
  }
});

test("claimRegressionTask 部分领取：已被领取后不复领（CAS）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    const onlineBefore = new Date(Date.now() - 60_000).toISOString();
    await store.createRegressionTask(taskInput({ platforms: ["android", "ios"] }));
    const first = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-1",
      platforms: ["android"],
      onlineBefore,
      allowPartial: true
    });
    assert.ok(first);
    assert.equal(first.attempts, 1);
    assert.equal(
      await store.claimRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-2",
        platforms: ["android"],
        onlineBefore,
        allowPartial: true
      }),
      null,
      "已领取 → CAS 守卫不复领"
    );
  }
});

test("release 语义：全量仅释放自己；单任务守卫（他人/已终态 → false 不覆盖）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.createRegressionTask(taskInput());
    await store.createRegressionTask(taskInput());
    const mine = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-me",
      platforms: ["android"]
    });
    const theirs = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-other",
      platforms: ["android"]
    });
    assert.ok(mine && theirs);

    assert.equal(
      await store.releaseRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-me",
        taskId: theirs.id
      }),
      false,
      "他人持有 → false 不动"
    );

    assert.equal(
      await store.releaseRegressionTasks({ rootPath: "/w/p1", runnerId: "r-me" }),
      1,
      "全量只释放自己的"
    );
    const afterBulk = await store.listRegressionTasks("/w/p1");
    const reMine = afterBulk.find((task) => task.id === mine.id);
    const reTheirs = afterBulk.find((task) => task.id === theirs.id);
    assert.equal(reMine.status, "pending");
    assert.equal(reMine.claimedBy, null);
    assert.equal(reMine.claimedAt, null);
    assert.equal(reTheirs.status, "claimed", "他人持有不动");

    await store.claimRegressionTask({ rootPath: "/w/p1", runnerId: "r-me", platforms: ["android"] });
    assert.equal(
      await store.releaseRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-me",
        taskId: mine.id
      }),
      true
    );
    await store.updateRegressionTask("/w/p1", mine.id, { status: "completed" });
    assert.equal(
      await store.releaseRegressionTask({
        rootPath: "/w/p1",
        runnerId: "r-me",
        taskId: mine.id
      }),
      false,
      "已终态 → false 不覆盖"
    );
    assert.equal((await store.getRegressionTask("/w/p1", mine.id)).status, "completed");
  }
});

test("updateRegressionTask: 键缺省不动 / null 显式置空；status-only 不清空 claimedBy", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.createRegressionTask(taskInput());
    const claimed = await store.claimRegressionTask({
      rootPath: "/w/p1",
      runnerId: "r-1",
      platforms: ["android"]
    });
    assert.ok(claimed);

    await store.updateRegressionTask("/w/p1", claimed.id, { status: "running" });
    const running = await store.getRegressionTask("/w/p1", claimed.id);
    assert.equal(running.status, "running");
    assert.equal(running.claimedBy, "r-1", "status-only 更新不清空领取归因");
    assert.ok(running.claimedAt);

    await store.updateRegressionTask("/w/p1", claimed.id, { claimedBy: null, claimedAt: null });
    const cleared = await store.getRegressionTask("/w/p1", claimed.id);
    assert.equal(cleared.claimedBy, null, "null 显式置空");
    assert.equal(cleared.claimedAt, null);
    assert.equal(cleared.status, "running", "置空领取不改状态");
  }
});

test("存量库迁移：旧 regression_tasks 缺 claimed_by/claimed_at → init 补列后可领取", async () => {
  // noAstCoverageCheck：旧表已存在时 pg-mem 会因未读取的 AST 约束直接报错，这里只关注迁移结果
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    `CREATE TABLE regression_tasks (
       id TEXT PRIMARY KEY,
       project_id TEXT,
       created_at TEXT NOT NULL,
       created_by TEXT,
       refs TEXT NOT NULL DEFAULT '[]',
       platforms TEXT NOT NULL DEFAULT '[]',
       baseline TEXT NOT NULL DEFAULT 'latest',
       status TEXT NOT NULL DEFAULT 'pending',
       run_ids TEXT NOT NULL DEFAULT '[]'
     )`
  );
  const store = new PostgresStore(pool);
  await store.init();
  await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await store.createRegressionTask(taskInput());
  const claimed = await store.claimRegressionTask({
    rootPath: "/w/p1",
    runnerId: "r-legacy",
    platforms: ["android"]
  });
  assert.ok(claimed, "补列后可领取");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claimedBy, "r-legacy");
  assert.equal(claimed.attempts, 1, "补列后 attempts 可累加");
});

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAt = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const CLAIM_CUT = isoAt(-DAY_MS);
const OFFLINE_CUT = isoAt(-DAY_MS);
const STALE_CLAIM = isoAt(-2 * DAY_MS);
const FRESH_CLAIM = isoAt(2 * DAY_MS);
const OFFLINE_SEEN = isoAt(-2 * DAY_MS);

async function seedClaimed(store, rootPath, { claimedBy, claimedAt, status = "claimed" }) {
  const task = await store.createRegressionTask(taskInput({ rootPath }));
  const claimed = await store.claimRegressionTask({
    rootPath,
    runnerId: claimedBy ?? "seed-runner",
    platforms: ["android"]
  });
  await store.updateRegressionTask(rootPath, claimed.id, {
    status,
    claimedBy: claimedBy ?? null,
    claimedAt
  });
  return claimed.id;
}

test("releaseStaleClaims: 超龄+失联→pending；在线/未超龄/终态→0；空 claimed_by 与 running 同判；跨项目隔离", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
    const online = await store.upsertRunner(runnerInput());

    const staleOffline = await seedClaimed(store, "/w/p1", {
      claimedBy: "ghost-runner",
      claimedAt: STALE_CLAIM
    });
    const staleOnline = await seedClaimed(store, "/w/p1", {
      claimedBy: online.id,
      claimedAt: STALE_CLAIM
    });
    const freshOffline = await seedClaimed(store, "/w/p1", {
      claimedBy: "ghost-runner",
      claimedAt: FRESH_CLAIM
    });
    const emptyClaimedBy = await seedClaimed(store, "/w/p1", {
      claimedBy: null,
      claimedAt: STALE_CLAIM
    });
    const runningStale = await seedClaimed(store, "/w/p1", {
      claimedBy: "ghost-runner",
      claimedAt: STALE_CLAIM,
      status: "running"
    });
    const terminal = await seedClaimed(store, "/w/p1", {
      claimedBy: "ghost-runner",
      claimedAt: STALE_CLAIM,
      status: "completed"
    });
    const otherProject = await seedClaimed(store, "/w/p2", {
      claimedBy: "ghost-runner",
      claimedAt: STALE_CLAIM
    });

    const count = await store.releaseStaleClaims({
      rootPath: "/w/p1",
      offlineBefore: OFFLINE_CUT,
      claimedBefore: CLAIM_CUT
    });
    assert.equal(count, 3, "staleOffline + emptyClaimedBy + runningStale");

    const reclaimed = await store.getRegressionTask("/w/p1", staleOffline);
    assert.equal(reclaimed.status, "pending");
    assert.equal(reclaimed.claimedBy, null);
    assert.equal(reclaimed.claimedAt, null);
    assert.equal(reclaimed.attempts, 1, "attempts 保留");

    const kept = await store.getRegressionTask("/w/p1", staleOnline);
    assert.equal(kept.status, "claimed", "在线 runner 不回收");
    assert.equal(kept.claimedBy, online.id);
    assert.equal(kept.attempts, 1);

    assert.equal((await store.getRegressionTask("/w/p1", freshOffline)).status, "claimed", "未超龄不回收");
    assert.equal((await store.getRegressionTask("/w/p1", emptyClaimedBy)).status, "pending", "空 claimed_by 且超龄回收");
    assert.equal((await store.getRegressionTask("/w/p1", runningStale)).status, "pending", "running 同判");
    assert.equal((await store.getRegressionTask("/w/p1", terminal)).status, "completed", "终态不回收");
    assert.equal((await store.getRegressionTask("/w/p2", otherProject)).status, "claimed", "跨项目隔离");
  }
});

test("releaseStaleClaims: 真实失联 runner（last_seen_at 超龄）回收、在线 runner 不回收（pg-mem）", async () => {
  const { store, pool } = await makePgStore();
  const project = await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await pool.query(
    `INSERT INTO runners
       (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, last_seen_at, created_at)
     VALUES ('r-off', $1, 'off', 'host-off', '[]', '[]', '{}', NULL, NULL, $2, $2)`,
    [project.id, OFFLINE_SEEN]
  );
  const online = await store.upsertRunner(runnerInput({ name: "on" }));

  const offlineTask = await seedClaimed(store, "/w/p1", {
    claimedBy: "r-off",
    claimedAt: STALE_CLAIM
  });
  const onlineTask = await seedClaimed(store, "/w/p1", {
    claimedBy: online.id,
    claimedAt: STALE_CLAIM
  });

  const count = await store.releaseStaleClaims({
    rootPath: "/w/p1",
    offlineBefore: OFFLINE_CUT,
    claimedBefore: CLAIM_CUT
  });
  assert.equal(count, 1);
  assert.equal((await store.getRegressionTask("/w/p1", offlineTask)).status, "pending");
  assert.equal((await store.getRegressionTask("/w/p1", onlineTask)).status, "claimed");
});

test("upsertRunner: 跨项目同名两行（同名不同 project 不冲突）", async () => {
  const stores = [new MemoryStore(), (await makePgStore()).store];
  for (const store of stores) {
    await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
    await store.upsertProject({ rootPath: "/w/p2", name: "p2" });
    const a = await store.upsertRunner(runnerInput({ rootPath: "/w/p1" }));
    const b = await store.upsertRunner(runnerInput({ rootPath: "/w/p2" }));
    assert.notEqual(a.id, b.id);
    assert.equal(a.name, b.name);
    assert.equal((await store.listRunners("/w/p1")).length, 1);
    assert.equal((await store.listRunners("/w/p2")).length, 1);
  }
});

test("upsertRunner: 同名已存在（直接插入）→ INSERT 撞唯一索引 23505 → 回退 UPDATE 仍单行", async () => {
  const { store, pool } = await makePgStore();
  const project = await store.upsertProject({ rootPath: "/w/p1", name: "p1" });
  await pool.query(
    `INSERT INTO runners
       (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, last_seen_at, created_at)
     VALUES ('r-seed', $1, 'runner-a', 'old-host', '[]', '[]', '{}', NULL, NULL, $2, $2)`,
    [project.id, "2026-10-14T00:00:00.000Z"]
  );
  const up = await store.upsertRunner(runnerInput());
  assert.equal(up.id, "r-seed", "回退 UPDATE 保留原 id");
  assert.equal(up.hostname, "mac-a.local");
  assert.equal((await store.listRunners("/w/p1")).length, 1);
});

test("迁移专项：runners 存量重复行去重（留 last_seen_at 最新、并列取 id 大）+ 唯一索引 + 二次 upsert 单行", async () => {
  // noAstCoverageCheck：旧表已存在时 pg-mem 会因未读取的 AST 约束直接报错，这里只关注迁移结果
  const mem = newDb({ noAstCoverageCheck: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await pool.query(
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY,
       root_path TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       figma_token TEXT,
       created_at TEXT NOT NULL,
       last_seen_at TEXT NOT NULL
     )`
  );
  await pool.query(
    `CREATE TABLE runners (
       id TEXT PRIMARY KEY,
       project_id TEXT,
       name TEXT NOT NULL,
       hostname TEXT NOT NULL,
       platforms TEXT NOT NULL,
       devices TEXT NOT NULL,
       tools TEXT NOT NULL DEFAULT '{}',
       artifact_base_url TEXT,
       version TEXT,
       last_seen_at TEXT NOT NULL,
       created_at TEXT NOT NULL
     )`
  );
  await pool.query(
    `INSERT INTO projects (id, root_path, name, figma_token, created_at, last_seen_at)
     VALUES ('proj-1', '/w/p1', 'p1', NULL, $1, $1)`,
    ["2026-10-01T00:00:00.000Z"]
  );
  const insertRunner = (id, lastSeenAt) =>
    pool.query(
      `INSERT INTO runners
         (id, project_id, name, hostname, platforms, devices, tools, artifact_base_url, version, last_seen_at, created_at)
       VALUES ($1, 'proj-1', 'dup-a', 'host', '[]', '[]', '{}', NULL, NULL, $2, $2)`,
      [id, lastSeenAt]
    );
  await insertRunner("r-1", "2026-10-14T00:00:00.000Z");
  await insertRunner("r-2", "2026-10-15T00:00:00.000Z");
  await insertRunner("r-3", "2026-10-15T00:00:00.000Z");

  const store = new PostgresStore(pool);
  await store.init();

  const remaining = await pool.query(
    `SELECT id FROM runners WHERE project_id = 'proj-1' ORDER BY id`
  );
  assert.deepEqual(
    remaining.rows.map((row) => row.id),
    ["r-3"],
    "仅剩 last_seen_at 最新、并列取 id 最大"
  );

  await assert.rejects(
    insertRunner("r-4", "2026-10-16T00:00:00.000Z"),
    (error) => error.code === "23505",
    "唯一索引已建立"
  );

  const up = await store.upsertRunner(runnerInput({ name: "dup-a" }));
  assert.equal(up.id, "r-3", "二次 upsert 复用去重后剩余行");
  assert.equal((await store.listRunners("/w/p1")).length, 1);
});
