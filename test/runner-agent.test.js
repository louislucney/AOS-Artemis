import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runRunnerAgent } from "../dist/runner/agent.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };
const TEST_HOST_ID = "test-host";
const TEST_INSTANCE_ID = "inst-1";

function inventory() {
  return {
    platforms: ["android", "ios"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" },
      {
        serial: "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B",
        name: "iPhone 15",
        platform: "ios",
        kind: "simulator",
        state: "Booted"
      }
    ],
    tools: TOOLS
  };
}

function snapshot() {
  return {
    identity: {
      id: TEST_HOST_ID,
      hardwareId: null,
      hostname: "test-machine",
      username: "tester",
      osPlatform: "darwin",
      osVersion: "1.0.0",
      arch: "arm64",
      kind: "mac",
      identitySource: "env"
    },
    env: { collectedAt: "2026-10-21T09:00:00.000Z" },
    capabilities: ["android", "ios-simulator"],
    ipPrimary: "10.0.0.5",
    addresses: [{ source: "self", iface: "en0", family: "ipv4", address: "10.0.0.5" }]
  };
}

async function setupFixture() {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, { store });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { dir, runtime, store, inventory: inventory() };
}

function makeOptions(runtime, inv, overrides = {}) {
  const logs = [];
  const errors = [];
  const options = {
    projectDir: runtime.project.rootDir,
    name: "runner-1",
    once: true,
    artifactBaseUrl: "http://mac-a.local:8770",
    env: {},
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    executeSuite: async () => 0,
    collectInventory: async () => inv,
    collectHostSnapshot: async () => snapshot(),
    instanceId: TEST_INSTANCE_ID,
    io: { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) },
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    ...overrides
  };
  return { options, logs, errors };
}

function taskInput(rootPath, overrides = {}) {
  return {
    rootPath,
    refs: [{ caseSetId: "cs-1", featureKey: "f-1" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli",
    ...overrides
  };
}

const SCHEDULE_NOW = Date.parse("2026-10-14T12:00:00.000Z");

async function seedSchedule(rootPath, store) {
  await store.recordCaseSet({
    rootPath,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-1",
        name: "登录流程",
        caseCount: 1,
        screens: ["Home"],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });
  return store.createSchedule({
    rootPath,
    name: "夜间回归",
    featureKeys: ["f-1"],
    platforms: ["android"],
    baseline: "latest",
    everyMinutes: 60,
    createdBy: "cli"
  });
}

test("once：心跳写入 runners（name/hostname/platforms/devices/tools/artifactBaseUrl）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const { options, logs } = makeOptions(runtime, inv);
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  const runners = await store.listRunners(runtime.project.rootDir);
  assert.equal(runners.length, 1);
  assert.equal(runners[0].name, "runner-1");
  assert.equal(runners[0].hostname, os.hostname());
  assert.deepEqual(runners[0].platforms, ["android", "ios"]);
  assert.deepEqual(runners[0].devices, inv.devices);
  assert.deepEqual(runners[0].tools, TOOLS);
  assert.equal(runners[0].artifactBaseUrl, "http://mac-a.local:8770");
  assert.ok(logs.some((line) => line.startsWith("[runner]")), "有 runner 日志");
});

test("once：领取最旧可跑 pending → executeSuite 收到正确 argv → 终态回写", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const task = await store.createRegressionTask(taskInput(runtime.project.rootDir, { platforms: ["android", "ios"] }));
  const calls = [];
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      await store.updateRegressionTask(runtime.project.rootDir, task.id, {
        status: "completed",
        runIds: ["r-1"]
      });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    "run",
    "--task",
    task.id,
    "--project",
    runtime.project.rootDir,
    "--device",
    "emulator-5554",
    "--device",
    "4E0A2C7A-1B2D-4F5E-8A9B-0C1D2E3F4A5B"
  ]);
  const after = await store.getRegressionTask(runtime.project.rootDir, task.id);
  assert.equal(after.status, "completed");
  assert.ok(after.claimedBy, "领取归因保留");
  assert.ok(logs.some((line) => line.includes(`领取任务 ${task.id}`)));
  assert.ok(logs.some((line) => line.includes("退出码 0")));
});

test("once：无 pending → 不调用 executeSuite，返回 0", async () => {
  const { runtime, inventory: inv } = await setupFixture();
  const calls = [];
  const { options } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
});

