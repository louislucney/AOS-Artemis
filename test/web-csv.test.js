import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { storeWebAsset, WebAssetError } from "../dist/web/assets.js";
import {
  CSV_SHEET_NAME,
  CsvError,
  CsvExportError,
  csvToXlsxBuffer,
  decodeCsv,
  encodeCsv,
  exportWorkbookCsv,
  parseCsv
} from "../dist/web/csv.js";
import { ensureWorkbookCopy, WorkbookCopyError } from "../dist/web/workbook.js";
import { createWebProject } from "../dist/web/project-service.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// 「用例编号,步骤,测试点,前置条件,测试数据,期望结果\nC1,点击登录,登录成功,已安装,账号demo,进入首页\n」
const GB18030_BYTES = Buffer.from(
  "d3c3c0fdb1e0bac52cb2bdd6e82cb2e2cad4b5e32cc7b0d6c3ccf5bcfe2cb2e2cad4cafdbedd2cc6dacdfbbde1b9fb0a" +
    "43312cb5e3bbf7b5c7c2bc2cb5c7c2bcb3c9b9a62cd2d1b0b2d7b02cd5cbbac564656d6f2cbdf8c8ebcad7d2b30a",
  "hex"
);

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeProject(store, rootPath, name = "acme") {
  await store.upsertProject({ rootPath, name });
  return store.createWebProject({
    rootPath,
    name,
    normalizedName: name,
    platforms: ["android"]
  });
}

