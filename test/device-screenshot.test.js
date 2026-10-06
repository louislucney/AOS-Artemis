import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { captureLiveScreenshot } from "../dist/diff/device-source.js";
import { designDeviceDiff } from "../dist/diff/tool.js";
import { captureAdbPng } from "../dist/device/screenshot.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempDir,
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
const ADB_ENV = { AOS_ADB_PATH: "/fake/adb" };

function devicesExec(list) {
  return async (command, args) => {
    if (args[0] === "devices") {
      return {
        code: 0,
        stdout: ["List of devices attached", ...list.map((serial) => `${serial}\tdevice`)].join("\n"),
        stderr: ""
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("captureAdbPng: 单设备自动解析并返回 PNG 字节", async () => {
  const result = await captureAdbPng({
    env: ADB_ENV,
    exec: devicesExec(["S1"]),
    execBuffer: async () => ({ code: 0, stdout: PNG_BYTES, stderr: "" })
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.serial, "S1");
  assert.equal(result.bytes.equals(PNG_BYTES), true);
});

test("captureAdbPng: 多设备且缺省 serial → no-serial", async () => {
  let captured = false;
  const result = await captureAdbPng({
    env: ADB_ENV,
    exec: devicesExec(["S1", "S2"]),
    execBuffer: async () => {
      captured = true;
      return { code: 0, stdout: PNG_BYTES, stderr: "" };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no-serial");
  assert.equal(captured, false);
});

test("captureAdbPng: 输出不是 PNG → not-png", async () => {
  const result = await captureAdbPng({
    env: ADB_ENV,
    exec: devicesExec(["S1"]),
    execBuffer: async () => ({ code: 0, stdout: JPG_BYTES, stderr: "" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not-png");
});

test("captureAdbPng: 超时 → timeout", async () => {
  const result = await captureAdbPng({
    env: ADB_ENV,
    exec: devicesExec(["S1"]),
    execBuffer: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", error: "timeout" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "timeout");
});

test("captureLiveScreenshot(lossless): 直接返回 adb PNG 且不调用代理", async () => {
  let proxyCalls = 0;
  const runtime = {
    proxy: {
      callTool: async () => {
        proxyCalls += 1;
        return { content: [] };
      }
    }
  };
  const capture = await captureLiveScreenshot(runtime, "S1", {
    lossless: true,
    capturePng: async () => ({ ok: true, bytes: PNG_BYTES, serial: "S1", adb: { path: "/fake/adb", source: "env" } })
  });
  assert.equal(proxyCalls, 0);
  assert.match(capture.note, /无损 PNG/);
  assert.equal(capture.serial, "S1");
  assert.equal(capture.bytes.equals(PNG_BYTES), true);
});

test("captureLiveScreenshot(lossless): adb 不可用时回退 live JPEG 并注明", async () => {
  const dir = makeTempDir("aos-lossless-");
  const jpgPath = path.join(dir, "device.jpg");
  fs.writeFileSync(jpgPath, JPG_BYTES);
  const runtime = {
    proxy: {
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ screenshot_path: jpgPath }) }]
      })
    }
  };
  const capture = await captureLiveScreenshot(runtime, undefined, {
    lossless: true,
    capturePng: async () => ({ ok: false, serial: null, adb: { path: null, source: "missing" }, error: "adb-not-found" })
  });
  assert.equal(capture.bytes.equals(JPG_BYTES), true);
  assert.match(capture.note, /回退 live JPEG/);
});

function makeLosslessProject() {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);
  const devicePng = Buffer.from(toPng(createImage(390, 844)));
  const figma = stubFigmaFetch(designPng, "1:2", "LosslessA1");
  return { dir, devicePng, figma };
}

test("design_device_diff: device.lossless 使用无损 PNG 且不查询 live 截图", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, figma } = makeLosslessProject();
    const proxy = new StubProxy({ running: true });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/LosslessA1/File?node-id=1-2" },
          device: { lossless: true }
        },
        {
          capturePng: async () => ({
            ok: true,
            bytes: devicePng,
            serial: "S1",
            adb: { path: "/fake/adb", source: "env" }
          })
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
      assert.equal(payload.alignment.scale, 1);
      assert.equal(proxy.calls.some((call) => call.name === "mobile_get_device_state"), false);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: device.lossless 与 mode=step 冲突时报错", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  const result = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/X/File?node-id=1-2" },
    device: { mode: "step", traceId: "t1", lossless: true }
  });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.match(payload.error, /lossless/);
});
