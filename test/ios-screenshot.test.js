import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { captureLiveScreenshot } from "../dist/diff/device-source.js";
import { designDeviceDiff } from "../dist/diff/tool.js";
import { captureIosPng, parseBootedUdids, resolveIdbPath } from "../dist/device/ios.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubFigmaFetch,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

const PNG_BYTES = Buffer.from(toPng(createImage(4, 4)));
const JPG_BYTES = Buffer.from(toJpeg(createImage(4, 4)));
const IOS_ENV = { AOS_IDB_PATH: "/fake/idb", AOS_XCRUN_PATH: "/fake/xcrun" };

function iosExec(options = {}) {
  const { booted = ["UDID-1"], idb = "ok", simctl = "ok", idbBytes = PNG_BYTES, simctlBytes = PNG_BYTES } =
    options;
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "simctl" && args[1] === "list") {
      return {
        code: 0,
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5": booted.map((udid) => ({
              udid,
              state: "Booted",
              isAvailable: true
            }))
          }
        }),
        stderr: ""
      };
    }
    const isSimctlShot = args[0] === "simctl" && args[1] === "io";
    const outcome = isSimctlShot ? simctl : idb;
    if (outcome === "notfound") {
      return { code: null, stdout: "", stderr: "", error: `spawn ${command} ENOENT` };
    }
    if (outcome === "timeout") return { code: null, stdout: "", stderr: "", error: "timeout" };
    if (outcome === "fail") return { code: 1, stdout: "", stderr: "boom" };
    fs.writeFileSync(args[args.length - 1], isSimctlShot ? simctlBytes : idbBytes);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("resolveIdbPath: env 优先，其次 Homebrew，最后 PATH", () => {
  assert.deepEqual(resolveIdbPath({ AOS_IDB_PATH: "/x/idb" }, () => false), {
    path: "/x/idb",
    source: "env"
  });
  assert.deepEqual(resolveIdbPath({}, (candidate) => candidate === "/opt/homebrew/bin/idb"), {
    path: "/opt/homebrew/bin/idb",
    source: "brew"
  });
  assert.deepEqual(resolveIdbPath({}, () => false), { path: "idb", source: "path" });
});

test("parseBootedUdids: 只取 Booted 且可用的设备，重复去重", () => {
  const stdout = JSON.stringify({
    devices: {
      "runtime-a": [
        { udid: "A", state: "Booted", isAvailable: true },
        { udid: "B", state: "Shutdown", isAvailable: true },
        { udid: "C", state: "Booted", isAvailable: false },
        { udid: "A", state: "Booted", isAvailable: true }
      ],
      "runtime-b": [{ udid: "D", state: "Booted", isAvailable: true }]
    }
  });
  assert.deepEqual(parseBootedUdids(stdout), ["A", "D"]);
  assert.equal(parseBootedUdids("not json"), null);
});

test("captureIosPng: 显式 UDID 经 idb 返回 PNG", async () => {
  const { exec, calls } = iosExec();
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin", serial: "UDID-9" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.tool, "idb");
  assert.equal(result.serial, "UDID-9");
  assert.equal(result.bytes.equals(PNG_BYTES), true);
  assert.equal(calls[0].command, "/fake/idb");
  assert.equal(calls.some((call) => call.args[1] === "list"), false);
});

test("captureIosPng: 唯一已启动模拟器自动选中", async () => {
  const { exec } = iosExec({ booted: ["ONLY-1"] });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.serial, "ONLY-1");
});

test("captureIosPng: 多台已启动且缺省 serial → no-serial（不发截图命令）", async () => {
  const { exec, calls } = iosExec({ booted: ["A", "B"] });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no-serial");
  assert.equal(calls.length, 1);
});

test("captureIosPng: 没有已启动模拟器 → no-device", async () => {
  const { exec } = iosExec({ booted: [] });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no-device");
});

test("captureIosPng: idb 失败时回退 simctl", async () => {
  const { exec } = iosExec({ idb: "fail" });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin", serial: "UDID-1" });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.tool, "simctl");
});

test("captureIosPng: idb 与 simctl 都缺失 → not-found", async () => {
  const { exec } = iosExec({ idb: "notfound", simctl: "notfound" });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin", serial: "UDID-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not-found");
});

test("captureIosPng: 输出不是 PNG → not-png", async () => {
  const { exec } = iosExec({ idbBytes: JPG_BYTES, simctlBytes: JPG_BYTES });
  const result = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin", serial: "UDID-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not-png");
});

test("captureIosPng: 两侧都超时 → timeout；非 macOS → ios-unsupported", async () => {
  const { exec } = iosExec({ idb: "timeout", simctl: "timeout" });
  const timedOut = await captureIosPng({ env: IOS_ENV, exec, platform: "darwin", serial: "UDID-1" });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error, "timeout");

  const { exec: noExec, calls } = iosExec();
  const unsupported = await captureIosPng({
    env: IOS_ENV,
    exec: noExec,
    platform: "linux",
    serial: "UDID-1"
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error, "ios-unsupported");
  assert.equal(calls.length, 0);
});

test("captureLiveScreenshot(ios): 注入的 iOS 截图源生效且不调用代理", async () => {
  let proxyCalls = 0;
  const runtime = {
    proxy: {
      callTool: async () => {
        proxyCalls += 1;
        return { content: [] };
      }
    }
  };
  const capture = await captureLiveScreenshot(runtime, "UDID-1", {
    platform: "ios",
    captureIosPng: async () => ({ ok: true, bytes: PNG_BYTES, serial: "UDID-1", tool: "idb" })
  });
  assert.equal(proxyCalls, 0);
  assert.match(capture.note, /iOS 模拟器 PNG/);
  assert.equal(capture.serial, "UDID-1");
  assert.equal(capture.bytes.equals(PNG_BYTES), true);
});

test("captureLiveScreenshot(ios): 失败抛出带指引的错误（无 ARTEMIS 回退）", async () => {
  const runtime = { proxy: { callTool: async () => ({ content: [] }) } };
  await assert.rejects(
    () =>
      captureLiveScreenshot(runtime, undefined, {
        platform: "ios",
        captureIosPng: async () => ({ ok: false, serial: null, error: "no-device" })
      }),
    /simctl boot/
  );
});

function makeIosDiffProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);
  const devicePng = Buffer.from(toPng(createImage(390, 844)));
  const figma = stubFigmaFetch(designPng, "1:2", "IosDiff1");
  return { dir, devicePng, figma };
}

test("design_device_diff: platform=ios 走模拟器截图且不查询 ARTEMIS", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, figma } = makeIosDiffProject();
    const proxy = new StubProxy({ running: true });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/IosDiff1/File?node-id=1-2" },
          device: { platform: "ios", serial: "UDID-1" }
        },
        {
          captureIosPng: async () => ({ ok: true, bytes: devicePng, serial: "UDID-1", tool: "idb" })
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
      assert.equal(payload.device.platform, "ios");
      assert.match(payload.device.source, /iOS 模拟器/);
      assert.equal(proxy.calls.some((call) => call.name === "mobile_get_device_state"), false);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: platform=ios 的 step 模式不再被拒绝（进入锚点解析）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  const result = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/X/File?node-id=1-2" },
    device: { mode: "step", platform: "ios", traceId: "t1" }
  });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.match(payload.error, /自动锚点失败/);
  assert.doesNotMatch(payload.error, /仅支持 mode="live"/);
});
