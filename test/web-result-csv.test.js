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
import { readAssertionColumn } from "../dist/web/assertion-column.js";
import { decodeCsv, encodeCsv, parseCsv } from "../dist/web/csv.js";
import { ingestWebJobResult, resultPathForJob, webResultCsvPath } from "../dist/web/results.js";
import { cellText, SYSTEM_COLUMNS, writebackWorkbook } from "../dist/web/writeback.js";
import { ensureWorkbookCopy, workbookCopyPath } from "../dist/web/workbook.js";

const HOST = "host-1";
const STARTED = "2026-10-29T01:00:00.000Z";
const FINISHED = "2026-10-29T01:02:00.000Z";
const SYSTEM_HEADERS = SYSTEM_COLUMNS.map((column) => column.header);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fileSha(filePath) {
  return sha256(await readFile(filePath));
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-web-result-csv-"));
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

function jobSpec(excelAssetId, platform = "android") {
  return {
    kind: "web-test",
    assignment: "manual",
    devicePinned: true,
    targetHostId: HOST,
    deviceSerial: "emulator-5554",
    requirements: { platform, deviceKind: "any" },
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

async function setup(t, options) {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "acme" });

  const headers = options.headers;
  let buffer;
  let filename;
  let sheetName;
  if (options.format === "csv") {
    const rows = [headers, ...options.rows];
    buffer = encodeCsv(rows, {
      encoding: options.encoding,
      lineEnding: options.lineEnding ?? "\r\n"
    });
    filename = "cases.csv";
    sheetName = "csv";
  } else {
    buffer = await xlsxBuffer(headers, options.rows);
    filename = "cases.xlsx";
    sheetName = "用例";
  }
  const original = path.join(rootPath, filename);
  fs.writeFileSync(original, buffer);
  const originalSha = sha256(buffer);

  const asset = await storeWebAsset({ store, rootPath, kind: "excel", filename, buffer });
  assert.equal(asset.metadata.format, options.format === "csv" ? "csv" : undefined);

  const columnMap = options.omitStepsMapping
    ? { caseId: "用例编号" }
    : { caseId: "用例编号", name: "用例名", steps: "步骤", ...options.mapping };
  await store.saveExcelMapping({
    rootPath,
    assetId: asset.id,
    sheetName,
    headerFingerprint: `fp-${sheetName}`,
    columnMap
  });

  const task = await store.createRegressionTask({
    rootPath,
    refs: [],
    platforms: [options.platform ?? "android"],
    baseline: "latest",
    targetHostId: HOST,
    jobSpec: jobSpec(asset.id, options.platform ?? "android"),
    deviceSerial: "emulator-5554",
    deviceLeaseId: `${HOST}:emulator-5554`
  });
  await store.updateRegressionTask(rootPath, task.id, { status: "running" });

  return {
    store,
    rootPath,
    asset,
    task,
    original,
    originalSha,
    sheetName,
    copyPath: workbookCopyPath(rootPath, asset.id)
  };
}

function payload(cases, overrides = {}) {
  return {
    execution: {
      status: cases.some((entry) => entry.status === "FAIL") ? "failed" : "passed",
      cases: cases.map((entry) => ({
        ...entry,
        name: entry.name ?? "",
        durationMs: 1000,
        traceId: `trace-${entry.caseId}`,
        ...(entry.status === "PASS" && !("assertionCount" in entry)
          ? { assertionCount: 1 }
          : {})
      })),
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

async function loadSheet(filePath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  return sheet;
}

function headerRowValues(sheet, columns) {
  return columns.map((column) => cellText(sheet.getCell(1, column)));
}

function columnByHeader(sheet, header, maxColumn = 40) {
  for (let column = 1; column <= maxColumn; column += 1) {
    if (cellText(sheet.getCell(1, column)) === header) return column;
  }
  return 0;
}

test("xlsx 源已有 AOS/IOS 列：写 AOS、保留 IOS，8 列 + 隐藏断言，原件 sha 不变", async (t) => {
  const ctx = await setup(t, {
    headers: ["用例编号", "用例名", "步骤", "期望结果", "AOS Result", "IOS Result"],
    mapping: { expected: "期望结果" },
    rows: [
      ["TC-1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”", "", "iOS 人工结果"],
      ["TC-2", "退出", "1. 点击退出", "2. 页面显示“已退出”", "人工-待复核", ""],
      ["TC-3", "设置", "1. 打开设置", "", "", ""]
    ]
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([
      { caseId: "TC-1", status: "PASS" },
      { caseId: "TC-2", status: "FAIL" },
      { caseId: "TC-3", status: "SKIP" }
    ])
  });

  assert.equal(summary.writebackStatus, "written");
  assert.equal(summary.resultCsvPath, null, "xlsx 源不导出结果 CSV");
  assert.equal(summary.assertionCells, 3);
  assert.deepEqual(summary.platformResult, {
    column: 5,
    header: "AOS Result",
    appended: false,
    layout: "fixed"
  });
  assert.equal(await fileSha(ctx.original), ctx.originalSha, "原件 sha256 必须不变");

  const sheet = await loadSheet(ctx.copyPath, "用例");
  assert.deepEqual(
    headerRowValues(sheet, [1, 2, 3, 4, 5, 6]),
    ["用例编号", "用例名", "步骤", "期望结果", "AOS Result", "IOS Result"],
    "既有列顺序与表头不得改动"
  );
  const aos = 5;
  const ios = 6;
  assert.equal(cellText(sheet.getCell(2, aos)), "PASS");
  assert.equal(cellText(sheet.getCell(3, aos)), "人工-待复核", "复用的 AOS 列非空人工内容冻结");
  assert.equal(cellText(sheet.getCell(4, aos)), "SKIP");
  assert.equal(cellText(sheet.getCell(2, ios)), "iOS 人工结果", "非本平台列不得写入");
  assert.equal(cellText(sheet.getCell(3, ios)), "");
  assert.ok(
    summary.warnings.some((warning) => warning.includes("冻结") && warning.includes("TC-2")),
    summary.warnings.join("；")
  );

  assert.deepEqual(
    headerRowValues(sheet, [7, 8, 9, 10, 11, 12, 13, 14]),
    SYSTEM_HEADERS,
    "8 列摘要应追加在平台结果列之后"
  );
  const hidden = 15;
  assert.equal(cellText(sheet.getCell(1, hidden)), "__aos_assertions");
  assert.equal(sheet.getColumn(hidden).hidden, true, "断言列必须隐藏");

  const assertions = await readAssertionColumn({
    workbookPath: ctx.copyPath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  const login = assertions.get("TC-1");
  assert.ok(login);
  assert.equal(login.confidence, "high");
  assert.deepEqual(login.steps, [{ step: 1, assert: [{ type: "visible", text: "登录成功" }] }]);
  const empty = assertions.get("TC-3");
  assert.ok(empty);
  assert.equal(empty.confidence, "low");
  assert.equal(empty.manual[0].reason, "无预期");
  assert.equal(empty.steps.length, 0);

  const saved = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, ctx.task.id), "utf8"));
  assert.equal(saved.resultCsvPath, null);
});

test("xlsx 源没有平台列：追加 AOS/IOS 再追加 8 列，隐藏断言在最后", async (t) => {
  const ctx = await setup(t, {
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["TC-1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "TC-1", status: "PASS" }])
  });
  assert.equal(summary.writebackStatus, "written");
  assert.equal(summary.assertionCells, 1);
  assert.deepEqual(summary.platformResult, {
    column: 5,
    header: "AOS Result",
    appended: true,
    layout: "fixed"
  });

  const sheet = await loadSheet(ctx.copyPath, "用例");
  assert.deepEqual(headerRowValues(sheet, [1, 2, 3, 4]), ["用例编号", "用例名", "步骤", "期望结果"]);
  assert.equal(cellText(sheet.getCell(1, 5)), "AOS Result");
  assert.equal(cellText(sheet.getCell(1, 6)), "IOS Result");
  assert.deepEqual(headerRowValues(sheet, [7, 8, 9, 10, 11, 12, 13, 14]), SYSTEM_HEADERS);
  assert.equal(cellText(sheet.getCell(1, 15)), "__aos_assertions");

  assert.equal(cellText(sheet.getCell(2, 5)), "PASS");
  assert.equal(cellText(sheet.getCell(2, 6)), "", "非本平台平台列留空");
  const resultColumn = 7 + SYSTEM_COLUMNS.findIndex((column) => column.key === "result");
  assert.equal(cellText(sheet.getCell(2, resultColumn)), "PASS");
  assert.equal(await fileSha(ctx.original), ctx.originalSha);
});

test("CSV 源（UTF-8）：导出同编码 CRLF 结果 CSV，AOS + 8 列，隐藏断言只在 xlsx 工作副本", async (t) => {
  const ctx = await setup(t, {
    format: "csv",
    encoding: "utf-8",
    lineEnding: "\r\n",
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [
      ["C1", "登录", "1. 打开登录页\n2. 输入账号, 密码", "1. 页面显示“登录成功”"],
      ["C2", "退出", "1. 点击退出", ""]
    ]
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([
      { caseId: "C1", status: "PASS" },
      { caseId: "C2", status: "FAIL" }
    ])
  });

  assert.equal(summary.writebackStatus, "written");
  assert.equal(summary.resultCsvPath, webResultCsvPath(ctx.rootPath, ctx.asset.id, ctx.task.id));
  assert.equal(await fileSha(ctx.original), ctx.originalSha, "原 CSV 字节必须不变");
  assert.equal(
    (await readFile(summary.resultCsvPath)).equals(await readFile(ctx.original)),
    false,
    "结果 CSV 是派生新文件"
  );

  const resultBytes = await readFile(summary.resultCsvPath);
  const decoded = decodeCsv(resultBytes);
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.bom, false);
  const rows = parseCsv(decoded.text);
  const header = rows[0];
  assert.ok(decoded.text.startsWith(`${header.join(",")}\r\n`), "记录分隔符保留原文件 CRLF");
  assert.ok(decoded.text.endsWith("\r\n"));
  assert.ok(decoded.text.includes('"1. 打开登录页\n2. 输入账号, 密码"'), "多行/逗号字段必须引用");
  assert.ok(header.includes("AOS Result"));
  assert.ok(header.includes("IOS Result"));
  assert.ok(!header.includes("__aos_assertions"), "结果 CSV 不得包含隐藏断言列");
  for (const column of SYSTEM_COLUMNS) assert.ok(header.includes(column.header), column.header);
  assert.deepEqual(header.slice(4), ["AOS Result", "IOS Result", ...SYSTEM_HEADERS]);

  const dataRow = rows[1];
  assert.deepEqual(dataRow.slice(0, 4), ["C1", "登录", "1. 打开登录页\n2. 输入账号, 密码", "1. 页面显示“登录成功”"]);
  assert.equal(dataRow[4], "PASS");
  assert.equal(dataRow[5], "");
  const resultIndex = 6 + SYSTEM_COLUMNS.findIndex((column) => column.key === "result");
  assert.equal(dataRow[resultIndex], "PASS");

  const sheet = await loadSheet(ctx.copyPath, "csv");
  const hiddenHeader = columnByHeader(sheet, "__aos_assertions");
  assert.ok(hiddenHeader > 0, "xlsx 工作副本必须写入隐藏断言列");
  assert.equal(sheet.getColumn(hiddenHeader).hidden, true);
  const assertions = await readAssertionColumn({
    workbookPath: ctx.copyPath,
    sheetName: "csv",
    caseIdHeader: "用例编号"
  });
  assert.deepEqual(assertions.get("C1").steps, [
    { step: 1, assert: [{ type: "visible", text: "登录成功" }] }
  ]);
  assert.equal(assertions.get("C2").confidence, "low");

  const saved = JSON.parse(await readFile(resultPathForJob(ctx.rootPath, ctx.task.id), "utf8"));
  assert.equal(saved.resultCsvPath, summary.resultCsvPath);
});

test("CSV 源（GB18030）：结果 CSV 保持 GB18030 + CRLF，原字节不变", async (t) => {
  const ctx = await setup(t, {
    format: "csv",
    encoding: "gb18030",
    lineEnding: "\r\n",
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["C1", "登录", "1. 打开登录页", "1. 显示“登录成功”"]]
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "C1", status: "PASS" }])
  });

  assert.equal(summary.resultCsvPath, webResultCsvPath(ctx.rootPath, ctx.asset.id, ctx.task.id));
  assert.equal(await fileSha(ctx.original), ctx.originalSha);

  const resultBytes = await readFile(summary.resultCsvPath);
  const decoded = decodeCsv(resultBytes);
  assert.equal(decoded.encoding, "gb18030");
  assert.ok(decoded.text.includes("\r\n"));
  const rows = parseCsv(decoded.text);
  assert.deepEqual(rows[0].slice(4), ["AOS Result", "IOS Result", ...SYSTEM_HEADERS]);
  assert.equal(rows[1][4], "PASS");

  const sheet = await loadSheet(ctx.copyPath, "csv");
  assert.ok(columnByHeader(sheet, "__aos_assertions") > 0);
});

