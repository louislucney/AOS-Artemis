import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import {
  CANONICAL_FIELDS,
  semanticFingerprint,
  suggestExcelMapping
} from "../dist/web/excel-columns.js";
import { ExcelMappingError, parseExcel, readExcelHeaders } from "../dist/web/excel.js";

async function xlsxBuffer(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows ?? []) worksheet.addRow(row);
    sheet.mutate?.(worksheet);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function isMappingError(code) {
  return (error) => {
    assert.ok(error instanceof ExcelMappingError, `expected ExcelMappingError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

test("CANONICAL_FIELDS: 规范字段集合与顺序固定", () => {
  assert.deepEqual(CANONICAL_FIELDS, [
    "caseId",
    "name",
    "steps",
    "expected",
    "preconditions",
    "module",
    "priority",
    "testData",
    "testId"
  ]);
});

test("suggestExcelMapping: 中文别名映射到规范字段", () => {
  assert.deepEqual(
    suggestExcelMapping([
      "用例编号",
      "用例名称",
      "操作步骤",
      "预期结果",
      "前置条件",
      "所属模块",
      "优先级",
      "测试数据",
      "测试编号"
    ]),
    {
      caseId: "用例编号",
      name: "用例名称",
      steps: "操作步骤",
      expected: "预期结果",
      preconditions: "前置条件",
      module: "所属模块",
      priority: "优先级",
      testData: "测试数据",
      testId: "测试编号"
    }
  );
  assert.deepEqual(suggestExcelMapping(["无关列", "备注"]), {});
});

test("suggestExcelMapping: 列顺序调整与无关列不影响映射", () => {
  const ordered = suggestExcelMapping(["用例编号", "用例名", "步骤", "预期", "模块"]);
  const shuffled = suggestExcelMapping(["备注", "模块", "预期", "步骤", "用例名", "用例编号", "其他"]);
  assert.deepEqual(shuffled, ordered);
  assert.equal(suggestExcelMapping(["用例编号", "步骤"])["caseId"], "用例编号");
});

test("semanticFingerprint: 只看映射字段集合与工作表名", () => {
  const base = semanticFingerprint("用例", ["用例编号", "用例名", "步骤", "预期", "备注"]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(
    semanticFingerprint("用例", ["备注", "预期", "步骤", "用例名", "用例编号"]),
    base,
    "列顺序变化不改变语义指纹"
  );
  assert.equal(
    semanticFingerprint("用例", ["用例编号", "用例名", "步骤", "预期", "备注", "优先级"]),
    semanticFingerprint("用例", ["用例编号", "用例名", "步骤", "预期", "备注", "优先级"]),
    "同映射稳定"
  );
  assert.notEqual(
    semanticFingerprint("用例", ["用例编号", "用例名", "预期"]),
    base,
    "缺步骤时字段集合不同"
  );
  assert.notEqual(semanticFingerprint("其他", ["用例编号", "用例名", "步骤", "预期", "备注"]), base);
});

test("parseExcel: 规范化字段/多行步骤/行号/空值", async () => {
  const headers = [
    "用例编号",
    "用例名",
    "步骤",
    "预期",
    "前置条件",
    "模块",
    "优先级",
    "测试数据",
    "测试编号"
  ];
  const buffer = await xlsxBuffer([
    {
      name: "登录",
      rows: [
        headers,
        [
          " 1001 ",
          "登录成功",
          "打开首页\n点击登录\n",
          "进入首页\n显示昵称",
          "已安装 App\n已登录网页",
          "账户",
          "P0",
          "账号: demo",
          "T-1"
        ],
        ["C2", "退出登录", "点击退出", "", "", "", "", "", ""]
      ]
    }
  ]);

  const parsed = await parseExcel(buffer, { mapping: suggestExcelMapping(headers) });
  assert.equal(parsed.sheetName, "登录");
  assert.deepEqual(parsed.headers, headers);
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.cases.length, 2);

  const [first, second] = parsed.cases;
  assert.equal(first.caseId, "1001");
  assert.equal(first.name, "登录成功");
  assert.deepEqual(first.steps, ["打开首页", "点击登录"]);
  assert.equal(first.expected, "进入首页\n显示昵称");
  assert.deepEqual(first.preconditions, ["已安装 App", "已登录网页"]);
  assert.equal(first.module, "账户");
  assert.equal(first.priority, "P0");
  assert.equal(first.testData, "账号: demo");
  assert.equal(first.testId, "T-1");
  assert.equal(first.rowNumber, 2);

  assert.equal(second.caseId, "C2");
  assert.equal(second.expected, null);
  assert.deepEqual(second.preconditions, []);
  assert.equal(second.module, null);
  assert.equal(second.priority, null);
  assert.equal(second.testData, null);
  assert.equal(second.testId, null);
  assert.equal(second.rowNumber, 3);
});

test("parseExcel: 数字 caseId 转字符串，列顺序变化结果一致", async () => {
  const a = await xlsxBuffer([
    {
      name: "S",
      rows: [
        ["用例编号", "步骤", "预期"],
        [1001, "点击", "出现"],
        ["C2", "滑动", "滚动"]
      ]
    }
  ]);
  const b = await xlsxBuffer([
    {
      name: "S",
      rows: [
        ["备注", "预期", "用例编号", "步骤"],
        ["无关", "出现", 1001, "点击"],
        ["无关", "滚动", "C2", "滑动"]
      ]
    }
  ]);
  const mappingA = suggestExcelMapping(["用例编号", "步骤", "预期"]);
  const mappingB = suggestExcelMapping(["备注", "预期", "用例编号", "步骤"]);
  assert.deepEqual(mappingB, mappingA);

  const parsedA = await parseExcel(a, { mapping: mappingA });
  const parsedB = await parseExcel(b, { mapping: mappingB });
  assert.equal(parsedA.cases[0].caseId, "1001");
  assert.deepEqual(parsedB.cases, parsedA.cases);
});

test("parseExcel: 重复 caseId 保留第一条，后续进 rejected", async () => {
  const buffer = await xlsxBuffer([
    {
      name: "S",
      rows: [
        ["用例编号", "步骤"],
        ["C1", "第一步"],
        ["C1", "重复步骤"],
        ["C2", "第二步"]
      ]
    }
  ]);
  const parsed = await parseExcel(buffer, {
    mapping: { caseId: "用例编号", steps: "步骤" }
  });
  assert.deepEqual(
    parsed.cases.map((entry) => entry.caseId),
    ["C1", "C2"]
  );
  assert.equal(parsed.rejected.length, 1);
  assert.equal(parsed.rejected[0].row, 3);
  assert.match(parsed.rejected[0].reason, /重复/);
  assert.match(parsed.rejected[0].reason, /第 2 行/);
});

test("parseExcel: 空 caseId / 空 steps 进 rejected，全空行跳过", async () => {
  const buffer = await xlsxBuffer([
    {
      name: "S",
      rows: [
        ["用例编号", "步骤"],
        ["", "缺编号"],
        ["C2", "   "],
        ["", ""],
        ["C3", "有效步骤"]
      ]
    }
  ]);
  const parsed = await parseExcel(buffer, {
    mapping: { caseId: "用例编号", steps: "步骤" }
  });
  assert.deepEqual(
    parsed.cases.map((entry) => [entry.caseId, entry.rowNumber]),
    [["C3", 5]]
  );
  assert.deepEqual(
    parsed.rejected.map((entry) => entry.row),
    [2, 3]
  );
  assert.match(parsed.rejected[0].reason, /用例编号/);
  assert.match(parsed.rejected[1].reason, /步骤/);
});

test("parseExcel: 公式使用缓存值（含 0/false），可选列无缓存为 null，必填列无缓存拒绝", async () => {
  const buffer = await xlsxBuffer([
    {
      name: "公式",
      rows: [
        ["用例编号", "步骤", "预期"],
        ["占位", "占位", ""],
        ["占位", "点击", "占位"],
        ["C4", "点击", "占位"],
        ["C5", "占位", "占位"],
        ["C6", "点击", ""]
      ],
      mutate(worksheet) {
        worksheet.getCell("A2").value = { formula: "1000+1", result: 1001 };
        worksheet.getCell("A3").value = { formula: "0", result: 0 };
        worksheet.getCell("C3").value = { formula: "1=2", result: false };
        worksheet.getCell("C4").value = { formula: "A1" };
        worksheet.getCell("B5").value = { formula: "A1" };
      }
    }
  ]);
  const parsed = await parseExcel(buffer, {
    mapping: { caseId: "用例编号", steps: "步骤", expected: "预期" }
  });
  assert.deepEqual(
    parsed.cases.map((entry) => [entry.caseId, entry.steps[0], entry.expected, entry.rowNumber]),
    [
      ["1001", "占位", null, 2],
      ["0", "点击", "false", 3],
      ["C4", "点击", null, 4],
      ["C6", "点击", null, 6]
    ]
  );
  assert.equal(parsed.rejected.length, 1);
  assert.equal(parsed.rejected[0].row, 5);
  assert.match(parsed.rejected[0].reason, /公式/);
  assert.match(parsed.rejected[0].reason, /步骤/);
});

test("suggestExcelMapping: web 解析器识别扩展别名（用例ID/测试过程）", () => {
  assert.deepEqual(suggestExcelMapping(["用例ID", "测试过程"]), {
    caseId: "用例ID",
    steps: "测试过程"
  });
});

test("parseExcel: 映射列含合并单元格拒绝，未映射列合并不影响", async () => {
  const merged = await xlsxBuffer([
    {
      name: "合并",
      rows: [
        ["用例编号", "步骤", "预期"],
        ["C1", "点击", ""],
        ["C2", "点击", ""]
      ],
      mutate(worksheet) {
        worksheet.mergeCells("B2:B3");
      }
    }
  ]);
  await assert.rejects(
    parseExcel(merged, { mapping: { caseId: "用例编号", steps: "步骤" } }),
    isMappingError("merged-cells")
  );

  const unrelated = await xlsxBuffer([
    {
      name: "无关合并",
      rows: [
        ["用例编号", "步骤", "备注"],
        ["C1", "点击", "备注一"],
        ["C2", "点击", "备注二"]
      ],
      mutate(worksheet) {
        worksheet.mergeCells("C2:C3");
      }
    }
  ]);
  const parsed = await parseExcel(unrelated, {
    mapping: { caseId: "用例编号", steps: "步骤" }
  });
  assert.deepEqual(
    parsed.cases.map((entry) => entry.caseId),
    ["C1", "C2"]
  );
});

test("parseExcel: 映射缺失必需列 / 列不存在时显式失败", async () => {
  const buffer = await xlsxBuffer([
    { name: "S", rows: [["用例编号", "步骤"], ["C1", "点击"]] }
  ]);
  await assert.rejects(
    parseExcel(buffer, { mapping: { caseId: "用例编号" } }),
    (error) => {
      assert.ok(error instanceof ExcelMappingError);
      assert.equal(error.code, "missing-required");
      assert.match(error.message, /步骤/);
      return true;
    }
  );
  await assert.rejects(
    parseExcel(buffer, { mapping: { caseId: "不存在的列", steps: "步骤" } }),
    isMappingError("column-not-found")
  );
  await assert.rejects(
    parseExcel(buffer, {
      mapping: { caseId: "用例编号", name: "用例编号", steps: "步骤" }
    }),
    isMappingError("duplicate-column")
  );
});

test("readExcelHeaders: 缺必填列时仍可读表头（预览用），表头行可指定", async () => {
  const buffer = await xlsxBuffer([
    { name: "封面", rows: [["说明"]] },
    {
      name: "用例",
      rows: [
        ["测试用例表"],
        ["用例编号", "备注"],
        ["C1", "x"]
      ]
    }
  ]);
  assert.deepEqual(await readExcelHeaders(buffer, { sheetName: "用例", headerRow: 2 }), {
    sheetName: "用例",
    headers: ["用例编号", "备注"]
  });
  const headers = await readExcelHeaders(buffer, { sheetName: "用例", headerRow: 2 });
  assert.deepEqual(suggestExcelMapping(headers.headers), { caseId: "用例编号" });
  await assert.rejects(
    parseExcel(buffer, { sheetName: "用例", headerRow: 2, mapping: suggestExcelMapping(headers.headers) }),
    isMappingError("missing-required")
  );
});

test("parseExcel: 选择工作表与表头行", async () => {
  const buffer = await xlsxBuffer([
    { name: "封面", rows: [["说明"]] },
    {
      name: "用例",
      rows: [
        ["测试用例表"],
        ["用例编号", "步骤"],
        ["C1", "点击"]
      ]
    }
  ]);
  const parsed = await parseExcel(buffer, {
    sheetName: "用例",
    headerRow: 2,
    mapping: { caseId: "用例编号", steps: "步骤" }
  });
  assert.equal(parsed.sheetName, "用例");
  assert.deepEqual(parsed.headers, ["用例编号", "步骤"]);
  assert.equal(parsed.cases[0].rowNumber, 3);

  await assert.rejects(
    parseExcel(buffer, { sheetName: "不存在", mapping: { caseId: "用例编号", steps: "步骤" } }),
    isMappingError("sheet-not-found")
  );
  await assert.rejects(
    parseExcel(Buffer.from("not an xlsx"), { mapping: { caseId: "用例编号", steps: "步骤" } }),
    isMappingError("invalid-workbook")
  );
});

test("suggestExcelMapping: 新增别名（用例ID/测试点/期望结果/测试步骤/前置条件/测试数据）", () => {
  assert.deepEqual(
    suggestExcelMapping([
      "用例ID",
      "测试点",
      "测试步骤",
      "期望结果",
      "前置条件",
      "测试数据"
    ]),
    {
      caseId: "用例ID",
      name: "测试点",
      steps: "测试步骤",
      expected: "期望结果",
      preconditions: "前置条件",
      testData: "测试数据"
    }
  );
  assert.equal(
    suggestExcelMapping(["用例编号", "步骤", "实际结果"])["expected"],
    undefined,
    "实际结果 是执行结果列，不参与导入映射"
  );
});

const CSV_TEXT = "用例编号,测试点,测试步骤,期望结果,前置条件,测试数据\n001,登录成功,\"打开首页\n点击登录\",进入首页,已安装,账号 demo\n";

test("readExcelHeaders/parseExcel: 直接接受 CSV 缓冲（工作表名 csv）", async () => {
  const buffer = Buffer.from(CSV_TEXT, "utf8");
  const headers = await readExcelHeaders(buffer);
  assert.deepEqual(headers, {
    sheetName: "csv",
    headers: ["用例编号", "测试点", "测试步骤", "期望结果", "前置条件", "测试数据"],
    format: "csv",
    encoding: "utf-8"
  });

  const parsed = await parseExcel(buffer, { mapping: suggestExcelMapping(headers.headers) });
  assert.equal(parsed.sheetName, "csv");
  assert.equal(parsed.format, "csv");
  assert.equal(parsed.encoding, "utf-8");
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.cases.length, 1);
  assert.equal(parsed.cases[0].caseId, "001");
  assert.equal(parsed.cases[0].name, "登录成功");
  assert.deepEqual(parsed.cases[0].steps, ["打开首页", "点击登录"]);
  assert.equal(parsed.cases[0].expected, "进入首页");
  assert.deepEqual(parsed.cases[0].preconditions, ["已安装"]);
  assert.equal(parsed.cases[0].testData, "账号 demo");
  assert.equal(parsed.cases[0].rowNumber, 2);

  await assert.rejects(
    parseExcel(buffer, { sheetName: "Sheet1", mapping: suggestExcelMapping(headers.headers) }),
    isMappingError("sheet-not-found")
  );
});

test("parseExcel: 显式 format=xlsx 时 CSV 内容按损坏工作簿拒绝", async () => {
  await assert.rejects(
    parseExcel(Buffer.from(CSV_TEXT, "utf8"), {
      format: "xlsx",
      mapping: { caseId: "用例编号", steps: "测试步骤" }
    }),
    isMappingError("invalid-workbook")
  );
  await assert.rejects(
    parseExcel(Buffer.from("not an xlsx"), {
      mapping: { caseId: "用例编号", steps: "测试步骤" }
    }),
    isMappingError("invalid-workbook")
  );
});

test("parseExcel: 显式 CSV 遇到 UTF-16 BOM 拒绝 unsupported-encoding", async () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("用例编号,步骤\n", "utf16le")
  ]);
  await assert.rejects(
    parseExcel(utf16, {
      format: "csv",
      mapping: { caseId: "用例编号", steps: "步骤" }
    }),
    (error) => {
      assert.ok(error instanceof ExcelMappingError);
      assert.equal(error.code, "unsupported-encoding");
      assert.match(error.message, /UTF-16/);
      return true;
    }
  );
});
