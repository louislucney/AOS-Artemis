import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("classify: 长设计说明里的引号片段不升硬断言；有展示动词的长句仍可 visible", () => {
  const designProse =
    "页面整体布局、间距、配色、字体、图标与交互细节都需要严格遵循“设计稿”，并且在全部机型与系统版本上保持完全一致，不得有任何视觉偏差";
  const blocked = classifyExpectedResult({
    expected: `1. ${designProse}`,
    steps: ["查看页面"],
    caseId: "TC_LONG_QUOTE"
  });
  assert.equal(blocked.confidence, "low");
  assert.equal(blocked.steps[0].assert[0].type, "manual");
  assert.equal(
    blocked.steps[0].assert.some((entry) => entry.type === "visible"),
    false,
    "长句引号不得冒充可见断言"
  );

  const withVerb =
    "在页面顶部的固定导航栏中应当清晰显示“提交订单”按钮，并且在向下滚动浏览全部商品列表的过程中始终保持可见状态且不被其他浮层遮挡";
  const visible = classifyExpectedResult({
    expected: `1. ${withVerb}`,
    steps: ["查看页面"],
    caseId: "TC_LONG_QUOTE_VERB"
  });
  assert.deepEqual(visible.steps[0].assert, [{ type: "visible", text: "提交订单" }]);
  assert.equal(visible.confidence, "high");
});

