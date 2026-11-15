import assert from "node:assert/strict";
import test from "node:test";

import { readAndroidSystemDialog } from "../dist/figma/android-system-dialog.js";

function execWith(xml) {
  return async (_command, args) => {
    if (args.includes("dump")) return { code: 0, stdout: "UI hierarchy dumped", stderr: "" };
    if (args.includes("cat")) return { code: 0, stdout: xml, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

const DIALOG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.android.systemui" text="" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
    <node class="android.widget.TextView" package="com.android.systemui" text="Software Update" content-desc="" clickable="false" bounds="[40,800][1040,900]" />
    <node class="android.widget.TextView" package="com.android.systemui" text="A new version is available" content-desc="" clickable="false" bounds="[40,900][1040,1000]" />
    <node class="android.widget.Button" package="com.android.systemui" text="Later" content-desc="" clickable="true" bounds="[40,1000][500,1100]" />
    <node class="android.widget.Button" package="com.android.systemui" text="Update" content-desc="" clickable="true" bounds="[520,1000][1040,1100]" />
  </node>
</hierarchy>`;

test("android system dialog: 识别系统弹窗标题/正文/按钮", async () => {
  const result = await readAndroidSystemDialog({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: execWith(DIALOG_XML)
  });
  assert.equal(result.status, "dialog");
  assert.equal(result.dialog?.title, "Software Update");
  assert.match(result.dialog?.message ?? "", /new version/);
  assert.deepEqual(result.dialog?.buttons, ["Later", "Update"]);
});

test("android system dialog: 无系统节点不误报；关闭开关返回 unavailable", async () => {
  const clean = await readAndroidSystemDialog({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo" },
    exec: execWith(
      '<hierarchy><node class="android.widget.TextView" package="com.example" text="Home" clickable="false" /></hierarchy>'
    )
  });
  assert.equal(clean.status, "none");
  const off = await readAndroidSystemDialog({
    serial: "emulator-5554",
    env: { AOS_ADB_PATH: "/bin/echo", AOS_RUNNER_SYSTEM_DIALOG_CHECK: "0" },
    exec: execWith(DIALOG_XML)
  });
  assert.equal(off.status, "unavailable");
});
