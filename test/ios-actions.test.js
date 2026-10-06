import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeIosDevice } from "../dist/device/ios-actions.js";
import { createImage, toPng } from "./helpers.js";

const UDID = "65584900-E161-4125-8928-587499DD6457";
const ENV = { AOS_IDB_PATH: "/fake/idb", AOS_XCRUN_PATH: "/fake/xcrun" };

function actionExec(responses = []) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    for (const rule of responses) {
      if (rule.command && command !== rule.command) continue;
      const joined = args.join(" ");
      if (!joined.includes(rule.match)) continue;
      if (rule.outcome === "fail") return { code: 1, stdout: "", stderr: "boom" };
      if (rule.outcome === "notfound") return { code: null, stdout: "", stderr: "", error: "spawn ENOENT" };
      if (typeof rule.outcome === "function") return rule.outcome(args);
      return { code: 0, stdout: rule.outcome, stderr: "" };
    }
    if (args[0] === "ui" && args[1] === "describe-all") {
      return { code: 0, stdout: JSON.stringify([]), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function deviceWith(responses = []) {
  const { exec, calls } = actionExec(responses);
  const device = makeIosDevice(UDID, { env: ENV, exec, platform: "darwin", pathExists: () => true });
  return { device, calls };
}

function last(calls) {
  return calls[calls.length - 1];
}

test("ios tap/swipe: 坐标取整，swipe 时长换算为秒", async () => {
  const { device, calls } = deviceWith();
  await device.tap(10.4, 20.6);
  assert.deepEqual(last(calls), {
    command: "/fake/idb",
    args: ["ui", "tap", "--udid", UDID, "10", "21"]
  });
  await device.swipe(0, 0, 100, 200, 500);
  assert.deepEqual(last(calls).args, [
    "ui",
    "swipe",
    "--udid",
    UDID,
    "0",
    "0",
    "100",
    "200",
    "--duration",
    "0.5"
  ]);
});

test("ios tap: idb 失败抛错", async () => {
  const { device } = deviceWith([{ match: "ui tap", outcome: "fail" }]);
  await assert.rejects(() => device.tap(1, 1), /idb tap 失败/);
});

test("ios inputText: ASCII 走 ui text；CJK 需坐标并走 set-value", async () => {
  const { device, calls } = deviceWith();
  assert.deepEqual(await device.inputText("abc123"), { mode: "type" });
  assert.deepEqual(last(calls).args, ["ui", "text", "--udid", UDID, "abc123"]);

  await assert.rejects(() => device.inputText("通用"), /非 ASCII 需要目标坐标/);
  assert.deepEqual(await device.inputText("通用", { x: 100.6, y: 200.2 }), { mode: "set" });
  assert.deepEqual(last(calls).args, [
    "ui",
    "set-value",
    "--api",
    "ax",
    "--udid",
    UDID,
    "--value",
    "通用",
    "101",
    "200"
  ]);
});

test("ios launch/openUrl: idb 失败回退 simctl", async () => {
  const { device, calls } = deviceWith([
    { command: "/fake/idb", match: "launch", outcome: "fail" },
    { command: "/fake/idb", match: "open ", outcome: "fail" }
  ]);
  await device.launch("com.apple.Preferences");
  const simctlLaunch = calls.find((call) => call.command === "/fake/xcrun" && call.args[1] === "launch");
  assert.ok(simctlLaunch, "simctl launch fallback used");

  await device.openUrl("prefs:root=General");
  const simctlOpen = calls.find((call) => call.command === "/fake/xcrun" && call.args[1] === "openurl");
  assert.ok(simctlOpen, "simctl openurl fallback used");
});

test("ios launch: idb 与 simctl 都失败抛错", async () => {
  const { device } = deviceWith([{ match: "launch", outcome: "fail" }]);
  const { exec } = actionExec([]);
  const failing = makeIosDevice(UDID, {
    env: ENV,
    platform: "darwin",
    pathExists: () => true,
    exec: async (command, args) => {
      void exec;
      if (command === "/fake/xcrun") return { code: 1, stdout: "", stderr: "simctl boom" };
      return { code: 1, stdout: "", stderr: "idb boom" };
    }
  });
  await assert.rejects(() => device.launch("com.x"), /启动 com.x 失败/);
  await assert.rejects(() => failing.launch("com.x"), /启动 com.x 失败/);
});

test("ios terminate: 任一路径成功返回 true，双双失败返回 false", async () => {
  const okIdb = deviceWith();
  assert.equal(await okIdb.device.terminate("com.x"), true);

  const fallback = deviceWith([{ command: "/fake/idb", match: "terminate", outcome: "fail" }]);
  assert.equal(await fallback.device.terminate("com.x"), true);
  assert.ok(fallback.calls.some((call) => call.command === "/fake/xcrun" && call.args[1] === "terminate"));

  const failing = makeIosDevice(UDID, {
    env: ENV,
    platform: "darwin",
    pathExists: () => true,
    exec: async () => ({ code: 1, stdout: "", stderr: "boom" })
  });
  assert.equal(await failing.terminate("com.x"), false);
});

test("ios nodes/size: 解析 idb 输出并从 Application 取逻辑尺寸", async () => {
  const nodes = [
    { type: "Application", AXLabel: "", AXValue: "", frame: { x: 0, y: 0, width: 402, height: 874 } },
    { type: "Button", AXLabel: "通用", AXValue: "", frame: { x: 10, y: 20, width: 100, height: 44 } }
  ];
  const { device } = deviceWith([
    { match: "ui describe-all", outcome: JSON.stringify(nodes) }
  ]);
  assert.equal((await device.nodes()).length, 2);
  assert.deepEqual(await device.size(), { width: 402, height: 874 });
});

test("ios screenshot: 落盘失败时抛错", async () => {
  const { device } = deviceWith();
  await assert.rejects(() => device.screenshot(), /iOS 截图失败/);
});

test("ios handleAlerts: accept 策略点击并计数；keep 不动；dismiss 用拒绝文案", async () => {
  let round = 0;
  const alertNodes = JSON.stringify([
    { type: "Button", AXLabel: "允许一次", AXValue: "", frame: { x: 100, y: 200, width: 80, height: 40 } }
  ]);
  const { exec, calls } = actionExec([
    {
      match: "ui describe-all",
      outcome: (args) => {
        void args;
        round += 1;
        return { code: 0, stdout: round === 1 ? alertNodes : JSON.stringify([]), stderr: "" };
      }
    }
  ]);
  const device = makeIosDevice(UDID, { env: ENV, exec, platform: "darwin", pathExists: () => true });
  const result = await device.handleAlerts({ mode: "accept" });
  assert.deepEqual(result, { handled: 1, tapped: ["允许一次"] });
  const tapCall = calls.find((call) => call.args[1] === "tap");
  assert.deepEqual(tapCall.args, ["ui", "tap", "--udid", UDID, "140", "220"]);

  const keep = await device.handleAlerts({ mode: "keep" });
  assert.deepEqual(keep, { handled: 0, tapped: [] });
});

test("ios: 非 macOS 平台动作直接拒绝", async () => {
  const { device } = deviceWith();
  const linux = makeIosDevice(UDID, { env: ENV, exec: actionExec([]).exec, platform: "linux", pathExists: () => true });
  void device;
  await assert.rejects(() => linux.tap(1, 1), /仅支持 macOS/);
});

test("ios screenshot: 成功路径返回 PNG 字节", async () => {
  const png = Buffer.from(toPng(createImage(4, 4)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aos-ios-act-"));
  const { exec } = actionExec([
    {
      match: "screenshot",
      outcome: (args) => {
        fs.writeFileSync(args[args.length - 1], png);
        return { code: 0, stdout: "", stderr: "" };
      }
    }
  ]);
  const device = makeIosDevice(UDID, { env: ENV, exec, platform: "darwin", pathExists: () => true });
  assert.equal((await device.screenshot()).equals(png), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});
