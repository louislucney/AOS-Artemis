import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.js";

const SCRIPT = fileURLToPath(new URL("../scripts/adb-safe.mjs", import.meta.url));
const skip = process.platform === "win32" ? "POSIX fake adb" : false;

const FAKE_ADB = `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf '%s\\n' "$FAKE_ADB_DEVICES"
  exit 0
fi
case "$*" in
  *" install "*) echo "Success"; exit 0 ;;
  *" shell echo "*) echo "hello-from-fake"; exit 0 ;;
  *" shell fail "*) echo "boom" >&2; exit 7 ;;
  *" shell sleep "*) sleep 30 ;;
esac
echo "fake-adb: $*"
`;

function writeFakeAdb() {
  const dir = makeTempDir("aos-adb-safe-");
  const file = path.join(dir, "adb");
  fs.writeFileSync(file, FAKE_ADB, "utf-8");
  fs.chmodSync(file, 0o755);
  return file;
}

function writeFakeApk() {
  const dir = makeTempDir("aos-adb-safe-apk-");
  const file = path.join(dir, "app.apk");
  fs.writeFileSync(file, "fake-apk", "utf-8");
  return file;
}

function runCli(adbPath, args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const childEnv = { ...process.env, AOS_ADB_PATH: adbPath, ...env };
    delete childEnv.ANDROID_SERIAL;
    if (childEnv.FAKE_ADB_DEVICES === undefined) childEnv.FAKE_ADB_DEVICES = "FAKE123\tdevice";
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

test("devices: 解析在线设备并退出 0", { skip }, async () => {
  const adb = writeFakeAdb();
  const result = await runCli(adb, ["devices"], { FAKE_ADB_DEVICES: "FAKE123\tdevice" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /FAKE123/);
});

test("shell: 透传远端 stdout 与退出码", { skip }, async () => {
  const adb = writeFakeAdb();
  const ok = await runCli(adb, ["shell", "echo hi"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "hello-from-fake");

  const failed = await runCli(adb, ["shell", "fail now"]);
  assert.equal(failed.code, 7);
  assert.match(failed.stderr, /boom/);
});

test("shell: 拦截 pm install 并提示改用 install", { skip }, async () => {
  const adb = writeFakeAdb();
  const result = await runCli(adb, ["shell", "pm install /data/local/tmp/x.apk"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /adb-safe install/);
});

test("timeout: 硬超时杀进程组并返回 124", { skip }, async () => {
  const adb = writeFakeAdb();
  const result = await runCli(adb, ["shell", "sleep 30", "--timeout", "1"]);
  assert.equal(result.code, 124);
  assert.ok(result.elapsedMs < 8000, `elapsed=${result.elapsedMs}ms`);
  assert.match(result.stderr, /超时/);
});

test("install: 多设备缺省报错，--serial 成功后返回 0", { skip }, async () => {
  const adb = writeFakeAdb();
  const apk = writeFakeApk();
  const ambiguous = await runCli(adb, ["install", apk], {
    FAKE_ADB_DEVICES: "FAKE1\tdevice\nFAKE2\tdevice"
  });
  assert.equal(ambiguous.code, 3);
  assert.match(ambiguous.stderr, /--serial/);

  const ok = await runCli(adb, ["install", apk, "--serial", "FAKE1"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Success/);
});

test("usage: 未知子命令退出 2，无参数打印帮助", { skip }, async () => {
  const adb = writeFakeAdb();
  const unknown = await runCli(adb, ["dance"]);
  assert.equal(unknown.code, 2);

  const help = await runCli(adb, []);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /adb-safe/);
});
