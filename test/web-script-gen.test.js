import assert from "node:assert/strict";
import test from "node:test";

import { generateFlow, generateScriptSet } from "../dist/web/script-gen.js";

const APP_ID = "com.example.app";

function gen(caseInput = {}, options = {}) {
  return generateFlow(
    {
      caseId: "TC-1",
      steps: ["1. 启动 App", "2. 点击“登录”", "3. 在“账号”输入 test@example.com"],
      expected: "页面显示“登录成功”",
      preconditions: [],
      ...caseInput
    },
    { appId: APP_ID, platform: "android", ...options }
  );
}

function codes(result) {
  return result.unresolved.map((entry) => entry.code);
}

test("script-gen: 基本流程生成 launch/tap/input/assert", () => {
  const result = gen();
  assert.equal(result.status, "ready");
  assert.equal(result.assertions, 1);
  assert.deepEqual(result.assertionTexts, [
    { step: 3, type: "visible", originalText: "登录成功" }
  ]);
  assert.match(result.yaml, /^appId: 'com\.example\.app'\n/);
  assert.match(result.yaml, /- launchApp:\n    clearState: true/);
  assert.match(result.yaml, /- tapOn: '登录'/);
  assert.match(result.yaml, /- tapOn: '账号'\n- inputText: 'test@example.com'/);
  assert.match(result.yaml, /# aos:assertion step=3 source=excel\.expected type=visible/);
  assert.match(result.yaml, /# aos:text 登录成功\n- assertVisible: '登录成功'/);
});

test("script-gen: 验证步骤不生成动作，断言落在该步", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 点击“登录”", "3. 查看“首页”"],
    expected: "页面显示“首页”"
  });
  assert.equal(result.status, "ready");
  assert.doesNotMatch(result.yaml, /tapOn: '首页'/);
  assert.match(result.yaml, /# aos:assertion step=3[\s\S]*- assertVisible: '首页'/);
});

test("script-gen: 在字段输入值（在金额输入框输入“15”）", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 在金额输入框输入“15”", "3. 点击“确认”"],
    expected: "页面显示“成功”"
  });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- tapOn: '金额输入框'\n- inputText: '15'/);
});

test("script-gen: 输入值转义只做 YAML，不做 regex", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 在“账号”输入 a+b@example.com"],
    expected: "页面显示“成功”"
  });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- inputText: 'a\+b@example\.com'/);
});

test("script-gen: soft text 默认跳过，保持 ready 但无硬断言", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 点击“关闭”"],
    expected: "需先手動取消愛心"
  });
  assert.equal(result.status, "ready");
  assert.equal(result.assertions, 0);
  assert.ok(result.warnings.includes("assertion-soft-text-skipped:2"));
  assert.ok(result.warnings.includes("unverified-expected"));
  assert.equal(result.yaml.includes("assertVisible"), false);
});

test("script-gen: manual 预期不阻断流程，但记 warning", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 点击“刷新”"],
    expected: "显示后台配置的价格"
  });
  assert.equal(result.status, "ready");
  assert.equal(result.assertions, 0);
  assert.ok(result.warnings.some((warning) => warning.startsWith("assertion-manual")));
});

test("script-gen: 扫描/条件步骤显式 unresolved", () => {
  const scan = gen({
    steps: ["1. 启动 App", "2. 扫描 QR 码"],
    expected: "页面显示“成功”"
  });
  assert.equal(scan.status, "unresolved");
  assert.equal(scan.yaml, null);
  assert.ok(codes(scan).includes("scan-unsupported"));

  const conditional = gen({
    steps: ["1. 启动 App", "2. 若金额大于 100 则显示提示"],
    expected: "页面显示“提示”"
  });
  assert.equal(conditional.status, "unresolved");
  assert.ok(codes(conditional).includes("conditional-unsupported"));
});

test("script-gen: strict 前置条件 unresolved；assume-prepared 生成且不清状态", () => {
  const strict = gen({
    preconditions: ["1. 用户已登录"],
    steps: ["1. 启动 App", "2. 点击“登录”"],
    expected: "页面显示“成功”"
  });
  assert.equal(strict.status, "unresolved");
  assert.ok(codes(strict).includes("precondition-unparsed"));

  const assumed = gen(
    {
      preconditions: ["1. 用户已登录"],
      steps: ["1. 启动 App", "2. 点击“登录”"],
      expected: "页面显示“成功”"
    },
    { preconditionMode: "assume-prepared" }
  );
  assert.equal(assumed.status, "ready");
  assert.match(assumed.yaml, /clearState: false/);
  assert.match(assumed.yaml, /stopApp: false/);
  assert.ok(assumed.warnings.includes("precondition-assumed:1"));
});

test("script-gen: 无前置条件时 assume-prepared 仍清状态", () => {
  const result = gen({ preconditions: [] }, { preconditionMode: "assume-prepared" });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /clearState: true/);
});

