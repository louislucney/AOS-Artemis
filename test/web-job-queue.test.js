import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  assertWebJobCombination,
  canRunMaestroDiscovery,
  WebJobDispatchError
} from "../dist/web/job-spec.js";
import {
  assignPendingWebJobs,
  createWebJob,
  reassignExpiredWebJobs,
  recoverStaleWebJobs,
  releaseWebJob
} from "../dist/web/jobs.js";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const TTL = 90_000;
const LEASE_TTL = 60_000;

function makeTools(overrides = {}) {
  return {
    adb: false,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: false,
    devicectl: false,
    ...overrides
  };
}

function sim(serial, model, osVersion = "17.2") {
  return {
    serial,
    name: model,
    model,
    osVersion,
    platform: "ios",
    kind: "simulator",
    state: "Booted"
  };
}

function android(serial, model, osVersion = "14") {
  return {
    serial,
    name: model,
    model,
    osVersion,
    platform: "android",
    kind: "device",
    state: "device"
  };
}

function runner(hostId, devices, tools = makeTools({ maestro: true, adb: true, simctl: true })) {
  return {
    hostId,
    name: `runner-${hostId}`,
    hostname: `${hostId}.local`,
    platforms: [...new Set(devices.map((device) => device.platform))],
    devices,
    tools,
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: `inst-${hostId}`
  };
}

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const pg = new PostgresStore(pool);
  await pg.init();
  return [new MemoryStore(), pg];
}

async function makeFileStore() {
  const home = await mkdtemp(join(tmpdir(), "aos-web-job-file-"));
  const store = await FileStore.create({ homeDir: home });
  return { store, home };
}

/** 包装 store：在 acquireDeviceLeases 前记录一次 claim（模拟 I1 的租约前窗口）。 */
function delayedLeaseStore(store, claimInput) {
  const seen = { duringWindow: "unset" };
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "acquireDeviceLeases") {
        return async (input) => {
          seen.duringWindow = await target.claimWebJob(claimInput);
          return target.acquireDeviceLeases(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { store: proxy, seen };
}

/** 两个 assigner 同时到达 acquireDeviceLeases 的屏障。 */
function barrierStore(store) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "acquireDeviceLeases") {
        return async (input) => {
          arrivals += 1;
          if (arrivals >= 2) release();
          await gate;
          return target.acquireDeviceLeases(input);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function makeProject(store, label) {
  const rootPath = `/tmp/aos-web-job-${label}-${randomUUID()}`;
  const name = `${label}-${rootUUID()}`;
  const project = await store.upsertProject({ rootPath, name });
  await store.createWebProject({
    rootPath,
    name,
    normalizedName: name,
    platforms: ["android", "ios"],
    projectId: project.id
  });
  return rootPath;
}

function rootUUID() {
  return randomUUID().slice(0, 8);
}

async function addAsset(store, rootPath, kind, filename, metadata = {}) {
  return store.createWebAsset({
    rootPath,
    kind,
    filename,
    sha256: createHash("sha256").update(`${rootPath}:${kind}:${filename}`).digest("hex"),
    size: 128,
    storagePath: `/tmp/${kind}/${filename}`,
    metadata
  });
}

async function makeAssets(store, rootPath) {
  const excel = await addAsset(store, rootPath, "excel", "cases.xlsx");
  const pkg = await addAsset(store, rootPath, "package", "app.apk");
  const script = await addAsset(store, rootPath, "scripts", "flows.zip", {
    sourceExcelAssetId: excel.id,
    packageAssetId: pkg.id
  });
  return { excel, pkg, script };
}

function jobInput(store, rootPath, assets, overrides = {}) {
  return {
    store,
    rootPath,
    assignment: "auto",
    requirements: { platform: "android", deviceKind: "any" },
    excelAssetId: assets.excel.id,
    packageAssetId: assets.pkg.id,
    scriptSetId: assets.script.id,
    executionMode: "maestro",
    caseFilter: { modules: ["登录"], caseIds: [] },
    nowMs: NOW,
    runnerTtlMs: TTL,
    reservationTtlMs: LEASE_TTL,
    ...overrides
  };
}

async function online(store, hostId, devices) {
  return store.upsertWebRunner({ ...runner(hostId, devices), lastSeenAt: new Date(NOW - 1_000).toISOString() });
}

async function offline(store, hostId, devices) {
  return store.upsertWebRunner({
    ...runner(hostId, devices),
    lastSeenAt: new Date(NOW - 10 * 60_000).toISOString()
  });
}

test("自动下发：iOS 只选 iPhone，写入 jobSpec/deviceSerial 并生成有效租约（memory + pg-mem）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "auto-ios");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-iphone", [sim("sim-15", "iPhone 15")]);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);

    const result = await createWebJob(
      jobInput(store, rootPath, assets, { requirements: { platform: "ios", deviceKind: "simulator" } })
    );

    assert.deepEqual(result.assignment && {
      hostId: result.assignment.hostId,
      deviceSerial: result.assignment.deviceSerial
    }, { hostId: "host-iphone", deviceSerial: "sim-15" });
    assert.equal(result.pendingReason, null);
    assert.equal(result.task.deviceSerial, "sim-15");
    assert.equal(result.task.deviceLeaseId, "host-iphone:sim-15");
    assert.equal(result.task.jobSpec.targetHostId, "host-iphone");
    assert.equal(result.task.jobSpec.deviceSerial, "sim-15");
    assert.equal(result.task.jobSpec.assignment, "auto");
    assert.equal(result.task.jobSpec.assetSnapshot.length, 3);
    assert.deepEqual(
      result.task.jobSpec.assetSnapshot.map((entry) => entry.kind).sort(),
      ["excel", "package", "scripts"]
    );

    const lease = (await store.listDeviceLeases()).find(
      (entry) => entry.hostId === "host-iphone" && entry.serial === "sim-15"
    );
    assert.ok(lease);
    assert.equal(lease.taskId, result.task.id);
    assert.ok(Date.parse(lease.expiresAt) > NOW);
  }
});

