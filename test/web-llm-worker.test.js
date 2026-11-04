import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { createWebJob } from "../dist/web/jobs.js";
import { runLlmWorkerOnce } from "../dist/web/llm/worker.js";

const NOW = Date.parse("2026-11-04T10:00:00.000Z");

function tools(overrides = {}) {
  return {
    adb: true,
    idb: false,
    simctl: false,
    ideviceId: false,
    appium: false,
    maestro: true,
    devicectl: false,
    ...overrides
  };
}

function device(serial = "pixel-1") {
  return {
    serial,
    name: "Pixel",
    model: "Pixel 7",
    osVersion: "14",
    platform: "android",
    kind: "device",
    state: "device"
  };
}

async function setup() {
  const store = new MemoryStore();
  const rootPath = `/tmp/aos-llm-worker-${randomUUID()}`;
  const project = await store.upsertProject({ rootPath, name: "llm" });
  await store.createWebProject({
    rootPath,
    name: "llm",
    normalizedName: `llm-${randomUUID().slice(0, 8)}`,
    platforms: ["android"],
    appPackage: "com.example.app",
    projectId: project.id
  });
  const excel = await store.createWebAsset({
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    sha256: "a".repeat(64),
    size: 1,
    storagePath: `${rootPath}/cases.xlsx`
  });
  const pkg = await store.createWebAsset({
    rootPath,
    kind: "package",
    filename: "app.apk",
    sha256: "b".repeat(64),
    size: 1,
    storagePath: `${rootPath}/app.apk`
  });
  await store.upsertWebRunner({
    hostId: "host-a",
    name: "runner-a",
    hostname: "host-a",
    platforms: ["android"],
    devices: [device()],
    tools: tools(),
    artifactBaseUrl: null,
    version: "0.1.0",
    instanceId: "runner-inst",
    gateway: {
      adbServer: "127.0.0.1:15037",
      appiumUrl: null,
      tunnelPort: 15037,
      ready: true,
      reportedAt: new Date(NOW).toISOString()
    },
    lastSeenAt: new Date(NOW - 1_000).toISOString()
  });
  const created = await createWebJob({
    store,
    rootPath,
    assignment: "auto",
    requirements: { platform: "android", deviceKind: "any" },
    excelAssetId: excel.id,
    packageAssetId: pkg.id,
    executionMode: "llm",
    scriptSetId: null,
    caseFilter: { modules: ["登录"], caseIds: [] },
    nowMs: NOW,
    runnerTtlMs: 90_000,
    reservationTtlMs: 60_000
  });
  return { store, rootPath, created, excel, pkg };
}

test("runLlmWorkerOnce: 只领 llm、按用例执行、回写状态并释放租约", async () => {
  const { store, rootPath, created } = await setup();
  const ingested = [];
  const result = await runLlmWorkerOnce({
    store,
    runnerId: "center-llm",
    instanceId: "center-inst",
    nowMs: NOW + 1_000,
    loadCases: async () => [
      { caseId: "TC-1", name: "登录", module: "登录", taskDesc: "登录成功" },
      { caseId: "TC-2", name: "登录二", module: "登录", taskDesc: "登录成功" }
    ],
    executeCase: async ({ testCase }) => ({
      caseId: testCase.caseId,
      status: testCase.caseId === "TC-1" ? "PASS" : "UNVERIFIED",
      durationMs: 1
    }),
    ingest: async ({ results }) => {
      ingested.push(results);
    }
  });
  assert.equal(result.claimed, 1);
  assert.deepEqual(result.jobs[0].results.map((entry) => entry.caseId), ["TC-1", "TC-2"]);
  assert.equal(result.jobs[0].status, "partial");
  assert.equal(ingested.length, 1);
  const stored = await store.getRegressionTask(rootPath, created.task.id);
  assert.equal(stored.status, "partial");
  assert.equal(stored.deviceLeaseId, null);
});

test("runLlmWorkerOnce: 任务预算耗尽 → SKIP/budget-exceeded", async () => {
  const { store } = await setup();
  const result = await runLlmWorkerOnce({
    store,
    runnerId: "center-llm",
    instanceId: "center-inst",
    nowMs: NOW + 1_000,
    jobMaxMs: 0,
    loadCases: async () => [
      { caseId: "TC-1", module: "登录", taskDesc: "登录成功" }
    ],
    executeCase: async () => {
      throw new Error("must not run");
    }
  });
  assert.equal(result.jobs[0].results[0].status, "SKIP");
  assert.equal(result.jobs[0].results[0].failureReason, "budget-exceeded");
});

test("runLlmWorkerOnce: 用例超时 → ERROR/case-timeout", async () => {
  const { store } = await setup();
  const result = await runLlmWorkerOnce({
    store,
    runnerId: "center-llm",
    instanceId: "center-inst",
    nowMs: NOW + 1_000,
    caseTimeoutMs: 10,
    loadCases: async () => [
      { caseId: "TC-1", module: "登录", taskDesc: "登录成功" }
    ],
    executeCase: async () => new Promise(() => undefined)
  });
  assert.equal(result.jobs[0].results[0].status, "ERROR");
  assert.equal(result.jobs[0].results[0].failureReason, "case-timeout");
});


