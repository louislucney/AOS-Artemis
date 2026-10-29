import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { storeWebAsset } from "../dist/web/assets.js";
import {
  ingestWebJobResult,
  normalizeWebJobResultPayload,
  resultPathForJob,
  WebResultError
} from "../dist/web/results.js";
import { cellText, recoverPendingWriteback } from "../dist/web/writeback.js";
import { workbookCopyPath } from "../dist/web/workbook.js";

const TOKEN = "runner-job-token-0123456789abcdef";
const HOST = "host-1";
const STARTED = "2026-10-29T01:00:00.000Z";
const FINISHED = "2026-10-29T01:02:00.000Z";

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

async function tempDir(t, prefix = "aos-web-result-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function writeWorkbook(filePath, rows = [["TC-1", "登录", "1. 打开", "1. 页面显示“登录”"], ["TC-2", "退出", "1. 退出", "1. 页面显示“退出”"], ["TC-3", "设置", "1. 设置", "1. 页面显示“设置”"]]) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  sheet.addRow(["用例编号", "用例名", "步骤", "期望结果"]);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function loadSheet(filePath, sheetName = "用例") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  return sheet;
}

async function mutateWorkbook(filePath, fn) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet("用例");
  fn(workbook, sheet);
  await workbook.xlsx.writeFile(filePath);
}

function jobSpec(overrides = {}) {
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: HOST,
    deviceSerial: "emulator-5554",
    requirements: { platform: "android", deviceKind: "any" },
    deviceLeaseId: `${HOST}:emulator-5554`,
    excelAssetId: overrides.excelAssetId ?? "asset-placeholder",
    packageAssetId: "pkg-1",
    materialsAssetId: null,
    scriptSetId: null,
    executionMode: overrides.executionMode ?? "maestro",
    caseFilter: { modules: [], caseIds: [] },
    retry: 0,
    allowStaleScript: false,
    allowPartialUnresolved: false,
    assetSnapshot: [],
    ...overrides
  };
}

async function makeStore() {
  const store = new MemoryStore();
  const workspace = await tempDir(null);
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  await store.upsertProject({ rootPath, name: "acme" });
  return { store, workspace, rootPath };
}

async function setupProject(t, options = {}) {
  const { store, workspace, rootPath } = await makeStore();
  if (t) t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const original = path.join(rootPath, "cases.xlsx");
  await writeWorkbook(original, options.rows);
  const buffer = await readFile(original);
  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer
  });
  if (options.mapping !== false) {
    await store.saveExcelMapping({
      rootPath,
      assetId: asset.id,
      sheetName: "用例",
      headerFingerprint: "fp-1",
      columnMap: { caseId: "用例编号", steps: "步骤", expected: "期望结果" },
      createdBy: "tester"
    });
  }
  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: jobSpec({
      excelAssetId: options.excelAssetId ?? asset.id,
      executionMode: options.executionMode ?? "maestro"
    }),
    deviceSerial: "emulator-5554",
    deviceLeaseId: `${HOST}:emulator-5554`
  });
  await store.updateRegressionTask(rootPath, task.id, {
    status: options.status ?? "running"
  });
  return {
    store,
    workspace,
    rootPath,
    asset,
    task,
    original,
    originalSha: sha256Buffer(buffer),
    copyPath: workbookCopyPath(rootPath, asset.id)
  };
}

async function newRunningJob(ctx, overrides = {}) {
  const task = await ctx.store.createRegressionTask({
    rootPath: ctx.rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: jobSpec({
      excelAssetId: ctx.asset.id,
      executionMode: overrides.executionMode ?? "maestro"
    }),
    deviceSerial: "emulator-5554"
  });
  await ctx.store.updateRegressionTask(ctx.rootPath, task.id, { status: "running" });
  return task;
}