test("once：端不完备的任务不领取（任务 ios+android，runner 仅 android）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const androidOnly = { platforms: ["android"], devices: [inv.devices[0]], tools: TOOLS };
  const task = await store.createRegressionTask(
    taskInput(runtime.project.rootDir, { platforms: ["android", "ios"] })
  );
  const calls = [];
  const { options } = makeOptions(runtime, androidOnly, {
    executeSuite: async (argv) => {
      calls.push(argv);
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  const after = await store.getRegressionTask(runtime.project.rootDir, task.id);
  assert.equal(after.status, "pending", "缺端不领、保持 pending");
});

test("启动释放：预置 claimed_by=me → 先释放再领取执行；他人持有不动", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const me = await store.upsertRunner({
    rootPath,
    name: "runner-1",
    hostname: os.hostname(),
    platforms: ["android"],
    devices: [inv.devices[0]],
    tools: TOOLS,
    hostId: TEST_HOST_ID,
    instanceId: TEST_INSTANCE_ID
  });
  const other = await store.upsertRunner({
    rootPath,
    name: "runner-other",
    hostname: "mac-b.local",
    platforms: ["android"],
    devices: [inv.devices[0]],
    tools: TOOLS
  });
  const mineTask = await store.createRegressionTask(taskInput(rootPath));
  const otherTask = await store.createRegressionTask(taskInput(rootPath));
  await store.claimRegressionTask({ rootPath, runnerId: me.id, platforms: ["android"], capabilities: ["android"] });
  await store.claimRegressionTask({ rootPath, runnerId: other.id, platforms: ["android"], capabilities: ["android"] });

  const calls = [];
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      await store.updateRegressionTask(rootPath, mineTask.id, { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.ok(logs.some((line) => line.includes("释放未完成领取：1 条")));
  assert.deepEqual(calls, [
    ["run", "--task", mineTask.id, "--project", rootPath, "--device", "emulator-5554"]
  ]);
  const finalOther = await store.getRegressionTask(rootPath, otherTask.id);
  assert.equal(finalOther.status, "claimed");
  assert.equal(finalOther.claimedBy, other.id, "他人持有不动");
});

test("执行器抛错 → 释放本次领取（回 pending 可再领）＋errorLog＋不中断", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  let failing = true;
  const { options, errors } = makeOptions(runtime, inv, {
    executeSuite: async () => {
      if (failing) throw new Error("boom");
      await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0, "不中断");
  assert.ok(errors.some((line) => line.includes("boom")), "errorLog 有事由");
  const released = await store.getRegressionTask(rootPath, task.id);
  assert.equal(released.status, "pending", "释放回 pending");
  assert.equal(released.claimedBy, null);

  failing = false;
  const second = await runRunnerAgent(options);
  assert.equal(second, 0);
  const final = await store.getRegressionTask(rootPath, task.id);
  assert.equal(final.status, "completed", "释放后可被再领取执行");
});

test("非零退出码且未达终态 → 守卫释放回待执行（真实 runSuiteCommand 吞错语义）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async () => 2
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "pending", "非零退出未达终态 → 释放");
  assert.equal(after.claimedBy, null);
  assert.ok(logs.some((line) => line.includes("已释放回待执行")));
});

test("非零退出码但已置终态 → 守卫拒绝不覆盖（partial 保持）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  const { options } = makeOptions(runtime, inv, {
    executeSuite: async () => {
      await store.updateRegressionTask(rootPath, task.id, {
        status: "partial",
        runIds: ["r-1"]
      });
      return 2;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "partial", "终态不被覆盖");
  assert.deepEqual(after.runIds, ["r-1"]);
});

test("面板停止：执行中置 stopping → 执行机确认 cancelled（不释放/不回写终态，保留取消元数据）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  let abortType = null;
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async (argv, execOptions) => {
      abortType = typeof execOptions?.shouldAbort;
      await store.cancelRegressionTask({
        rootPath,
        taskId: task.id,
        source: "panel",
        actor: "panel",
        actorHostId: "h-a",
        note: "面板取消",
        at: "2026-10-21T02:00:00.000Z"
      });
      return 2;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(abortType, "function", "注入 shouldAbort（轮询停止请求）");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled", "执行机 ack：stopping → cancelled（不释放、不重试）");
  assert.equal(after.cancelSource, "panel");
  assert.equal(after.cancelNote, "面板取消");
  assert.equal(after.cancelRequestedAt, "2026-10-21T02:00:00.000Z");
  assert.ok(after.cancelledAt, "确认时补完成时间");
  assert.ok(logs.some((line) => line.includes("已取消")), "日志如实说明");
  assert.ok(logs.some((line) => line.includes("停止请求已确认")), "ack 日志");
});

test("领取与 beginExecution 之间取消：确认 cancelled，不执行也不释放", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  const baseClaim = store.claimRegressionTask.bind(store);
  store.claimRegressionTask = async (input) => {
    const claimed = await baseClaim(input);
    if (claimed) {
      await store.cancelRegressionTask({
        rootPath,
        taskId: claimed.id,
        source: "panel",
        actor: "panel",
        actorHostId: "h-a",
        note: "领取窗口取消"
      });
    }
    return claimed;
  };
  let executed = 0;
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async () => {
      executed += 1;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(executed, 0, "取消请求落在执行窗口：不启动用例");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancelSource, "panel");
  assert.equal(after.cancelNote, "领取窗口取消");
  assert.ok(after.cancelledAt, "窗口内确认补取消时间");
  assert.ok(
    logs.some((line) => line.includes("领取与执行之间被取消")),
    "日志说明领取窗口取消"
  );
});

