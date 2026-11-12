import assert from "node:assert/strict";
import test from "node:test";

import { proposeFieldTargets } from "../dist/structured/field-map.js";

function node(id, label, type, x = 10, y = 10) {
  return { id, label, value: "", type, rect: { x, y, width: 200, height: 48 } };
}

test("field map proposal: 按 id → label 生成候选，跳过非输入控件并去重", () => {
  const proposals = proposeFieldTargets([
    node("com.example:id/email", "Email", "android.widget.EditText"),
    node("", "Phone", "android.widget.EditText", 10, 80),
    node("", "", "android.widget.EditText", 10, 160),
    node("com.example:id/submit", "提交", "android.widget.Button"),
    node("com.example:id/email", "Email", "android.widget.EditText")
  ]);

  assert.equal(proposals.length, 3);
  assert.deepEqual(proposals[0].target, {
    kind: "resource-id",
    value: "com.example:id/email"
  });
  assert.equal(proposals[0].label, "Email");
  assert.deepEqual(proposals[1].target, { kind: "content-desc", value: "Phone" });
  assert.equal(proposals[2].target, null);
  assert.deepEqual(proposals[2].bounds, { x: 10, y: 160, width: 200, height: 48 });
  assert.ok(proposals.every((entry) => !("value" in entry)), "不回显输入值");
});
