import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { newDb } from "pg-mem";

import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import {
  canRunMaestroDiscovery,
  WebJobDispatchError
} from "../dist/web/job-spec.js";
import {
  assignPendingWebJobs,
  createWebJob,
  reassignExpiredWebJobs,
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
      jobInput(store, rootPath, assets, { requirements: { platform: "ios", deviceKind: "any" } })
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
          requirements: { platform: "ios", deviceKind: "any" }
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
        requirements: { platform: "ios", deviceKind: "any" }
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
        instanceId: "inst-a"
      }),
      null
    );
    assert.equal(
      await store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-pixel",
        deviceSerial: "pixel-8",
        instanceId: "inst-a"
      }),
      null
    );

    const [first, second] = await Promise.all([
      store.claimWebJob({
        runnerId: "runner-a",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-a"
      }),
      store.claimWebJob({
        runnerId: "runner-b",
        hostId: "host-pixel",
        deviceSerial: "pixel-7",
        instanceId: "inst-b"
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
        instanceId: "inst-c"
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
        instanceId: "inst-a"
      }),
      null
    );

    await store.setHostQueuePaused({ hostId: "host-pixel", paused: false, by: "test" });
    const claimed = await store.claimWebJob({
      runnerId: "runner-a",
      hostId: "host-pixel",
      deviceSerial: "pixel-7",
      instanceId: "inst-a"
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

test("manual 钉设备过期离线：保留 host+serial 等待并记录告警；改派超限判 failed", async () => {
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
    const processed = await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 60_000,
      leaseTtlMs: 10_000,
      runnerTtlMs: TTL
    });
    assert.equal(processed, 1);

    let task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "pending");
    assert.equal(task.targetHostId, "host-a");
    assert.equal(task.deviceSerial, "a-device");
    assert.equal(task.deviceLeaseId, null);
    assert.equal(task.jobSpec.assignmentError.code, "host-offline");
    assert.match(task.jobSpec.assignmentError.message, /钉住/);
    assert.equal((await store.listDeviceLeases()).length, 0);

    await store.updateRegressionTask(rootPath, created.task.id, {
      jobSpec: {
        ...task.jobSpec,
        reassignCount: 3,
        assignmentError: null
      }
    });
    const again = await reassignExpiredWebJobs({
      store,
      nowMs: NOW + 120_000,
      leaseTtlMs: 10_000,
      runnerTtlMs: TTL
    });
    assert.equal(again, 1);
    task = await store.getRegressionTask(rootPath, created.task.id);
    assert.equal(task.status, "failed");
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
        instanceId: "inst-a"
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
      instanceId: "inst-x"
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

test("组合校验：ios×device×maestro 拒绝，ios×device×llm 允许；无发现设备只能 draft", async () => {
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
        error instanceof WebJobDispatchError && error.code === "ios-real-device-requires-llm"
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