test("重试上限：永久失败任务达上限置 failed，不再饿死后续任务", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const permanent = await store.createRegressionTask(taskInput(rootPath));
  const later = await store.createRegressionTask(taskInput(rootPath));
  const calls = [];
  const state = { done: false };
  const { options, logs } = makeOptions(runtime, inv, {
    once: false,
    maxAttempts: 2,
    shouldStop: () => state.done,
    executeSuite: async (argv) => {
      const taskId = argv[2];
      calls.push(taskId);
      if (taskId === permanent.id) return 2;
      await store.updateRegressionTask(rootPath, later.id, { status: "completed" });
      state.done = true;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.deepEqual(
    calls,
    [permanent.id, permanent.id, later.id],
    "达上限后让位给后续任务（不饥饿）"
  );
  const failed = await store.getRegressionTask(rootPath, permanent.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 2);
  assert.equal((await store.getRegressionTask(rootPath, later.id)).status, "completed");
  assert.ok(logs.some((line) => line.includes("标记 failed")));
});

test("once：到期调度触发建任务并当轮领取执行", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await seedSchedule(rootPath, store);
  const calls = [];
  const { options, logs } = makeOptions(runtime, inv, {
    now: () => SCHEDULE_NOW,
    executeSuite: async (argv) => {
      calls.push(argv[2]);
      await store.updateRegressionTask(rootPath, argv[2], { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].createdBy, "schedule:夜间回归");
  assert.equal(tasks[0].status, "completed", "当轮即领取执行");
  assert.ok(logs.some((line) => line.includes("触发 夜间回归")));
});

test("调度可关：schedulesEnabled:false / AOS_RUNNER_SCHEDULES=0 → 不触发", async () => {
  const off1 = await setupFixture();
  await seedSchedule(off1.runtime.project.rootDir, off1.store);
  const { options: options1 } = makeOptions(off1.runtime, off1.inventory, {
    now: () => SCHEDULE_NOW,
    schedulesEnabled: false
  });
  await runRunnerAgent(options1);
  assert.equal(
    (await off1.store.listRegressionTasks(off1.runtime.project.rootDir)).length,
    0
  );

  const off2 = await setupFixture();
  await seedSchedule(off2.runtime.project.rootDir, off2.store);
  const { options: options2 } = makeOptions(off2.runtime, off2.inventory, {
    now: () => SCHEDULE_NOW,
    env: { AOS_RUNNER_SCHEDULES: "0" }
  });
  await runRunnerAgent(options2);
  assert.equal(
    (await off2.store.listRegressionTasks(off2.runtime.project.rootDir)).length,
    0
  );
});

test("daemon：跨窗口连续触发（now 推进；每窗口一次）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await seedSchedule(rootPath, store);
  let nowMs = SCHEDULE_NOW;
  let completed = 0;
  const calls = [];
  const state = { done: false };
  const { options } = makeOptions(runtime, inv, {
    once: false,
    now: () => nowMs,
    shouldStop: () => state.done,
    executeSuite: async (argv) => {
      calls.push(argv[2]);
      await store.updateRegressionTask(rootPath, argv[2], { status: "completed" });
      completed += 1;
      if (completed >= 2) state.done = true;
      else nowMs = SCHEDULE_NOW + 2 * 60 * 60_000;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 2, "两窗口各触发一次");
  const tasks = await store.listRegressionTasks(rootPath);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.createdBy === "schedule:夜间回归"));
});

test("调度触发失败不打断领取循环（后续任务照常执行）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await seedSchedule(rootPath, store);
  const manual = await store.createRegressionTask(taskInput(rootPath));
  const original = store.createRegressionTask.bind(store);
  store.createRegressionTask = async () => {
    throw new Error("insert fail");
  };
  const calls = [];
  const { options, errors } = makeOptions(runtime, inv, {
    now: () => SCHEDULE_NOW,
    executeSuite: async (argv) => {
      calls.push(argv[2]);
      await store.updateRegressionTask(rootPath, argv[2], { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  store.createRegressionTask = original;
  assert.equal(code, 0);
  assert.deepEqual(calls, [manual.id], "调度失败后照常领取执行");
  assert.ok(errors.some((line) => line.includes("insert fail")));
  assert.equal((await store.getRegressionTask(rootPath, manual.id)).status, "completed");
});

test("执行期间心跳持续（daemon）：长跑不再失联", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await store.createRegressionTask(taskInput(rootPath));
  const original = store.upsertRunner.bind(store);
  let upserts = 0;
  store.upsertRunner = async (input) => {
    upserts += 1;
    return original(input);
  };
  const state = { stop: false, duringExecution: 0 };
  const { options } = makeOptions(runtime, inv, {
    once: false,
    shouldStop: () => state.stop,
    executeSuite: async () => {
      const before = upserts;
      const deadline = Date.now() + 2_000;
      while (upserts < before + 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      state.duringExecution = upserts - before;
      state.stop = true;
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.ok(state.duringExecution >= 2, `执行期间心跳 ≥2（实际 ${state.duringExecution}）`);
});

test("心跳异常不终止：单次 upsert 抛错 → 日志后循环继续恢复", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const original = store.upsertRunner.bind(store);
  let attempts = 0;
  let successes = 0;
  store.upsertRunner = async (input) => {
    attempts += 1;
    if (attempts === 2) throw new Error("db hiccup");
    const record = await original(input);
    successes += 1;
    return record;
  };
  const { options, errors } = makeOptions(runtime, inv, {
    once: false,
    shouldStop: () => successes >= 3
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.ok(errors.some((line) => line.includes("心跳失败")), "心跳失败有日志");
  assert.ok(attempts >= 4, "失败后继续心跳");
});

test("首轮心跳失败 → 返回 2 且 errorLog", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  store.upsertRunner = async () => {
    throw new Error("db down");
  };
  const { options, errors } = makeOptions(runtime, inv);
  const code = await runRunnerAgent(options);
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("首轮心跳失败")));
});

const RECLAIM_NOW = Date.parse("2026-10-14T12:00:00.000Z");

test("回收：主循环每轮调用 releaseStaleClaims（now-TTL / now-900000）且顺序 回收→触发→领取", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await seedSchedule(rootPath, store);
  const sequence = [];
  const reclaimCalls = [];
  const claimCalls = [];
  const originalClaim = store.claimRegressionTask.bind(store);
  const originalCreate = store.createRegressionTask.bind(store);
  store.releaseStaleClaims = async (input) => {
    reclaimCalls.push(input);
    sequence.push("releaseStaleClaims");
    return 0;
  };
  store.createRegressionTask = async (input) => {
    sequence.push("createRegressionTask");
    return originalCreate(input);
  };
  store.claimRegressionTask = async (input) => {
    claimCalls.push(input);
    sequence.push("claimRegressionTask");
    return originalClaim(input);
  };
  const { options } = makeOptions(runtime, inv, {
    now: () => RECLAIM_NOW,
    executeSuite: async (argv) => {
      await store.updateRegressionTask(rootPath, argv[2], { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(reclaimCalls.length, 1);
  assert.deepEqual(reclaimCalls[0], {
    rootPath,
    offlineBefore: new Date(RECLAIM_NOW - 90_000).toISOString(),
    claimedBefore: new Date(RECLAIM_NOW - 900_000).toISOString()
  });
  assert.deepEqual(
    sequence,
    ["releaseStaleClaims", "createRegressionTask", "claimRegressionTask"],
    "顺序：回收→触发→领取"
  );
  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0].onlineBefore, new Date(RECLAIM_NOW - 90_000).toISOString());
  assert.equal(claimCalls[0].allowPartial, false);
});

test("回收：AOS_RUNNER_STALE_CLAIM_MS 正数透传（含 TTL 覆盖，勿回退默认）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const calls = [];
  store.releaseStaleClaims = async (input) => {
    calls.push(input);
    return 0;
  };
  const { options } = makeOptions(runtime, inv, {
    now: () => RECLAIM_NOW,
    env: { AOS_RUNNER_STALE_CLAIM_MS: "5000", AOS_RUNNER_TTL_MS: "30000" }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.deepEqual(calls[0], {
    rootPath,
    offlineBefore: new Date(RECLAIM_NOW - 30_000).toISOString(),
    claimedBefore: new Date(RECLAIM_NOW - 5_000).toISOString()
  });
});

test('回收：env "0" 关闭不调用；回收数>0 → 日志', async () => {
  const off = await setupFixture();
  let offCalls = 0;
  off.store.releaseStaleClaims = async () => {
    offCalls += 1;
    return 0;
  };
  const { options: offOptions } = makeOptions(off.runtime, off.inventory, {
    env: { AOS_RUNNER_STALE_CLAIM_MS: "0" }
  });
  await runRunnerAgent(offOptions);
  assert.equal(offCalls, 0, '"0" 不回退默认：关闭回收');

  const on = await setupFixture();
  on.store.releaseStaleClaims = async () => 2;
  const { options: onOptions, logs } = makeOptions(on.runtime, on.inventory);
  await runRunnerAgent(onOptions);
  assert.ok(logs.some((line) => line.includes("回收失联领取：2 条")), "回收数>0 有日志");
});

test("部分领取：无 env → allowPartial=false 透传；env=1 → true", async () => {
  const a = await setupFixture();
  const seenA = [];
  const originalA = a.store.claimRegressionTask.bind(a.store);
  a.store.claimRegressionTask = async (input) => {
    seenA.push(input);
    return originalA(input);
  };
  const { options: optionsA } = makeOptions(a.runtime, a.inventory);
  await runRunnerAgent(optionsA);
  assert.equal(seenA.length, 1);
  assert.equal(seenA[0].allowPartial, false, "默认关");
  assert.ok(seenA[0].onlineBefore, "始终透传 onlineBefore");

  const b = await setupFixture();
  const seenB = [];
  const originalB = b.store.claimRegressionTask.bind(b.store);
  b.store.claimRegressionTask = async (input) => {
    seenB.push(input);
    return originalB(input);
  };
  const { options: optionsB } = makeOptions(b.runtime, b.inventory, {
    env: { AOS_RUNNER_PARTIAL_CLAIM: "1" }
  });
  await runRunnerAgent(optionsB);
  assert.equal(seenB.length, 1);
  assert.equal(seenB[0].allowPartial, true, "env=1 开启");
});

test("部分领取：命中部分端任务 → 日志明示缺端", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const androidOnly = { platforms: ["android"], devices: [inv.devices[0]], tools: TOOLS };
  const task = await store.createRegressionTask(
    taskInput(rootPath, { platforms: ["android", "ios"] })
  );
  const calls = [];
  const { options, logs } = makeOptions(runtime, androidOnly, {
    env: { AOS_RUNNER_PARTIAL_CLAIM: "1" },
    executeSuite: async (argv) => {
      calls.push(argv);
      await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "部分领取后执行");
  const line = logs.find((entry) => entry.includes("部分端"));
  assert.ok(line, "有部分端日志");
  assert.ok(line.includes("android"), "含覆盖端");
  assert.ok(line.includes("ios"), "含缺端");
});

test("领取守卫：attempts 超上限 → 置 failed、不执行、毒丸防护日志", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  for (let i = 0; i < 3; i += 1) {
    await store.claimRegressionTask({
      rootPath,
      runnerId: "seed",
      hostId: "seed-host",
      instanceId: "seed-inst",
      platforms: ["android"],
      capabilities: ["android"]
    });
    await store.beginExecution({
      rootPath,
      taskId: task.id,
      runnerId: "seed",
      instanceId: "seed-inst"
    });
    await store.releaseRegressionTask({
      rootPath,
      runnerId: "seed",
      taskId: task.id,
      to: "pending"
    });
  }
  const before = await store.getRegressionTask(rootPath, task.id);
  assert.equal(before.attempts, 3);
  const calls = [];
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 0, "毒丸不进入执行");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "failed");
  assert.equal(after.claimedBy, null);
  assert.ok(logs.some((line) => line.includes("毒丸防护")), "有毒丸防护日志");
  assert.ok(logs.some((line) => line.includes("超上限")), "有超上限说明");
});

test("领取守卫边界：attempts < maxAttempts → 仍执行（beginExecution 后达 max）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  for (let i = 0; i < 2; i += 1) {
    await store.claimRegressionTask({
      rootPath,
      runnerId: "seed",
      hostId: "seed-host",
      instanceId: "seed-inst",
      platforms: ["android"],
      capabilities: ["android"]
    });
    await store.beginExecution({
      rootPath,
      taskId: task.id,
      runnerId: "seed",
      instanceId: "seed-inst"
    });
    await store.releaseRegressionTask({
      rootPath,
      runnerId: "seed",
      taskId: task.id,
      to: "pending"
    });
  }
  const before = await store.getRegressionTask(rootPath, task.id);
  assert.equal(before.attempts, 2);
  const calls = [];
  const { options, logs } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "attempts=2<max 不越界、仍执行（beginExecution → 3）");
  const after = await store.getRegressionTask(rootPath, task.id);
  assert.equal(after.status, "completed");
  assert.ok(!logs.some((line) => line.includes("毒丸防护")), "未触发毒丸");
});

test("领取守卫：置 failed 返回 false → errorLog（可能已被并发处理）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  for (let i = 0; i < 3; i += 1) {
    await store.claimRegressionTask({
      rootPath,
      runnerId: "seed",
      hostId: "seed-host",
      instanceId: "seed-inst",
      platforms: ["android"],
      capabilities: ["android"]
    });
    await store.beginExecution({
      rootPath,
      taskId: task.id,
      runnerId: "seed",
      instanceId: "seed-inst"
    });
    await store.releaseRegressionTask({
      rootPath,
      runnerId: "seed",
      taskId: task.id,
      to: "pending"
    });
  }
  store.releaseRegressionTask = async () => false;
  const calls = [];
  const { options, errors } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      return 0;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 0, "不进入执行");
  assert.ok(
    errors.some((line) => line.includes("超上限置 failed 失败")),
    "释放 false 有 errorLog"
  );
});

test("执行失败释放返回 false → errorLog（守卫释放未生效）＋ 干净退出", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  await store.createRegressionTask(taskInput(rootPath));
  store.releaseRegressionTask = async () => false;
  const calls = [];
  const { options, errors } = makeOptions(runtime, inv, {
    executeSuite: async (argv) => {
      calls.push(argv);
      return 2;
    }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0, "干净退出");
  assert.equal(calls.length, 1, "执行失败后被守卫释放");
  assert.ok(
    errors.some((line) => line.includes("守卫释放未生效")),
    "释放 false 有 errorLog（守卫释放未生效）"
  );
  assert.ok(
    !errors.some((line) => line.includes("释放任务失败")),
    "与 catch 分支日志可区分"
  );
});

test("回收：非法 AOS_RUNNER_STALE_CLAIM_MS → 回退 900000（非关闭）", async () => {
  const { runtime, store, inventory: inv } = await setupFixture();
  const rootPath = runtime.project.rootDir;
  const calls = [];
  store.releaseStaleClaims = async (input) => {
    calls.push(input);
    return 0;
  };
  const { options } = makeOptions(runtime, inv, {
    now: () => RECLAIM_NOW,
    env: { AOS_RUNNER_STALE_CLAIM_MS: "abc" }
  });
  const code = await runRunnerAgent(options);
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "非法值回退默认、仍回收");
  assert.deepEqual(calls[0], {
    rootPath,
    offlineBefore: new Date(RECLAIM_NOW - 90_000).toISOString(),
    claimedBefore: new Date(RECLAIM_NOW - 900_000).toISOString()
  });
});