test("classify: 超出 input.steps 范围的编号进 ambiguous，不发明步骤", () => {
  const result = classifyExpectedResult({
    expected: ["1. 显示“A”", "3. 显示“B”"].join("\n"),
    steps: ["打开首页", "点击登录"],
    caseId: "TC_RANGE"
  });
  assert.deepEqual(result.steps, [{ step: 1, assert: [{ type: "visible", text: "A" }] }]);
  assert.equal(result.ambiguous.length, 1);
  assert.match(result.ambiguous[0].reason, /超出范围/);
  assert.match(result.ambiguous[0].sourceText, /^3\./);
  assert.equal(result.confidence, "medium");
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

test("classify: 单行无编号预期绑定最后一步；多行无编号仍 ambiguous", () => {
  const single = classifyExpectedResult({
    expected: "显示“成功”",
    steps: ["打开首页", "点击确认"],
    caseId: "TC_SINGLE"
  });
  assert.deepEqual(single.steps, [
    { step: 2, assert: [{ type: "visible", text: "成功" }] }
  ]);
  assert.deepEqual(single.ambiguous, []);

  const multi = classifyExpectedResult({
    expected: ["显示“成功”", "显示“失败”"].join("\n"),
    steps: ["点击确认"],
    caseId: "TC_ORPHAN"
  });
  assert.deepEqual(multi.steps, []);
  assert.equal(multi.ambiguous.length, 2);
  assert.match(multi.ambiguous[0].reason, /缺少步骤编号/);

  const followed = classifyExpectedResult({
    expected: ["1. 已进入首页", "显示“成功”"].join("\n"),
    steps: ["打开首页"],
    caseId: "TC_FOLLOW"
  });
  assert.deepEqual(followed.steps, [
    {
      step: 1,
      assert: [
        { type: "text", text: "已进入首页" },
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
    expected: [longLine, longLine].join("\n"),
    steps: ["查看页面"],
    caseId: "TC_LONG_ORPHAN"
  });
  assert.deepEqual(orphan.steps, []);
  assert.equal(orphan.ambiguous[0].step, null);
  assert.match(orphan.ambiguous[0].reason, /缺少步骤编号/);
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

test("classify: 繁体显示/否定/人工关键词", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 頁面顯示“首頁”，出現“提示”",
      "2. 未顯示“A”，未出現“B”，隱藏“C”，不可見“D”，不能“E”",
      "3. 後台資料排序",
      "4. 積分餘額需刷新",
      "5. 未加載“F”，未返回“G”，未生效“H”，未完成“I”，未成功“J”，未存在“K”，未找到“L”，未彈出“M”，未支持“N”",
      "6. 未有顯示MOP intro彈窗",
      "7. 沒有成功顯示MOP intro彈窗"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e", "f", "g"],
    caseId: "TC_TRAD"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "首頁" },
    { type: "visible", text: "提示" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "notVisible", text: "A" },
    { type: "notVisible", text: "B" },
    { type: "notVisible", text: "C" },
    { type: "notVisible", text: "D" },
    { type: "notVisible", text: "E" }
  ]);
  assert.equal(byStep.get(3)[0].type, "manual");
  assert.equal(byStep.get(4)[0].type, "manual");
  assert.deepEqual(byStep.get(5), [
    { type: "notVisible", text: "F" },
    { type: "notVisible", text: "G" },
    { type: "notVisible", text: "H" },
    { type: "notVisible", text: "I" },
    { type: "notVisible", text: "J" },
    { type: "notVisible", text: "K" },
    { type: "notVisible", text: "L" },
    { type: "notVisible", text: "M" },
    { type: "notVisible", text: "N" }
  ]);
  assert.deepEqual(byStep.get(6), [{ type: "notVisible", text: "MOP intro" }]);
  assert.deepEqual(byStep.get(7), [{ type: "notVisible", text: "MOP intro" }]);
});

test("classify: ’愛心‘ / 【...】 / ‘...’ 引号对均输出 visible", () => {
  const result = classifyExpectedResult({
    expected: ["1. ’愛心‘icon變紅色", "2. 點擊【選擇門市】tab", "3. ‘首頁’按鈕"].join("\n"),
    steps: ["a", "b", "c"],
    caseId: "TC_QUOTES"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "visible", text: "愛心" }]);
  assert.deepEqual(byStep.get(2), [{ type: "visible", text: "選擇門市" }]);
  assert.deepEqual(byStep.get(3), [{ type: "visible", text: "首頁" }]);
  assert.equal(result.confidence, "high");
});

test("classify: 顯示/包含 + 、 字段列表逐标签 visible，跳过模糊标签", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 展开后显示Location、Shop Name、Reference Code等字段",
      "2. 顯示Total Amount、Location、Shop、Used S Dollar、Used S Coupon、Minimum Spending",
      "3. 顯示Member ID、Total Amount、Ref Code",
      "4. 顯示Location、內容完整、Shop Name",
      "5. 包含Location、Shop Name"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_FIELDS"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "Location" },
    { type: "visible", text: "Shop Name" },
    { type: "visible", text: "Reference Code" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "visible", text: "Total Amount" },
    { type: "visible", text: "Location" },
    { type: "visible", text: "Shop" },
    { type: "visible", text: "Used S Dollar" },
    { type: "visible", text: "Used S Coupon" },
    { type: "visible", text: "Minimum Spending" }
  ]);
  assert.deepEqual(byStep.get(3), [
    { type: "visible", text: "Member ID" },
    { type: "visible", text: "Total Amount" },
    { type: "visible", text: "Ref Code" }
  ]);
  assert.deepEqual(byStep.get(4), [
    { type: "visible", text: "Location" },
    { type: "visible", text: "Shop Name" }
  ]);
  assert.deepEqual(byStep.get(5), [
    { type: "visible", text: "Location" },
    { type: "visible", text: "Shop Name" }
  ]);
  assert.deepEqual(result.manual, []);
});

