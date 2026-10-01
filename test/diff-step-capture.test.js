import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubFigmaFetch,
  stubStepScreenshots,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

function makeStepProject({ fileKey }) {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);

  const prePath = path.join(dir, "step-pre.jpg");
  fs.writeFileSync(prePath, toJpeg(designImage, 90));

  const postImage = createImage(390, 844);
  fillRect(postImage, 40, 80, 120, 60, [220, 38, 38, 255]);
  const postPath = path.join(dir, "step-post.jpg");
  fs.writeFileSync(postPath, toJpeg(postImage, 90));

  const figma = stubFigmaFetch(designPng, "1:2", fileKey);
  return { dir, prePath, postPath, figma };
}

function stepPayload(prePath, postPath) {
  return {
    trace_id: "trace-1",
    device_serial: "emulator-5554",
    step_number: 3,
    before_screenshot: `file://${prePath}`,
    after_screenshot: `file://${postPath}`,
    action_overlay_screenshot: null
  };
}

test("design_device_diff: mode=step 默认用 post 截图并记录 unit.device", async () => {
  await withFigmaToken(async () => {
    const { dir, prePath, postPath, figma } = makeStepProject({ fileKey: "StepA1" });
    const proxy = new StubProxy({ running: true });
    stubStepScreenshots(proxy, stepPayload(prePath, postPath));
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/StepA1/File?node-id=1-2" },
          device: { mode: "step", traceId: "trace-1", stepNumber: 3 }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1);
      assert.match(payload.device.source, /after_screenshot/);

      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.deepEqual(report.unit.device, {
        mode: "step",
        traceId: "trace-1",
        stepNumber: 3,
        image: "post",
        serial: "emulator-5554"
      });

      const call = proxy.calls.find((entry) => entry.name === "mobile_inspect_trace");
      assert.deepEqual(call.args, { action: "view_step_screenshots", trace_id: "trace-1", step_number: 3 });
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: image=pre 选择 before 截图", async () => {
  await withFigmaToken(async () => {
    const { dir, prePath, postPath, figma } = makeStepProject({ fileKey: "StepB2" });
    const proxy = new StubProxy({ running: true });
    stubStepScreenshots(proxy, stepPayload(prePath, postPath));
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/StepB2/File?node-id=1-2" },
          device: { mode: "step", traceId: "trace-1", stepNumber: 3, image: "pre" }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 0, JSON.stringify(payload.regions));
      assert.match(payload.device.source, /before_screenshot/);
      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.equal(report.unit.device.image, "pre");
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: mode=step 缺 traceId/stepNumber 时结构化报错", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const missingTrace = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/StepC3/File?node-id=1-2" },
    device: { mode: "step", stepNumber: 3 }
  });
  assert.equal(missingTrace.isError, true);
  assert.match(parseToolResult(missingTrace).error, /traceId/);

  const missingStep = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/StepC3/File?node-id=1-2" },
    device: { mode: "step", traceId: "trace-1" }
  });
  assert.equal(missingStep.isError, true);
  assert.match(parseToolResult(missingStep).error, /stepNumber/);
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
});

test("design_device_diff: 上游错误结构化返回", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeStepProject({ fileKey: "StepD4" });
    const proxy = new StubProxy({ running: true });
    stubStepScreenshots(proxy, {
      error: "Step not found",
      message: "Step number 99 not found for trace 'trace-1'."
    });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/StepD4/File?node-id=1-2" },
        device: { mode: "step", traceId: "trace-1", stepNumber: 99 }
      });
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /步骤截图获取失败|Step not found/);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 步骤截图文件缺失时报错", async () => {
  await withFigmaToken(async () => {
    const { dir, prePath, figma } = makeStepProject({ fileKey: "StepE5" });
    const proxy = new StubProxy({ running: true });
    stubStepScreenshots(proxy, stepPayload(prePath, path.join(dir, "missing-post.jpg")));
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/StepE5/File?node-id=1-2" },
        device: { mode: "step", traceId: "trace-1", stepNumber: 3 }
      });
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /不存在/);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: post 缺失时提示改用 pre；stepNumber 必须为正整数", async () => {
  await withFigmaToken(async () => {
    const { dir, prePath, figma } = makeStepProject({ fileKey: "StepF6" });
    const proxy = new StubProxy({ running: true });
    stubStepScreenshots(proxy, {
      trace_id: "trace-1",
      step_number: 3,
      before_screenshot: `file://${prePath}`,
      after_screenshot: null
    });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const missingPost = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/StepF6/File?node-id=1-2" },
        device: { mode: "step", traceId: "trace-1", stepNumber: 3 }
      });
      assert.equal(missingPost.isError, true);
      const error = parseToolResult(missingPost).error;
      assert.match(error, /没有 post 截图/);
      assert.match(error, /image:"pre"/);
    } finally {
      figma.restore();
    }
  });

  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });
  const zeroStep = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/StepG7/File?node-id=1-2" },
    device: { mode: "step", traceId: "trace-1", stepNumber: 0 }
  });
  assert.equal(zeroStep.isError, true);
  assert.match(parseToolResult(zeroStep).error, /正整数/);
});