function resultPayload(overrides = {}) {
  return {
    execution: {
      status: "failed",
      cases: [
        { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 1200, traceId: "trace-1", assertionCount: 1 },
        {
          caseId: "TC-2",
          name: "退出",
          status: "FAIL",
          durationMs: 800,
          traceId: "trace-2",
          failureReason: "按钮不存在"
        },
        { caseId: "TC-3", name: "设置", status: "SKIP", durationMs: 0, traceId: "trace-3" }
      ],
      startedAt: STARTED,
      finishedAt: FINISHED,
      detail: null
    },
    device: { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" },
    package: { name: "com.acme.app", version: "1.2.3", filename: "app.apk" },
    startedAt: STARTED,
    finishedAt: FINISHED,
    evidence: ["/runner/maestro/TC-2.png"],
    ...overrides
  };
}

function passingPayload(overrides = {}) {
  return {
    execution: {
      status: "passed",
      cases: [
        { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 900, traceId: "trace-1", assertionCount: 1 },
        { caseId: "TC-2", name: "退出", status: "PASS", durationMs: 900, traceId: "trace-2", assertionCount: 1 },
        { caseId: "TC-3", name: "设置", status: "PASS", durationMs: 900, traceId: "trace-3", assertionCount: 1 }
      ],
      startedAt: STARTED,
      finishedAt: FINISHED,
      detail: null
    },
    device: { serial: "emulator-5554", model: "Pixel 7", osVersion: "14" },
    package: { name: "com.acme.app", version: "1.2.3", filename: "app.apk" },
    startedAt: STARTED,
    finishedAt: FINISHED,
    ...overrides
  };
}

test("ingest：PASS/FAIL/SKIP 聚合 failed，写回 8 列中的结果/时间/设备/包/trace，原件不变", async (t) => {
  const ctx = await setupProject(t);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: resultPayload()
  });

  assert.equal(summary.taskStatus, "failed");
  assert.equal(summary.writebackStatus, "written");
  assert.deepEqual(summary.gate, {
    result: "failed",
    total: 3,
    passed: 1,
    failed: 1,
    errors: 0,
    skipped: 1
  });
  const keys = new Set(summary.writtenCells.map((cell) => cell.key));
  for (const key of ["result", "device", "package", "startedAt", "finishedAt", "traceId"]) {
    assert.ok(keys.has(key), `missing ${key}`);
  }
  assert.equal(summary.writtenCells.length, 18);
  assert.deepEqual(summary.warnings, []);

  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell("I2")), "PASS");
  assert.equal(cellText(sheet.getCell("I3")), "FAIL");
  assert.equal(cellText(sheet.getCell("I4")), "SKIP");
  assert.equal(cellText(sheet.getCell("J2")), "Pixel 7 / 14");
  assert.equal(cellText(sheet.getCell("K2")), "com.acme.app 1.2.3 app.apk");
  assert.equal(cellText(sheet.getCell("L2")), STARTED);
  assert.equal(cellText(sheet.getCell("M2")), FINISHED);
  assert.equal(cellText(sheet.getCell("N2")), "trace-1");
  assert.equal(cellText(sheet.getCell("G1")), "建议｜脚本文件");
  assert.equal(cellText(sheet.getCell("N1")), "执行｜traceId");

  assert.equal(await sha256File(ctx.original), ctx.originalSha, "原件 sha256 必须不变");

  const resultPath = resultPathForJob(ctx.rootPath, ctx.task.id);
  const saved = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(saved.jobId, ctx.task.id);
  assert.equal(saved.taskStatus, "failed");
  assert.deepEqual(saved.device, {
    serial: "emulator-5554",
    model: "Pixel 7",
    osVersion: "14"
  });
  assert.deepEqual(saved.package, {
    name: "com.acme.app",
    version: "1.2.3",
    filename: "app.apk"
  });
  assert.equal(saved.execution.cases.length, 3);
  assert.deepEqual([...saved.evidence], ["/runner/maestro/TC-2.png"]);
  assert.equal(saved.writebackStatus, "written");

  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "failed");
});

test("ingest：空结果聚合为 error，任务落 failed（绝不假成功）", async (t) => {
  const ctx = await setupProject(t);
  const empty = resultPayload({
    execution: {
      status: "error",
      cases: [],
      startedAt: STARTED,
      finishedAt: FINISHED,
      detail: "junit-empty"
    }
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: empty
  });
  assert.equal(summary.gate.result, "error");
  assert.deepEqual(summary.gate, {
    result: "error",
    total: 0,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0
  });
  assert.equal(summary.taskStatus, "error");
  assert.equal(summary.dbStatus, "failed");
  assert.deepEqual(summary.writtenCells, []);
  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "failed", "DB 无 error 枚举，空结果落 failed 而不是成功");
});

test("ingest：重复上传同内容幂等，不再写 journal / 不再改写工作副本", async (t) => {
  const ctx = await setupProject(t);
  const first = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: resultPayload()
  });
  const journalAfterFirst = ctx.store.excelWritebacks.length;
  const copyShaAfterFirst = await sha256File(ctx.copyPath);

  const reordered = {
    evidence: ["/runner/maestro/TC-2.png"],
    startedAt: STARTED,
    finishedAt: FINISHED,
    package: { version: "1.2.3", filename: "app.apk", name: "com.acme.app" },
    device: { osVersion: "14", model: "Pixel 7", serial: "emulator-5554" },
    execution: {
      detail: null,
      finishedAt: FINISHED,
      startedAt: STARTED,
      cases: resultPayload().execution.cases.map((entry) => ({ ...entry })),
      status: "failed"
    }
  };
  const second = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: reordered
  });

  assert.equal(second.idempotent, true);
  assert.equal(second.taskStatus, first.taskStatus);
  assert.deepEqual(second.writtenCells, first.writtenCells);
  assert.equal(ctx.store.excelWritebacks.length, journalAfterFirst, "幂等上传不得重复写 journal");
  assert.equal(await sha256File(ctx.copyPath), copyShaAfterFirst, "幂等上传不得改写工作副本");
});