function isCsvError(code) {
  return (error) => {
    assert.ok(error instanceof CsvError, `expected CsvError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

function isExportError(code) {
  return (error) => {
    assert.ok(error instanceof CsvExportError, `expected CsvExportError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

async function xlsxBuffer(rows, mutate) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("用例");
  for (const row of rows) sheet.addRow(row);
  mutate?.(sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("decodeCsv: 无 BOM UTF-8 / UTF-8 BOM / GB18030 自动识别且保留结论", () => {
  const plain = Buffer.from("用例编号,步骤\nC1,点击\n", "utf8");
  assert.deepEqual(decodeCsv(plain), {
    text: "用例编号,步骤\nC1,点击\n",
    encoding: "utf-8",
    bom: false
  });

  const withBom = Buffer.concat([UTF8_BOM, plain]);
  const bomDecoded = decodeCsv(withBom);
  assert.equal(bomDecoded.encoding, "utf-8");
  assert.equal(bomDecoded.bom, true);
  assert.equal(bomDecoded.text, plain.toString("utf8"), "BOM 不进正文");
  assert.equal(bomDecoded.text.charCodeAt(0), "用".charCodeAt(0));

  const gb = decodeCsv(GB18030_BYTES);
  assert.equal(gb.encoding, "gb18030");
  assert.equal(gb.bom, false);
  assert.match(gb.text, /^用例编号,步骤,测试点,前置条件,测试数据,期望结果\nC1,点击登录/);
  assert.match(gb.text, /进入首页\n$/);

  assert.deepEqual(decodeCsv(Buffer.alloc(0)), { text: "", encoding: "utf-8", bom: false });
});

test("parseCsv: RFC4180（引号、转义引号、逗号、CRLF/LF、内嵌换行）不截断", () => {
  const text =
    '用例编号,步骤,预期\r\n' +
    'C1,"打开首页,点击登录",进入首页\r\n' +
    'C2,"说 ""你好""","第一行\n第二行"\r\n';
  assert.deepEqual(parseCsv(text), [
    ["用例编号", "步骤", "预期"],
    ["C1", "打开首页,点击登录", "进入首页"],
    ["C2", '说 "你好"', "第一行\n第二行"]
  ]);
});

test("parseCsv: 保留空单元格/空行，容忍尾部空行与单独 CR", () => {
  assert.deepEqual(parseCsv("a,b\n,\n\nc,\n"), [
    ["a", "b"],
    ["", ""],
    [""],
    ["c", ""]
  ]);
  assert.deepEqual(parseCsv("a,b\r1,2"), [
    ["a", "b"],
    ["1", "2"]
  ]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,b"), [["a", "b"]]);
});

test("parseCsv: 引号未闭合显式失败（不静默截断）", () => {
  assert.throws(() => parseCsv('a,"b\nc'), isCsvError("unterminated-quote"));
  assert.throws(() => parseCsv('a,"b""'), isCsvError("unterminated-quote"));
});

test("encodeCsv: RFC4180 引用 + 指定编码/行尾/BOM", () => {
  const rows = [
    ["用例编号", "步骤"],
    ["C1", '说 "你好", 再见\n第二行']
  ];
  const utf8 = encodeCsv(rows);
  assert.equal(
    utf8.toString("utf8"),
    '用例编号,步骤\nC1,"说 ""你好"", 再见\n第二行"\n'
  );
  assert.deepEqual(parseCsv(utf8.toString("utf8")), rows);

  const crlf = encodeCsv(rows, { lineEnding: "\r\n" }).toString("utf8");
  assert.match(crlf, /用例编号,步骤\r\n/);
  assert.equal(crlf.replaceAll("\r\n", "").includes("\n"), true, "内嵌换行不改成 CRLF");

  const gb = encodeCsv([["用例编号", "步骤"], ["C1", "点击登录"]], { encoding: "gb18030" });
  assert.deepEqual(decodeCsv(gb).encoding, "gb18030");
  assert.deepEqual(parseCsv(decodeCsv(gb).text), [["用例编号", "步骤"], ["C1", "点击登录"]]);

  const withBom = encodeCsv([["a"]], { bom: true });
  assert.deepEqual([...withBom.subarray(0, 3)], [...UTF8_BOM]);
});

test("encodeCsv: GB18030 无法表示的字符显式失败", () => {
  assert.throws(() => encodeCsv([["\uFFFF"]], { encoding: "gb18030" }), isExportError("unencodable"));
});

test("csvToXlsxBuffer: 生成名为 csv 的工作表，块/空值原样保留", async () => {
  const text = "用例编号,步骤,预期\n001,打开首页\nC2,\"点击, 登录\",进入\n";
  const converted = await csvToXlsxBuffer(Buffer.from(text, "utf8"));
  assert.equal(converted.sheetName, CSV_SHEET_NAME);
  assert.equal(converted.encoding, "utf-8");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(converted.buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, CSV_SHEET_NAME);
  assert.equal(sheet.getCell("A2").value, "001", "数字形编号保持字符串");
  assert.equal(sheet.getCell("B3").value, "点击, 登录");
  assert.equal(sheet.getCell("C3").value, "进入");
  assert.equal(sheet.getCell("C2").value, null);
});

test("csvToXlsxBuffer: GB18030 输入按检测结果解码", async () => {
  const converted = await csvToXlsxBuffer(GB18030_BYTES);
  assert.equal(converted.encoding, "gb18030");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(converted.buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A1").value, "用例编号");
  assert.equal(sheet.getCell("B2").value, "点击登录");
  assert.equal(sheet.getCell("C2").value, "登录成功");
});

test("ensureWorkbookCopy: CSV 原件生成有效 xlsx 工作副本，原件字节不变且副本不被覆盖", async (t) => {
  const dir = await tempDir(t, "aos-csv-copy-");
  const original = path.join(dir, "case.csv");
  const target = path.join(dir, "workbook", "a.xlsx");
  const csvBytes = Buffer.from("用例编号,步骤\nC1,点击\n", "utf8");
  await writeFile(original, csvBytes);

  await ensureWorkbookCopy(original, target);
  assert.deepEqual(await readFile(original), csvBytes, "原件只读");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(target));
  assert.equal(workbook.worksheets[0].name, CSV_SHEET_NAME);
  assert.equal(workbook.worksheets[0].getCell("A2").value, "C1");

  workbook.worksheets[0].getCell("D1").value = "人工写入";
  await writeFile(target, Buffer.from(await workbook.xlsx.writeBuffer()));
  const before = await readFile(target);
  await ensureWorkbookCopy(original, target);
  assert.deepEqual(await readFile(target), before, "副本有效时保留人工写入");
});

test("ensureWorkbookCopy: 扩展名非 .csv 但内容是 CSV 也生成 xlsx", async (t) => {
  const dir = await tempDir(t, "aos-csv-copy-");
  const original = path.join(dir, "case.txt");
  const target = path.join(dir, "a.xlsx");
  await writeFile(original, Buffer.from("用例编号,步骤\nC1,点击\n", "utf8"));
  await ensureWorkbookCopy(original, target);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(target));
  assert.equal(workbook.worksheets[0].getCell("A2").value, "C1");
});

test("ensureWorkbookCopy: 非 CSV 的损坏原件仍按 invalid-original 拒绝", async (t) => {
  const dir = await tempDir(t, "aos-csv-copy-");
  const original = path.join(dir, "bad.xlsx");
  const target = path.join(dir, "a.xlsx");
  await writeFile(original, Buffer.from("not an xlsx"));
  await assert.rejects(
    ensureWorkbookCopy(original, target),
    (error) => error instanceof WorkbookCopyError && error.code === "invalid-original"
  );
});

test("storeWebAsset: excel 接受 .csv 且记录 format/encoding 元数据", async (t) => {
  const dir = await tempDir(t, "aos-csv-asset-");
  const rootPath = path.join(dir, "acme");
  await mkdir(rootPath, { recursive: true });
  const store = new MemoryStore();
  await makeProject(store, rootPath);

  const utf8 = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.csv",
    buffer: Buffer.from("用例编号,步骤\nC1,点击\n", "utf8")
  });
  assert.equal(path.extname(utf8.storagePath), ".csv");
  assert.deepEqual(utf8.metadata, { format: "csv", encoding: "utf-8" });

  const gb = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "legacy.CSV",
    buffer: GB18030_BYTES
  });
  assert.equal(path.extname(gb.storagePath), ".csv");
  assert.deepEqual(gb.metadata, { format: "csv", encoding: "gb18030" });

  const xlsx = await storeWebAsset({
    store,
    rootPath,
    kind: "excel",
    filename: "cases.xlsx",
    buffer: Buffer.from("PK-fake"),
    metadata: { note: "keep" }
  });
  assert.deepEqual(xlsx.metadata, { note: "keep" }, "xlsx 不伪造格式元数据");

  await assert.rejects(
    () =>
      storeWebAsset({
        store,
        rootPath,
        kind: "excel",
        filename: "cases.xls",
        buffer: Buffer.from("a,b\n")
      }),
    (error) => error instanceof WebAssetError && error.code === "invalid-extension"
  );
});