test("manual 指定 host+device：校验归属、租约占用 409、成功后写入绑定", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "manual");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-iphone", [sim("sim-15", "iPhone 15")]);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);

    await assert.rejects(
      createWebJob(
        jobInput(store, rootPath, assets, {
          assignment: "manual",
          devicePinned: true,
          targetHostId: "host-pixel",
          deviceSerial: "sim-15",
          requirements: { platform: "android", deviceKind: "any" }
        })
      ),
      (error) => error instanceof WebJobDispatchError && error.code === "device-not-on-host"
    );

    await store.acquireDeviceLeases({
      hostId: "host-iphone",
      taskId: "other-task",
      serials: ["sim-15"],
      ttlMs: LEASE_TTL,
      at: new Date(NOW).toISOString()
    });

    await assert.rejects(
      createWebJob(
        jobInput(store, rootPath, assets, {
          assignment: "manual",
          devicePinned: true,
          targetHostId: "host-iphone",
          deviceSerial: "sim-15",
          requirements: { platform: "ios", deviceKind: "simulator" }
        })
      ),
      (error) =>
        error instanceof WebJobDispatchError &&
        error.code === "device-busy" &&
        error.status === 409
    );

    await store.releaseDeviceLeases({ hostId: "host-iphone", taskId: "other-task" });
    const ok = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        devicePinned: true,
        targetHostId: "host-iphone",
        deviceSerial: "sim-15",
        requirements: { platform: "ios", deviceKind: "simulator" }
      })
    );
    assert.equal(ok.assignment.hostId, "host-iphone");
    assert.equal(ok.assignment.deviceSerial, "sim-15");
    assert.equal(ok.task.targetHostId, "host-iphone");
    assert.equal(ok.task.deviceSerial, "sim-15");
  }
});

test("manual 只指定 host：同 host 上选分数最高的空闲设备", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "manual-host");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-ios", [sim("sim-se", "iPhone SE", "16.4"), sim("sim-15", "iPhone 15")]);

    const result = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        targetHostId: "host-ios",
        requirements: { platform: "ios", deviceKind: "simulator", deviceModel: ["iPhone 15"] }
      })
    );
    assert.equal(result.assignment.deviceSerial, "sim-15");
    assert.ok(result.assignment.score >= 20);
  }
});

