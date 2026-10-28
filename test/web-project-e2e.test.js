import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset } from "../dist/web/assets.js";
import { parseExcel } from "../dist/web/excel.js";
import {
  findExcelMapping,
  previewExcelAsset,
  saveExcelMapping
} from "../dist/web/excel-mapping.js";
import { createWebProject } from "../dist/web/project-service.js";
import { ensureWorkbookCopy, workbookCopyPath } from "../dist/web/workbook.js";
import { SYSTEM_COLUMNS, writebackWorkbook } from "../dist/web/writeback.js";

const SHEET_NAME = "用例";
const BASE_HEADERS = ["模块", "展示编号", "用例名", "操作步骤", "预期结果"];
const SYSTEM_HEADERS = SYSTEM_COLUMNS.map((column) => column.header);

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

function headerValues(sheet, headerRow = 1) {
  return sheet.getRow(headerRow).values.slice(1).map(cellText);
}

function columnOfHeader(sheet, header, headerRow = 1) {
  return headerValues(sheet, headerRow).findIndex((value) => value === header) + 1;
}

function rowOfCaseId(sheet, caseId, caseIdColumn, headerRow = 1) {
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (cellText(sheet.getRow(rowNumber).getCell(caseIdColumn).value).trim() === caseId) {
      return rowNumber;
    }
  }
  return null;
}

async function readSheet(filePath, sheetName = SHEET_NAME) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  return sheet;
}

