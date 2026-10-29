import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset } from "../dist/web/assets.js";
import {
  applyWebJobManualStatus,
  ingestWebJobResult,
  readWebJobResult,
  resultPathForJob
} from "../dist/web/results.js";
import { cellText } from "../dist/web/writeback.js";
import { workbookCopyPath } from "../dist/web/workbook.js";

const HOST = "host-1";
const STARTED = "2026-10-29T01:00:00.000Z";
const FINISHED = "2026-10-29T01:02:00.000Z";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-manual-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function xlsxBuffer(headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function jobSpec(excelAssetId) {
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: HOST,
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "any" },
    deviceLeaseId: `${HOST}:emulator-5554`,
    excelAssetId,
    packageAssetId: "pkg-1",
    materialsAssetId: null,
    scriptSetId: null,
    executionMode: "maestro",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: []
  };
}

function payload() {
  return {
    execution: {
      status: "passed",
      cases: [
        { caseId: "C1", name: "登录", status: "PASS", durationMs: 1000, assertionCount: 1 }
      ],
      startedAt: STARTED,
      finishedAt: FINISHED,
      detail: null
    },
    device: { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" },
    package: { name: "com.acme.app", version: "1.0.0", filename: "app.apk" },
    startedAt: STARTED,
    finishedAt: FINISHED,
    evidence: []
  };
}

async function setup(t) {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme" });
  const buffer = await xlsxBuffer(
    ["用例编号", "用例名", "步骤", "期望结果"],
    [["C1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  );
  const asset = await storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xlsx", buffer });
  await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    headerFingerprint: "fp-1",
    columnMap: { caseId: "用例编号", name: "用例名", steps: "步骤", expected: "期望结果" }
  });
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: jobSpec(asset.id),
    deviceSerial: "emulator-5554",
    deviceLeaseId: `${HOST}:emulator-5554`
  });
  await store.updateRegressionTask(rootPath, task.id, { status: "running" });
  const originalSha = sha256(buffer);
  return {
    store,
    rootPath,
    asset,
    task,
    copyPath: workbookCopyPath(rootPath, asset.id),
    originalSha,
    original: asset.storagePath
  };
}

async function loadSheet(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet("用例");
  assert.ok(sheet);
  return sheet;
}

function columnByHeader(sheet, header) {
  const row = sheet.getRow(1);
  for (let column = 1; column <= 30; column += 1) {
    if (cellText(row.getCell(column)) === header) return column;
  }
  return 0;
}

test("人工状态 NOT_IMPL：写 result.json/Excel，任务 partial；清除恢复 PASS", async (t) => {
  const ctx = await setup(t);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload()
  });
  assert.equal(summary.taskStatus, "completed");
  assert.equal(summary.gate.result, "passed");

  const applied = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: "NOT_IMPL",
    reason: "客户端页面未实现",
    actor: "tester"
  });
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.document.gate, {
    result: "partial",
    total: 1,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    notImplemented: 1
  });
  assert.equal(applied.document.taskStatus, "partial");

  const saved = await readWebJobResult(ctx.rootPath, ctx.task.id);
  assert.equal(saved.execution.cases[0].status, "PASS");
  assert.equal(saved.execution.cases[0].manualStatus.status, "NOT_IMPL");
  assert.equal(saved.execution.cases[0].manualStatus.reason, "客户端页面未实现");
  assert.equal(
    JSON.parse(await readFile(resultPathForJob(ctx.rootPath, ctx.task.id), "utf8")).gate.result,
    "partial"
  );
  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "partial");

  const sheet = await loadSheet(ctx.copyPath);
  const aos = columnByHeader(sheet, "AOS Result");
  const resultColumn = columnByHeader(sheet, "执行｜结果");
  assert.equal(cellText(sheet.getCell(2, aos)), "NOT_IMPL");
  assert.equal(cellText(sheet.getCell(2, resultColumn)), "NOT_IMPL");
  assert.equal(await readFile(ctx.original).then(sha256), ctx.originalSha);

  const cleared = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: null,
    actor: "tester"
  });
  assert.equal(cleared.document.gate.result, "passed");
  assert.equal(cleared.document.taskStatus, "completed");
  assert.equal(
    (await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status,
    "completed"
  );
  const clearedSheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(clearedSheet.getCell(2, aos)), "PASS");
  assert.equal(cellText(clearedSheet.getCell(2, resultColumn)), "PASS");
});