test("claimWebJob 只命中对应 host/serial；重复与并发领取只有一个成功", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "claim");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));

    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-other",
        deviceSerial: "pixel-7",
        instanceId: "inst-a",
        nowMs: NOW
      }),
      null
    );
    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-pixel",
        deviceSerial: "pixel-8",
        instanceId: "inst-a",
        nowMs: NOW
      }),
      null
    );

    const [first, second] = await Promise.all([
      store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-a",
        nowMs: NOW
      }),
      store.claimWebJob({
        runnerId: "runner-b",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-b",
        nowMs: NOW
      })
    ]);
    const winners = [first, second].filter((entry) => entry !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0].rootPath, rootPath);
    assert.equal(winners[0].task.id, created.task.id);
    assert.equal(winners[0].task.status, "claimed");
    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-c",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-c",
        nowMs: NOW
      }),
      null
    );

    const plain = await store.createRegressionTask({
      rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: "host-pixel",
      deviceSerial: "pixel-7"
    });
    assert.ok(plain.jobSpec === null);
  }
});

test("host 队列暂停阻断 claimWebJob；恢复后可领", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "paused");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));

    await store.upsertHost({ id: "host-pixel", hostname: "host-pixel.local" });
    await store.setHostQueuePaused({ hostId: "host-pixel", paused: true, by: "test" });
    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-a",
        nowMs: NOW
      }),
      null
    );

    await store.setHostQueuePaused({ hostId: "host-pixel", paused: false, by: "test" });
    const claimed = await store.claimWebJob({
      runnerId: "runner-a",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-a",
      nowMs: NOW
    });
    assert.equal(claimed.task.id, created.task.id);
  }
});

test("自动任务预占过期 + runner 离线：释放租约并回到全局池重选", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "reassign-auto");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    const created = await createWebJob(
      jobInput(store, rootPath, assets, { reservationTtlMs: 10_000 })
    );
    assert.equal(created.task.targetHostId, "host-a");

    await offline(store, "host-a", [android("a-device", "Pixel 7")]);
    await online(store, "host-b", [android("b-device", "Pixel 8")]);

    const reassigned = await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 60_000,
      leaseTtlMs: 10_000,
      runnerTtlMs: TTL
    });
    assert.equal(reassigned, 1);

    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.targetHostId, "host-b");
    assert.equal(task.deviceSerial, "b-device");
    assert.equal(task.deviceLeaseId, "host-b:b-device");
    assert.equal(task.jobSpec.reassignCount, 1);
    const leases = await store.listDeviceLeases();
    assert.equal(leases.filter((lease) => lease.taskId === created.task.id).length, 1);
  }
});

test("manual 钉设备过期离线：等待不改派；4 轮后仍 pending，reassignCount 不变且无 unstable", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "reassign-pinned");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    const created = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        devicePinned: true,
        targetHostId: "host-a",
        deviceSerial: "a-device",
        reservationTtlMs: 10_000
      })
    );

    await offline(store, "host-a", [android("a-device", "Pixel 7")]);
    let task = created.task;
    for (let tick = 1; tick <= 4; tick += 1) {
      const processed = await reassignExpiredWebJobs({
        store,
        nowMs: NOW + 60_000 + tick * 30_000,
        leaseTtlMs: 10_000,
        runnerTtlMs: TTL
      });
      assert.equal(processed, 1);
      task = await store.getRegressionTask(rootPath, created.task.id);
      assert.equal(task.status, "pending");
      assert.equal(task.targetHostId, "host-a");
      assert.equal(task.deviceSerial, "a-device");
      assert.equal(task.deviceLeaseId, null);
      assert.equal(task.jobSpec.reassignCount, 0);
      assert.equal(task.jobSpec.pinnedWaitCount, tick);
      assert.notEqual(task.jobSpec.assignmentError.code, "unstable-assignment");
      assert.match(task.jobSpec.assignmentError.message, /钉住/);
      assert.equal((await store.listDeviceLeases()).length, 0);
    }
  }
});

test("未钉设备改派超过 3 次判 failed：无法稳定分配", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "reassign-cap");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    const created = await createWebJob(
      jobInput(store, rootPath, assets, { reservationTtlMs: 10_000 })
    );
    await store.updateRegressionTask(rootPath, created.task.id, {
      jobSpec: { ...created.task.jobSpec, reassignCount: 3 }
    });
    await offline(store, "host-a", [android("a-device", "Pixel 7")]);

    const processed = await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 60_000,
      leaseTtlMs: 10_000,
      runnerTtlMs: TTL
    });
    assert.equal(processed, 1);
    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "failed");
    assert.equal(task.jobSpec.reassignCount, 4);
    assert.equal(task.jobSpec.assignmentError.code, "unstable-assignment");
    assert.match(task.jobSpec.assignmentError.message, /无法稳定分配/);
  }
});