async function mutateWorkbook(filePath, mutate, sheetName = SHEET_NAME) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `工作表不存在：${sheetName}`);
  await mutate(sheet);
  await workbook.xlsx.writeFile(filePath);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function sourceWorkbookBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.addRow(BASE_HEADERS);
  sheet.addRow(["登录", "TC-1", "登录成功", "1. 打开应用\n2. 输入账号", "进入首页"]);
  sheet.addRow(["登录", "TC-2", "退出登录", "1. 点击退出", "回到登录页"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * 调用方视角的 journal 适配器：按当前工作副本解析 `(caseId, key) → cellRef`，
 * 再读 store 的最后一次系统写入。与中心 API/编排层同构，E2E 用它证明写回与 journal 一致。
 */
function journalFor(
  store,
  { rootPath, assetId, caseIdHeader, workbookPath, sheetName = SHEET_NAME }
) {
  const resolveCellRef = async (caseId, key) => {
    const sheet = await readSheet(workbookPath, sheetName);
    const column = SYSTEM_COLUMNS.find((entry) => entry.key === key);
    const columnNumber = columnOfHeader(sheet, column.header);
    const caseIdColumn = columnOfHeader(sheet, caseIdHeader);
    if (columnNumber === 0 || caseIdColumn === 0) return null;
    const rowNumber = rowOfCaseId(sheet, caseId, caseIdColumn);
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
    async record(result, jobId) {
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

test("web project e2e：建项目 → Excel CAS → 映射 → 工作副本 → 8 列写回 → journal", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aos-web-e2e-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const store = new MemoryStore();
  const created = await createWebProject({
    store,
    workspaceRoot,
    name: "星巴克 Excel",
    platforms: ["android", "ios"],
    appPackage: "com.starbucks.tw",
    customerName: "星巴克",
    owner: "admin"
  });
  const rootPath = created.rootPath;
  const project = await store.getProjectByPath(rootPath);
  assert.ok(project, "项目行应已登记");

  const buffer = await sourceWorkbookBuffer();
  const asset = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer,
    uploadedBy: "alice"
  });
  assert.equal(asset.version, 1);
  assert.equal(asset.sha256, createHash("sha256").update(buffer).digest("hex"));
  assert.equal(await sha256File(asset.storagePath), asset.sha256);
  const originalSha = asset.sha256;

  const web = await store.getWebProject(rootPath);
  assert.equal(web.name, "星巴克 Excel");
  assert.equal(web.customerName, "星巴克");
  assert.equal((await store.listWebAssets(rootPath, "excel")).length, 1);

  const preview = await previewExcelAsset({ store, rootPath, assetId: asset.id });
  assert.equal(preview.sheetName, SHEET_NAME);
  assert.deepEqual(preview.headers, BASE_HEADERS);
  assert.equal(preview.suggested.caseId, "展示编号");
  assert.equal(preview.suggested.steps, "操作步骤");
  assert.deepEqual(preview.rejectedPreview, []);

  const mapping = await saveExcelMapping({
    store,
    rootPath,
    assetId: asset.id,
    sheetName: preview.sheetName,
    columnMap: preview.suggested,
    createdBy: "alice"
  });
  assert.equal(mapping.headerFingerprint, preview.fingerprint);
  assert.equal(mapping.columnMap.caseId, "展示编号");
  const found = await findExcelMapping(store, rootPath, asset.id, preview.fingerprint);
  assert.equal(found?.id, mapping.id);
  assert.equal((await store.listExcelMappings(rootPath, asset.id)).length, 1);

  const parsed = await parseExcel(await readFile(asset.storagePath), {
    mapping: mapping.columnMap
  });
  assert.deepEqual(
    parsed.cases.map((entry) => entry.caseId),
    ["TC-1", "TC-2"]
  );
  assert.deepEqual(parsed.cases[0].steps, ["1. 打开应用", "2. 输入账号"]);
  assert.deepEqual(parsed.rejected, []);

  const workbookPath = workbookCopyPath(rootPath, asset.id);
  assert.equal(
    workbookPath,
    path.join(rootPath, ".artemis", "web", "workbook", `${asset.id}.xlsx`)
  );
  await ensureWorkbookCopy(asset.storagePath, workbookPath);
  assert.equal(await sha256File(workbookPath), originalSha, "首次复制应与原件字节一致");
  assert.deepEqual(headerValues(await readSheet(workbookPath)), BASE_HEADERS);

  const caseIdHeader = mapping.columnMap.caseId;
  assert.equal(caseIdHeader, "展示编号");
  const journal = journalFor(store, {
    rootPath,
    assetId: asset.id,
    caseIdHeader,
    workbookPath
  });

  const first = await writebackWorkbook({
    workbookPath,
    originalPath: asset.storagePath,
    assetId: asset.id,
    sheetName: SHEET_NAME,
    caseIdHeader,
    rows: [
      {
        caseId: "TC-1",
        values: { result: "FAIL", device: "Pixel 8 / Android 15", traceId: "trace-1" }
      },
      { caseId: "TC-2", values: { result: "PASS" } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(first.written, 4);
  assert.equal(first.skipped, 0);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.columns, SYSTEM_HEADERS);
  assert.deepEqual(
    first.writtenCells.map((cell) => `${cell.key}=${cell.cellRef}`),
    ["result=用例!H2", "device=用例!I2", "traceId=用例!M2", "result=用例!H3"]
  );
  await journal.record(first, "job-1");

  let sheet = await readSheet(workbookPath);
  assert.deepEqual(headerValues(sheet).slice(5, 13), SYSTEM_HEADERS);
  assert.equal(cellText(sheet.getCell("A2").value), "登录");
  assert.equal(cellText(sheet.getCell("B2").value), "TC-1");
  assert.equal(cellText(sheet.getCell("H2").value), "FAIL");
  assert.equal(cellText(sheet.getCell("I2").value), "Pixel 8 / Android 15");
  assert.equal(cellText(sheet.getCell("M2").value), "trace-1");
  assert.equal(cellText(sheet.getCell("H3").value), "PASS");
  assert.equal(await sha256File(asset.storagePath), originalSha, "写回不得改变原件 sha");

  const firstJournal = await store.lastExcelWriteback(rootPath, asset.id, "用例!H2");
  assert.equal(firstJournal.value, "FAIL");
  assert.equal(firstJournal.jobId, "job-1");
  assert.equal(firstJournal.caseId, "TC-1");
  assert.equal(firstJournal.columnKey, "result");
  assert.equal(firstJournal.sheetName, SHEET_NAME);
  assert.equal(firstJournal.actor, "alice");
  assert.equal((await store.lastExcelWriteback(rootPath, asset.id, "用例!I2")).value, "Pixel 8 / Android 15");
  assert.equal((await store.lastExcelWriteback(rootPath, asset.id, "用例!M2")).value, "trace-1");
  assert.equal((await store.lastExcelWriteback(rootPath, asset.id, "用例!H3")).value, "PASS");

  await ensureWorkbookCopy(asset.storagePath, workbookPath);
  assert.equal(
    cellText((await readSheet(workbookPath)).getCell("H2").value),
    "FAIL",
    "已有工作副本不得被原件覆盖"
  );

  await mutateWorkbook(workbookPath, (current) => {
    current.getCell("H3").value = "人工复核";
  });

  const second = await writebackWorkbook({
    workbookPath,
    originalPath: asset.storagePath,
    assetId: asset.id,
    sheetName: SHEET_NAME,
    caseIdHeader,
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
  assert.deepEqual(
    second.writtenCells.map((cell) => `${cell.key}=${cell.cellRef}`),
    ["result=用例!H2"]
  );
  await journal.record(second, "job-2");

  sheet = await readSheet(workbookPath);
  assert.equal(cellText(sheet.getCell("H2").value), "PASS", "系统格应可刷新");
  assert.equal(cellText(sheet.getCell("H3").value), "人工复核", "人工格应冻结");
  assert.equal((await store.lastExcelWriteback(rootPath, asset.id, "用例!H2")).value, "PASS");
  assert.equal(
    (await store.lastExcelWriteback(rootPath, asset.id, "用例!H3")).value,
    "PASS",
    "冻结格不得追加 journal"
  );
  assert.equal(await sha256File(asset.storagePath), originalSha);

  const third = await writebackWorkbook({
    workbookPath,
    originalPath: asset.storagePath,
    assetId: asset.id,
    sheetName: SHEET_NAME,
    caseIdHeader,
    rows: [
      { caseId: "TC-1", values: { result: "PASS" } },
      { caseId: " TC-1 ", values: { result: "FAIL" } }
    ],
    lastSystemValue: journal.last
  });
  assert.equal(third.written, 1);
  assert.equal(third.skipped, 1);
  assert.equal(third.writtenCells.length, 1);
  assert.equal(third.writtenCells[0].value, "PASS");
  assert.match(third.warnings[0], /重复/);
  await journal.record(third, "job-3");

  sheet = await readSheet(workbookPath);
  assert.equal(cellText(sheet.getCell("H2").value), "PASS", "重复输入用例编号只写首条");
  assert.equal(cellText(sheet.getCell("H3").value), "人工复核");
  assert.deepEqual(
    headerValues(sheet).filter((value) => SYSTEM_HEADERS.includes(value)),
    SYSTEM_HEADERS,
    "重复写回不得重复堆列"
  );

  assert.equal(await sha256File(asset.storagePath), originalSha, "全流程后原件 sha 不变");
  assert.deepEqual(headerValues(await readSheet(asset.storagePath)), BASE_HEADERS);
  assert.notEqual(await sha256File(workbookPath), originalSha);
});
