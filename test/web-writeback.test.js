import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";
import { FileLockTimeoutError, withFileLock } from "../dist/web/lock.js";
import { ensureWorkbookCopy, workbookCopyPath, WorkbookCopyError } from "../dist/web/workbook.js";
import { SYSTEM_COLUMNS, WritebackError, writebackWorkbook } from "../dist/web/writeback.js";

const SYSTEM_HEADERS = [
  "建议｜脚本文件",
  "建议｜关键预期",
  "执行｜结果",
  "执行｜设备与系统",
  "执行｜安装包",
  "执行｜开始时间",
  "执行｜结束时间",
  "执行｜traceId"
];

const BASE_HEADERS = ["用例编号", "用例名", "步骤"];

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  if (value.result !== undefined && value.result !== null) return cellText(value.result);
  if (typeof value.text === "string") return value.text;
  return "";
}

async function tempDir(t, prefix = "aos-web-writeback-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function writeWorkbook(
  filePath,
  { headers, rows = [], sheetName = "用例", headerRow = 1, merges = [], formulas = [] } = {}
) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (let index = 1; index < headerRow; index += 1) sheet.addRow([`标题行 ${index}`]);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  for (const range of merges) sheet.mergeCells(range);
  for (const entry of formulas) {
    sheet.getCell(entry.ref).value = { formula: entry.formula, result: entry.result };
  }
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function readSheet(filePath, sheetName = "用例") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  return sheet;
}

async function mutateWorkbook(filePath, mutate, sheetName = "用例") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  await mutate(workbook, sheet);
  await workbook.xlsx.writeFile(filePath);
}

function headerValues(sheet, headerRow = 1) {
  return sheet.getRow(headerRow).values.slice(1).map(cellText);
}

function columnOfHeader(sheet, header, headerRow = 1) {
  return headerValues(sheet, headerRow).findIndex((value) => value === header) + 1;
}

function rowOfCaseId(sheet, caseId, caseIdColumn, headerRow = 1) {
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const value = cellText(sheet.getRow(rowNumber).getCell(caseIdColumn).value).trim();
    if (value === caseId) return rowNumber;
  }
  return null;
}

/**
 * 调用方视角的 journal 适配器：按「用例编号 + 列 key」解析出当前工作副本里的 cellRef，
 * 再读写 store 里的 journal（与后续 API 层同构）。
 */
function journalFor(
  store,
  { rootPath, assetId, workbookPath, sheetName = "用例", caseIdHeader = "用例编号", headerRow = 1 }
) {
  const resolveCellRef = async (caseId, key) => {
    const column = SYSTEM_COLUMNS.find((entry) => entry.key === key);
    const sheet = await readSheet(workbookPath, sheetName);
    const columnNumber = columnOfHeader(sheet, column.header, headerRow);
    if (columnNumber === 0) return null;
    const caseIdColumn = columnOfHeader(sheet, caseIdHeader, headerRow);
    if (caseIdColumn === 0) return null;
    const rowNumber = rowOfCaseId(sheet, caseId, caseIdColumn, headerRow);
    if (rowNumber === null) return null;
    return `${sheet.name}!${sheet.getCell(rowNumber, columnNumber).address}`;
  };

  return {
    async last(caseId, key) {
      const cellRef = await resolveCellRef(caseId, key);
      if (cellRef === null) return null;
      const record = await store.lastExcelWriteback(rootPath, assetId, cellRef);
      return record ? record.value : null;
    },
    async record(result, jobId = "job-1") {
      for (const cell of result.writtenCells) {
        await store.recordExcelWriteback({
          rootPath,
          assetId,
          sheetName,
          jobId,
          caseId: cell.caseId,
          columnKey: cell.key,
          cellRef: cell.cellRef,
          value: cell.value,
          actor: "alice"
        });
      }
    }
  };
}