test("manual 未钉设备过期：保留 host、清空 serial；恢复在线后 assign 重新绑定", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "reassign-manual");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    const created = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        targetHostId: "host-a",
        reservationTtlMs: 10_000
      })
    );
    assert.equal(created.task.deviceSerial, "a-device");

    await offline(store, "host-a", [android("a-device", "Pixel 7")]);
    await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 60_000,
      leaseTtlMs: 10_000,
      runnerTtlMs: TTL
    });
    let task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "pending");
    assert.equal(task.targetHostId, "host-a");
    assert.equal(task.deviceSerial, null);
    assert.match(task.jobSpec.assignmentError.message, /host/);
    assert.equal((await store.listDeviceLeases()).length, 0);

    const boundWhileOffline = await assignPendingWebJobs({
      store,
      nowMs: NOW + 61_000,
      runnerTtlMs: TTL
    });
    assert.equal(boundWhileOffline, 0);

    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    const bound = await assignPendingWebJobs({
      store,
      nowMs: NOW + 62_000,
      runnerTtlMs: TTL
    });
    assert.equal(bound, 1);
    task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.targetHostId, "host-a");
    assert.equal(task.deviceSerial, "a-device");
    assert.equal(task.jobSpec.assignmentError, null);
    assert.ok(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-a",
        deviceSerial: "a-device",
        instanceId: "inst-a",
        nowMs: NOW
      })
    );
  }
});

test("manual host 离线创建 pending；host 上线后 assign 绑定并可 claim", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "offline-pending");
    const assets = await makeAssets(store, rootPath);

    const created = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        targetHostId: "host-x",
        requirements: { platform: "android", deviceKind: "any" }
      })
    );
    assert.equal(created.assignment, null);
    assert.match(created.pendingReason, /离线|未注册/);
    assert.equal(created.task.status, "pending");
    assert.equal(created.task.targetHostId, "host-x");
    assert.equal(created.task.deviceSerial, null);
    assert.equal(created.task.deviceLeaseId, null);
    assert.ok(created.task.jobSpec.assignmentError);

    const pending = await store.listPendingWebJobs();
    assert.ok(pending.some((entry) => entry.task.id === created.task.id && entry.rootPath === rootPath));

    await online(store, "host-x", [android("x-device", "Pixel 7")]);
    const bound = await assignPendingWebJobs({ store, nowMs: NOW + 1_000, runnerTtlMs: TTL });
    assert.equal(bound, 1);
    const claimed = await store.claimWebJob({
      runnerId: "runner-x",
      hostId: "host-x",
      deviceSerial: "x-device",
      instanceId: "inst-x",
      nowMs: NOW
    });
    assert.equal(claimed.task.id, created.task.id);
  }
});

test("auto 无候选保持 pending 且原因可见；候选出现后 assign 绑定", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "no-candidate");
    const assets = await makeAssets(store, rootPath);
    const created = await createWebJob(jobInput(store, rootPath, assets));
    assert.equal(created.assignment, null);
    assert.equal(created.task.status, "pending");
    assert.equal(created.task.deviceSerial, null);
    assert.equal(created.task.jobSpec.assignmentError.code, "no-runner");
    assert.match(created.pendingReason, /没有在线/);

    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const bound = await assignPendingWebJobs({ store, nowMs: NOW + 2_000, runnerTtlMs: TTL });
    assert.equal(bound, 1);
    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.targetHostId, "host-pixel");
    assert.equal(task.deviceSerial, "pixel-7");
    assert.equal(task.jobSpec.assignmentError, null);
  }
});

