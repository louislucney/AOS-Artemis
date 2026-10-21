import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { runSuiteCommand } from "../dist/suite-command.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempProject,
  SuiteProxy,
  TEST_HOST_IDENTITY
} from "./helpers.js";

const FEATURE_KEY = "f-登录-lease001";
const DEVICE = "emulator-5554";

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

async function setupRunnableTask({ runError = null } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const proxy = new SuiteProxy({
    statuses: { "trace-1": { status: "completed" } },
    runError
  });
  const { runtime } = await loadTestRuntime(dir, { proxy, store });
  await runtime.store.upsertProject({ rootPath: runtime.project.rootDir, name: "p" });
  const archiveDir = path.join(runtime.configDirAbs, "design", "case-sets");
  fs.mkdirSync(archiveDir, { recursive: true });
  const jsonPath = path.join(archiveDir, "20261021T100000_登录.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ flows: [caseEntry(1, FEATURE_KEY)] }), "utf-8");
  const set = await store.recordCaseSet({
    rootPath: runtime.project.rootDir,
    source: "pen:a.pen",
    basename: "tests",
    features: [
      {
        key: FEATURE_KEY,
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
    rootPath: runtime.project.rootDir,
    refs: [{ caseSetId: set.id, featureKey: FEATURE_KEY }],
    platforms: ["android"],
    baseline: "latest",
    createdBy: "cli"
  });
  return { store: runtime.store, runtime, task, proxy };
}

function runTask(runtime, taskId, extra = {}) {
  const logs = [];
  const errors = [];
  return runSuiteCommand(["run", "--task", taskId, "--device", DEVICE], {
    buildRuntime: async () => ({ runtime, dispose: async () => {} }),
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    env: {},
    ...extra
  }).then((code) => ({ code, logs, errors }));
}

test("手动 suite run --task：设备被租约占用 → exit 2 且不执行", async () => {
  const { store, runtime, task, proxy } = await setupRunnableTask();
  const hostId = TEST_HOST_IDENTITY.id;
  const held = await store.acquireDeviceLeases({
    hostId,
    taskId: "other-task",
    serials: [DEVICE],
    ttlMs: 600_000
  });
  assert.equal(held.ok, true);

  const busy = await runTask(runtime, task.id);
  assert.equal(busy.code, 2);
  assert.match(busy.errors.join("\n"), /设备被占用：emulator-5554（先等待或释放租约）/);
  assert.equal(proxy.submitted, 0, "占用期间不调用 mobile_run_task");
  assert.equal((await store.listSuiteRuns(runtime.project.rootDir, { taskId: task.id })).length, 0);
  assert.equal((await store.getRegressionTask(runtime.project.rootDir, task.id)).status, "pending");

  assert.equal(await store.releaseDeviceLeases({ hostId, taskId: "other-task" }), 1);
  const proceeds = await runTask(runtime, task.id);
  assert.equal(proceeds.code, 0, proceeds.errors.join("\n"));
  assert.equal((await store.listSuiteRuns(runtime.project.rootDir, { taskId: task.id })).length, 1);

  const probe = await store.acquireDeviceLeases({ hostId, taskId: "probe", serials: [DEVICE] });
  assert.equal(probe.ok, true, "执行结束后释放租约");
  await store.releaseDeviceLeases({ hostId, taskId: "probe" });
});

test("手动 suite run --task：执行失败也在 finally 释放租约", async () => {
  const { store, runtime, task } = await setupRunnableTask({ runError: "device not found" });
  const hostId = TEST_HOST_IDENTITY.id;

  const failed = await runTask(runtime, task.id);
  assert.equal(failed.code, 2);
  assert.equal((await store.listSuiteRuns(runtime.project.rootDir, { taskId: task.id })).length, 1);

  const probe = await store.acquireDeviceLeases({ hostId, taskId: "probe", serials: [DEVICE] });
  assert.equal(probe.ok, true, "失败路径同样释放租约");
  await store.releaseDeviceLeases({ hostId, taskId: "probe" });
});

test("runner 内嵌执行（leasesHeld）不重复获取或释放 runner 持有的租约", async () => {
  const { store, runtime, task } = await setupRunnableTask();
  const hostId = TEST_HOST_IDENTITY.id;
  const held = await store.acquireDeviceLeases({
    hostId,
    taskId: task.id,
    serials: [DEVICE],
    ttlMs: 600_000
  });
  assert.equal(held.ok, true);

  const { code } = await runTask(runtime, task.id, { leasesHeld: true });
  assert.equal(code, 0);

  const probe = await store.acquireDeviceLeases({ hostId, taskId: "probe", serials: [DEVICE] });
  assert.equal(probe.ok, false, "租约仍由 runner 持有，内层未释放");
  assert.deepEqual(probe.busy, [DEVICE]);
  assert.equal(await store.releaseDeviceLeases({ hostId, taskId: task.id }), 1);
});

test("手动执行超过 TTL 时按 TTL/3 续租，竞争获取仍 busy", async () => {
  const { store, runtime, task, proxy } = await setupRunnableTask();
  const hostId = TEST_HOST_IDENTITY.id;
  let clock = Date.parse("2026-10-21T10:00:00.000Z");
  let captured = null;
  let cleared = false;
  const leaseTimers = {
    now: () => clock,
    setInterval: (callback, ms) => {
      captured = { callback, ms };
      return "manual-timer";
    },
    clearInterval: (handle) => {
      assert.equal(handle, "manual-timer");
      cleared = true;
    }
  };
  let busyDuringRun = null;
  const baseCall = proxy.callTool.bind(proxy);
  proxy.callTool = async (name, args) => {
    if (name === "mobile_run_task" && captured !== null) {
      clock += 100_000;
      await captured.callback();
      const competing = await store.acquireDeviceLeases({
        hostId,
        taskId: "competing",
        serials: [DEVICE],
        at: new Date(clock).toISOString()
      });
      busyDuringRun = competing.ok ? null : competing.busy;
    }
    return baseCall(name, args);
  };

  const result = await runTask(runtime, task.id, {
    env: { AOS_DEVICE_LEASE_MS: "90000" },
    leaseTimers
  });
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.ok(captured);
  assert.equal(captured.ms, 30_000);
  assert.equal(cleared, true, "finally 清理续租定时器");
  assert.deepEqual(busyDuringRun, [DEVICE], "续租后竞争获取仍 busy");

  const after = await store.acquireDeviceLeases({
    hostId,
    taskId: "after",
    serials: [DEVICE],
    at: new Date(clock).toISOString()
  });
  assert.equal(after.ok, true, "执行结束后释放手动租约");
});

test("runner 持有同任务租约时手动执行 exit 2，runner 租约保留", async () => {
  const { store, runtime, task } = await setupRunnableTask();
  const hostId = TEST_HOST_IDENTITY.id;
  const held = await store.acquireDeviceLeases({
    hostId,
    taskId: task.id,
    serials: [DEVICE],
    ttlMs: 600_000
  });
  assert.equal(held.ok, true);

  const busy = await runTask(runtime, task.id);
  assert.equal(busy.code, 2);
  assert.match(busy.errors.join("\n"), /设备被占用：emulator-5554/);

  const probe = await store.acquireDeviceLeases({ hostId, taskId: "probe", serials: [DEVICE] });
  assert.equal(probe.ok, false, "runner 的同任务租约未被手动执行删除");
  assert.deepEqual(probe.busy, [DEVICE]);
  assert.equal(await store.releaseDeviceLeases({ hostId, taskId: task.id }), 1);
});

test("手动执行只释放 manual:* 租约，不碰 runner 的同任务其他设备租约", async () => {
  const { store, runtime, task } = await setupRunnableTask();
  const hostId = TEST_HOST_IDENTITY.id;
  const runnerOnlySerial = "udid-runner-only";
  const held = await store.acquireDeviceLeases({
    hostId,
    taskId: task.id,
    serials: [runnerOnlySerial],
    ttlMs: 600_000
  });
  assert.equal(held.ok, true);

  const run = await runTask(runtime, task.id);
  assert.equal(run.code, 0, run.errors.join("\n"));

  const runnerLease = await store.acquireDeviceLeases({
    hostId,
    taskId: "probe",
    serials: [runnerOnlySerial]
  });
  assert.equal(runnerLease.ok, false, "runner 租约仍在");
  assert.deepEqual(runnerLease.busy, [runnerOnlySerial]);

  const manualLease = await store.acquireDeviceLeases({ hostId, taskId: "probe-2", serials: [DEVICE] });
  assert.equal(manualLease.ok, true, "manual:* 租约已释放");
  await store.releaseDeviceLeases({ hostId, taskId: task.id });
  await store.releaseDeviceLeases({ hostId, taskId: "probe-2" });
});