test("classify: 显示子句金额/积分/数字 visible，日期不输出", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 显示积分170 points，对应S Dollar $85",
      "2. 显示HK$500，对应-$10和-$20",
      "3. 输入框显示15",
      "4. 显示日期2026-10-29",
      "5. 显示2026-10-29，对应$85",
      "6. 第2步显示15",
      "7. 不存在“已删除”"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e", "f", "g"],
    caseId: "TC_VALUES"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "170 points" },
    { type: "visible", text: "$85" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "visible", text: "HK$500" },
    { type: "visible", text: "-$10" },
    { type: "visible", text: "-$20" }
  ]);
  assert.deepEqual(byStep.get(3), [{ type: "visible", text: "15" }]);
  assert.equal(byStep.get(4)[0].type, "manual");
  assert.equal(
    byStep.get(4).some((entry) => entry.type === "visible" && entry.text.includes("2026")),
    false
  );
  assert.deepEqual(byStep.get(5), [{ type: "visible", text: "$85" }]);
  assert.deepEqual(byStep.get(6), [{ type: "visible", text: "15" }]);
  assert.deepEqual(byStep.get(7), [{ type: "notVisible", text: "已删除" }]);
});

test("classify: 向下取整/四捨五入/向上取整 从表达式剥离", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 组件显示金额为$82（165 ÷ 2 向下取整）",
      "2. 165 ÷ 2 四捨五入",
      "3. 165 ÷ 2 向上取整",
      "4. 165 ÷ 2 向下取整",
      "5. 165 ÷ 2 四舍五入"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_ROUND"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "calc", expression: "165 / 2", expected: 82 }]);
  assert.deepEqual(byStep.get(2), [{ type: "calc", expression: "165 / 2", expected: 83 }]);
  assert.deepEqual(byStep.get(3), [{ type: "calc", expression: "165 / 2", expected: 83 }]);
  assert.deepEqual(byStep.get(4), [{ type: "calc", expression: "165 / 2", expected: 82 }]);
  assert.deepEqual(byStep.get(5), [{ type: "calc", expression: "165 / 2", expected: 83 }]);
});

test("classify: 最多可放/儲存 + 繁体数字", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 最多可放8則",
      "2. 最多可儲存5個",
      "3. 最多可放八則",
      "4. 最多可放 十 則",
      "5. 最多可放入3個",
      "6. 最多可存入4個"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e", "f"],
    caseId: "TC_COUNT_TRAD"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "count", max: 8 }]);
  assert.deepEqual(byStep.get(2), [{ type: "count", max: 5 }]);
  assert.deepEqual(byStep.get(3), [{ type: "count", max: 8 }]);
  assert.deepEqual(byStep.get(4), [{ type: "count", max: 10 }]);
  assert.deepEqual(byStep.get(5), [{ type: "count", max: 3 }]);
  assert.deepEqual(byStep.get(6), [{ type: "count", max: 4 }]);
});

test("classify: text 去尾标点/引导语，模糊句不产 text", () => {
  const result = classifyExpectedResult({
    expected: ["1. 需先手動取消愛心；", "2. 功能正常", "3. 正確顯示"].join("\n"),
    steps: ["a", "b", "c"],
    caseId: "TC_TEXT"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "text", text: "需先手動取消愛心" }]);
  assert.equal(byStep.get(2)[0].type, "manual");
  assert.equal(byStep.get(3)[0].type, "manual");
  assert.equal(
    result.steps.some((entry) => entry.assert.some((item) => item.type === "text" && /功能正常|正確顯示/.test(item.text))),
    false
  );
});