test("script-gen: appId 缺失/非法/平台校验", () => {
  const missing = gen({}, { appId: "" });
  assert.equal(missing.status, "unresolved");
  assert.ok(codes(missing).includes("app-id-missing"));

  const invalidAndroid = gen({}, { appId: "com.example-app", platform: "android" });
  assert.equal(invalidAndroid.status, "unresolved");
  assert.ok(codes(invalidAndroid).includes("app-id-invalid"));

  const validIos = gen({}, { appId: "com.example-app", platform: "ios" });
  assert.equal(validIos.status, "ready");
});

test("script-gen: regex 元字符转义 + YAML 单引号", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 点击“订单号：12345(已支付)”"],
    expected: "页面显示“订单号：12345(已支付)”"
  });
  assert.equal(result.status, "ready");
  assert.ok(result.yaml.includes("- tapOn: '订单号：12345\\(已支付\\)'"));
  assert.ok(result.yaml.includes("- assertVisible: '订单号：12345\\(已支付\\)'"));

  const quote = gen({
    steps: ["1. 启动 App", "2. 点击“Bob's”"],
    expected: "页面显示“成功”"
  });
  assert.equal(quote.status, "ready");
  assert.match(quote.yaml, /- tapOn: 'Bob''s'/);
});

test("script-gen: 代词回指使用上一个具体标签", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 查看“S Dollar组件”", "3. 点击该组件"],
    expected: "页面显示“成功”"
  });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- tapOn: 'S Dollar组件'/);
});

test("script-gen: 导航默认 unresolved，显式 inferNavigationTap 才生成 tap", () => {
  const strict = gen({
    steps: ["1. 启动 App", "2. 进入“报告”页面"],
    expected: "页面显示“报告”"
  });
  assert.equal(strict.status, "unresolved");
  assert.ok(codes(strict).includes("navigation-unparsed"));

  const inferred = gen(
    {
      steps: ["1. 启动 App", "2. 进入“报告”页面"],
      expected: "页面显示“报告”"
    },
    { inferNavigationTap: true }
  );
  assert.equal(inferred.status, "ready");
  assert.match(inferred.yaml, /- tapOn: '报告'/);
});

test("script-gen: 单字选择动词与筛选项目标", () => {
  const selected = gen({
    steps: ["1. 启动 App", "2. 選 到店自取"],
    expected: "页面显示“到店自取”"
  });
  assert.equal(selected.status, "ready");
  assert.match(selected.yaml, /- tapOn: '到店自取'/);

  const filter = gen({
    steps: ["1. 启动 App", "2. 點擊篩選項，eg.内用點餐"],
    expected: "页面显示“内用點餐”"
  });
  assert.equal(filter.status, "unresolved");
  assert.ok(codes(filter).includes("ambiguous-text"));
});

test("script-gen: 符号按钮 unresolved", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 点击“+”"],
    expected: "页面显示“成功”"
  });
  assert.equal(result.status, "unresolved");
  assert.ok(codes(result).includes("symbol-label"));
});

test("script-gen: 滚动至元素生成 scrollUntilVisible", () => {
  const result = gen({
    steps: ["1. 启动 App", "2. 滚动至“My Record”列表"],
    expected: "页面显示“My Record”"
  });
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- scrollUntilVisible:\n    element:\n      text: 'My Record'\n    direction: DOWN/);
});

test("script-gen: notVisible 生成 assertNotVisible", () => {
  const result = generateFlow(
    {
      caseId: "TC-NV",
      steps: ["1. 启动 App", "2. 点击“关闭”"],
      expected: null,
      preconditions: [],
      assertionDoc: {
        version: 1,
        source: "excel.expected",
        confidence: "high",
        steps: [{ step: 2, assert: [{ type: "notVisible", text: "错误提示" }] }],
        manual: [],
        ambiguous: []
      }
    },
    { appId: APP_ID, platform: "android" }
  );
  assert.equal(result.status, "ready");
  assert.match(result.yaml, /- assertNotVisible: '错误提示'/);
});

test("script-gen: 断言步骤越界显式 unresolved", () => {
  const result = generateFlow(
    {
      caseId: "TC-OOR",
      steps: ["1. 启动 App", "2. 点击“关闭”"],
      expected: null,
      preconditions: [],
      assertionDoc: {
        version: 1,
        source: "excel.expected",
        confidence: "high",
        steps: [{ step: 4, assert: [{ type: "visible", text: "X" }] }],
        manual: [],
        ambiguous: []
      }
    },
    { appId: APP_ID, platform: "android" }
  );
  assert.equal(result.status, "unresolved");
  assert.ok(codes(result).includes("assertion-step-out-of-range"));
});

test("script-gen: generateScriptSet 统计 ready/unresolved", () => {
  const result = generateScriptSet({
    appId: APP_ID,
    platform: "android",
    cases: [
      {
        caseId: "TC-1",
        steps: ["1. 启动 App", "2. 点击“登录”"],
        expected: "页面显示“成功”",
        preconditions: []
      },
      {
        caseId: "TC-2",
        steps: ["1. 启动 App", "2. 扫描 QR 码"],
        expected: "页面显示“成功”",
        preconditions: []
      }
    ]
  });
  assert.equal(result.ready, 1);
  assert.equal(result.unresolved, 1);
  assert.equal(result.cases.length, 2);
});