test("组合校验：iOS Maestro 仅允许 simulator；ios×device/any×maestro 拒绝，ios×device×llm 允许", async () => {
  const combination = (deviceKind, executionMode) => ({
    assignment: "auto",
    requirements: { platform: "ios", deviceKind },
    executionMode
  });
  for (const deviceKind of ["any", "device"]) {
    assert.throws(
      () => assertWebJobCombination(combination(deviceKind, "maestro")),
      (error) =>
        error instanceof WebJobDispatchError &&
        error.code === "ios-maestro-requires-simulator" &&
        error.status === 400
    );
  }
  const simulator = assertWebJobCombination(combination("simulator", "maestro"));
  assert.equal(simulator.requirements.deviceKind, "simulator");
  const llmReal = assertWebJobCombination(combination("device", "llm"));
  assert.equal(llmReal.executionMode, "llm");

  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "combo");
    const assets = await makeAssets(store, rootPath);

    await assert.rejects(
      createWebJob(
        jobInput(store, rootPath, assets, {
          requirements: { platform: "ios", deviceKind: "device" },
          executionMode: "maestro"
        })
      ),
      (error) =>
        error instanceof WebJobDispatchError && error.code === "ios-maestro-requires-simulator"
    );
    await assert.rejects(
      createWebJob(
        jobInput(store, rootPath, assets, {
          requirements: { platform: "ios", deviceKind: "any" },
          executionMode: "maestro"
        })
      ),
      (error) =>
        error instanceof WebJobDispatchError && error.code === "ios-maestro-requires-simulator"
    );

    const llm = await createWebJob(
      jobInput(store, rootPath, assets, {
        requirements: { platform: "ios", deviceKind: "device" },
        executionMode: "llm"
      })
    );
    assert.equal(llm.task.status, "pending");
  }

  assert.equal(canRunMaestroDiscovery([]), false);
  assert.equal(canRunMaestroDiscovery([{ ...android("a", "Pixel"), platform: "ios", kind: "device" }]), false);
  assert.equal(canRunMaestroDiscovery([sim("s", "iPhone 15")]), true);
  assert.equal(canRunMaestroDiscovery([android("a", "Pixel 7")]), true);
});

test("脚本集资产精确匹配：不一致拒绝；历史版本精确匹配允许；allowStaleScript 放行", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "script-match");
    const v1 = await addAsset(store, rootPath, "excel", "cases-v1.xlsx");
    const pkg = await addAsset(store, rootPath, "package", "app.apk");
    const script = await addAsset(store, rootPath, "scripts", "flows.zip", {
      sourceExcelAssetId: v1.id,
      packageAssetId: pkg.id
    });
    const v2 = await addAsset(store, rootPath, "excel", "cases-v2.xlsx");
    const assets = { excel: v1, pkg, script };

    await assert.rejects(
      createWebJob(jobInput(store, rootPath, assets, { excelAssetId: v2.id, scriptSetId: script.id })),
      (error) => error instanceof WebJobDispatchError && error.code === "script-set-mismatch"
    );

    const historical = await createWebJob(
      jobInput(store, rootPath, assets, {
        excelAssetId: v1.id,
        scriptSetId: script.id,
        allowStaleScript: false
      })
    );
    assert.equal(historical.task.jobSpec.excelAssetId, v1.id);

    const stale = await createWebJob(
      jobInput(store, rootPath, assets, {
        excelAssetId: v2.id,
        scriptSetId: script.id,
        allowStaleScript: true
      })
    );
    assert.equal(stale.task.jobSpec.excelAssetId, v2.id);
    assert.equal(stale.task.jobSpec.allowStaleScript, true);

    await assert.rejects(
      createWebJob(jobInput(store, rootPath, assets, { scriptSetId: v1.id })),
      (error) => error instanceof WebJobDispatchError && error.code === "asset-kind-mismatch"
    );
  }
});

test("钉设备等待：无租约 claim 返回 null；host 上线 assign 预占后可 claim，auto 不能抢同一设备", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "pinned-lease");
    const assets = await makeAssets(store, rootPath);
    const created = await createWebJob(
      jobInput(store, rootPath, assets, {
        assignment: "manual",
        devicePinned: true,
        targetHostId: "host-a",
        deviceSerial: "a-device",
        requirements: { platform: "android", deviceKind: "any" }
      })
    );
    assert.equal(created.task.status, "pending");
    assert.equal(created.task.deviceSerial, "a-device");
    assert.equal((await store.listDeviceLeases()).length, 0);

    const claimInput = {
      runnerId: "runner-a",
      hostId: "host-a",
      deviceSerial: "a-device",
      instanceId: "inst-a"
    };
    assert.equal(await store.claimWebJob(claimInput), null);

    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    assert.equal(await store.claimWebJob(claimInput), null, "host 在线但还没有租约时仍不可领");

    const bound = await assignPendingWebJobs({ store, nowMs: NOW + 1_000, runnerTtlMs: TTL });
    assert.equal(bound, 1);
    assert.equal((await store.listDeviceLeases()).length, 1);

    const auto = await createWebJob(
      jobInput(store, rootPath, assets, { requirements: { platform: "android", deviceKind: "any" } })
    );
    assert.equal(auto.assignment, null, "auto 任务不能抢已被预占的同一设备");
    assert.equal(auto.task.deviceSerial, null);

    const claimed = await store.claimWebJob(claimInput);
    assert.equal(claimed.task.id, created.task.id);
  }
});