test("classify: 真实样例回归（非 manual）", () => {
  const cases = [
    {
      expected: "1. 组件显示金额为$82（165 ÷ 2 向下取整）；2. 点击后成功跳转至“Points Record”页面",
      steps: ["打开积分页", "点击入口"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(1), [{ type: "calc", expression: "165 / 2", expected: 82 }]);
        assert.deepEqual(byStep.get(2), [{ type: "visible", text: "Points Record" }]);
      }
    },
    {
      expected: "1. 显示积分170 points，对应S Dollar $85；2. 点击图标弹出“About S Dollar”说明弹窗，内容完整",
      steps: ["打开积分页", "点击图标"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(1), [
          { type: "visible", text: "170 points" },
          { type: "visible", text: "$85" }
        ]);
        assert.deepEqual(byStep.get(2), [{ type: "visible", text: "About S Dollar" }]);
      }
    },
    {
      expected: "2. 展开后显示Location、Shop Name、Reference Code等字段",
      steps: ["打开页面", "展开"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(2), [
          { type: "visible", text: "Location" },
          { type: "visible", text: "Shop Name" },
          { type: "visible", text: "Reference Code" }
        ]);
      }
    },
    {
      expected: "输入框显示“15”，下方提示“Equivalent to 30 S Points”",
      steps: ["打开页面", "输入", "查看提示"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(3), [
          { type: "visible", text: "15" },
          { type: "visible", text: "Equivalent to 30 S Points" }
        ]);
      }
    },
    {
      expected: "1.跳轉到MOP首頁，且彈出MOP intro彈窗",
      steps: ["打开"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(1), [
          { type: "visible", text: "MOP首頁" },
          { type: "visible", text: "MOP intro" }
        ]);
      }
    },
    {
      expected: "1.直接跳轉到MOP首頁，沒有出現MOP intro彈窗",
      steps: ["打开"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(1), [
          { type: "visible", text: "MOP首頁" },
          { type: "notVisible", text: "MOP intro" }
        ]);
      }
    },
    {
      expected: "2.顯示提示語：我的最愛最多可儲存5個，需先手動取消愛心，才能再新增",
      steps: ["打开", "查看"],
      check: (byStep) => {
        assert.equal(byStep.get(2)[0].type, "count");
        assert.equal(byStep.get(2)[0].max, 5);
        assert.equal(byStep.get(2).some((item) => item.type === "manual"), false);
      }
    },
    {
      expected: "4.’愛心‘icon變紅色，對應門市會展示在【我的最愛】tab",
      steps: ["a", "b", "c", "d"],
      check: (byStep) => {
        assert.deepEqual(byStep.get(4), [
          { type: "visible", text: "愛心" },
          { type: "visible", text: "我的最愛" }
        ]);
      }
    }
  ];

  for (const [index, item] of cases.entries()) {
    const result = classifyExpectedResult({
      expected: item.expected,
      steps: item.steps,
      caseId: `REAL_${index}`
    });
    assert.deepEqual(result.manual, [], `样例 ${index} 不应落 manual：${item.expected}`);
    assert.equal(
      result.steps.some((entry) => entry.assert.some((assertion) => assertion.type === "manual")),
      false,
      `样例 ${index} 不应含内联 manual`
    );
    item.check(new Map(result.steps.map((entry) => [entry.step, entry.assert])));
  }
});

test("classify: 简体「没有」否定", () => {
  const result = classifyExpectedResult({
    expected: ["1. 没有显示“删除”按钮", "2. 没有“删除”按钮"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_NEG_SIMPLE"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "notVisible", text: "删除" }]);
  assert.deepEqual(byStep.get(2), [{ type: "notVisible", text: "删除" }]);
});

test("classify: 字段列表不得吞掉 MANUAL 关键词", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 顯示後台配置的價格、名稱",
      "2. 顯示名稱、數量並後台有資料",
      "3. 顯示後台數據、報表",
      "4. 顯示Location、數據正確、Shop Name"
    ].join("\n"),
    steps: ["a", "b", "c", "d"],
    caseId: "TC_FIELD_MANUAL"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4]) {
    assert.equal(byStep.get(step)[0].type, "manual", `step ${step} 应保持 manual`);
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 不应出现 visible`
    );
  }
  assert.equal(result.manual.length, 4);
});

test("classify: 、列表逐标签校验，句子/过长/连接词/尾标点不升 visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 頁面顯示載入中、請稍候",
      "2. 显示商品、价格（后台配置）",
      "3. 顯示名稱、數量、總計並可匯出",
      "4. 顯示ThisIsAnExtremelyLongFieldNameThatExceedsTheCap、Location",
      "5. 顯示Location、Shop Name、"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_FIELD_INVALID"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4, 5]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 不应出现 visible`
    );
    assert.equal(byStep.get(step)[0].type, "manual");
  }
  assert.equal(result.manual.length, 5);
});