test("HTTP POST /panel/api/jobs/:id/results：runner token、未知 job、非法 body 与幂等", async (t) => {
  const previous = new Map();
  for (const [key, value] of Object.entries({
    AOS_RUNNER_JOB_TOKEN: TOKEN,
    AOS_HTTP_TOKEN: undefined,
    AOS_HTTP_USERS: undefined,
    AOS_HTTP_ALLOW_INSECURE: undefined
  })) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const workspace = await tempDir(t, "aos-web-result-http-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme" });
  const original = path.join(rootPath, "cases.xlsx");
  await writeWorkbook(original);
  const buffer = await readFile(original);
  const asset = await storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xlsx", buffer });
  await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    headerFingerprint: "fp-http",
    columnMap: { caseId: "用例编号", steps: "步骤", expected: "期望结果" }
  });
  const makeJob = async (status) => {
    const task = await store.createRegressionTask({
      rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: HOST,
      jobSpec: jobSpec({ excelAssetId: asset.id }),
      deviceSerial: "emulator-5554"
    });
    await store.updateRegressionTask(rootPath, task.id, { status });
    return task;
  };
  const running = await makeJob("running");
  const pending = await makeJob("pending");

  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const url = `${base}/panel/api/jobs/${running.id}/results`;
    const auth = { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": HOST };
    const jsonHeaders = { ...auth, "content-type": "application/json" };
    const body = JSON.stringify(resultPayload());

    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal(
      (await fetch(url, { method: "POST", headers: { ...jsonHeaders, authorization: "Bearer wrong-token" }, body })).status,
      401
    );
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body
        })
      ).status,
      403,
      "缺少 X-AOS-Host-Id → 403"
    );
    assert.equal(
      (await fetch(`${base}/panel/api/jobs/unknown-job/results`, { method: "POST", headers: jsonHeaders, body })).status,
      404
    );
    assert.equal(
      (await fetch(url, { method: "POST", headers: { ...jsonHeaders, "content-type": "text/plain" }, body })).status,
      415
    );
    assert.equal(
      (await fetch(url, { method: "POST", headers: jsonHeaders, body: "{not-json" })).status,
      400
    );
    assert.equal(
      (await fetch(url, { method: "POST", headers: jsonHeaders, body: JSON.stringify("hello") })).status,
      400
    );
    assert.equal(
      (await fetch(url, { method: "GET", headers: auth })).status,
      405
    );

    const response = await fetch(url, { method: "POST", headers: jsonHeaders, body });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.ok, true);
    assert.equal(summary.taskStatus, "failed");
    assert.equal(summary.writebackStatus, "written");
    assert.equal(summary.writtenCells.length, 18);

    const duplicate = await fetch(url, { method: "POST", headers: jsonHeaders, body });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).idempotent, true);

    const notRunning = await fetch(`${base}/panel/api/jobs/${pending.id}/results`, {
      method: "POST",
      headers: jsonHeaders,
      body
    });
    assert.equal(notRunning.status, 409);
    assert.equal((await notRunning.json()).code, "result-already-recorded");
  } finally {
    await handle.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("ingest：写回失败仍保存结果，返回 writeback-failed 且不改变任务聚合状态", async (t) => {
  const ctx = await setupProject(t);
  await mkdir(ctx.copyPath, { recursive: true });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload()
  });

  assert.equal(summary.taskStatus, "completed");
  assert.equal(summary.writebackStatus, "writeback-failed");
  assert.equal(summary.writtenCells.length, 0);
  assert.ok(
    summary.warnings.some((warning) => warning.includes("writeback")),
    summary.warnings.join("；")
  );
  const saved = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, ctx.task.id), "utf8"));
  assert.equal(saved.writebackStatus, "writeback-failed");
  assert.equal(saved.taskStatus, "completed");

  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "completed");
  assert.equal(await sha256File(ctx.original), ctx.originalSha);
});

test("ingest：人工清空系统格默认冻结，显式 allowClearedRefresh 才重写（confirmed 行）", async (t) => {
  const ctx = await setupProject(t);
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: passingPayload() });
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "PASS");

  await mutateWorkbook(ctx.copyPath, (_workbook, sheet) => {
    sheet.getCell("I2").value = null;
  });
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "");

  const second = await newRunningJob(ctx);
  const frozen = await ingestWebJobResult({
    store: ctx.store,
    jobId: second.id,
    payload: passingPayload()
  });
  assert.equal(frozen.writebackStatus, "written");
  assert.ok(
    frozen.warnings.some((warning) => warning.includes("人工清空")),
    frozen.warnings.join("；")
  );
  const frozenResults = frozen.writtenCells.filter((cell) => cell.key === "result");
  assert.equal(frozenResults.length, 2, "同一批其余用例仍写结果");
  assert.ok(!frozenResults.some((cell) => cell.caseId === "TC-1"), "被人工清空的结果格默认冻结");
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "");

  const third = await newRunningJob(ctx);
  const refreshed = await ingestWebJobResult({
    store: ctx.store,
    jobId: third.id,
    payload: passingPayload(),
    allowClearedRefresh: true
  });
  assert.equal(refreshed.writtenCells.length, 18);
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "PASS");
  const last = await ctx.store.lastExcelWritebackByCellKey(
    ctx.rootPath,
    ctx.asset.id,
    "用例",
    "TC-1",
    "result"
  );
  assert.equal(last.value, "PASS");
  assert.equal(last.status, "confirmed");
  assert.equal((await ctx.store.listPendingExcelWriteback(ctx.rootPath, ctx.asset.id)).length, 0);
});

