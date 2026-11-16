import assert from "node:assert/strict";
import test from "node:test";

import { readIosSystemDialog } from "../dist/figma/ios-system-dialog.js";

function device(nodes) {
  return {
    async nodes() {
      return nodes;
    }
  };
}

test("iOS system dialog: 只识别 Alert 类型并提取内容/按钮", async () => {
  const result = await readIosSystemDialog({
    device: device([
      { type: "XCUIElementTypeAlert", label: "Software Update", value: "", id: "", rect: { x: 0, y: 0, width: 300, height: 200 } },
      { type: "XCUIElementTypeStaticText", label: "A new version is available", value: "", id: "", rect: { x: 0, y: 40, width: 300, height: 30 } },
      { type: "XCUIElementTypeButton", label: "Later", value: "", id: "", rect: { x: 0, y: 100, width: 100, height: 30 } },
      { type: "XCUIElementTypeButton", label: "Update", value: "", id: "", rect: { x: 100, y: 100, width: 100, height: 30 } }
    ])
  });
  assert.equal(result.status, "dialog");
  assert.equal(result.dialog?.title, "Software Update");
  assert.match(result.dialog?.message ?? "", /new version/);
  assert.deepEqual(result.dialog?.buttons, ["Later", "Update"]);
});

test("iOS system dialog: 普通页面不误报；关闭开关返回 unavailable", async () => {
  const clean = await readIosSystemDialog({
    device: device([
      { type: "XCUIElementTypeButton", label: "Login", value: "", id: "", rect: { x: 0, y: 0, width: 100, height: 30 } }
    ])
  });
  assert.equal(clean.status, "none");
  const off = await readIosSystemDialog({
    device: device([
      { type: "XCUIElementTypeAlert", label: "Software Update", value: "", id: "", rect: { x: 0, y: 0, width: 300, height: 200 } }
    ]),
    env: { AOS_RUNNER_SYSTEM_DIALOG_CHECK: "0" }
  });
  assert.equal(off.status, "unavailable");
});