test("classify: 数值断言遵循否定极性；裸 為/是 不出数值", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 未顯示 $85 餘額",
      "2. 不顯示 15",
      "3. 沒有顯示 3 個項目",
      "4. 未有顯示 4 個",
      "5. 沒有成功顯示 5",
      "6. 顯示85%",
      "7. 顯示10 秒",
      "8. 金額為$85",
      "9. $85 對應 170 points"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    caseId: "TC_VALUE_POLARITY"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [{ type: "notVisible", text: "$85" }]);
  assert.deepEqual(byStep.get(2), [{ type: "notVisible", text: "15" }]);
  assert.deepEqual(byStep.get(3), [{ type: "notVisible", text: "3" }]);
  assert.deepEqual(byStep.get(4), [{ type: "notVisible", text: "4" }]);
  assert.deepEqual(byStep.get(5), [{ type: "notVisible", text: "5" }]);
  assert.deepEqual(byStep.get(6), [{ type: "visible", text: "85%" }]);
  assert.deepEqual(byStep.get(7), [{ type: "visible", text: "10 秒" }]);
  assert.equal(
    byStep.get(8).some((assertion) => assertion.type === "visible"),
    false,
    "裸 為 不产数值 visible"
  );
  assert.deepEqual(byStep.get(9), [
    { type: "visible", text: "$85" },
    { type: "visible", text: "170 points" }
  ]);
});