test("两阶段 journal：pending 按单元格值 confirm，不一致则删除；恢复后不把系统格误判人工", async (t) => {
  const ctx = await setupProject(t);
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: passingPayload() });
  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell("I2")), "PASS");
  const confirmedBefore = await ctx.store.lastExcelWritebackByCellKey(
    ctx.rootPath,
    ctx.asset.id,
    "用例",
    "TC-1",
    "result"
  );

  const matching = await ctx.store.recordExcelWriteback({
    rootPath: ctx.rootPath,
    assetId: ctx.asset.id,
    sheetName: "用例",
    jobId: ctx.task.id,
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!I2",
    value: "PASS",
    status: "pending"
  });
  const stale = await ctx.store.recordExcelWriteback({
    rootPath: ctx.rootPath,
    assetId: ctx.asset.id,
    sheetName: "用例",
    jobId: ctx.task.id,
    caseId: "TC-1",
    columnKey: "device",
    cellRef: "用例!J2",
    value: "STALE / 0",
    status: "pending"
  });
  assert.equal(
    (
      await ctx.store.lastExcelWritebackByCellKey(ctx.rootPath, ctx.asset.id, "用例", "TC-1", "result")
    ).id,
    confirmedBefore.id,
    "pending 行不参与系统格归属"
  );
  assert.equal((await ctx.store.listPendingExcelWriteback(ctx.rootPath, ctx.asset.id)).length, 2);

  const recovered = await recoverPendingWriteback({
    store: ctx.store,
    rootPath: ctx.rootPath,
    assetId: ctx.asset.id,
    workbookPath: ctx.copyPath
  });
  assert.equal(recovered.confirmed, 1);
  assert.equal(recovered.deleted, 1);
  assert.equal(recovered.kept, 0);
  assert.equal((await ctx.store.listPendingExcelWriteback(ctx.rootPath, ctx.asset.id)).length, 0);
  const confirmed = await ctx.store.lastExcelWritebackByCellKey(
    ctx.rootPath,
    ctx.asset.id,
    "用例",
    "TC-1",
    "result"
  );
  assert.equal(confirmed.id, matching.id);
  assert.equal(confirmed.status, "confirmed");
  const deviceConfirmed = await ctx.store.lastExcelWritebackByCellKey(
    ctx.rootPath,
    ctx.asset.id,
    "用例",
    "TC-1",
    "device"
  );
  assert.notEqual(deviceConfirmed.id, stale.id, "不一致的 pending 声明必须被删除");
  assert.equal(stale.status, "pending");

  // 恢复后的系统格仍按系统格刷新，不被当成人内容冻结。
  const second = await newRunningJob(ctx);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: second.id,
    payload: passingPayload()
  });
  const resultCells = summary.writtenCells.filter((cell) => cell.key === "result");
  assert.equal(resultCells.length, 3);
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "PASS");
});

test("远程 LLM 结果：tokenUsage + 原始工件落到结果目录；缺工件记 token-unavailable 不伪造", async (t) => {
  const ctx = await setupProject(t, { executionMode: "llm" });
  const tokenUsage = [
    {
      caseId: "TC-1",
      traceId: "trace-1",
      model: "deepseek-flash",
      promptTokens: 100,
      completionTokens: 20,
      cacheCreateTokens: 5,
      cacheReadTokens: 3
    },
    {
      caseId: "TC-3",
      traceId: "trace-3",
      model: "deepseek-flash",
      promptTokens: 10,
      completionTokens: 2,
      cacheCreateTokens: 0,
      cacheReadTokens: 0
    }
  ];
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      tokenUsage,
      tokenArtifacts: {
        dataEngineDb: {
          filename: "data-engine.db",
          base64: Buffer.from("sqlite-bytes").toString("base64")
        },
        statusJson: {
          filename: "status.json",
          base64: Buffer.from('{"ok":true}').toString("base64")
        }
      }
    })
  });
  assert.equal(summary.taskStatus, "completed");
  assert.ok(!summary.warnings.some((warning) => warning.includes("token-unavailable")));

  const resultPath = resultPathForJob(ctx.rootPath, ctx.task.id);
  const saved = JSON.parse(await readFile(resultPath, "utf8"));
  assert.deepEqual(saved.tokenUsage, tokenUsage);
  assert.deepEqual(saved.tokenTotals, {
    promptTokens: 110,
    completionTokens: 22,
    cacheCreateTokens: 5,
    cacheReadTokens: 3
  });
  assert.equal(saved.tokenArtifacts.dataEngineDb, "artifacts/data-engine.db");
  assert.equal(saved.tokenArtifacts.statusJson, "artifacts/status.json");
  const resultDir = path.dirname(resultPath);
  assert.deepEqual(await readdir(path.join(resultDir, "artifacts")), ["data-engine.db", "status.json"]);
  assert.equal(await readFile(path.join(resultDir, "artifacts", "data-engine.db"), "utf8"), "sqlite-bytes");

  const missingJob = await newRunningJob(ctx, { executionMode: "llm" });
  const missing = await ingestWebJobResult({
    store: ctx.store,
    jobId: missingJob.id,
    payload: passingPayload()
  });
  assert.ok(
    missing.warnings.some((warning) => warning.includes("token-unavailable")),
    missing.warnings.join("；")
  );
  const missingSaved = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, missingJob.id), "utf8"));
  assert.equal(missingSaved.tokenTotals, null, "缺 tokenUsage 时不得按 0 计费");
  assert.equal(missingSaved.tokenArtifacts, null, "不得伪造本地工件路径");
});

