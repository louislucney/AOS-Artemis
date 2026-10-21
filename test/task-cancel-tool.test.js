import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { createServerForRuntime } from "../dist/server.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import { baseConfig, loadTestRuntime, makeTempProject, SuiteProxy } from "./helpers.js";

function caseEntry(index, feature) {
  return {
    id: `case-${index}`,
    name: `Case ${index}`,
    screens: ["Home"],
    steps: ["点击「Go」，验证进入「Next」"],
    preconditions: ["应用已安装且可正常启动"],
    taskDesc: `run case ${index}（【真实数据】须经真实请求链路，禁止伪造页面/假数据）`,
    feature
  };
}

async function setupProject({ statuses = {} } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new SuiteProxy({ statuses, running: true }),
    store
  });
  await store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  return { dir, store, runtime, rootPath: runtime.project.rootDir };
}

async function setupRunnableTask({ targetHostId = null } = {}) {
  const { dir, store, runtime } = await setupProject({
    statuses: { "trace-1": { status: "completed" } }
  });
  const rootPath = runtime.project.rootDir;
  const archiveDir = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.mkdirSync(archiveDir, { recursive: true });
  const jsonPath = path.join(archiveDir, "20261014T153000_登录.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ flows: [caseEntry(1, "f-登录-aaaa1111")] }), "utf-8");
  const set = await store.recordCaseSet({
    rootPath,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: "f-登录-aaaa1111",
        name: "登录流程",
        caseCount: 1,
        screens: ["登录"],
        jsonPath,
        mdPath: jsonPath.replace(/\.json$/, ".md"),
        xlsxPath: jsonPath.replace(/\.json$/, ".xlsx")
      }
    ]
  });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [{ caseSetId: set.id, featureKey: "f-登录-aaaa1111" }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli",
    targetHostId
  });
  return { dir, store, runtime, rootPath, task };
}

async function makeHarness() {
  const { store, runtime, rootPath } = await setupProject();
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-cancel-tool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(
    tools.some((tool) => tool.name === "regression_task_cancel"),
    `regression_task_cancel missing from ${tools.map((tool) => tool.name).join(",")}`
  );
  return {
    store,
    runtime,
    rootPath,
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

async function callCancel(client, args) {
  const result = await client.callTool({ name: "regression_task_cancel", arguments: args });
  return { result, payload: JSON.parse(result.content[0].text) };
}

test("regression_task_cancel 写 local-mcp 来源与用户名", async () => {
  const harness = await makeHarness();
  const previous = process.env.AOS_ACTOR;
  process.env.AOS_ACTOR = "alice-cancel";
  try {
    const task = await harness.store.createRegressionTask({
      rootPath: harness.rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      createdBy: "cli",
      targetHostId: "test-host"
    });

    const { result, payload } = await callCancel(harness.client, {
      taskId: task.id,
      note: "手工取消"
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(payload.ok, true);
    assert.equal(payload.task.id, task.id);
    assert.equal(payload.task.status, "cancelled");

    const stored = await harness.store.getRegressionTask(harness.rootPath, task.id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.cancelSource, "local-mcp");
    assert.equal(stored.cancelledBy, "alice-cancel");
    assert.equal(stored.cancelledHostId, harness.runtime.hostIdentity.id);
    assert.equal(stored.cancelNote, "手工取消");

    const audit = await harness.store.listAudit(harness.rootPath, { domain: "task" });
    const entry = audit.find(
      (event) => event.action === "task.cancel" && event.refs.taskId === task.id
    );
    assert.ok(entry, "审计写入 task/task.cancel");
    assert.equal(entry.channel, "mcp");
    assert.equal(entry.actor, "alice-cancel");
    assert.equal(entry.actorHostId, harness.runtime.hostIdentity.id);
    assert.equal(entry.refs.source, "local-mcp");
  } finally {
    if (previous === undefined) delete process.env.AOS_ACTOR;
    else process.env.AOS_ACTOR = previous;
    await harness.close();
  }
});

test("regression_task_cancel 缺省 actor 用系统用户名", async () => {
  const harness = await makeHarness();
  const previous = process.env.AOS_ACTOR;
  delete process.env.AOS_ACTOR;
  try {
    const task = await harness.store.createRegressionTask({
      rootPath: harness.rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest"
    });
    const { result } = await callCancel(harness.client, { taskId: task.id });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    const stored = await harness.store.getRegressionTask(harness.rootPath, task.id);
    assert.equal(stored.cancelledBy, os.userInfo().username);
  } finally {
    if (previous !== undefined) process.env.AOS_ACTOR = previous;
    await harness.close();
  }
});

test("regression_task_cancel 未知任务 → ok:false", async () => {
  const harness = await makeHarness();
  try {
    const { result, payload } = await callCancel(harness.client, { taskId: "task-nope" });
    assert.equal(result.isError, true);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /未找到回归任务 task-nope/);
  } finally {
    await harness.close();
  }
});

test("regression_task_cancel 他机定向任务 → 拒绝且不改动", async () => {
  const harness = await makeHarness();
  try {
    const task = await harness.store.createRegressionTask({
      rootPath: harness.rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: "h-other"
    });
    const { result, payload } = await callCancel(harness.client, { taskId: task.id });
    assert.equal(result.isError, true);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /不属于本机/);
    const stored = await harness.store.getRegressionTask(harness.rootPath, task.id);
    assert.equal(stored.status, "pending");
    assert.equal(stored.cancelSource, null);
  } finally {
    await harness.close();
  }
});

test("regression_task_cancel 跨主机认领任务 → 拒绝", async () => {
  const harness = await makeHarness();
  try {
    const task = await harness.store.createRegressionTask({
      rootPath: harness.rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest"
    });
    await harness.store.claimRegressionTask({
      rootPath: harness.rootPath,
      runnerId: "runner-other",
      platforms: ["android"],
      capabilities: ["android"],
      hostId: "h-other"
    });
    const { result, payload } = await callCancel(harness.client, { taskId: task.id });
    assert.equal(result.isError, true);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /不属于本机/);
  } finally {
    await harness.close();
  }
});

test("suite run --task 跨主机拒绝", async () => {
  const { store, runtime, task } = await setupRunnableTask({ targetHostId: "h-other" });
  const errors = [];
  const code = await runSuiteCommand(["run", "--task", task.id, "--device", "emulator-5554"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: () => {},
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /不属于本机/);
  assert.equal((await store.getRegressionTask(runtime.project.rootDir, task.id)).status, "pending");
});

test("suite run --task 未定向任务正常执行（不误拦）", async () => {
  const { store, runtime, task } = await setupRunnableTask({ targetHostId: null });
  const logs = [];
  const errors = [];
  const code = await runSuiteCommand(["run", "--task", task.id, "--device", "emulator-5554"], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 0, errors.join("\n"));
  const runs = await store.listSuiteRuns(runtime.project.rootDir, { taskId: task.id });
  assert.equal(runs.length, 1);
});

test("suite run --task 本机身份未知且任务定向 → exit 2", async () => {
  const { store, runtime, task } = await setupRunnableTask({ targetHostId: "h-other" });
  const stubRuntime = {
    project: runtime.project,
    store,
    hostIdentity: null
  };
  const errors = [];
  const code = await runSuiteCommand(["run", "--task", task.id, "--device", "emulator-5554"], {
    buildRuntime: async () => ({ runtime: stubRuntime, dispose: async () => {} }),
    log: () => {},
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /本机身份未知/);
  assert.equal((await store.getRegressionTask(runtime.project.rootDir, task.id)).status, "pending");
});
