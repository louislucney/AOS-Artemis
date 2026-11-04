import assert from "node:assert/strict";
import test from "node:test";

import {
  checkExpectedTexts,
  extractExpectedTexts,
  summaryStatus
} from "../dist/web/llm/verify.js";

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

test("verify: test_summary 平台无关判定（未决不判 PASS）", () => {
  assert.equal(summaryStatus(null), "UNVERIFIED");
  assert.equal(summaryStatus({ passed: 1, failed: 0 }), "PASS");
  assert.equal(summaryStatus({ passed: 1, failed: 0, unchecked: 1 }), "UNVERIFIED");
  assert.equal(summaryStatus({ passed: 1, failed: 0, inconclusive: 1 }), "UNVERIFIED");
  assert.equal(summaryStatus({ passed: 1, failed: 1 }), "FAIL");
  assert.equal(summaryStatus({ passed: 0, failed: 0 }), "UNVERIFIED");
});