test("旧工作副本已有 8 列：平台列追加在后并显式告警 layout legacy（不插列）", async (t) => {
  const ctx = await setup(t, {
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["TC-1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  });
  await ensureWorkbookCopy(ctx.original, ctx.copyPath);
  const legacy = await writebackWorkbook({
    workbookPath: ctx.copyPath,
    originalPath: ctx.original,
    assetId: ctx.asset.id,
    sheetName: ctx.sheetName,
    caseIdHeader: "用例编号",
    rows: [{ caseId: "TC-1", values: { scriptFile: "legacy.js" } }],
    lastSystemValue: async () => null
  });
  assert.equal(legacy.written, 1);

  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "TC-1", status: "PASS" }])
  });

  assert.equal(summary.writebackStatus, "written");
  assert.ok(
    summary.warnings.some((warning) => warning.includes("platform-columns-after-system")),
    summary.warnings.join("；")
  );
  assert.deepEqual(summary.platformResult, {
    column: 13,
    header: "AOS Result",
    appended: true,
    layout: "legacy"
  });
  assert.equal(summary.assertionCells, 1);
  const sheet = await loadSheet(ctx.copyPath, "用例");
  assert.deepEqual(headerRowValues(sheet, [5, 6, 7, 8, 9, 10, 11, 12]), SYSTEM_HEADERS);
  assert.equal(cellText(sheet.getCell(1, 13)), "AOS Result");
  assert.equal(cellText(sheet.getCell(1, 14)), "IOS Result");
  assert.equal(cellText(sheet.getCell(1, 15)), "__aos_assertions");
  assert.equal(cellText(sheet.getCell(2, 13)), "PASS");
  assert.equal(await fileSha(ctx.original), ctx.originalSha);
});

