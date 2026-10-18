import assert from "node:assert/strict";
import test from "node:test";

import { adfToText } from "../dist/jira/adf.js";
import {
  buildVerifyComment,
  parseVerifyMapping,
  VERIFY_MARKER_PREFIX,
  verifyMarker
} from "../dist/jira/verify-comment.js";

function input(overrides = {}) {
  return {
    issue: { key: "AOS-1", summary: "登录失败" },
    conclusion: "failed",
    composition: { strong: 2, weak: 1, explore: 0 },
    source: "导入自 qa.xlsx@abcd1234",
    device: "emulator-5554",
    manifestPaths: [".artemis/design/runs/a.json"],
    failed: [
      { caseId: "c1", name: "登录-错误密码", classification: "strong", traceId: "t1" },
      { caseId: "c2", name: "登录-探索", classification: "weak", traceId: null }
    ],
    ...overrides
  };
}

test("verifyMarker: AOS-VERIFY:<KEY>", () => {
  assert.equal(VERIFY_MARKER_PREFIX, "AOS-VERIFY:");
  assert.equal(verifyMarker("AOS-1"), "AOS-VERIFY:AOS-1");
});

test("buildVerifyComment: FAIL 逐行文案（构成/批次/失败行含与不含 trace/映射行）", () => {
  const { text, adf } = buildVerifyComment(input({ mapping: { caseIds: ["c1", "c2"] } }));
  assert.equal(
    text,
    [
      "【AOS 自动验证】AOS-1 登录失败",
      "- 结论: FAIL（强断言失败 1 条）",
      "- 构成: 强 2 · 弱 1 · 探索 0（共 3 条）",
      "- 来源: 导入自 qa.xlsx@abcd1234",
      "- 设备: emulator-5554",
      "- 批次: .artemis/design/runs/a.json",
      "- 失败: 登录-错误密码（trace t1，强）",
      "- 失败: 登录-探索（弱）",
      "弱断言仅记录路径，不代表验证通过",
      "映射用例: c1, c2"
    ].join("\n")
  );
  assert.equal(adfToText(adf).includes("【AOS 自动验证】AOS-1 登录失败"), true);
  assert.equal(adfToText(adf).includes("映射用例: c1, c2"), true);
});

test("buildVerifyComment: PASS 全强 → 无弱披露行、无映射行", () => {
  const { text } = buildVerifyComment(
    input({ conclusion: "passed", composition: { strong: 2, weak: 0, explore: 0 }, failed: [] })
  );
  assert.equal(
    text,
    [
      "【AOS 自动验证】AOS-1 登录失败",
      "- 结论: PASS",
      "- 构成: 强 2 · 弱 0 · 探索 0（共 2 条）",
      "- 来源: 导入自 qa.xlsx@abcd1234",
      "- 设备: emulator-5554",
      "- 批次: .artemis/design/runs/a.json"
    ].join("\n")
  );
});

test("buildVerifyComment: inconclusive 披露句只出现一次（结论行内）", () => {
  const { text } = buildVerifyComment(
    input({
      conclusion: "inconclusive",
      composition: { strong: 0, weak: 1, explore: 2 },
      failed: [{ caseId: "c9", name: "探索用例", classification: "explore", traceId: "t9" }]
    })
  );
  const count = text.split("弱断言仅记录路径，不代表验证通过").length - 1;
  assert.equal(count, 1);
  assert.match(text, /- 结论: 无法判定（无强断言；弱断言仅记录路径，不代表验证通过）/);
  assert.match(text, /- 失败: 探索用例（trace t9，探索）/);
});

test("parseVerifyMapping: 中英文冒号/多分隔符/无行", () => {
  assert.deepEqual(parseVerifyMapping("映射用例: a, b"), ["a", "b"]);
  assert.deepEqual(parseVerifyMapping("映射用例：a，b、 c"), ["a", "b", "c"]);
  assert.deepEqual(parseVerifyMapping("- 结论: PASS"), []);
});

test("parseVerifyMapping: 与 buildVerifyComment 输出闭环（bullet 前缀容错）", () => {
  const { adf } = buildVerifyComment(input({ mapping: { caseIds: ["c1", "c2"] } }));
  assert.deepEqual(parseVerifyMapping(adfToText(adf)), ["c1", "c2"]);
});

test("buildVerifyComment: 强断言存在但弱断言失败 → inconclusive 文案点明弱失败", () => {
  const { text } = buildVerifyComment(
    input({
      conclusion: "inconclusive",
      composition: { strong: 1, weak: 1, explore: 0 },
      failed: [{ caseId: "c2", name: "退出登录", classification: "weak", traceId: null }]
    })
  );
  assert.equal(
    text.includes("- 结论: 无法判定（弱断言失败 1 条；弱断言仅记录路径，不代表验证通过）"),
    true
  );
  assert.equal(text.split("不代表验证通过").length - 1, 1);
});
