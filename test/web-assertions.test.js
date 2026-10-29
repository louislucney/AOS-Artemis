import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { classifyExpectedResult } from "../dist/web/assertions.js";
import {
  ASSERTION_COLUMN_HEADER,
  AssertionColumnError,
  readAssertionColumn,
  writeAssertionColumn
} from "../dist/web/assertion-column.js";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeWorkbook(t, options = {}) {
  const dir = await tempDir(t, "aos-assertions-");
  const filePath = path.join(dir, options.fileName ?? "cases.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? "用例");
  for (const row of options.rows ?? [
    ["用例编号", "用例名", "步骤", "预期"],
    ["C1", "登录", "打开首页\n点击登录", "显示“首页”"],
    ["C2", "退出", "打开首页\n点击退出", "显示“已退出”"],
    ["C3", "列表", "打开列表", "最多8条"]
  ]) {
    sheet.addRow(row);
  }
  if (options.mutate) options.mutate(workbook, sheet);
  await workbook.xlsx.writeFile(filePath);
  return { dir, filePath };
}

async function loadSheet(filePath, sheetName = "用例") {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  assert.ok(sheet, `missing sheet ${sheetName}`);
  return { workbook, sheet };
}

const doc = (caseId, step = 1, text = "首页") => ({
  version: 1,
  source: "excel.expected",
  confidence: "high",
  steps: [{ step, assert: [{ type: "visible", text }] }],
  manual: [],
  ambiguous: []
});

function snapshot(sheet, rows, columns) {
  const values = [];
  for (let row = 1; row <= rows; row += 1) {
    const line = [];
    for (let column = 1; column <= columns; column += 1) {
      line.push(sheet.getCell(row, column).value ?? null);
    }
    values.push(line);
  }
  return values;
}

test("classify: 编号多行 1./2./-- → visible + notVisible，备注不作硬断言", () => {
  const expected = [
    "1. 页面显示“商品详情”，显示“加入购物车”",
    "2. 显示“已收藏”，不显示“加入购物车”",
    "-- 备注：收藏状态以后台返回为准，仅作记录"
  ].join("\n");
  const result = classifyExpectedResult({
    expected,
    steps: ["打开商品详情页", "点击收藏按钮"],
    caseId: "TC_01"
  });

  assert.equal(result.version, 1);
  assert.equal(result.source, "excel.expected");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.steps, [
    {
      step: 1,
      assert: [
        { type: "visible", text: "商品详情" },
        { type: "visible", text: "加入购物车" }
      ]
    },
    {
      step: 2,
      assert: [
        { type: "visible", text: "已收藏" },
        { type: "notVisible", text: "加入购物车" }
      ]
    }
  ]);
  assert.deepEqual(result.manual, []);
  assert.deepEqual(result.ambiguous, []);
  assert.equal(
    JSON.stringify(result).includes("后台"),
    false,
    "备注行默认不进断言"
  );
});

test("classify: TC_03 子项 i./ii. 绑定当前步骤，最多N → count", () => {
  const result = classifyExpectedResult({
    expected: ["2. 积分模块：", "i. 当前积分为“120”", "ii. 最多8条积分记录"].join("\n"),
    steps: ["进入首页", "查看积分模块"],
    caseId: "TC_03"
  });

  assert.equal(result.confidence, "high");
  assert.deepEqual(result.steps, [
    {
      step: 2,
      assert: [
        { type: "visible", text: "120" },
        { type: "count", max: 8 }
      ]
    }
  ]);
  assert.deepEqual(result.manual, []);
  assert.deepEqual(result.ambiguous, []);
});

test("classify: S Dollar 风格 金额计算式 → calc，跳转引号文本 → visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 组件显示金额为$80（160 ÷ 2）",
      "2. 点击后跳转至“Points Record”"
    ].join("\n"),
    steps: ["打开积分页", "点击 Points 入口"],
    caseId: "S_DOLLAR"
  });

  assert.deepEqual(result.steps, [
    {
      step: 1,
      assert: [{ type: "calc", expression: "160 / 2", expected: 80 }]
    },
    {
      step: 2,
      assert: [{ type: "visible", text: "Points Record" }]
    }
  ]);
  assert.equal(result.confidence, "high");
});

