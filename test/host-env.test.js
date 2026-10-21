import assert from "node:assert/strict";
import test from "node:test";

import { deriveCapabilities, detectHostEnvironment } from "../dist/host/env.js";

function fakeExec(table) {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const hit = table[key];
    if (hit === undefined) return { code: 1, stdout: "", stderr: "not found", error: "ENOENT" };
    return typeof hit === "function" ? hit() : { code: 0, stdout: hit, stderr: "", error: undefined };
  };
}

const DARWIN = {
  "adb version": "Android Debug Bridge version 1.0.41\n",
  "xcodebuild -version": "Xcode 16.4\nBuild version 16F6\n",
  "xcrun simctl help": "Usage: simctl",
  "idb --version": "idb 1.1.8",
  "which idevicesyslog": "/usr/local/bin/idevicesyslog",
  "uv --version": "uv 0.8.1"
};

test("darwin 完整工具链 → iOS 模拟器/真机 + Android", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" },
    exec: fakeExec(DARWIN),
    statfs: async () => ({ freeBytes: 100, totalBytes: 200 }),
    appiumStatus: async () => ({ version: "2.11.0" })
  });
  assert.equal(env.tools.adb.present, true);
  assert.equal(env.tools.xcodebuild.version, "16.4");
  const caps = deriveCapabilities("darwin", env.tools);
  assert.deepEqual(caps.sort(), ["android", "ios-real", "ios-simulator"]);
});

test("win32 只有 adb → 只有 Android，不产生 iOS", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "C:/w/app",
    platform: "win32",
    exec: fakeExec({ "adb version": "Android Debug Bridge version 1.0.41\n" }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 })
  });
  assert.deepEqual(deriveCapabilities("win32", env.tools), ["android"]);
  assert.equal(env.tools.simctl.present, false);
});

test("命令失败/超时不抛错，探测为 present=false", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    exec: async () => ({ code: null, stdout: "", stderr: "", error: "timeout" }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 })
  });
  assert.equal(env.tools.adb.present, false);
  assert.equal(env.tools.xcodebuild.present, false);
});

test("darwin 有 idevice_id + idb 但无 Appium → 仍可推导 iOS 真机", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    exec: fakeExec({
      "xcrun simctl help": "Usage: simctl",
      "idb --version": "idb 1.1.8",
      "which idevice_id": "/usr/local/bin/idevice_id"
    }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 })
  });
  assert.equal(env.tools.ideviceId.present, true);
  assert.equal(env.tools.appium.present, false);
  assert.deepEqual(deriveCapabilities("darwin", env.tools).sort(), ["ios-real", "ios-simulator"]);
});

test("Appium 已配置但探测失败 → present=false 且不产生 iOS 真机", async () => {
  const env = await detectHostEnvironment({
    projectRoot: "/w/app",
    platform: "darwin",
    env: { AOS_APPIUM_URL: "http://127.0.0.1:4723" },
    exec: fakeExec({ "xcrun simctl help": "Usage: simctl" }),
    statfs: async () => ({ freeBytes: 1, totalBytes: 2 }),
    appiumStatus: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4723");
    }
  });
  assert.equal(env.tools.appium.present, false);
  assert.equal(env.tools.appium.configured, true);
  assert.equal(env.tools.appium.reachable, false);
  assert.match(env.tools.appium.note, /ECONNREFUSED/);
  assert.deepEqual(deriveCapabilities("darwin", env.tools), ["ios-simulator"]);
});