function isWritebackError(code) {
  return (error) => {
    assert.ok(error instanceof WritebackError, `expected WritebackError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

test("ensureWorkbookCopy：复制原件、重复调用不覆盖副本、原件 sha 不变、同路径拒绝", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const original = path.join(rootPath, "cases.xlsx");
  await writeWorkbook(original, {
    headers: ["用例编号", "步骤"],
    rows: [["TC-1", "1. 打开"]]
  });
  const originalSha = await sha256(original);

  const copyPath = workbookCopyPath(rootPath, "asset-1");
  assert.equal(copyPath, path.join(rootPath, ".artemis", "web", "workbook", "asset-1.xlsx"));

  await ensureWorkbookCopy(original, copyPath);
  assert.equal(await sha256(copyPath), originalSha);

  await mutateWorkbook(copyPath, (_workbook, sheet) => {
    sheet.getCell("A3").value = "副本内的人工修改";
  });
  await ensureWorkbookCopy(original, copyPath);
  assert.equal((await readSheet(copyPath)).getCell("A3").value, "副本内的人工修改");
  assert.equal(await sha256(original), originalSha);

  await assert.rejects(
    () => ensureWorkbookCopy(original, original),
    (error) => {
      assert.ok(error instanceof WorkbookCopyError, `expected WorkbookCopyError, got ${error}`);
      assert.equal(error.code, "same-path");
      return true;
    }
  );
  await assert.rejects(() =>
    ensureWorkbookCopy(path.join(rootPath, "missing.xlsx"), path.join(rootPath, "other-copy.xlsx"))
  );
});

test("首次写回：8 列按序追加在用例编号锚点右侧，值写入对应行，原件 sha 不变", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const original = path.join(rootPath, "cases.xlsx");
  await writeWorkbook(original, {
    headers: BASE_HEADERS,
    rows: [
      ["TC-1", "登录成功", "1. 打开应用"],
      ["TC-2", "退出登录", "2. 点击退出"]
    ]
  });
  const originalSha = await sha256(original);
  const copyPath = workbookCopyPath(rootPath, "asset-1");
  await ensureWorkbookCopy(original, copyPath);
  const copyShaBefore = await sha256(copyPath);

  await mutateWorkbook(copyPath, (_workbook, sheet) => {
    sheet.getCell("M2").value = "游离数据";
  });
  const copyShaWithStray = await sha256(copyPath);

  const store = new MemoryStore();
  const journal = journalFor(store, { rootPath, assetId: "asset-1", workbookPath: copyPath });
  const result = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      {
        caseId: "TC-1",
        values: {
          result: "FAIL",
          device: "Pixel 8 / Android 15",
          traceId: "trace-1"
        }
      },
      { caseId: "TC-2", values: { result: "PASS" } }
    ],
    lastSystemValue: journal.last
  });

  assert.equal(result.written, 4);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.columns, SYSTEM_HEADERS);
  assert.equal(result.writtenCells.length, 4);
  assert.deepEqual(
    result.writtenCells.map((cell) => `${cell.key}=${cell.cellRef}`),
    ["result=用例!F2", "device=用例!G2", "traceId=用例!K2", "result=用例!F3"]
  );

  const sheet = await readSheet(copyPath);
  assert.deepEqual(headerValues(sheet).slice(3, 11), SYSTEM_HEADERS);
  assert.equal(headerValues(sheet)[2], "步骤");
  assert.equal(headerValues(sheet).length, 11);
  assert.equal(cellText(sheet.getCell("M2").value), "游离数据");
  assert.equal(cellText(sheet.getCell("F2").value), "FAIL");
  assert.equal(cellText(sheet.getCell("G2").value), "Pixel 8 / Android 15");
  assert.equal(cellText(sheet.getCell("K2").value), "trace-1");
  assert.equal(cellText(sheet.getCell("F3").value), "PASS");
  assert.equal(cellText(sheet.getCell("D2").value), "");
  assert.equal(cellText(sheet.getCell("A2").value), "TC-1");
  assert.equal(cellText(sheet.getCell("B2").value), "登录成功");

  assert.equal(await sha256(original), originalSha);
  assert.notEqual(await sha256(copyPath), copyShaWithStray);
  assert.notEqual(copyShaWithStray, copyShaBefore);
});

test("二次写回：系统格可刷新，人工改过的系统格冻结并告警", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const copyPath = path.join(rootPath, ".artemis", "web", "workbook", "asset-1.xlsx");
  await writeWorkbook(copyPath, {
    headers: BASE_HEADERS,
    rows: [
      ["TC-1", "登录成功", "1. 打开应用"],
      ["TC-2", "退出登录", "2. 点击退出"]
    ]
  });

  const store = new MemoryStore();
  const journal = journalFor(store, { rootPath, assetId: "asset-1", workbookPath: copyPath });
  const first = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { result: "FAIL", device: "Pixel 8" } },
      { caseId: "TC-2", values: { result: "PASS" } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(first.written, 3);
  await journal.record(first);
  assert.equal(await journal.last("TC-1", "result"), "FAIL");

  await mutateWorkbook(copyPath, (_workbook, sheet) => {
    sheet.getCell("F2").value = "人工";
  });

  const second = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { result: "PASS" } },
      { caseId: "TC-2", values: { result: "FAIL" } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(second.written, 1);
  assert.equal(second.skipped, 1);
  assert.equal(second.failed, 0);
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /人工/);

  const sheet = await readSheet(copyPath);
  assert.equal(cellText(sheet.getCell("F2").value), "人工");
  assert.equal(cellText(sheet.getCell("F3").value), "FAIL");

  await journal.record(second);
  assert.equal(await journal.last("TC-2", "result"), "FAIL");
  assert.equal(await journal.last("TC-1", "result"), "FAIL");
});

test("人工清空系统格不回填；空且无 journal 的格子照常写", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const copyPath = path.join(rootPath, ".artemis", "web", "workbook", "asset-1.xlsx");
  await writeWorkbook(copyPath, {
    headers: BASE_HEADERS,
    rows: [
      ["TC-1", "登录成功", "1. 打开应用"],
      ["TC-2", "退出登录", "2. 点击退出"]
    ]
  });

  const store = new MemoryStore();
  const journal = journalFor(store, { rootPath, assetId: "asset-1", workbookPath: copyPath });
  const first = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [{ caseId: "TC-1", values: { result: "FAIL" } }],
    lastSystemValue: journal.last
  });
  assert.equal(first.written, 1);
  await journal.record(first);

  await mutateWorkbook(copyPath, (_workbook, sheet) => {
    sheet.getCell("F2").value = null;
    sheet.addRow(["TC-3", "新增用例", "3. 步骤"]);
  });

  const second = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { result: "PASS" } },
      { caseId: "TC-3", values: { result: "PASS" } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(second.written, 1);
  assert.equal(second.skipped, 1);
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /清空/);

  const sheet = await readSheet(copyPath);
  assert.equal(cellText(sheet.getCell("F2").value), "");
  assert.equal(cellText(sheet.getCell("F4").value), "PASS");
});

test("锚定只看表头行：游离数据列不参与锚定也不被覆盖；锚点左侧不动", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");

  const strayHeaderPath = path.join(rootPath, "stray-header", "cases.xlsx");
  await writeWorkbook(strayHeaderPath, {
    headers: ["用例编号", "用例名", "", "步骤"],
    rows: [["TC-1", "登录成功", "游离数据", "1. 打开应用"]]
  });
  await mutateWorkbook(strayHeaderPath, (_workbook, sheet) => {
    sheet.getCell("E2").value = "人工游离";
  });
  const store = new MemoryStore();
  const strayJournal = journalFor(store, {
    rootPath,
    assetId: "asset-stray",
    workbookPath: strayHeaderPath
  });
  const strayResult = await writebackWorkbook({
    workbookPath: strayHeaderPath,
    assetId: "asset-stray",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { scriptFile: "scripts/login.maestro.yaml", result: "PASS" } }
    ],
    lastSystemValue: strayJournal.last
  });
  assert.equal(strayResult.written, 1);
  assert.equal(strayResult.skipped, 1);
  const straySheet = await readSheet(strayHeaderPath);
  assert.deepEqual(headerValues(straySheet).slice(4, 12), SYSTEM_HEADERS);
  assert.equal(cellText(straySheet.getCell("C2").value), "游离数据");
  assert.equal(cellText(straySheet.getCell("D2").value), "1. 打开应用");
  assert.equal(cellText(straySheet.getCell("E2").value), "人工游离");
  assert.equal(cellText(straySheet.getCell("G2").value), "PASS");

  const offsetPath = path.join(rootPath, "offset-anchor", "cases.xlsx");
  await writeWorkbook(offsetPath, {
    headers: ["模块", "用例编号", "用例名", "步骤"],
    rows: [["登录", "TC-1", "登录成功", "1. 打开应用"]]
  });
  const offsetJournal = journalFor(store, {
    rootPath,
    assetId: "asset-offset",
    workbookPath: offsetPath
  });
  const offsetResult = await writebackWorkbook({
    workbookPath: offsetPath,
    assetId: "asset-offset",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
    lastSystemValue: offsetJournal.last
  });
  assert.equal(offsetResult.written, 1);
  const offsetSheet = await readSheet(offsetPath);
  assert.equal(cellText(offsetSheet.getCell("A1").value), "模块");
  assert.equal(cellText(offsetSheet.getCell("A2").value), "登录");
  assert.deepEqual(headerValues(offsetSheet).slice(4, 12), SYSTEM_HEADERS);
  assert.equal(cellText(offsetSheet.getCell("G2").value), "PASS");
});

test("合并单元格/公式：目标格跳过并告警，锚点/系统表头与合并区重叠时抛错", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const store = new MemoryStore();

  const formulaPath = path.join(rootPath, "formula", "cases.xlsx");
  await writeWorkbook(formulaPath, {
    headers: ["用例编号", "执行｜结果"],
    rows: [
      ["TC-1", null],
      ["TC-2", null]
    ],
    formulas: [{ ref: "B2", formula: "1+1", result: "2" }]
  });
  const formulaJournal = journalFor(store, {
    rootPath,
    assetId: "asset-formula",
    workbookPath: formulaPath
  });
  const formulaResult = await writebackWorkbook({
    workbookPath: formulaPath,
    assetId: "asset-formula",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { result: "PASS" } },
      { caseId: "TC-2", values: { result: "PASS" } }
    ],
    lastSystemValue: formulaJournal.last
  });
  assert.equal(formulaResult.written, 1);
  assert.equal(formulaResult.skipped, 1);
  assert.match(formulaResult.warnings[0], /公式/);
  const formulaSheet = await readSheet(formulaPath);
  assert.equal(formulaSheet.getCell("B2").formula, "1+1");
  assert.equal(cellText(formulaSheet.getCell("B3").value), "PASS");
  assert.deepEqual(headerValues(formulaSheet).slice(0, 2), ["用例编号", "执行｜结果"]);
  assert.deepEqual(headerValues(formulaSheet).slice(2, 9), [
    "建议｜脚本文件",
    "建议｜关键预期",
    "执行｜设备与系统",
    "执行｜安装包",
    "执行｜开始时间",
    "执行｜结束时间",
    "执行｜traceId"
  ]);

  const mergedTargetPath = path.join(rootPath, "merged-target", "cases.xlsx");
  await writeWorkbook(mergedTargetPath, {
    headers: ["用例编号", "执行｜结果"],
    rows: [
      ["TC-1", null],
      ["TC-2", null]
    ],
    merges: ["B2:B3"]
  });
  const mergedTargetSha = await sha256(mergedTargetPath);
  const mergedTargetJournal = journalFor(store, {
    rootPath,
    assetId: "asset-merged-target",
    workbookPath: mergedTargetPath
  });
  const mergedTargetResult = await writebackWorkbook({
    workbookPath: mergedTargetPath,
    assetId: "asset-merged-target",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-1", values: { result: "PASS" } },
      { caseId: "TC-2", values: { result: "PASS" } }
    ],
    lastSystemValue: mergedTargetJournal.last
  });
  assert.equal(mergedTargetResult.written, 0);
  assert.equal(mergedTargetResult.skipped, 2);
  assert.equal(mergedTargetResult.warnings.length, 2);
  assert.ok(mergedTargetResult.warnings.every((warning) => /合并/.test(warning)));
  assert.equal(await sha256(mergedTargetPath), mergedTargetSha);

  const mergedAnchorPath = path.join(rootPath, "merged-anchor", "cases.xlsx");
  await writeWorkbook(mergedAnchorPath, {
    headers: ["用例编号", "用例名", "步骤"],
    rows: [["TC-1", "登录成功", "1. 打开应用"]],
    merges: ["A1:B1"]
  });
  const mergedAnchorSha = await sha256(mergedAnchorPath);
  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: mergedAnchorPath,
        assetId: "asset-merged-anchor",
        sheetName: "用例",
        caseIdHeader: "用例编号",
        rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
        lastSystemValue: async () => null
      }),
    isWritebackError("merged-header")
  );
  assert.equal(await sha256(mergedAnchorPath), mergedAnchorSha);

  const mergedSystemPath = path.join(rootPath, "merged-system", "cases.xlsx");
  await writeWorkbook(mergedSystemPath, {
    headers: ["用例编号", "执行｜结果", "备注"],
    rows: [["TC-1", null, null]],
    merges: ["B1:C1"]
  });
  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: mergedSystemPath,
        assetId: "asset-merged-system",
        sheetName: "用例",
        caseIdHeader: "用例编号",
        rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
        lastSystemValue: async () => null
      }),
    isWritebackError("merged-header")
  );
});

test("withFileLock：互斥串行、超时抛错、finally 释放锁文件", async (t) => {
  const dir = await tempDir(t);
  const lockPath = path.join(dir, "nested", "writeback.lock");

  let active = 0;
  let maxActive = 0;
  const order = [];
  const task = (name) =>
    withFileLock(lockPath, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`${name}:end`);
      active -= 1;
      return name;
    });

  const results = await Promise.all([task("a"), task("b")]);
  assert.deepEqual(results, ["a", "b"]);
  assert.equal(maxActive, 1);
  assert.equal(order.length, 4);
  await assert.rejects(() => access(lockPath));

  await withFileLock(lockPath, async () => {
    await assert.rejects(
      () => withFileLock(lockPath, async () => undefined, { timeoutMs: 30, pollMs: 5 }),
      FileLockTimeoutError
    );
  });
  await assert.rejects(() => access(lockPath));

  await assert.rejects(
    () =>
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    /boom/
  );
  await assert.rejects(() => access(lockPath));
});

test("并发写回：同一 lock 串行，系统列不重复、文件可重新打开", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const copyPath = path.join(rootPath, ".artemis", "web", "workbook", "asset-1.xlsx");
  await writeWorkbook(copyPath, {
    headers: BASE_HEADERS,
    rows: [
      ["TC-1", "登录成功", "1. 打开应用"],
      ["TC-2", "退出登录", "2. 点击退出"]
    ]
  });

  const store = new MemoryStore();
  const journal = journalFor(store, { rootPath, assetId: "asset-1", workbookPath: copyPath });
  const lockPath = path.join(rootPath, ".artemis", "web", "workbook", "asset-1.lock");

  const run = (row) =>
    withFileLock(lockPath, async () => {
      const result = await writebackWorkbook({
        workbookPath: copyPath,
        assetId: "asset-1",
        sheetName: "用例",
        caseIdHeader: "用例编号",
        rows: [row],
        lastSystemValue: journal.last
      });
      await journal.record(result);
      return result;
    });

  const [first, second] = await Promise.all([
    run({ caseId: "TC-1", values: { result: "FAIL" } }),
    run({ caseId: "TC-2", values: { result: "PASS" } })
  ]);
  assert.equal(first.written, 1);
  assert.equal(second.written, 1);

  const sheet = await readSheet(copyPath);
  const headers = headerValues(sheet);
  for (const header of SYSTEM_HEADERS) {
    assert.equal(headers.filter((value) => value === header).length, 1, `表头重复：${header}`);
  }
  assert.deepEqual(headers.slice(3, 11), SYSTEM_HEADERS);
  assert.equal(cellText(sheet.getCell("F2").value), "FAIL");
  assert.equal(cellText(sheet.getCell("F3").value), "PASS");
  await assert.rejects(() => access(lockPath));
});

test("未知用例编号/空值不写、不改文件；缺锚点/缺表/坏文件显式报错；支持 headerRow", async (t) => {
  const workspace = await tempDir(t);
  const rootPath = path.join(workspace, "acme");
  const copyPath = path.join(rootPath, ".artemis", "web", "workbook", "asset-1.xlsx");
  await writeWorkbook(copyPath, {
    headers: BASE_HEADERS,
    rows: [["TC-1", "登录成功", "1. 打开应用"]]
  });
  const store = new MemoryStore();
  const journal = journalFor(store, { rootPath, assetId: "asset-1", workbookPath: copyPath });
  const shaBefore = await sha256(copyPath);

  const result = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [
      { caseId: "TC-404", values: { result: "FAIL" } },
      { caseId: "TC-1", values: { result: "" } },
      { caseId: "TC-1", values: { traceId: undefined } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(result.written, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.match(result.warnings[0], /TC-404/);
  assert.equal(await sha256(copyPath), shaBefore);

  const journalFailure = await writebackWorkbook({
    workbookPath: copyPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
    lastSystemValue: async () => {
      throw new Error("journal down");
    }
  });
  assert.equal(journalFailure.written, 0);
  assert.equal(journalFailure.skipped, 0);
  assert.equal(journalFailure.failed, 1);
  assert.match(journalFailure.warnings[0], /读取写回日志失败/);
  assert.equal(await sha256(copyPath), shaBefore);

  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: copyPath,
        assetId: "asset-1",
        sheetName: "用例",
        caseIdHeader: "用例编号X",
        rows: [],
        lastSystemValue: async () => null
      }),
    isWritebackError("case-id-header-not-found")
  );
  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: copyPath,
        assetId: "asset-1",
        sheetName: "用例",
        caseIdHeader: "   ",
        rows: [],
        lastSystemValue: async () => null
      }),
    isWritebackError("invalid-case-id-header")
  );
  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: copyPath,
        assetId: "asset-1",
        sheetName: "不存在的表",
        caseIdHeader: "用例编号",
        rows: [],
        lastSystemValue: async () => null
      }),
    isWritebackError("sheet-not-found")
  );

  const corruptPath = path.join(rootPath, "corrupt.xlsx");
  await writeFile(corruptPath, "not a workbook", "utf8");
  await assert.rejects(
    () =>
      writebackWorkbook({
        workbookPath: corruptPath,
        assetId: "asset-corrupt",
        sheetName: "用例",
        caseIdHeader: "用例编号",
        rows: [],
        lastSystemValue: async () => null
      }),
    isWritebackError("invalid-workbook")
  );

  const headerRowPath = path.join(rootPath, "header-row", "cases.xlsx");
  await writeWorkbook(headerRowPath, {
    headerRow: 2,
    headers: BASE_HEADERS,
    rows: [["TC-1", "登录成功", "1. 打开应用"]]
  });
  const headerRowJournal = journalFor(store, {
    rootPath,
    assetId: "asset-header-row",
    workbookPath: headerRowPath,
    headerRow: 2
  });
  const headerRowResult = await writebackWorkbook({
    workbookPath: headerRowPath,
    assetId: "asset-header-row",
    sheetName: "用例",
    caseIdHeader: "用例编号",
    headerRow: 2,
    rows: [{ caseId: "TC-1", values: { result: "PASS" } }],
    lastSystemValue: headerRowJournal.last
  });
  assert.equal(headerRowResult.written, 1);
  const headerRowSheet = await readSheet(headerRowPath);
  assert.deepEqual(headerValues(headerRowSheet, 2).slice(3, 11), SYSTEM_HEADERS);
  assert.equal(cellText(headerRowSheet.getCell("F3").value), "PASS");
  assert.equal(cellText(headerRowSheet.getCell("A1").value), "标题行 1");
});

test("MemoryStore journal：追加写、按 cellRef 取最后一条、项目/资产隔离", async () => {
  const store = new MemoryStore();
  const rootPath = "/w/acme";
  const first = await store.recordExcelWriteback({
    rootPath,
    assetId: "asset-1",
    sheetName: "用例",
    jobId: "job-1",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "FAIL",
    actor: "alice",
    writtenAt: "2026-10-28T10:00:00.000Z"
  });
  assert.equal(first.projectId, null);
  assert.equal(first.jobId, "job-1");
  assert.equal(first.actor, "alice");
  assert.equal(first.writtenAt, "2026-10-28T10:00:00.000Z");

  const second = await store.recordExcelWriteback({
    rootPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "PASS",
    writtenAt: "2026-10-28T11:00:00.000Z"
  });
  await store.recordExcelWriteback({
    rootPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseId: "TC-2",
    columnKey: "result",
    cellRef: "用例!F3",
    value: "PASS"
  });

  assert.equal((await store.lastExcelWriteback(rootPath, "asset-1", "用例!F2")).value, "PASS");
  assert.equal((await store.lastExcelWriteback(rootPath, "asset-1", "用例!F2")).id, second.id);
  assert.equal((await store.lastExcelWriteback(rootPath, "asset-1", "用例!F3")).value, "PASS");
  assert.equal(await store.lastExcelWriteback(rootPath, "asset-1", "用例!F9"), null);
  assert.equal(await store.lastExcelWriteback(rootPath, "asset-2", "用例!F2"), null);
  assert.equal(await store.lastExcelWriteback("/w/other", "asset-1", "用例!F2"), null);
});

test("FileStore journal：写入 state.json、重启后仍可取最新", async (t) => {
  const homeDir = await tempDir(t, "aos-web-writeback-ledger-");
  const rootPath = path.join(await tempDir(t), "acme");
  await mkdir(rootPath, { recursive: true });

  const store = await FileStore.create({ homeDir });
  await store.upsertProject({ rootPath, name: "acme" });
  await store.recordExcelWriteback({
    rootPath,
    assetId: "asset-1",
    sheetName: "用例",
    jobId: "job-1",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "FAIL",
    writtenAt: "2026-10-28T10:00:00.000Z"
  });
  await store.recordExcelWriteback({
    rootPath,
    assetId: "asset-1",
    sheetName: "用例",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "PASS",
    writtenAt: "2026-10-28T11:00:00.000Z"
  });
  await store.close();

  const stateFile = path.join(rootPath, ".artemis", "ledger", "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.state.excelWritebacks.length, 2);

  const reopened = await FileStore.create({ homeDir });
  const latest = await reopened.lastExcelWriteback(rootPath, "asset-1", "用例!F2");
  assert.equal(latest.value, "PASS");
  assert.equal(await reopened.lastExcelWriteback(rootPath, "asset-2", "用例!F2"), null);
  await reopened.close();
});

test("PostgresStore (pg-mem): excel_writeback_journal 记录与最新值查询", async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();

  await store.recordExcelWriteback({
    rootPath: "/w/acme",
    assetId: "asset-1",
    sheetName: "用例",
    jobId: "job-1",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "FAIL",
    actor: "alice",
    writtenAt: "2026-10-28T10:00:00.000Z"
  });
  await store.recordExcelWriteback({
    rootPath: "/w/acme",
    assetId: "asset-1",
    sheetName: "用例",
    jobId: "job-2",
    caseId: "TC-1",
    columnKey: "result",
    cellRef: "用例!F2",
    value: "PASS",
    writtenAt: "2026-10-28T11:00:00.000Z"
  });
  await store.recordExcelWriteback({
    rootPath: "/w/acme",
    assetId: "asset-1",
    sheetName: "用例",
    caseId: "TC-2",
    columnKey: "result",
    cellRef: "用例!F3",
    value: "ERROR"
  });

  const latest = await store.lastExcelWriteback("/w/acme", "asset-1", "用例!F2");
  assert.equal(latest.value, "PASS");
  assert.equal(latest.jobId, "job-2");
  assert.equal(latest.columnKey, "result");
  assert.equal(latest.caseId, "TC-1");
  assert.equal((await store.lastExcelWriteback("/w/acme", "asset-1", "用例!F3")).value, "ERROR");
  assert.equal(await store.lastExcelWriteback("/w/acme", "asset-1", "用例!F9"), null);
  assert.equal(await store.lastExcelWriteback("/w/acme", "asset-2", "用例!F2"), null);
  assert.equal(await store.lastExcelWriteback("/w/other", "asset-1", "用例!F2"), null);
  await store.close();
});