test("exportWorkbookCsv: 新文件导出，跳过隐藏列，RFC4180 引用，源文件不变", async (t) => {
  const dir = await tempDir(t, "aos-csv-export-");
  const source = path.join(dir, "workbook.xlsx");
  const out = path.join(dir, "result.csv");
  const steps = '点击 "登录", 再输入\n换行内容';
  await writeFile(
    source,
    await xlsxBuffer(
      [
        ["用例编号", "步骤", "隐藏列"],
        ["001", steps, "secret"],
        ["C2", "", "secret2"]
      ],
      (sheet) => {
        sheet.getColumn(3).hidden = true;
      }
    )
  );
  const sourceBefore = await readFile(source);

  const result = await exportWorkbookCsv(source, out);
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.lineEnding, "\n");
  assert.equal(result.sheetName, "用例");
  const text = await readFile(out, "utf8");
  assert.deepEqual(parseCsv(text), [
    ["用例编号", "步骤"],
    ["001", steps],
    ["C2", ""]
  ]);
  assert.deepEqual(await readFile(source), sourceBefore, "源工作副本只读");

  await assert.rejects(
    () => exportWorkbookCsv(source, source),
    isExportError("same-path")
  );
  await assert.rejects(
    () => exportWorkbookCsv(source, out),
    isExportError("output-exists")
  );
  await exportWorkbookCsv(source, out, { overwrite: true });
});

test("exportWorkbookCsv: 指定 GB18030 与 CRLF 时按请求输出", async (t) => {
  const dir = await tempDir(t, "aos-csv-export-");
  const source = path.join(dir, "workbook.xlsx");
  const out = path.join(dir, "result.csv");
  await writeFile(
    source,
    await xlsxBuffer([
      ["用例编号", "步骤"],
      ["C1", "点击登录"]
    ])
  );

  const result = await exportWorkbookCsv(source, out, {
    encoding: "gb18030",
    lineEnding: "\r\n",
    bom: false
  });
  assert.equal(result.encoding, "gb18030");
  const raw = await readFile(out);
  const decoded = decodeCsv(raw);
  assert.equal(decoded.encoding, "gb18030");
  assert.equal(decoded.text, "用例编号,步骤\r\nC1,点击登录\r\n");
  assert.equal(decoded.text.replaceAll("\r\n", "").includes("\n"), false);
  assert.deepEqual(parseCsv(decoded.text), [
    ["用例编号", "步骤"],
    ["C1", "点击登录"]
  ]);
  assert.equal(raw.subarray(0, 3).equals(UTF8_BOM), false, "GB18030 不写 UTF-8 BOM");
});

test("exportWorkbookCsv: 拒绝把结果写到原件路径", async (t) => {
  const dir = await tempDir(t, "aos-csv-export-");
  const source = path.join(dir, "workbook.xlsx");
  const original = path.join(dir, "case.csv");
  const out = path.join(dir, "result.csv");
  await writeFile(source, await xlsxBuffer([["用例编号"], ["C1"]]));
  await writeFile(original, Buffer.from("用例编号\nC1\n", "utf8"));
  await assert.rejects(
    () => exportWorkbookCsv(source, out, { originalPath: out }),
    isExportError("same-path")
  );
});