test("CSV 源映射缺 steps（parseExcel 失败）：PASS fail-closed 为 UNVERIFIED，仍导出结果 CSV", async (t) => {
  const ctx = await setup(t, {
    format: "csv",
    encoding: "utf-8",
    lineEnding: "\r\n",
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    rows: [["C1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]],
    omitStepsMapping: true
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "C1", status: "PASS" }])
  });

  assert.equal(summary.writebackStatus, "written");
  assert.equal(summary.taskStatus, "partial", "原件不可解析时 PASS 不得直通");
  assert.deepEqual(summary.gate, {
    result: "partial",
    total: 1,
    passed: 0,
    failed: 0,
    errors: 0,
    skipped: 0,
    unverified: 1
  });
  assert.equal(summary.platformResult, null, "原件不可解析时不写平台列");
  assert.equal(summary.assertionCells, 0, "原件不可解析时不写隐藏断言");
  assert.equal(summary.resultCsvPath, webResultCsvPath(ctx.rootPath, ctx.asset.id, ctx.task.id));
  for (const marker of [
    "source-unreadable",
    "platform-result-skipped",
    "assertion-column-skipped",
    "verdict-source-unreadable",
    "verdict-unverified"
  ]) {
    assert.ok(
      summary.warnings.some((warning) => warning.includes(marker)),
      `${marker}: ${summary.warnings.join("；")}`
    );
  }
  assert.equal(await fileSha(ctx.original), ctx.originalSha);

  const resultBytes = await readFile(summary.resultCsvPath);
  assert.equal(decodeCsv(resultBytes).encoding, "utf-8");
  const rows = parseCsv(decodeCsv(resultBytes).text);
  assert.deepEqual(rows[0], ["用例编号", "用例名", "步骤", "期望结果", ...SYSTEM_HEADERS]);
  assert.equal(rows[1][rows[0].indexOf("执行｜结果")], "UNVERIFIED");
  assert.ok(!rows[0].includes("AOS Result"), "解析失败时不伪造平台列");
  assert.ok(!rows[0].includes("__aos_assertions"));
});

