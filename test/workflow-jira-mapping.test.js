import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMappingMessages,
  MAPPING_CASE_CAP,
  MAPPING_SELECTION_CAP,
  selectCasesWithLlm
} from "../dist/workflow/jira-mapping.js";

const ISSUE = {
  key: "AOS-1",
  summary: "登录失败",
  descriptionText: "输入错误密码应提示",
  acceptanceCriteria: ["不能进入主页"]
};

const CANDIDATES = [
  {
    feature: "账户",
    provenance: "导入自 qa.xlsx@abcd1234",
    cases: [
      { id: "imp-1", name: "错误密码" },
      { id: "imp-2", name: "退出登录" }
    ]
  },
  {
    feature: "订单",
    provenance: "生成自 figma:x",
    cases: [{ id: "f-9", name: "下单" }]
  }
];

test("buildMappingMessages: 约束/工单/候选/上次选择逐字；输出契约 JSON", () => {
  const messages = buildMappingMessages({ issue: ISSUE, candidates: CANDIDATES, previous: ["imp-1"] });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  for (const phrase of ["只能从清单中选", "不能编造", "没有合适的就返回空数组", "最多选 10 条", "只输出 JSON"]) {
    assert.equal(messages[0].content.includes(phrase), true, phrase);
  }
  assert.equal(messages[0].content.includes('"caseIds"'), true);

  const user = messages[1].content;
  assert.equal(typeof user, "string");
  assert.equal(user.includes("工单：AOS-1 登录失败"), true);
  assert.equal(user.includes("输入错误密码应提示"), true);
  assert.equal(user.includes("- 不能进入主页"), true);
  assert.equal(user.includes("- 账户（导入自 qa.xlsx@abcd1234）"), true);
  assert.equal(user.includes("  - imp-1 错误密码"), true);
  assert.equal(user.includes("  - f-9 下单"), true);
  assert.equal(user.includes("上次验证选择的用例（仅供参考）：imp-1"), true);
});

test("buildMappingMessages: previous 缺省无上次行；候选超 400 截断并注明", () => {
  assert.equal(MAPPING_CASE_CAP, 400);
  const noPrevious = buildMappingMessages({ issue: ISSUE, candidates: CANDIDATES });
  assert.equal(noPrevious[1].content.includes("上次验证选择的用例"), false);

  const many = [];
  for (let i = 0; i < 401; i += 1) many.push({ id: `c-${i}`, name: `用例${i}` });
  const capped = buildMappingMessages({
    issue: ISSUE,
    candidates: [{ feature: "大库", provenance: "生成自 x", cases: many }]
  });
  const user = capped[1].content;
  assert.equal(user.includes("  - c-399 用例399"), true);
  assert.equal(user.includes("  - c-400 用例400"), false);
  assert.equal(user.includes(`候选已达上限 ${MAPPING_CASE_CAP} 条`), true);
});

test("selectCasesWithLlm: 合法 JSON → 交集/去重/保序；编造 id 丢弃", async () => {
  const chat = async () => '{"caseIds":["f-9","imp-1","f-9","bogus"]}';
  const result = await selectCasesWithLlm(chat, { issue: ISSUE, candidates: CANDIDATES });
  assert.deepEqual(result, { ok: true, caseIds: ["f-9", "imp-1"] });
});

test("selectCasesWithLlm: 围栏/前后缀提取；[] → 空（答没有）；非 JSON → ok:false", async () => {
  const fenced = await selectCasesWithLlm(async () => '```json\n{"caseIds": ["imp-2"]}\n```', {
    issue: ISSUE,
    candidates: CANDIDATES
  });
  assert.deepEqual(fenced, { ok: true, caseIds: ["imp-2"] });

  const prefixed = await selectCasesWithLlm(async () => '好的，结果如下： {"caseIds": ["f-9"]}', {
    issue: ISSUE,
    candidates: CANDIDATES
  });
  assert.deepEqual(prefixed, { ok: true, caseIds: ["f-9"] });

  const none = await selectCasesWithLlm(async () => '{"caseIds": []}', {
    issue: ISSUE,
    candidates: CANDIDATES
  });
  assert.deepEqual(none, { ok: true, caseIds: [] });

  const broken = await selectCasesWithLlm(async () => "没有合适的", {
    issue: ISSUE,
    candidates: CANDIDATES
  });
  assert.equal(broken.ok, false);

  const notObject = await selectCasesWithLlm(async () => "[1,2]", {
    issue: ISSUE,
    candidates: CANDIDATES
  });
  assert.equal(notObject.ok, false);
});

test("selectCasesWithLlm: >10 截断；chat 抛错 → ok:false；调用带超时 AbortSignal", async () => {
  assert.equal(MAPPING_SELECTION_CAP, 10);
  const many = [];
  for (let i = 0; i < 12; i += 1) many.push({ id: `c-${i}`, name: `u${i}` });
  const ids = many.map((entry) => `"${entry.id}"`).join(",");
  const capped = await selectCasesWithLlm(async () => `{"caseIds":[${ids}]}`, {
    issue: ISSUE,
    candidates: [{ feature: "大库", provenance: "生成自 x", cases: many }]
  });
  assert.deepEqual(capped, {
    ok: true,
    caseIds: many.slice(0, MAPPING_SELECTION_CAP).map((entry) => entry.id)
  });

  const thrown = await selectCasesWithLlm(
    async () => {
      throw new Error("boom");
    },
    { issue: ISSUE, candidates: CANDIDATES }
  );
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.includes("boom"), true);

  let seenSignal = null;
  await selectCasesWithLlm(
    async (_messages, signal) => {
      seenSignal = signal;
      return '{"caseIds":[]}';
    },
    { issue: ISSUE, candidates: CANDIDATES }
  );
  assert.ok(seenSignal instanceof AbortSignal);
});