test("classify: 裸 N ÷ M → calc 且按计算式补齐 expected；向下取整生效", () => {
  const result = classifyExpectedResult({
    expected: ["1. 160 ÷ 2", "2. 100 ÷ 3 向下取整"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_CALC"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "calc", expression: "160 / 2", expected: 80 }]);
  assert.deepEqual(byStep.get(2), [
    { type: "calc", expression: "100 / 3", expected: 33 }
  ]);
});

test("classify: 否定词按谓词判定——「未登录时显示」不误判，未显示才是否定", () => {
  const result = classifyExpectedResult({
    expected: ["1. 未登录时显示“去登录”", "2. 页面未显示“提交”"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_NEG"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "visible", text: "去登录" }]);
  assert.deepEqual(byStep.get(2), [{ type: "notVisible", text: "提交" }]);
});

test("classify: 后台/刷新/GPS/排序 → manual；否定引号仍 → notVisible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 后台返回订单列表，按最近下单排序",
      "2. 下拉刷新后显示“最新数据”",
      "3. GPS 定位开启后显示当前位置",
      "4. 页面不显示“暂无数据”"
    ].join("\n"),
    steps: ["进入订单页", "下拉刷新", "开启定位", "查看空态"],
    caseId: "TC_MANUAL"
  });

  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.equal(byStep.get(1)[0].type, "manual");
  assert.equal(byStep.get(2)[0].type, "manual");
  assert.equal(byStep.get(3)[0].type, "manual");
  assert.deepEqual(byStep.get(4), [{ type: "notVisible", text: "暂无数据" }]);
  assert.deepEqual(
    result.manual.map((entry) => entry.step),
    [1, 2, 3]
  );
  assert.equal(result.confidence, "medium", "存在人工断言时置信度降一档");
  assert.deepEqual(result.ambiguous, []);
});

test("classify: 空预期 → 无断言、manual 记「无预期」、low", () => {
  for (const expected of [null, "", "   \n\t "]) {
    const result = classifyExpectedResult({ expected, steps: ["打开首页"], caseId: "TC_EMPTY" });
    assert.deepEqual(result.steps, []);
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.manual, [{ step: null, reason: "无预期", sourceText: "" }]);
    assert.deepEqual(result.ambiguous, []);
  }
});

test("classify: 无编号且无当前步骤 → ambiguous，不默认 step 1；有当前步骤则跟随", () => {
  const orphan = classifyExpectedResult({
    expected: "显示“成功”",
    steps: ["点击确认"],
    caseId: "TC_ORPHAN"
  });
  assert.deepEqual(orphan.steps, []);
  assert.deepEqual(orphan.ambiguous, [
    { step: null, reason: "缺少步骤编号，无法定位步骤", sourceText: "显示“成功”" }
  ]);

  const followed = classifyExpectedResult({
    expected: ["1. 打开首页", "显示“成功”"].join("\n"),
    steps: ["打开首页"],
    caseId: "TC_FOLLOW"
  });
  assert.deepEqual(followed.steps, [
    {
      step: 1,
      assert: [
        { type: "text", text: "打开首页" },
        { type: "visible", text: "成功" }
      ]
    }
  ]);
  assert.deepEqual(followed.ambiguous, []);
});

test("classify: 长句不发明文本 → manual（有步骤）/ ambiguous（无步骤）", () => {
  const longLine = "页面整体布局、间距与交互状态均需要与产品设计稿保持完全一致并覆盖全部机型";
  const bound = classifyExpectedResult({
    expected: `1. ${longLine}`,
    steps: ["查看页面"],
    caseId: "TC_LONG"
  });
  assert.equal(bound.steps[0].assert[0].type, "manual");
  assert.match(bound.manual[0].reason, /长句/);

  const orphan = classifyExpectedResult({
    expected: longLine,
    steps: ["查看页面"],
    caseId: "TC_LONG_ORPHAN"
  });
  assert.deepEqual(orphan.steps, []);
  assert.equal(orphan.ambiguous[0].step, null);
  assert.match(orphan.ambiguous[0].reason, /长句/);
  assert.equal(orphan.confidence, "low");
});

test("classify: 繁体/英文与不可解析计算式", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 頁面顯示“首頁”",
      '2. Do not show "Delete"',
      "3. 最多 10 個",
      "4. 160 ÷ 2 = 80",
      "5. 金额向下取整后正确"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_MIXED"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "visible", text: "首頁" }]);
  assert.deepEqual(byStep.get(2), [{ type: "notVisible", text: "Delete" }]);
  assert.deepEqual(byStep.get(3), [{ type: "count", max: 10 }]);
  assert.deepEqual(byStep.get(4), [{ type: "calc", expression: "160 / 2", expected: 80 }]);
  assert.equal(byStep.get(5)[0].type, "manual");
  assert.equal(result.manual[0].step, 5);
});