test("ingest：无 mapping / 无 excelAssetId 明确报错且不产生任何写回", async (t) => {
  const noMapping = await setupProject(t, { mapping: false });
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: noMapping.store,
        jobId: noMapping.task.id,
        payload: resultPayload()
      }),
    (error) => {
      assert.ok(error instanceof WebResultError);
      assert.equal(error.code, "excel-mapping-missing");
      return true;
    }
  );
  assert.equal(
    await stat(path.dirname(resultPathForJob(noMapping.rootPath, noMapping.task.id))).then(
      () => true,
      () => false
    ),
    false,
    "无 mapping 不得先写结果目录"
  );
  assert.equal(
    await stat(noMapping.copyPath).then(() => true, () => false),
    false,
    "不得创建工作副本"
  );
  assert.equal(noMapping.store.excelWritebacks.length, 0);

  const noAsset = await setupProject(t, { excelAssetId: "" });
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: noAsset.store,
        jobId: noAsset.task.id,
        payload: resultPayload()
      }),
    (error) => {
      assert.ok(error instanceof WebResultError);
      assert.equal(error.code, "excel-asset-missing");
      return true;
    }
  );
  assert.equal(noAsset.store.excelWritebacks.length, 0);
});

test("journal status：Memory/File/PG 的 pending 列表、confirmed 归属与 confirm/delete 语义一致", async (t) => {
  const workspace = await tempDir(t, "aos-web-journal-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });

  const stores = [];
  stores.push({ name: "memory", store: new MemoryStore() });
  stores.push({ name: "file", store: await FileStore.create({ homeDir: path.join(workspace, "ledger") }) });
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  stores.push({ name: "pg", store: pg });

  for (const { name, store } of stores) {
    await store.upsertProject({ rootPath, name: `acme-${name}` });
    const pending = await store.recordExcelWriteback({
      rootPath,
      assetId: "asset-1",
      sheetName: "用例",
      caseId: "TC-1",
      columnKey: "result",
      cellRef: "用例!H2",
      value: "PASS",
      status: "pending"
    });
    assert.equal(pending.status, "pending", name);
    assert.equal((await store.listPendingExcelWriteback(rootPath, "asset-1")).length, 1, name);
    assert.equal(
      await store.lastExcelWritebackByCellKey(rootPath, "asset-1", "用例", "TC-1", "result"),
      null,
      `${name}：pending 不参与归属`
    );
    assert.equal(await store.confirmExcelWriteback(rootPath, pending.id), true, name);
    assert.equal((await store.listPendingExcelWriteback(rootPath, "asset-1")).length, 0, name);
    const confirmed = await store.lastExcelWritebackByCellKey(
      rootPath,
      "asset-1",
      "用例",
      "TC-1",
      "result"
    );
    assert.equal(confirmed.status, "confirmed", name);
    assert.equal(confirmed.id, pending.id, name);

    const stale = await store.recordExcelWriteback({
      rootPath,
      assetId: "asset-1",
      sheetName: "用例",
      caseId: "TC-1",
      columnKey: "device",
      cellRef: "用例!I2",
      value: "STALE",
      status: "pending"
    });
    assert.equal(await store.deleteExcelWriteback(rootPath, stale.id), true, name);
    assert.equal(await store.deleteExcelWriteback(rootPath, stale.id), false, name);
    assert.equal((await store.listPendingExcelWriteback(rootPath, "asset-1")).length, 0, name);

    const legacy = await store.recordExcelWriteback({
      rootPath,
      assetId: "asset-1",
      sheetName: "用例",
      caseId: "TC-1",
      columnKey: "traceId",
      cellRef: "用例!K2",
      value: "trace-1"
    });
    assert.equal(legacy.status, "confirmed", `${name}：缺省 confirmed`);
  }
  await pg.close();
});

test("C1：保留 runner 上报状态（error 不因用例全 PASS 变 completed；Excel 不写 PASS）", async (t) => {
  const ctx = await setupProject(t);
  const allPass = [
    { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 1, traceId: "trace-1" },
    { caseId: "TC-2", name: "退出", status: "PASS", durationMs: 1, traceId: "trace-2" }
  ];
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      execution: {
        status: "error",
        cases: allPass,
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: "maestro-exit:1"
      }
    })
  });
  assert.equal(summary.taskStatus, "error");
  assert.equal(summary.dbStatus, "failed");
  assert.equal(summary.gate.result, "error");
  assert.equal(summary.gate.passed, 2);
  assert.ok(summary.warnings.some((warning) => warning.includes("status-mismatch")));
  assert.ok(!summary.writtenCells.some((cell) => cell.key === "result"));
  const sheet = await loadSheet(ctx.copyPath);
  assert.notEqual(cellText(sheet.getCell("I2")), "PASS");
  assert.equal(cellText(sheet.getCell("J2")), "Pixel 7 / 14");
  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "failed");

  const failedJob = await newRunningJob(ctx);
  const failed = await ingestWebJobResult({
    store: ctx.store,
    jobId: failedJob.id,
    payload: passingPayload({
      execution: {
        status: "failed",
        cases: allPass,
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: "maestro-exit:2"
      }
    })
  });
  assert.equal(failed.taskStatus, "failed");
  assert.equal(failed.dbStatus, "failed");
  assert.ok(!failed.writtenCells.some((cell) => cell.key === "result"));
  assert.ok(failed.warnings.some((warning) => warning.includes("status-mismatch")));
});

