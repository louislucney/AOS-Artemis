import assert from "node:assert/strict";
import test from "node:test";

import {
  engineForActions,
  hasCompleteActions,
  validateStructuredActions
} from "../dist/figma/structured-actions.js";
import { structuredActionGateIssue } from "../dist/figma/gate.js";

const TAP = {
  stepIndex: 0,
  action: "tap",
  target: { kind: "resource-id", value: "login_button" },
  fallbackTargets: [{ kind: "text", value: "登录" }],
  expect: { screen: "首页", hints: ["首页"] }
};

test("structured actions: 合法动作解析、补全与 engine 选择", () => {
  const validation = validateStructuredActions(
    [
      TAP,
      { stepIndex: 1, action: "type", target: { kind: "content-desc", value: "账号" }, input: { kind: "text", text: "qa" } },
      { stepIndex: 2, action: "back" }
    ],
    3
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.actions.length, 3);
  assert.deepEqual(validation.actions[0].target, { kind: "resource-id", value: "login_button" });

  const expectations = [{ kind: "assert" }, { kind: "assert" }, { kind: "assert" }];
  assert.equal(hasCompleteActions(validation.actions, expectations), false, "type/back 缺 expect");
  const withExpect = validation.actions.map((action) => ({
    ...action,
    expect: action.expect ?? { hints: ["可见"] }
  }));
  assert.equal(hasCompleteActions(withExpect, expectations), true);
  assert.equal(engineForActions(withExpect, expectations).engine, "native");
  assert.equal(
    engineForActions(withExpect, [{ kind: "explore" }, ...expectations.slice(1)]).engine,
    "artemis"
  );
});

test("structured actions: secretRef type 可省略 target（执行期按字段映射解析）", () => {
  const validation = validateStructuredActions(
    [
      {
        stepIndex: 0,
        action: "type",
        input: { kind: "secretRef", ref: "reg_email" },
        expect: { hints: ["注册"] }
      }
    ],
    1
  );
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.actions[0].target, undefined);

  const textWithoutTarget = validateStructuredActions(
    [{ stepIndex: 0, action: "type", input: { kind: "text", text: "qa" } }],
    1
  );
  assert.ok(textWithoutTarget.errors.some((error) => error.includes("缺少有效 target")));
});

test("structured actions: 非法 stepIndex/target/action/重复显式报错", () => {
  const validation = validateStructuredActions(
    [
      { stepIndex: 9, action: "tap", target: { kind: "resource-id", value: "x" } },
      { stepIndex: 0, action: "unknown" },
      { stepIndex: 1, action: "tap" },
      { stepIndex: 2, action: "tap", target: { kind: "a11y", value: "x" } },
      { stepIndex: 0, action: "tap", target: { kind: "text", value: "x" } },
      { stepIndex: 0, action: "tap", target: { kind: "text", value: "x" } },
      { stepIndex: 1, action: "type", target: { kind: "text", value: "x" } }
    ],
    3
  );
  assert.equal(validation.actions.length, 1);
  assert.ok(validation.errors.some((error) => error.includes("stepIndex 越界")));
  assert.ok(validation.errors.some((error) => error.includes("action 非法")));
  assert.ok(validation.errors.some((error) => error.includes("缺少有效 target")));
  assert.ok(validation.errors.some((error) => error.includes("stepIndex 重复")));
  assert.ok(validation.errors.some((error) => error.includes("type 缺少有效 input")));
});

test("structured actions: gate 对 native actions 错误给出硬门禁文案", () => {
  const issue = structuredActionGateIssue({
    structuredActions: {
      native: 1,
      artemis: 0,
      errors: [{ caseId: "case-1", message: "actions 未覆盖所有断言步骤" }]
    }
  });
  assert.match(issue, /结构化动作校验失败/);
  assert.match(issue, /case-1/);
  assert.equal(
    structuredActionGateIssue({
      structuredActions: { native: 1, artemis: 0, errors: [] }
    }),
    null
  );
});