test("classify: calc/count 与引号共存时保留 visible", () => {
  const result = classifyExpectedResult({
    expected: ["1. 顯示“$82”（165 ÷ 2 向下取整）", "2. 顯示“5個”最多可5個"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_CALC_QUOTE"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "calc", expression: "165 / 2", expected: 82 },
    { type: "visible", text: "$82" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "count", max: 5 },
    { type: "visible", text: "5個" }
  ]);
});

test("classify: 逗号无条件拆分；动作子句不造 text，非动作短句可 text", () => {
  const withDisplay = classifyExpectedResult({
    expected: "1. 點擊後成功，顯示“A”",
    steps: ["a"],
    caseId: "TC_COMMA_DISPLAY"
  });
  assert.deepEqual(withDisplay.steps, [
    { step: 1, assert: [{ type: "visible", text: "A" }] }
  ]);
  assert.deepEqual(withDisplay.manual, []);

  const actionOnly = classifyExpectedResult({
    expected: "1. 點擊後成功",
    steps: ["a"],
    caseId: "TC_COMMA_ACTION"
  });
  assert.deepEqual(actionOnly.steps, [
    { step: 1, assert: [{ type: "manual", reason: "无法确定可验证文本" }] }
  ]);
  assert.equal(
    actionOnly.steps[0].assert.some((item) => item.type === "text"),
    false
  );

  const nonAction = classifyExpectedResult({
    expected: "1. 彈窗關閉，停留在MOP首頁",
    steps: ["a"],
    caseId: "TC_COMMA_TEXT"
  });
  assert.deepEqual(nonAction.steps, [
    {
      step: 1,
      assert: [
        { type: "text", text: "彈窗關閉" },
        { type: "text", text: "停留在MOP首頁" }
      ]
    }
  ]);
  assert.deepEqual(nonAction.manual, []);

  const subItem = classifyExpectedResult({
    expected: "i.選擇門市",
    steps: ["a"],
    caseId: "TC_COMMA_SUBITEM"
  });
  assert.deepEqual(subItem.steps, [
    { step: 1, assert: [{ type: "text", text: "選擇門市" }] }
  ]);

  const actionClause = classifyExpectedResult({
    expected: "1. 選擇門市：不自動帶入門市",
    steps: ["a"],
    caseId: "TC_COMMA_ACTION_CLAUSE"
  });
  assert.equal(
    actionClause.steps[0].assert.some((item) => item.type === "text"),
    false
  );
  assert.equal(actionClause.steps[0].assert[0].type, "manual");
});

test("classify: 标注性【】不升 visible", () => {
  const result = classifyExpectedResult({
    expected: ["1. 顯示【設計稿】與【待確認】", "2. 頁面顯示【備註】", "3. 顯示【我的最愛】"].join("\n"),
    steps: ["a", "b", "c"],
    caseId: "TC_BRACKET_ANNOTATION"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 标注位不应 visible`
    );
  }
  assert.deepEqual(byStep.get(3), [{ type: "visible", text: "我的最愛" }]);
});

test("classify: 中英混合字段列表与「包含」逗号列表", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 页面显示Total Amount、Location、Shop、Used S Dollar及积分、Used S Coupon名称和数量、Minimum Spending",
      "2. 页面显示Total Amount、S Coupon折扣、S Dollar折扣、最终应付金额",
      "3. 记录包含Used Date and Time, Member ID, Total amount deducted, S Coupon Name & volume, S Dollar Discount Amount, Ref Code",
      "4. 记录包含Payment Date and Time, Member ID, Total Amount, S Coupon Name & volume, S Dollar Discount Amount, Ref Code"
    ].join("\n"),
    steps: ["a", "b", "c", "d"],
    caseId: "TC_MIXED_FIELDS"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "Total Amount" },
    { type: "visible", text: "Location" },
    { type: "visible", text: "Shop" },
    { type: "visible", text: "Used S Dollar及积分" },
    { type: "visible", text: "Used S Coupon名称和数量" },
    { type: "visible", text: "Minimum Spending" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "visible", text: "Total Amount" },
    { type: "visible", text: "S Coupon折扣" },
    { type: "visible", text: "S Dollar折扣" },
    { type: "visible", text: "最终应付金额" }
  ]);
  assert.deepEqual(byStep.get(3), [
    { type: "visible", text: "Used Date and Time" },
    { type: "visible", text: "Member ID" },
    { type: "visible", text: "Total amount deducted" },
    { type: "visible", text: "S Coupon Name & volume" },
    { type: "visible", text: "S Dollar Discount Amount" },
    { type: "visible", text: "Ref Code" }
  ]);
  assert.deepEqual(byStep.get(4), [
    { type: "visible", text: "Payment Date and Time" },
    { type: "visible", text: "Member ID" },
    { type: "visible", text: "Total Amount" },
    { type: "visible", text: "S Coupon Name & volume" },
    { type: "visible", text: "S Dollar Discount Amount" },
    { type: "visible", text: "Ref Code" }
  ]);
  assert.deepEqual(result.manual, []);
});

test("classify: 模糊/正常类子句不升 visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 圖片展示正常",
      "2. Banner正确显示",
      "3. 正確顯示",
      "4. 正常",
      "5. 圖片展示正常，且可以滑動切換"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_VAGUE_CLAUSE"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4, 5]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 不应出现 visible`
    );
  }
  assert.equal(byStep.get(5).some((assertion) => assertion.type === "manual"), false);
});

test("classify: 标点/右括号标签不升 visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. (若有同品項客製化完全相同，合併以數量顯示)",
      "2. 顯示)",
      "3. 顯示（",
      "4. 顯示Location、)、Shop Name"
    ].join("\n"),
    steps: ["a", "b", "c", "d"],
    caseId: "TC_PUNCT_LABEL"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4]) {
    assert.equal(
      byStep.get(step).some(
        (assertion) => assertion.type === "visible" && /^[)）(（]+$/.test(assertion.text)
      ),
      false,
      `step ${step} 不应出现标点 visible`
    );
  }
});