test("I1：per-job 锁让并发同内容上传只写一次，崩溃后重复上传补写终态", async (t) => {
  const ctx = await setupProject(t);
  const payload = passingPayload();
  const [first, second] = await Promise.all([
    ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload }),
    ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload })
  ]);
  assert.equal(first.jobId, second.jobId);
  assert.equal([first.idempotent, second.idempotent].filter(Boolean).length, 1);
  assert.equal(ctx.store.excelWritebacks.length, 18, "只允许一次写回 journal");
  assert.equal(
    (await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status,
    "completed"
  );

  // 模拟“result.json 已写、CAS 未写”的崩溃：任务回到 running，同内容重传必须补终态。
  await ctx.store.updateRegressionTask(ctx.rootPath, ctx.task.id, { status: "running" });
  const recovered = await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload });
  assert.equal(recovered.idempotent, true);
  assert.equal(
    (await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status,
    "completed",
    "幂等重传必须把 running 任务补成终态"
  );
  assert.equal(ctx.store.excelWritebacks.length, 18, "幂等重传不得重复写 journal");
});

test("I2：tokenArtifacts 只接受内联 base64；拒绝路径、超限工件与不安全文件名", async (t) => {
  const ctx = await setupProject(t, { executionMode: "llm" });
  const tokenUsage = [
    {
      caseId: "TC-1",
      traceId: "trace-1",
      model: "m",
      promptTokens: 1,
      completionTokens: 1
    }
  ];
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: ctx.store,
        jobId: ctx.task.id,
        payload: passingPayload({
          tokenUsage,
          tokenArtifacts: { dataEngineDb: "/etc/passwd", statusJson: "/tmp/status.json" }
        })
      }),
    (error) => error instanceof WebResultError && error.code === "invalid-result"
  );
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: ctx.store,
        jobId: ctx.task.id,
        payload: passingPayload({
          tokenUsage,
          tokenArtifacts: {
            dataEngineDb: { filename: "big.db", base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") },
            statusJson: { filename: "s.json", base64: Buffer.from("{}").toString("base64") }
          }
        })
      }),
    (error) => error instanceof WebResultError && error.code === "invalid-result"
  );
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: ctx.store,
        jobId: ctx.task.id,
        payload: passingPayload({
          tokenUsage,
          tokenArtifacts: {
            dataEngineDb: { filename: "x.db", base64: "not base64 !!!" },
            statusJson: { filename: "s.json", base64: Buffer.from("{}").toString("base64") }
          }
        })
      }),
    (error) => error instanceof WebResultError && error.code === "invalid-result"
  );

  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      tokenUsage,
      tokenArtifacts: {
        dataEngineDb: {
          filename: "../../evil db.db",
          base64: Buffer.from("db-bytes").toString("base64")
        },
        statusJson: { filename: "/abs/status.json", base64: Buffer.from("{}").toString("base64") }
      }
    })
  });
  assert.equal(summary.writebackStatus, "written");
  const resultPath = resultPathForJob(ctx.rootPath, ctx.task.id);
  const saved = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(saved.tokenArtifacts.dataEngineDb, "artifacts/evil_db.db");
  assert.equal(saved.tokenArtifacts.statusJson, "artifacts/status.json");
  assert.ok(!JSON.stringify(saved).includes(ctx.rootPath), "结果文档不得回显中心绝对路径");
  assert.equal(await readFile(path.join(path.dirname(resultPath), "artifacts", "evil_db.db"), "utf8"), "db-bytes");
});

test("I4：任务已终态且无结果时允许迟到首次上传（不改任务状态）；有结果/取消仍 409", async (t) => {
  const ctx = await setupProject(t, { status: "completed" });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload()
  });
  assert.equal(summary.taskStatus, "completed");
  assert.equal(summary.dbStatus, "completed");
  assert.ok(summary.warnings.some((warning) => warning.includes("迟到的首次结果")));
  const task = await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id);
  assert.equal(task.status, "completed", "迟到上传不得改写任务终态");
  assert.equal((await stat(resultPathForJob(ctx.rootPath, ctx.task.id))).isFile(), true);

  const different = await assert.rejects(
    () =>
      ingestWebJobResult({
        store: ctx.store,
        jobId: ctx.task.id,
        payload: resultPayload()
      }),
    (error) => {
      assert.ok(error instanceof WebResultError);
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(different, undefined);

  const cancelled = await setupProject(t, { status: "cancelled" });
  await assert.rejects(
    () =>
      ingestWebJobResult({
        store: cancelled.store,
        jobId: cancelled.task.id,
        payload: passingPayload()
      }),
    (error) => error instanceof WebResultError && error.status === 409
  );
  assert.equal(await cancelled.store.listPendingExcelWriteback(cancelled.rootPath, cancelled.asset.id).then((rows) => rows.length), 0);
});

