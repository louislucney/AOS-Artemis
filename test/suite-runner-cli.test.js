import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { MigrationIncompleteError, PostgresStore } from "../dist/db/postgres.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

async function setup() {
  const store = await makePgStore();
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { runtime, store };
}

function androidInventory() {
  return {
    platforms: ["android"],
    devices: [
      { serial: "emulator-5554", name: "", platform: "android", kind: "emulator", state: "device" }
    ],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  };
}

function androidHostSnapshot() {
  return {
    identity: {
      id: "runner-host",
      hardwareId: null,
      hostname: "runner-host",
      username: "runner",
      osPlatform: "linux",
      osVersion: "1.0.0",
      arch: "x64",
      kind: "linux",
      identitySource: "env"
    },
    env: { collectedAt: "2026-10-21T09:00:00.000Z" },
    capabilities: ["android"],
    ipPrimary: "10.0.0.9",
    addresses: []
  };
}

async function runCli(runtime, args, extraDeps = {}) {
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(args, {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...extraDeps
  });
  return { code, logs, errors };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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

test("suite runner: usage 列出 runner 与 task release", async () => {
  const logs = [];
  const code = await runSuiteCommand(["help"], {
    log: (line) => logs.push(line),
    errorLog: () => {}
  });
  assert.equal(code, 0);
  const usage = logs.join("\n");
  assert.match(usage, /suite runner/);
  assert.match(usage, /task create\|list\|show\|release/);
});

test("suite runner: 内存 store → exit 2 提示中心 PG", async () => {
  const memStore = new MemoryStore();
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { store: memStore });
  const { code, errors } = await runCli(runtime, ["runner", "--once", "--artifact-port", "0"]);
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("中心 PG")));
});

test("suite runner: 非法 --poll-ms → exit 2", async () => {
  const { runtime } = await setup();
  const { code, errors } = await runCli(runtime, ["runner", "--poll-ms", "abc"]);
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("--poll-ms")));
});

test("suite runner: 迁移未完成 → 打印可操作消息并 exit 2", async () => {
  const errors = [];
  const code = await runSuiteCommand(["runner", "--once"], {
    buildRuntime: async () => {
      throw new MigrationIncompleteError(["projects_host_path_idx"]);
    },
    log: () => {},
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.ok(errors.some((line) => line.includes("数据库迁移未完成")));
  assert.ok(errors.some((line) => line.includes("projects_host_path_idx")));
});

test("suite runner --once 冒烟：心跳落库 + 领取执行（假执行器）", async () => {
  const { runtime, store } = await setup();
  const rootPath = runtime.project.rootDir;
  const task = await store.createRegressionTask(taskInput(rootPath));
  const executed = [];
  const { code, logs } = await runCli(runtime, ["runner", "--once", "--artifact-port", "0"], {
    runner: {
      collectInventory: async () => androidInventory(),
      collectHostSnapshot: async () => androidHostSnapshot(),
      executeSuite: async (argv) => {
        executed.push(argv);
        await store.updateRegressionTask(rootPath, task.id, { status: "completed" });
        return 0;
      }
    }
  });
  assert.equal(code, 0);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].slice(0, 2), ["run", "--task"]);
  const runners = await store.listRunners(rootPath);
  assert.equal(runners.length, 1);
  assert.equal(runners[0].artifactBaseUrl, null, "--artifact-port 0 不广播基址");
  assert.equal((await store.getRegressionTask(rootPath, task.id)).status, "completed");
  assert.ok(logs.some((line) => line.includes("领取任务")));
});

test("suite runner: artifact 端口被占 → 警告继续 + 不广播基址", async () => {
  const { runtime, store } = await setup();
  const rootPath = runtime.project.rootDir;
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  try {
    const { code, errors } = await runCli(
      runtime,
      ["runner", "--once", "--artifact-port", String(port), "--artifact-host", "127.0.0.1"],
      {
        runner: {
          collectInventory: async () => androidInventory(),
          executeSuite: async () => 0
        }
      }
    );
    assert.equal(code, 0, "不阻断执行");
    assert.ok(errors.some((line) => line.includes("产物服务启动失败")));
    const runners = await store.listRunners(rootPath);
    assert.equal(runners[0].artifactBaseUrl, null, "不广播死链");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test("suite runner: artifact 服务启动 → 广播基址（AOS_RUNNER_ADVERTISE_URL 覆盖）", async () => {
  const { runtime, store } = await setup();
  const rootPath = runtime.project.rootDir;
  const port = await freePort();
  const { code } = await runCli(
    runtime,
    ["runner", "--once", "--artifact-port", String(port), "--artifact-host", "127.0.0.1"],
    {
      env: { AOS_RUNNER_ADVERTISE_URL: "http://mac-x.local:9999" },
      runner: {
        collectInventory: async () => androidInventory(),
        executeSuite: async () => 0
      }
    }
  );
  assert.equal(code, 0);
  const runners = await store.listRunners(rootPath);
  assert.equal(runners[0].artifactBaseUrl, "http://mac-x.local:9999");
});