test("classify: 中文字段状态/散文标签不升 visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 顯示首頁正常、列表正常",
      "2. 顯示訂單已成功提交、庫存已更新",
      "3. 顯示新增成功、刪除成功",
      "4. 包含A, B, 表示已成功",
      "5. 包含OrderNo, Amount, 完成後返回首頁"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e"],
    caseId: "TC_LABEL_STATE"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4, 5]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 不应出现 state/prose visible`
    );
  }
});

test("classify: 中文字段 更新時間/請求編號/載入時間 仍 visible", () => {
  const result = classifyExpectedResult({
    expected: ["1. 顯示更新時間、請求編號、載入時間", "2. 包含請求編號、回應狀態"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_LABEL_LEGIT"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "更新時間" },
    { type: "visible", text: "請求編號" },
    { type: "visible", text: "載入時間" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "visible", text: "請求編號" },
    { type: "visible", text: "回應狀態" }
  ]);
});

test("classify: 动作/指引子句不产 soft text；独立导航结果保留 text", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 點擊後成功，返回首頁",
      "2. 確認訂單，如圖所示",
      "3. 勾選商品",
      "4. 展開詳情",
      "5. 如圖所示",
      "6. 請稍候",
      "7. 詳情請參閱說明"
    ].join("\n"),
    steps: ["a", "b", "c", "d", "e", "f", "g"],
    caseId: "TC_ACTION_TEXT"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "text"),
      false,
      `step ${step} 不应产 text`
    );
    assert.equal(byStep.get(step)[0].type, "manual");
  }

  const standalone = classifyExpectedResult({
    expected: ["1. 返回MOP首頁", "2. 確認後優惠券被清空"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_NAV_STANDALONE"
  });
  const standaloneByStep = new Map(
    standalone.steps.map((entry) => [entry.step, entry.assert])
  );
  assert.deepEqual(standaloneByStep.get(1), [{ type: "text", text: "返回MOP首頁" }]);
  assert.deepEqual(standaloneByStep.get(2), [
    { type: "text", text: "確認後優惠券被清空" }
  ]);
});

test("classify: 、列表里的纯标点标签跳过而非整列失败", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 顯示Location、)、Shop Name",
      "2. 包含Location、（、Shop Name",
      "3. 顯示Location、(、Shop Name"
    ].join("\n"),
    steps: ["a", "b", "c"],
    caseId: "TC_PUNCT_SKIP"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3]) {
    assert.deepEqual(byStep.get(step), [
      { type: "visible", text: "Location" },
      { type: "visible", text: "Shop Name" }
    ]);
  }
});

test("classify: 包含逗号列表仍先过 MANUAL 扫描", () => {
  const result = classifyExpectedResult({
    expected: "1. 記錄包含Used Date, 后台配置, Ref Code",
    steps: ["a"],
    caseId: "TC_COMMA_MANUAL"
  });
  assert.equal(result.steps[0].assert[0].type, "manual");
  assert.equal(
    result.steps[0].assert.some((assertion) => assertion.type === "visible"),
    false
  );
});

test("classify: 中/待状态标签不产 hard visible", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 顯示處理中、等待中",
      "2. 顯示進行中、暫停中",
      "3. 顯示提交中、搜尋中",
      "4. 顯示待付款、配送中"
    ].join("\n"),
    steps: ["a", "b", "c", "d"],
    caseId: "TC_STATE_PROGRESS"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2, 3, 4]) {
    assert.equal(
      byStep.get(step).some((assertion) => assertion.type === "visible"),
      false,
      `step ${step} 不应出现 visible`
    );
    assert.equal(byStep.get(step)[0].type, "manual");
  }
  assert.notEqual(result.confidence, "high");
});

test("classify: 模糊标签剔除后保留合法字段", () => {
  const result = classifyExpectedResult({
    expected: [
      "1. 顯示Location、功能正常、Shop Name",
      "2. 顯示Location、內容完整、Shop Name"
    ].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_VAGUE_DROP"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  for (const step of [1, 2]) {
    assert.deepEqual(byStep.get(step), [
      { type: "visible", text: "Location" },
      { type: "visible", text: "Shop Name" }
    ]);
  }
  assert.deepEqual(result.manual, []);
});

test("classify: 已用/最後更新/批量刪除 字段仍 visible", () => {
  const result = classifyExpectedResult({
    expected: ["1. 顯示已用S Dollar、已用S Coupon", "2. 顯示最後更新、批量刪除"].join("\n"),
    steps: ["a", "b"],
    caseId: "TC_STATE_NOUN"
  });
  const byStep = new Map(result.steps.map((entry) => [entry.step, entry.assert]));
  assert.deepEqual(byStep.get(1), [
    { type: "visible", text: "已用S Dollar" },
    { type: "visible", text: "已用S Coupon" }
  ]);
  assert.deepEqual(byStep.get(2), [
    { type: "visible", text: "最後更新" },
    { type: "visible", text: "批量刪除" }
  ]);
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

test("writeAssertionColumn: 追加位已有零散人工内容 → 跳过该行并告警，不覆盖", async (t) => {
  const { filePath } = await makeWorkbook(t, {
    rows: [
      ["用例编号", "用例名", "", "步骤"],
      ["C1", "登录", "", "打开首页", ""],
      ["C2", "退出", "", "打开首页", "人工备注：保留我"],
      ["C3", "列表", "", "打开列表", ""]
    ]
  });
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map([
      ["C1", doc("C1")],
      ["C2", doc("C2")],
      ["C3", doc("C3")]
    ])
  });

  assert.equal(result.column, 5);
  assert.equal(result.written, 2);
  assert.match(result.warnings.join("\n"), /C2.*已有内容.*不覆盖人工数据/);

  const { sheet } = await loadSheet(filePath);
  assert.equal(sheet.getCell(3, 5).value, "人工备注：保留我", "人工内容不得被覆盖");
  assert.deepEqual(JSON.parse(sheet.getCell(2, 5).value), doc("C1"));
  assert.deepEqual(JSON.parse(sheet.getCell(4, 5).value), doc("C3"));
  assert.equal(sheet.getCell(1, 5).value, ASSERTION_COLUMN_HEADER);
  assert.equal(sheet.getColumn(5).hidden, true);
});

test("writeAssertionColumn: 空 Map 不改写/不隐藏工作副本（字节不变）", async (t) => {
  const { filePath } = await makeWorkbook(t);
  const before = await readFile(filePath);
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    assertions: new Map()
  });
  const after = await readFile(filePath);

  assert.deepEqual(result, { column: 5, written: 0, warnings: [] });
  assert.ok(before.equals(after), "工作副本字节应保持不变");
  const { sheet } = await loadSheet(filePath);
  assert.equal(sheet.getCell(1, 5).value ?? null, null);
  assert.equal(sheet.getColumn(5).hidden, false);
});

test("write/readAssertionColumn: 可选 headerRow 支持标题行在上的工作簿", async (t) => {
  const { filePath } = await makeWorkbook(t, {
    rows: [
      ["Web 用例说明", "", "", ""],
      ["用例编号", "步骤", "预期", ""],
      ["C1", "打开首页", "显示“首页”", ""]
    ]
  });
  const result = await writeAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    headerRow: 2,
    assertions: new Map([["C1", doc("C1")]])
  });
  assert.equal(result.column, 4);
  assert.equal(result.written, 1);

  const { sheet } = await loadSheet(filePath);
  assert.equal(sheet.getCell(2, 4).value, ASSERTION_COLUMN_HEADER);
  assert.equal(sheet.getCell(1, 4).value ?? null, "", "标题行不被写");
  const read = await readAssertionColumn({
    workbookPath: filePath,
    sheetName: "用例",
    caseIdHeader: "用例编号",
    headerRow: 2
  });
  assert.deepEqual(read.get("C1"), doc("C1"));

  await assert.rejects(
    writeAssertionColumn({
      workbookPath: filePath,
      sheetName: "用例",
      caseIdHeader: "用例编号",
      headerRow: 0,
      assertions: new Map()
    }),
    (error) => error instanceof AssertionColumnError && error.code === "invalid-header-row"
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