test("HTTP：结果上传大小上限（>256KB 200 / >16MB 413）、415、错误主机 403、短 token 503", async (t) => {
  const previous = new Map();
  for (const [key, value] of Object.entries({
    AOS_RUNNER_JOB_TOKEN: TOKEN,
    AOS_HTTP_TOKEN: undefined,
    AOS_HTTP_USERS: undefined,
    AOS_HTTP_ALLOW_INSECURE: undefined
  })) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const workspace = await tempDir(t, "aos-web-result-http-limits-");
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme" });
  const buffer = await readFile(await writeWorkbook(path.join(rootPath, "cases.xlsx")));
  const asset = await storeWebAsset({ store, rootPath, kind: "excel", filename: "cases.xlsx", buffer });
  await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName: "用例",
    headerFingerprint: "fp-limits",
    columnMap: { caseId: "用例编号", steps: "步骤", expected: "期望结果" }
  });
  const makeJob = async (status = "running") => {
    const task = await store.createRegressionTask({
      rootPath,
      refs: [],
      platforms: ["android"],
      baseline: "latest",
      targetHostId: HOST,
      jobSpec: jobSpec({ excelAssetId: asset.id }),
      deviceSerial: "emulator-5554"
    });
    await store.updateRegressionTask(rootPath, task.id, { status });
    return task;
  };
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace, store });
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const auth = { authorization: `Bearer ${TOKEN}`, "x-aos-host-id": HOST };
    const jsonHeaders = { ...auth, "content-type": "application/json" };

    const wrongHostJob = await makeJob();
    assert.equal(
      (
        await fetch(`${base}/panel/api/jobs/${wrongHostJob.id}/results`, {
          method: "POST",
          headers: { ...jsonHeaders, "x-aos-host-id": "host-other" },
          body: JSON.stringify(resultPayload())
        })
      ).status,
      403
    );

    const shortTokenJob = await makeJob();
    process.env.AOS_RUNNER_JOB_TOKEN = "short";
    try {
      const shortResponse = await fetch(`${base}/panel/api/jobs/${shortTokenJob.id}/results`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify(resultPayload())
      });
      assert.equal(shortResponse.status, 503);
      assert.equal((await shortResponse.json()).code, "runner-token-too-short");
    } finally {
      process.env.AOS_RUNNER_JOB_TOKEN = TOKEN;
    }

    const pathArtifactJob = await makeJob();
    const pathBody = JSON.stringify(
      resultPayload({
        tokenArtifacts: { dataEngineDb: "/etc/passwd", statusJson: "/tmp/x.json" }
      })
    );
    const pathResponse = await fetch(`${base}/panel/api/jobs/${pathArtifactJob.id}/results`, {
      method: "POST",
      headers: jsonHeaders,
      body: pathBody
    });
    assert.equal(pathResponse.status, 400, "绝对路径工件必须拒绝");
    assert.equal((await pathResponse.json()).code, "invalid-result");

    const largeJob = await makeJob();
    const largeEvidence = Array.from({ length: 400 }, (_, index) => `${index}-${"x".repeat(800)}`);
    const largeBody = JSON.stringify(resultPayload({ evidence: largeEvidence }));
    assert.ok(largeBody.length > 256 * 1024, `body 需要 >256KB，实际 ${largeBody.length}`);
    const largeResponse = await fetch(`${base}/panel/api/jobs/${largeJob.id}/results`, {
      method: "POST",
      headers: jsonHeaders,
      body: largeBody
    });
    assert.equal(largeResponse.status, 200);
    const largeSummary = await largeResponse.json();
    assert.equal(largeSummary.taskStatus, "failed");
    assert.ok(!("resultPath" in largeSummary));
    for (const cell of largeSummary.writtenCells) {
      assert.deepEqual(Object.keys(cell).sort(), ["caseId", "key", "value"]);
    }
    assert.ok(!largeBody.includes(rootPath));

    const hugeJob = await makeJob();
    const hugeBody = JSON.stringify(resultPayload({ evidence: ["y".repeat(17 * 1024 * 1024)] }));
    const hugeResponse = await fetch(`${base}/panel/api/jobs/${hugeJob.id}/results`, {
      method: "POST",
      headers: jsonHeaders,
      body: hugeBody
    });
    assert.equal(hugeResponse.status, 413);
  } finally {
    await handle.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("ingest：runner 上传 body 的 allowClearedRefresh 不能解冻人工清空（I5）", async (t) => {
  const ctx = await setupProject(t);
  await ingestWebJobResult({ store: ctx.store, jobId: ctx.task.id, payload: passingPayload() });
  await mutateWorkbook(ctx.copyPath, (_workbook, sheet) => {
    sheet.getCell("I2").value = null;
  });

  const task = await newRunningJob(ctx);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: task.id,
    payload: { ...passingPayload(), allowClearedRefresh: true }
  });
  assert.equal(summary.writebackStatus, "written");
  assert.equal(cellText((await loadSheet(ctx.copyPath)).getCell("I2")), "", "body 字段不得解冻");
  const doc = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, task.id), "utf8"));
  assert.equal(doc.allowClearedRefresh, false);
  assert.ok(summary.warnings.some((warning) => warning.includes("人工清空")));
});

