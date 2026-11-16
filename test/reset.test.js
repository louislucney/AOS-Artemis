import assert from "node:assert/strict";
import test from "node:test";

import { resetApp } from "../dist/device/reset.js";

function ok(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

function fail({ code = 1, stderr = "", error } = {}) {
  return { code, stdout: "", stderr, error };
}

function recordingExec(handler) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return handler(args.join(" "), calls.length);
  };
  return { calls, exec };
}

test("resetApp: force-stops then relaunches with the given serial", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp(
    { packageName: "com.example.app", serial: "emulator-5554" },
    { exec }
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.serial, "emulator-5554");
  assert.deepEqual(calls[0].args, [
    "-s",
    "emulator-5554",
    "shell",
    "am",
    "force-stop",
    "com.example.app"
  ]);
  assert.deepEqual(calls[1].args, [
    "-s",
    "emulator-5554",
    "shell",
    "monkey",
    "-p",
    "com.example.app",
    "-c",
    "android.intent.category.LAUNCHER",
    "1"
  ]);
  assert.equal(calls[0].options.timeoutMs, 15000);
  assert.deepEqual(outcome.commands, [calls[0].args, calls[1].args]);
});

test("resetApp: omits -s when no serial is given", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp({ packageName: "com.example.app" }, { exec });
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].args[0], "shell");
});

test("resetApp: rejects invalid package without running adb", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp({ packageName: "not a package; rm -rf /" }, { exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "invalid-package");
  assert.equal(calls.length, 0);
});

test("resetApp: missing adb degrades to adb-not-found", async () => {
  const { exec } = recordingExec(() => fail({ code: null, error: "spawn adb ENOENT" }));
  const outcome = await resetApp({ packageName: "com.example.app" }, { exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "adb-not-found");
});

test("resetApp: offline device stops before launch", async () => {
  const { calls, exec } = recordingExec(() => fail({ stderr: "error: device offline" }));
  const outcome = await resetApp(
    { packageName: "com.example.app", serial: "emulator-5554" },
    { exec }
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "device-offline");
  assert.equal(calls.length, 1);
});

test("resetApp: generic force-stop failure is reported as force-stop-failed", async () => {
  const { exec } = recordingExec(() => fail({ stderr: "error: closed" }));
  const outcome = await resetApp({ packageName: "com.example.app" }, { exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "force-stop-failed");
});

test("resetApp: launch failure is reported as launch-failed", async () => {
  const { calls, exec } = recordingExec((joined) =>
    joined.includes("monkey") ? fail({ stderr: "** No activities found to run" }) : ok()
  );
  const outcome = await resetApp({ packageName: "com.example.app" }, { exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "launch-failed");
  assert.equal(calls.length, 2);
});

test("resetApp: timeout is classified and does not throw", async () => {
  const { exec } = recordingExec(() => ({ code: null, stdout: "", stderr: "", error: "timeout" }));
  const outcome = await resetApp({ packageName: "com.example.app" }, { exec });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "timeout");
});

test("resetApp: honors AOS_ADB_PATH and AOS_RESET_TIMEOUT_MS", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp(
    { packageName: "com.example.app" },
    { exec, env: { AOS_ADB_PATH: "/opt/adb", AOS_RESET_TIMEOUT_MS: "9000" } }
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].command, "/opt/adb");
  assert.equal(calls[0].options.timeoutMs, 9000);
});

test("resetApp: AOS_ANDROID_RESET_BACKGROUND=1 清理后台", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp(
    { packageName: "com.example.app", serial: "emulator-5554" },
    { exec, env: { AOS_ANDROID_RESET_BACKGROUND: "1" } }
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls[2].args, [
    "-s",
    "emulator-5554",
    "shell",
    "am",
    "kill-all"
  ]);
});

test("resetApp: AOS_ANDROID_RESET_ALERTS=1 关闭系统弹窗", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp(
    { packageName: "com.example.app", serial: "emulator-5554" },
    { exec, env: { AOS_ANDROID_RESET_ALERTS: "1" } }
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, [
    "-s",
    "emulator-5554",
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.CLOSE_SYSTEM_DIALOGS"
  ]);
});

test("resetApp: AOS_ANDROID_RESET_URL 走 App 内建复位并重新拉起", async () => {
  const { calls, exec } = recordingExec(() => ok());
  const outcome = await resetApp(
    { packageName: "com.example.app", serial: "emulator-5554" },
    {
      exec,
      env: {
        AOS_ANDROID_RESET_URL: "testapp://debug/reset",
        AOS_ANDROID_RESET_WAIT_MS: "0"
      }
    }
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].args, [
    "-s",
    "emulator-5554",
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "testapp://debug/reset"
  ]);
  assert.deepEqual(calls[3].args, calls[1].args, "复位后再次拉起应用");
});

test("resetApp: App 内建复位入口失败 → app-internal-reset-failed", async () => {
  const { exec } = recordingExec((joined) =>
    joined.includes("android.intent.action.VIEW") ? fail({ stderr: "Error: Activity not started" }) : ok()
  );
  const outcome = await resetApp(
    { packageName: "com.example.app" },
    {
      exec,
      env: { AOS_ANDROID_RESET_URL: "testapp://fail", AOS_ANDROID_RESET_WAIT_MS: "0" }
    }
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "app-internal-reset-failed");
  assert.match(outcome.message, /内建复位/);
});
