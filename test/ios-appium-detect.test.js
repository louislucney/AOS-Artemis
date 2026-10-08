import assert from "node:assert/strict";
import test from "node:test";

import { detectAppium } from "../dist/ios/appium/detect.js";

function fakeExec(routes) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    for (const [pattern, result] of routes) {
      if ([command, ...args].join(" ").includes(pattern)) return result;
    }
    return { code: 1, stdout: "", stderr: "not found", error: "spawn ENOENT" };
  };
  exec.calls = calls;
  return exec;
}

test("ios detect: appium 与 xcuitest 就绪（驱动列表走 stderr）", async () => {
  const exec = fakeExec([
    ["--version", { code: 0, stdout: "3.8.0\n", stderr: "", error: undefined }],
    [
      "driver list",
      {
        code: 0,
        stdout: "",
        stderr: "\u001b[32m- xcuitest@12.15.0 [installed (npm)]\u001b[39m\n",
        error: undefined
      }
    ]
  ]);
  const detection = await detectAppium({ env: {}, exec });
  assert.equal(detection.appium.found, true);
  assert.equal(detection.appium.version, "3.8.0");
  assert.deepEqual(detection.xcuitest, { installed: true, version: "12.15.0" });
  assert.ok(detection.guidance.some((line) => line.includes("tunnel-creation")));
  assert.ok(detection.guidance.some((line) => line.includes("AOS_IOS_XCODE_ORG_ID")));
});

test("ios detect: 未安装 appium 与缺驱动分别给指引", async () => {
  const missing = await detectAppium({
    env: {},
    exec: fakeExec([])
  });
  assert.equal(missing.appium.found, false);
  assert.equal(missing.appium.path, null);
  assert.ok(missing.guidance.some((line) => line.includes("npm install -g appium")));

  const noDriver = await detectAppium({
    env: { AOS_IOS_XCODE_ORG_ID: "TEAM123" },
    exec: fakeExec([
      ["--version", { code: 0, stdout: "3.8.0", stderr: "", error: undefined }],
      ["driver list", { code: 0, stdout: "no drivers installed", stderr: "", error: undefined }]
    ])
  });
  assert.equal(noDriver.xcuitest.installed, false);
  assert.ok(noDriver.guidance.some((line) => line.includes("appium driver install xcuitest")));
  assert.ok(!noDriver.guidance.some((line) => line.includes("AOS_IOS_XCODE_ORG_ID")));
});

test("ios detect: AOS_APPIUM_PATH 覆盖二进制", async () => {
  const exec = fakeExec([
    ["--version", { code: 0, stdout: "3.8.0", stderr: "", error: undefined }],
    ["driver list", { code: 0, stdout: "xcuitest@12.15.0", stderr: "", error: undefined }]
  ]);
  const detection = await detectAppium({
    env: { AOS_APPIUM_PATH: "/opt/custom/appium" },
    exec
  });
  assert.equal(detection.appium.path, "/opt/custom/appium");
  assert.ok(exec.calls[0].startsWith("/opt/custom/appium"));
});
