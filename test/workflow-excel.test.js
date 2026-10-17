import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { readCaseSheet } from "../dist/workflow/excel.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aos-xlsx-"));
}

async function writeWorkbook(file, build) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  build(sheet);
  await workbook.xlsx.writeFile(file);
  return file;
}

test("readCaseSheet: 表头与行归一（数字/布尔/富文本/公式结果），尾部空行裁剪", async () => {
  const dir = tempDir();
  try {
    const file = await writeWorkbook(path.join(dir, "cases.xlsx"), (sheet) => {
      sheet.addRow(["用例名", "步骤", "预期", "优先级"]);
      sheet.addRow(["登录", "输入账号密码并点击登录", "进入首页", 1]);
      sheet.getCell("A2").value = { richText: [{ text: "登" }, { text: "录" }] };
      sheet.addRow(["下单", "选择商品并提交", { formula: "1+1", result: 2 }, true]);
      sheet.addRow([]);
      sheet.addRow([]);
    });
    const parsed = await readCaseSheet(file);
    assert.deepEqual(parsed.headers, ["用例名", "步骤", "预期", "优先级"]);
    assert.equal(parsed.rows.length, 2);
    assert.deepEqual(parsed.rows[0], ["登录", "输入账号密码并点击登录", "进入首页", "1"]);
    assert.deepEqual(parsed.rows[1], ["下单", "选择商品并提交", "2", "true"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCaseSheet: 合并单元格显式失败（转换指引）", async () => {
  const dir = tempDir();
  try {
    const file = await writeWorkbook(path.join(dir, "merged.xlsx"), (sheet) => {
      sheet.addRow(["用例名", "步骤"]);
      sheet.addRow(["登录", "点击登录"]);
      sheet.mergeCells("A1:B1");
    });
    await assert.rejects(() => readCaseSheet(file), /合并单元格/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCaseSheet: 非 .xlsx 扩展名显式失败", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "legacy.xls");
    fs.writeFileSync(file, "not-a-workbook");
    await assert.rejects(() => readCaseSheet(file), /\.xlsx/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCaseSheet: 损坏工作簿显式失败", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "broken.xlsx");
    fs.writeFileSync(file, "not-a-zip");
    await assert.rejects(() => readCaseSheet(file), /读取|有效|损坏/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readCaseSheet: 空表头显式失败", async () => {
  const dir = tempDir();
  try {
    const file = await writeWorkbook(path.join(dir, "empty.xlsx"), (sheet) => {
      sheet.addRow([]);
    });
    await assert.rejects(() => readCaseSheet(file), /表头|为空/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