test("createWebJob 安全顺序：租约写入前任务不可领取（延迟租约窗口）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "lease-window");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const { store: proxied, seen } = delayedLeaseStore(store, {
      runnerId: "runner-a",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-a"
    });

    const created = await createWebJob(jobInput(proxied, rootPath, assets));
    assert.equal(seen.duringWindow, null, "租约写入前 claim 必须返回 null");
    assert.equal(created.task.deviceSerial, "pixel-7");
    assert.equal(created.task.deviceLeaseId, "host-pixel:pixel-7");

    const claimed = await store.claimWebJob({
      runnerId: "runner-a",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-a",
      nowMs: NOW
    });
    assert.equal(claimed.task.id, created.task.id);
  }
});

test("两个 assigner 并发只能绑定一个设备（deviceSerial 空 CAS）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "assign-race");
    const assets = await makeAssets(store, rootPath);
    const created = await createWebJob(jobInput(store, rootPath, assets));
    assert.equal(created.assignment, null);

    await online(store, "host-a", [
      android("d-1", "Pixel 7"),
      android("d-2", "Pixel 7")
    ]);
    const proxied = barrierStore(store);
    const [first, second] = await Promise.all([
      assignPendingWebJobs({
        store: proxied,
        nowMs: NOW + 1_000,
        runnerTtlMs: TTL,
        rng: () => 0
      }),
      assignPendingWebJobs({
        store: proxied,
        nowMs: NOW + 1_000,
        runnerTtlMs: TTL,
        rng: () => 0.999
      })
    ]);
    assert.equal(first + second, 1);

    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.ok(task.deviceSerial === "d-1" || task.deviceSerial === "d-2");
    const leases = await store.listDeviceLeases();
    assert.equal(leases.length, 1);
    assert.equal(leases[0].serial, task.deviceSerial);
    assert.equal(leases[0].taskId, task.id);
  }
});

test("FileStore.claimWebJob：跨 bucket 查找、host 队列暂停阻断", async () => {
  const { store, home } = await makeFileStore();
  try {
    const rootA = await makeProject(store, "file-a");
    const assetsA = await makeAssets(store, rootA);
    const rootB = await makeProject(store, "file-b");
    const assetsB = await makeAssets(store, rootB);
    await online(store, "host-a", [android("a-device", "Pixel 7")]);
    await online(store, "host-b", [android("b-device", "Pixel 7")]);
    const jobA = await createWebJob(jobInput(store, rootA, assetsA));
    const jobB = await createWebJob(jobInput(store, rootB, assetsB));

    const claimedB = await store.claimWebJob({
      runnerId: "runner-b",
      hostId: "host-b",
      deviceSerial: "b-device",
      instanceId: "inst-b",
      nowMs: NOW
    });
    assert.equal(claimedB.task.id, jobB.task.id);
    assert.equal(claimedB.rootPath, rootB);

    await store.upsertHost({ id: "host-a", hostname: "host-a.local" });
    await store.setHostQueuePaused({ hostId: "host-a", paused: true, by: "test" });
    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-a",
        deviceSerial: "a-device",
        instanceId: "inst-a",
        nowMs: NOW
      }),
      null
    );

    await store.setHostQueuePaused({ hostId: "host-a", paused: false, by: "test" });
    const claimedA = await store.claimWebJob({
      runnerId: "runner-a",
      hostId: "host-a",
      deviceSerial: "a-device",
      instanceId: "inst-a",
      nowMs: NOW
    });
    assert.equal(claimedA.task.id, jobA.task.id);
    assert.equal(claimedA.rootPath, rootA);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("脚本集未声明 sourceExcelAssetId/packageAssetId → script-set-unverified；allowStaleScript 放行", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "script-unverified");
    const assets = await makeAssets(store, rootPath);
    const bareScript = await addAsset(store, rootPath, "scripts", "bare.zip");

    await assert.rejects(
      createWebJob(jobInput(store, rootPath, assets, { scriptSetId: bareScript.id })),
      (error) =>
        error instanceof WebJobDispatchError &&
        error.code === "script-set-unverified" &&
        error.status === 409
    );

    const allowed = await createWebJob(
      jobInput(store, rootPath, assets, { scriptSetId: bareScript.id, allowStaleScript: true })
    );
    assert.equal(allowed.task.jobSpec.scriptSetId, bareScript.id);
    assert.equal(allowed.task.jobSpec.allowStaleScript, true);
  }
});

