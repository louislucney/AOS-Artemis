import assert from "node:assert/strict";
import test from "node:test";

import { checkExpectedTexts, extractExpectedTexts } from "../dist/web/llm/verify.js";

test("verify: 引号/显示锚点抽取；无锚点不产 L1", () => {
  assert.deepEqual(extractExpectedTexts("页面显示“登录成功”"), ["登录成功"]);
  assert.deepEqual(extractExpectedTexts('应出现 "Welcome"'), ["Welcome"]);
  assert.deepEqual(extractExpectedTexts("操作完成"), []);
});

test("verify: 原始 OCR 文本命中/缺失", () => {
  const hit = checkExpectedTexts("页面显示“登录成功”", ["首页", "登录成功"]);
  assert.equal(hit.anchored, true);
  assert.equal(hit.passed, 1);
  assert.equal(hit.failed, 0);

  const miss = checkExpectedTexts("页面显示“登录成功”", ["首页"]);
  assert.equal(miss.failed, 1);
  assert.deepEqual(miss.missing, ["登录成功"]);
});