test("断言门禁：缺失用例补 SKIP（未执行）→ partial，平台/8 列/断言列同批落盘", async (t) => {
  const ctx = await setupProject(t);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      execution: {
        status: "passed",
        cases: [
          { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 900, assertionCount: 1 }
        ],
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: null
      }
    })
  });

  assert.equal(summary.taskStatus, "partial", "缺失用例不得 completed");
  assert.deepEqual(summary.gate, {
    result: "partial",
    total: 3,
    passed: 1,
    failed: 0,
    errors: 0,
    skipped: 2
  });
  assert.ok(
    summary.warnings.some((warning) => warning.includes("verdict-missing-result")),
    summary.warnings.join("；")
  );
  assert.equal(summary.assertionCells, 3);

  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell("E2")), "PASS");
  assert.equal(cellText(sheet.getCell("E3")), "SKIP");
  assert.equal(cellText(sheet.getCell("E4")), "SKIP");
  assert.equal(cellText(sheet.getCell("I2")), "PASS");
  assert.equal(cellText(sheet.getCell("I3")), "SKIP（未执行）");
  assert.equal(cellText(sheet.getCell("I4")), "SKIP（未执行）");
  assert.equal(cellText(sheet.getCell("J3")), "", "未执行用例不写设备");
  assert.equal(cellText(sheet.getCell("N3")), "", "未执行用例不写 trace");
  assert.equal(cellText(sheet.getCell("O1")), "__aos_assertions");

  const saved = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, ctx.task.id), "utf8"));
  assert.equal(saved.gate.result, "partial");
  assert.deepEqual(
    saved.execution.cases.map((entry) => [entry.caseId, entry.status, entry.synthetic === true]),
    [
      ["TC-1", "PASS", false],
      ["TC-2", "SKIP", true],
      ["TC-3", "SKIP", true]
    ]
  );
  assert.equal(saved.execution.cases[0].assertionCount, 1);
  assert.equal(saved.execution.status, "partial");
  assert.equal(await sha256File(ctx.original), ctx.originalSha, "原件 sha256 必须不变");
});

test("断言门禁：PASS 缺 assertionCount → UNVERIFIED，任务 partial、Excel 不得 PASS", async (t) => {
  const ctx = await setupProject(t);
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      execution: {
        status: "passed",
        cases: [
          { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 900 },
          { caseId: "TC-2", name: "退出", status: "PASS", durationMs: 900, assertionCount: 1 },
          { caseId: "TC-3", name: "设置", status: "PASS", durationMs: 900, assertionCount: 1 }
        ],
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: null
      }
    })
  });

  assert.equal(summary.taskStatus, "partial");
  assert.deepEqual(summary.gate, {
    result: "partial",
    total: 3,
    passed: 2,
    failed: 0,
    errors: 0,
    skipped: 0,
    unverified: 1
  });
  assert.ok(
    summary.warnings.some((warning) => warning.includes("verdict-unverified")),
    summary.warnings.join("；")
  );

  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell("E2")), "UNVERIFIED");
  assert.equal(cellText(sheet.getCell("E3")), "PASS");
  assert.equal(cellText(sheet.getCell("I2")), "UNVERIFIED");
  assert.equal(cellText(sheet.getCell("I3")), "PASS");
  assert.match(cellText(sheet.getCell("A2")), /TC-1/);
  assert.equal(await sha256File(ctx.original), ctx.originalSha);
  assert.equal((await ctx.store.getRegressionTask(ctx.rootPath, ctx.task.id)).status, "partial");
});

test("断言门禁：空预期 PASS → UNVERIFIED（no-executable-assertion）", async (t) => {
  const ctx = await setupProject(t, { rows: [["TC-1", "登录", "1. 打开", ""]] });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: passingPayload({
      execution: {
        status: "passed",
        cases: [
          { caseId: "TC-1", name: "登录", status: "PASS", durationMs: 900, assertionCount: 1 }
        ],
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: null
      }
    })
  });
  assert.equal(summary.taskStatus, "partial");
  assert.deepEqual(summary.gate, {
    result: "partial",
    total: 1,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    unverified: 1
  });
  assert.ok(summary.warnings.some((warning) => warning.includes("verdict-unverified")));
  const sheet = await loadSheet(ctx.copyPath);
  assert.equal(cellText(sheet.getCell("I2")), "UNVERIFIED");
});

test("normalize：assertionCount 必须是非负整数", () => {
  const base = {
    execution: {
      status: "passed",
      cases: [{ caseId: "TC-1", status: "PASS", assertionCount: 1 }],
      startedAt: STARTED,
      finishedAt: FINISHED
    },
    device: { serial: "emulator-5554" },
    package: { filename: "app.apk" },
    startedAt: STARTED,
    finishedAt: FINISHED
  };
  assert.equal(normalizeWebJobResultPayload(base).execution.cases[0].assertionCount, 1);
  for (const assertionCount of [-1, 1.5, "2", true]) {
    assert.throws(
      () =>
        normalizeWebJobResultPayload({
          ...base,
          execution: {
            ...base.execution,
            cases: [{ caseId: "TC-1", status: "PASS", assertionCount }]
          }
        }),
      (error) => error instanceof WebResultError && error.code === "invalid-result"
    );
  }
});

test("normalize：token 工件合计超过 16MB（2×8MB 上限）拒绝", () => {
  const payload = {
    execution: { status: "error", cases: [], startedAt: STARTED, finishedAt: FINISHED, detail: null },
    device: { serial: "emulator-5554" },
    package: { filename: "app.apk" },
    startedAt: STARTED,
    finishedAt: FINISHED,
    tokenArtifacts: {
      dataEngineDb: {
        filename: "data_engine.db",
        base64: Buffer.alloc(8 * 1024 * 1024).toString("base64")
      },
      statusJson: {
        filename: "status.json",
        base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")
      }
    }
  };
  assert.throws(() => normalizeWebJobResultPayload(payload), /合计|上限/);
});