test("人工状态 BLOCKED：gate 计 blocked，任务 partial", async (t) => {
  const ctx = await setup(t);
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: payload() });
  const applied = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: "BLOCKED",
    reason: "等待后端环境",
    actor: "tester"
  });
  assert.deepEqual(applied.document.gate, {
    result: "partial",
    total: 1,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    blocked: 1
  });
  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell(2, columnByHeader(sheet, "AOS Result"))), "BLOCKED");
  assert.equal(
    cellText(sheet.getCell(2, columnByHeader(sheet, "执行｜结果"))),
    "BLOCKED"
  );
});

test("人工状态不能把任务级 error 恢复成 completed", async (t) => {
  const ctx = await setup(t);
  const errorPayload = payload();
  errorPayload.execution.status = "error";
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: errorPayload });
  const applied = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: "BLOCKED",
    reason: "任务级错误",
    actor: "tester"
  });
  assert.equal(applied.document.gate.result, "error");
  assert.equal(applied.document.taskStatus, "error");
  assert.equal((await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status, "failed");

  const cleared = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: null,
    actor: "tester"
  });
  assert.equal(cleared.document.gate.result, "error", "清除人工状态也不能升级任务级 error");
  assert.equal((await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status, "failed");
  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell(2, columnByHeader(sheet, "AOS Result"))), "ERROR");
  assert.equal(cellText(sheet.getCell(2, columnByHeader(sheet, "执行｜结果"))), "ERROR");
});

test("人工状态不能把迟到结果后的 failed 任务升级", async (t) => {
  const ctx = await setup(t);
  await ctx.store.updateRegressionTask(ctx.rootPath, ctx.task.id, { status: "failed" });
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: payload() });
  const applied = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: "NOT_IMPL",
    actor: "tester"
  });
  assert.equal(applied.document.reportedStatus, "passed");
  assert.equal(applied.document.gate.result, "failed", "既有 failed 终态不能被人工状态改好");
  const cleared = await applyWebJobManualStatus({
    store: ctx.store,
    rootPath: ctx.rootPath,
    jobId: ctx.task.id,
    caseId: "C1",
    status: null,
    actor: "tester"
  });
  assert.equal(cleared.document.gate.result, "failed");
  assert.equal((await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status, "failed");
});

test("人工状态：jobId/caseId 路径字符拒绝", async (t) => {
  const ctx = await setup(t);
  for (const [jobId, caseId] of [
    ["../escape", "C1"],
    ["job-1", "../C1"],
    ["job/1", "C1"]
  ]) {
    await assert.rejects(
      () =>
        applyWebJobManualStatus({
          store: ctx.store,
          rootPath: ctx.rootPath,
          jobId,
          caseId,
          status: "NOT_IMPL"
        }),
      (error) => error.status === 400
    );
  }
});

test("人工状态：没有结果/未知用例明确报错", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(
    () =>
      applyWebJobManualStatus({
        store: ctx.store,
        rootPath: ctx.rootPath,
        jobId: ctx.task.id,
        caseId: "C1",
        status: "NOT_IMPL"
      }),
    (error) => error.status === 404
  );
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: payload() });
  await assert.rejects(
    () =>
      applyWebJobManualStatus({
        store: ctx.store,
        rootPath: ctx.rootPath,
        jobId: ctx.task.id,
        caseId: "C9",
        status: "NOT_IMPL"
      }),
    (error) => error.status === 400
  );
});