test("CSV 源 8 列写回存在失败单元格：不导出结果 CSV，并显式告警", async (t) => {
  const ctx = await setup(t, {
    format: "csv",
    encoding: "utf-8",
    lineEnding: "\r\n",
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["C1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  });
  ctx.store.lastExcelWritebackByCellKey = async () => {
    throw new Error("journal-unavailable");
  };

  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "C1", status: "PASS" }])
  });

  assert.equal(summary.writebackStatus, "writeback-failed");
  assert.equal(summary.resultCsvPath, null, "存在失败单元格时不得导出结果 CSV");
  assert.ok(
    summary.warnings.some((warning) => warning.includes("result-csv-skipped")),
    summary.warnings.join("；")
  );
  assert.equal(
    fs.existsSync(webResultCsvPath(ctx.rootPath, ctx.asset.id, ctx.task.id)),
    false,
    "不得留下未完成的结果 CSV"
  );
  assert.equal(await fileSha(ctx.original), ctx.originalSha);
});

test("平台结果列沿用假绿守卫：任务 error 且用例全 PASS 时不写 PASS", async (t) => {
  const ctx = await setup(t, {
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["TC-1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  });
  const summary = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([], {
      execution: {
        status: "error",
        cases: [
          {
            caseId: "TC-1",
            name: "登录",
            status: "PASS",
            durationMs: 1000,
            traceId: "trace-TC-1"
          }
        ],
        startedAt: STARTED,
        finishedAt: FINISHED,
        detail: "maestro-exit:1"
      }
    })
  });

  assert.equal(summary.taskStatus, "error");
  assert.ok(summary.platformResult);
  assert.equal(summary.platformResult.header, "AOS Result");
  assert.ok(!summary.writtenCells.some((cell) => cell.key === "result"));
  const sheet = await loadSheet(ctx.copyPath, "用例");
  const aos = columnByHeader(sheet, "AOS Result");
  const result = columnByHeader(sheet, "执行｜结果");
  assert.equal(cellText(sheet.getCell(2, aos)), "", "任务级 error 不得写平台 PASS");
  assert.equal(cellText(sheet.getCell(2, result)), "", "8 列结果同口径不写 PASS");
});

test("CSV 源每个 job 生成独立结果 CSV（不覆盖上一轮）", async (t) => {
  const ctx = await setup(t, {
    format: "csv",
    encoding: "utf-8",
    lineEnding: "\n",
    headers: ["用例编号", "用例名", "步骤", "期望结果"],
    mapping: { expected: "期望结果" },
    rows: [["C1", "登录", "1. 打开登录页", "1. 页面显示“登录成功”"]]
  });
  const first = await ingestWebJobResult({
    store: ctx.store,
    jobId: ctx.task.id,
    payload: payload([{ caseId: "C1", status: "PASS" }])
  });
  const secondTask = await ctx.store.createRegressionTask({
    rootPath: ctx.rootPath,
    refs: [],
    platforms: ["android"],
    baseline: "latest",
    targetHostId: "host-1",
    jobSpec: jobSpec(ctx.asset.id),
    deviceSerial: "emulator-5554",
    deviceLeaseId: "host-1:emulator-5554"
  });
  await ctx.store.updateRegressionTask(ctx.rootPath, secondTask.id, { status: "running" });
  const second = await ingestWebJobResult({
    store: ctx.store,
    jobId: secondTask.id,
    payload: payload([{ caseId: "C1", status: "PASS" }])
  });

  assert.equal(first.resultCsvPath, webResultCsvPath(ctx.rootPath, ctx.asset.id, ctx.task.id));
  assert.equal(
    second.resultCsvPath,
    webResultCsvPath(ctx.rootPath, ctx.asset.id, secondTask.id)
  );
  assert.notEqual(first.resultCsvPath, second.resultCsvPath);
  assert.equal(fs.existsSync(first.resultCsvPath), true);
  assert.equal(fs.existsSync(second.resultCsvPath), true);
  assert.equal(await fileSha(ctx.original), ctx.originalSha);
});