test("claimWebJob 用显式 nowMs 判定租约过期（与墙钟无关）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "claim-clock");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));
    const input = {
      runnerId: "runner-a",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-a"
    };

    assert.equal(
      await store.claimWebJob({ ...input, nowMs: NOW + 120_000 }),
      null,
      "租约在 NOW+60s 到期；NOW+120s 领取必须失败"
    );
    const claimed = await store.claimWebJob({ ...input, nowMs: NOW + 1_000 });
    assert.equal(claimed.task.id, created.task.id);
    assert.equal(claimed.task.claimedAt, new Date(NOW + 1_000).toISOString());
  }
});

test("无租约的高优先级等待任务不会挡住租约持有者（先按租约过滤再排序）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "claim-filter");
    const older = await store.createRegressionTask({
      rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: "host-a",
      deviceSerial: "a-device",
      priority: 10,
      jobSpec: { kind: "web-test", assignment: "manual" }
    });
    const newer = await store.createRegressionTask({
      rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: "host-a",
      deviceSerial: "a-device",
      priority: 1,
      jobSpec: { kind: "web-test", assignment: "manual" }
    });
    await store.acquireDeviceLeases({
      hostId: "host-a",
      taskId: newer.id,
      serials: ["a-device"],
      ttlMs: 60_000,
      at: new Date(NOW).toISOString()
    });

    const claimed = await store.claimWebJob({
      runnerId: "runner-a",
      hostId: "host-a",
      deviceSerial: "a-device",
      instanceId: "inst-a",
      nowMs: NOW
    });
    assert.equal(claimed.task.id, newer.id);
    assert.equal((await store.getRegressionTask(rootPath, older.id)).status, "pending");
  }
});

test("创建租约窗口内 assign/listPending 跳过 binding 任务", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "binding-window");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const seen = { assignBound: -1, pending: -1 };
    const proxy = new Proxy(store, {
      get(target, prop) {
        if (prop === "acquireDeviceLeases") {
          return async (input) => {
            seen.pending = (await target.listPendingWebJobs()).length;
            seen.assignBound = await assignPendingWebJobs({
              store: target,
              nowMs: NOW,
              runnerTtlMs: TTL
            });
            return target.acquireDeviceLeases(input);
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    const created = await createWebJob(jobInput(proxy, rootPath, assets));
    assert.equal(seen.pending, 0, "binding 任务不进 listPendingWebJobs");
    assert.equal(seen.assignBound, 0, "并发 assign 不得绑定创建中的任务");
    assert.equal(created.task.deviceSerial, "pixel-7");
    assert.notEqual(created.task.jobSpec.binding, true);
    const pendingAfter = await store.listPendingWebJobs();
    assert.equal(pendingAfter.length, 1, "绑定完成后回到 pending 列表");
    assert.notEqual(pendingAfter[0].task.jobSpec.binding, true);
  }
});

test("取消 web 任务释放设备租约并保留历史", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "cancel");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));

    const released = await releaseWebJob({
      store,
      rootPath,
      taskId: created.task.id,
      reason: "cancelled"
    });
    assert.equal(released, true);
    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "cancelled");
    assert.equal((await store.listDeviceLeases()).length, 0);
    assert.ok(task.jobSpec !== null);
    assert.equal(task.deviceSerial, "pixel-7");

    assert.equal(
      await releaseWebJob({ store, rootPath, taskId: "missing", reason: "cancelled" }),
      false
    );
  }
});