test("writeAssertionColumn: 追加隐藏列、只写已匹配行、原有单元格不变", async (t) => {
  const { filePath } = await makeWorkbook(t);
  const before = await loadSheet(filePath);
  const original = snapshot(before.sheet, 4, 4);

  const c1 = doc("C1");
  const c3 = doc("C3", 1, "列表");
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([
      ["C1", c1],
      ["C3", c3]
    ])
  });

  assert.deepEqual(result, { column: 5, written: 2, warnings: [] });

  const { sheet } = await loadSheet(filePath);
  assert.equal(sheet.getCell(1, 5).value, ASSERTION_COLUMN_HEADER);
  assert.equal(sheet.getColumn(5).hidden, true);
  assert.deepEqual(snapshot(sheet, 4, 4), original, "既有列内容不被改写");
  assert.equal(sheet.getCell(3, 5).value ?? null, null, "未提供断言的用例行留空");

  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.equal(read.size, 2);
  assert.deepEqual(read.get("C1"), c1);
  assert.deepEqual(read.get("C3"), c3);
});

test("writeAssertionColumn: 已存在隐藏列则复用，不重复追加、不清除未提供行", async (t) => {
  const { filePath } = await makeWorkbook(t);
  const first = doc("C1");
  await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([["C1", first]])
  });

  const second = doc("C2", 2, "已退出");
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([["C2", second]])
  });
  assert.equal(result.column, 5);
  assert.equal(result.written, 1);

  const { sheet } = await loadSheet(filePath);
  let headers = 0;
  sheet.getRow(1).eachCell((cell) => {
    if (cell.value === ASSERTION_COLUMN_HEADER) headers += 1;
  });
  assert.equal(headers, 1, "隐藏列表头唯一");
  assert.equal(sheet.getColumn(5).hidden, true);

  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.deepEqual(read.get("C1"), first, "未提供断言的行保持既有值");
  assert.deepEqual(read.get("C2"), second);
});

test("writeAssertionColumn: 隐藏列已在中间时原位复用；保留其他工作表", async (t) => {
  const { filePath } = await makeWorkbook(t, {
    rows: [
      ["用例编号", ASSERTION_COLUMN_HEADER, "步骤", "预期"],
      ["C1", "", "打开首页", "显示“首页”"]
    ],
    mutate: (workbook) => {
      const extra = workbook.addWorksheet("说明");
      extra.getCell("A1").value = "请勿删除";
    }
  });

  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([["C1", doc("C1")]])
  });
  assert.equal(result.column, 2);

  const { workbook, sheet } = await loadSheet(filePath);
  assert.equal(sheet.getCell(1, 4).value, "预期", "没有追加到末尾");
  assert.equal(sheet.getCell(1, 2).value, ASSERTION_COLUMN_HEADER);
  assert.equal(workbook.getWorksheet("说明").getCell("A1").value, "请勿删除");
  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.deepEqual(read.get("C1"), doc("C1"));
});

test("writeAssertionColumn: 用例编号不存在/为空 → 跳过并告警", async (t) => {
  const { filePath } = await makeWorkbook(t);
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([
      ["C9", doc("C9")],
      ["  ", doc("X")]
    ])
  });
  assert.equal(result.written, 0);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings.join("\n"), /用例编号不存在：C9/);
  assert.match(result.warnings.join("\n"), /缺少用例编号/);
});

test("readAssertionColumn: 缺少隐藏列返回空 Map；坏 JSON 跳过", async (t) => {
  const { filePath } = await makeWorkbook(t);
  const empty = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.equal(empty.size, 0);

  await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([["C1", doc("C1")]])
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  workbook.getWorksheet("用例").getCell(3, 5).value = "{not json";
  await workbook.xlsx.writeFile(filePath);

  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.equal(read.size, 1);
  assert.deepEqual(read.get("C1"), doc("C1"));
});

test("readAssertionColumn: 缺少隐藏列时即使下一列表头是合并区也不报错", async (t) => {
  const { filePath } = await makeWorkbook(t, {
    rows: [
      ["用例编号", "步骤", "", ""],
      ["C1", "打开首页", "", ""]
    ],
    mutate: (_workbook, sheet) => {
      sheet.mergeCells("C1:D1");
    }
  });
  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号"
  });
  assert.equal(read.size, 0);
  await assert.rejects(
    writeAssertionColumn({
      workbookPath: filePath,
      sheetName: "用例",
      caseIdHeader: "用例编号",
      assertions: new Map()
    }),
    (error) => error instanceof AssertionColumnError && error.code === "merged-header"
  );
});

test("writeAssertionColumn: 工作表/用例编号列缺失显式失败", async (t) => {
  const { filePath } = await makeWorkbook(t);
  await assert.rejects(
    writeAssertionColumn({
      workbookPath: filePath,
      sheetName: "不存在",
      caseIdHeader: "用例编号",
      assertions: new Map()
    }),
    (error) => error instanceof AssertionColumnError && error.code === "sheet-not-found"
  );
  await assert.rejects(
    writeAssertionColumn({
      workbookPath: filePath,
      sheetName: "用例",
      caseIdHeader: "编号不存在",
      assertions: new Map()
    }),
    (error) => error instanceof AssertionColumnError && error.code === "case-id-header-not-found"
  );
});
