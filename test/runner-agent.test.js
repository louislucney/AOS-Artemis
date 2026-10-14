import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runRunnerAgent } from "../dist/runner/agent.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

const TOOLS = { adb: true, idb: true, simctl: true, ideviceId: true, appium: false };

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
    tools: TOOLS
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
  await store.claimRegressionTask({ rootPath, runnerId: me.id, platforms: ["android"] });
  await store.claimRegressionTask({ rootPath, runnerId: other.id, platforms: ["android"] });

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