test("项目 suite runner 不领取 web 任务；releaseStaleClaims 不回收 web job（C1）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "isolation");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));
    assert.equal(created.task.status, "pending");

    const projectClaim = await store.claimRegressionTask({
      rootPath,
      runnerId: "project-suite-runner",
      platforms: ["android"],
      capabilities: ["android"],
      hostId: null
    });
    assert.equal(projectClaim, null, "claimRegressionTask 必须排除 job_spec 行");
    const untouched = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(untouched.status, "pending");

    const webClaim = await store.claimWebJob({
      runnerId: "web-runner",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-pixel",
      nowMs: NOW + 1_000
    });
    assert.equal(webClaim?.task.id, created.task.id, "web 领取仍可用");

    const stale = await store.releaseStaleClaims({
      rootPath,
      offlineBefore: new Date(NOW + 10 * 60_000).toISOString(),
      claimedBefore: new Date(NOW + 10 * 60_000).toISOString()
    });
    assert.equal(stale, 0, "项目 runner 的失联回收不得回收 web job");
    assert.equal((await store.getRegressionTask(rootPath, created.task.id)).status, "claimed");
  }
});

test("失联回收：实例被接管/进度超时 → pending 并释放租约；自身实例跳过（I2）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "recover");
    const assets = await makeAssets(store, rootPath);
    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    const created = await createWebJob(jobInput(store, rootPath, assets));
    const claimed = await store.claimWebJob({
      runnerId: "web-runner",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-old",
      nowMs: NOW + 1_000
    });
    assert.ok(claimed);

    const skipped = await recoverStaleWebJobs({
      store,
      nowMs: NOW + 2_000,
      staleMs: 0,
      runnerTtlMs: TTL,
      hostId: "host-pixel",
      instanceId: "inst-old"
    });
    assert.equal(skipped, 0, "本进程实例不回收");

    const recovered = await recoverStaleWebJobs({
      store,
      nowMs: NOW + 2_000,
      staleMs: 0,
      runnerTtlMs: TTL
    });
    assert.equal(recovered, 1);
    const task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "pending");
    assert.equal(task.claimedBy, null);
    assert.equal(task.claimedHostId, null);
    assert.equal(task.claimedInstanceId, null);
    assert.equal(task.startedAt, null);
    assert.equal(task.deviceLeaseId, null);
    assert.equal(task.jobSpec.assignmentError.code, "stale-claim");
    assert.equal((await store.listDeviceLeases()).length, 0);
  }
});

test("队列暂停：assign/reassign 跳过暂停 host，且不计 reassignCount（I3）", async () => {
  for (const store of await makeStores()) {
    const rootPath = await makeProject(store, "paused");
    const assets = await makeAssets(store, rootPath);
    const waiting = await createWebJob(jobInput(store, rootPath, assets));
    assert.equal(waiting.assignment, null, "无执行机时先建等待任务");

    await online(store, "host-pixel", [android("pixel-7", "Pixel 7")]);
    await store.upsertHost({ id: "host-pixel", hostname: "pixel.local" });
    await store.setHostQueuePaused({ hostId: "host-pixel", paused: true, by: "tester" });

    const assigned = await assignPendingWebJobs({
      store,
      nowMs: NOW + 60_000,
      runnerTtlMs: TTL,
      reservationTtlMs: LEASE_TTL
    });
    assert.equal(assigned, 0, "暂停 host 不参与补绑");
    assert.equal((await store.getRegressionTask(rootPath, waiting.task.id)).status, "pending");

    await store.setHostQueuePaused({ hostId: "host-pixel", paused: false, by: "tester" });
    assert.equal(
      await assignPendingWebJobs({
        store,
        nowMs: NOW + 60_000,
        runnerTtlMs: TTL,
        reservationTtlMs: LEASE_TTL
      }),
      1
    );
    const bound = await store.getRegressionTask(rootPath, waiting.task.id);
    assert.equal(bound.deviceSerial, "pixel-7");
    const before = bound.jobSpec.reassignCount ?? 0;

    await store.setHostQueuePaused({ hostId: "host-pixel", paused: true, by: "tester" });
    const processed = await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 10 * 60_000,
      leaseTtlMs: LEASE_TTL,
      runnerTtlMs: TTL
    });
    assert.equal(processed, 0, "暂停 host 的绑定不回池");
    const after = await store.getRegressionTask(rootPath, waiting.task.id);
    assert.equal(after.status, "pending");
    assert.equal(after.deviceSerial, "pixel-7");
    assert.equal(after.jobSpec.reassignCount ?? 0, before, "暂停不增加 reassignCount");
  }
});
