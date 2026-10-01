import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { screenMap } from "../dist/diff/screen-map.js";
import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubStepScreenshots,
  toJpeg,
  toPng
} from "./helpers.js";

const PEN_FIXTURE = `{
  "version": "2.19",
  "children": [
    {
      "id": "screen", "type": "frame", "name": "Home", "x": 0, "y": 0, "width": 390, "height": 844,
      "fill": "#FFFFFF", "layout": "none",
      "children": [
        { "id": "card", "type": "rectangle", "name": "Card", "x": 40, "y": 80, "width": 120, "height": 60, "fill": "#1E40B0" }
      ]
    }
  ]
}`;

test("集成：pen 设计源 × step 截图 × screen_map 定位（mapped）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "demo.pen"), PEN_FIXTURE, "utf-8");

  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 176, 255]);
  const designPng = toPng(designImage);
  const exec = async (command, args) => {
    const output = args[args.indexOf("--export") + 1];
    fs.writeFileSync(output, designPng);
    return { code: 0, stdout: `Export saved to: ${output}`, stderr: "" };
  };
  const ensure = async () => ({ ok: true, source: "path", path: "/fake/pen", installed: false });

  const postImage = createImage(390, 844);
  fillRect(postImage, 40, 80, 120, 60, [220, 38, 38, 255]);
  const postPath = path.join(dir, "step-post.jpg");
  fs.writeFileSync(postPath, toJpeg(postImage, 90));
  const proxy = new StubProxy({ running: true });
  stubStepScreenshots(proxy, {
    trace_id: "trace-1",
    device_serial: "emulator-5554",
    step_number: 2,
    before_screenshot: null,
    after_screenshot: `file://${postPath}`,
    action_overlay_screenshot: null
  });

  const { runtime } = await loadTestRuntime(dir, { proxy });
  await screenMap(runtime, {
    action: "save",
    entries: [
      {
        design: { screen: "Home" },
        code: { route: "/", component: "HomeScreen", file: "lib/screens/home_screen.dart" }
      }
    ]
  });

  const payload = parseToolResult(
    await designDeviceDiff(
      runtime,
      {
        design: { source: "pen", penPath: ".artemis/design/demo.pen" },
        device: { mode: "step", traceId: "trace-1", stepNumber: 2 }
      },
      { exec, ensure }
    )
  );

  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.design.source, "pen");
  assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
  const region = payload.regions[0];
  assert.equal(region.category, "color");
  assert.equal(region.designNode.id, "card");
  assert.equal(region.localized.status, "mapped");
  assert.equal(region.localized.mapEntry.code.file, "lib/screens/home_screen.dart");
  assert.deepEqual(payload.designScreens.map((screen) => screen.name), ["Home"]);

  const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
  assert.equal(report.unit.design.source, "pen");
  assert.equal(report.unit.device.mode, "step");
  assert.equal(report.unit.device.anchor, "explicit");
  assert.equal(report.unit.device.stepNumber, 2);
});
