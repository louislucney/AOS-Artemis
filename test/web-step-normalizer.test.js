import assert from "node:assert/strict";
import test from "node:test";

import {
  createLlmStepNormalizer,
  parseNormalizedResponse,
  validateNormalizedSteps
} from "../dist/web/step-normalizer.js";

const INPUT = {
  caseId: "TC-1",
  name: "Information",
  steps: ['1. Tap the information button next to "Referral Code"', "2. Verify popup"],
  expected: '2. Display "Referral Code"',
  preconditions: [],
  platform: "android",
  appId: "com.example.app"
};

test("step-normalizer: 有效 JSON 生成受控动作", async () => {
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () =>
      JSON.stringify({
        steps: [
          {
            step: 1,
            actions: [{ type: "tap", target: { text: "Referral Code", relation: "rightOf" } }],
            confidence: "high"
          },
          { step: 2, actions: [{ type: "verify" }], confidence: "high" }
        ]
      })
  });
  const result = await normalizer.normalize(INPUT);
  assert.deepEqual(result[0].actions[0], {
    type: "tap",
    target: { text: "Referral Code", relation: "rightOf" }
  });
  assert.equal(result[1].actions[0].type, "verify");
});

test("step-normalizer: 模型发明标签时拒绝并回退 null", async () => {
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () =>
      JSON.stringify({
        steps: [
          {
            step: 1,
            actions: [{ type: "tap", target: { text: "Invented Button" } }],
            confidence: "high"
          }
        ]
      })
  });
  const result = await normalizer.normalize(INPUT);
  assert.equal(result, null);
});

test("step-normalizer: chat 抛错/非法 JSON 返回 null", async () => {
  const throwing = createLlmStepNormalizer({
    model: "fake",
    chat: async () => {
      throw new Error("boom");
    }
  });
  assert.equal(await throwing.normalize(INPUT), null);
  const bad = createLlmStepNormalizer({ model: "fake", chat: async () => "not json" });
  assert.equal(await bad.normalize(INPUT), null);
});

test("step-normalizer: 跨用例依赖转 manual，不在 step 范围内拒绝", async () => {
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () =>
      JSON.stringify({
        steps: [
          { step: 1, actions: [{ type: "manual", reason: "depends-on:TC_04" }], confidence: "high" }
        ]
      })
  });
  const result = await normalizer.normalize(INPUT);
  assert.deepEqual(result[0].actions[0], { type: "manual", reason: "depends-on:TC_04" });

  assert.equal(
    validateNormalizedSteps(
      { steps: [{ step: 3, actions: [{ type: "verify" }] }] },
      INPUT
    ),
    null
  );
});

test("step-normalizer: 动作类型必须匹配步骤动词", async () => {
  for (const actions of [
    [{ type: "verify" }],
    [{ type: "launch" }]
  ]) {
    const normalizer = createLlmStepNormalizer({
      model: "fake",
      chat: async () => JSON.stringify({ steps: [{ step: 1, actions, confidence: "high" }] })
    });
    assert.equal(await normalizer.normalize(INPUT), null, JSON.stringify(actions));
  }
});

test("step-normalizer: 输入值必须来自原文", async () => {
  const input = {
    ...INPUT,
    steps: ["1. Input referral code"],
    expected: '1. Display "Referral Code"'
  };
  const normalizer = createLlmStepNormalizer({
    model: "fake",
    chat: async () =>
      JSON.stringify({
        steps: [
          {
            step: 1,
            actions: [
              { type: "input", target: { text: "Referral Code" }, value: "REAL-CUSTOMER-123" }
            ],
            confidence: "high"
          }
        ]
      })
  });
  assert.equal(await normalizer.normalize(input), null);
});

test("step-normalizer: 保留繁体/英文原文标签，不因大小写或空白拒绝", () => {
  const input = {
    ...INPUT,
    steps: ['1. 點擊「登入」', '2. Tap "Referral   Code"'],
    expected: "2. 顯示「登入」"
  };
  const result = parseNormalizedResponse(
    JSON.stringify({
      steps: [
        { step: 1, actions: [{ type: "tap", target: { text: "登入" } }], confidence: "high" },
        { step: 2, actions: [{ type: "tap", target: { text: "Referral Code" } }], confidence: "high" }
      ]
    }),
    input
  );
  assert.equal(result[0].actions[0].target.text, "登入");
  assert.equal(result[1].actions[0].target.text, "Referral Code");
});
