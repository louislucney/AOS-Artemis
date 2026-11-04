import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { createWebJob } from "../dist/web/jobs.js";
import { parseWebJobSpec } from "../dist/web/job-spec.js";
import { ingestLlmResults } from "../dist/web/llm/ingest.js";
import { runLlmWorkerOnce } from "../dist/web/llm/worker.js";
import { readWebJobResult } from "../dist/web/results.js";

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
  await mkdir(rootPath, { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["用例编号", "用例名称", "步骤", "期望结果"]);
  sheet.addRow(["TC-1", "登录", "1. 启动 App", "登录成功"]);
  const excel = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer())
  });
  await store.saveExcelMapping({
    rootPath,
    assetId: excel.id,
    sheetName: "Sheet1",
    headerFingerprint: "fp-1",
    columnMap: { caseId: "用例编号", name: "用例名称", steps: "步骤", expected: "期望结果" }
  });
  const pkg = await storeWebAsset({
    store,
    rootPath,
    kind: "package",
    filename: "app.apk",
    buffer: Buffer.from("fake-apk")
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
  let prepared = 0;
  const result = await runLlmWorkerOnce({
    store,
    runnerId: "center-llm",
    instanceId: "center-inst",
    nowMs: NOW + 1_000,
    prepareJob: async () => {
      prepared += 1;
      return { prepared: true };
    },
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
  assert.equal(prepared, 1, "每 job 只 prepare 一次");
  assert.equal(ingested.length, 1);
  const stored = await store.getRegressionTask(rootPath, created.task.id);
  assert.equal(stored.status, "partial");
  assert.equal(stored.deviceLeaseId, null);
});

test("ingestLlmResults: center-only UNVERIFIED 落库并聚合 partial", async () => {
  const { store, rootPath, created } = await setup();
  const spec = parseWebJobSpec(created.task.jobSpec);
  assert.ok(spec);
  await store.updateRegressionTask(rootPath, created.task.id, {
    status: "running",
    startedAt: new Date().toISOString()
  });
  await ingestLlmResults({
    store,
    job: { task: created.task, rootPath, spec, deviceSerial: "pixel-1" },
    results: [
      {
        caseId: "TC-1",
        status: "UNVERIFIED",
        durationMs: 1,
        failureReason: "no-l1",
        verification: {
          deterministic: { passed: 0, failed: 0, skipped: 0 },
          reference: "missing",
          verifier: "not-run"
        }
      }
    ]
  });
  const stored = await store.getRegressionTask(rootPath, created.task.id);
  assert.equal(stored.status, "partial");
  const document = await readWebJobResult(rootPath, created.task.id);
  assert.equal(document.execution.cases[0].status, "UNVERIFIED");
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

test("runLlmWorkerOnce: 用例超时 → ERROR/case-timeout 并中止 signal", async () => {
  const { store } = await setup();
  let signal = null;
  const result = await runLlmWorkerOnce({
    store,
    runnerId: "center-llm",
    instanceId: "center-inst",
    nowMs: NOW + 1_000,
    caseTimeoutMs: 10,
    loadCases: async () => [
      { caseId: "TC-1", module: "登录", taskDesc: "登录成功" }
    ],
    executeCase: async (input) => {
      signal = input.signal;
      return new Promise(() => undefined);
    }
  });
  assert.equal(result.jobs[0].results[0].status, "ERROR");
  assert.equal(result.jobs[0].results[0].failureReason, "case-timeout");
  assert.equal(signal.aborted, true);
});


