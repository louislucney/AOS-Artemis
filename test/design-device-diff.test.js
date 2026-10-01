import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PNG } from "pngjs";

import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubDevice,
  stubFigmaFetch,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

function makeDiffProject({ fileKey }) {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);

  const deviceImage = createImage(390, 844);
  const deviceJpeg = toJpeg(deviceImage, 85);
  const devicePath = path.join(dir, "device-screen.jpg");
  fs.writeFileSync(devicePath, deviceJpeg);

  const figma = stubFigmaFetch(designPng, "1:2", fileKey);
  return { dir, designPng, deviceJpeg, devicePath, figma };
}

test("design_device_diff: Figma × 实时截图 → 差异报告 + 标注图 + 产物落盘", async () => {
  await withFigmaToken(async () => {
    const { dir, designPng, deviceJpeg, devicePath, figma } = makeDiffProject({ fileKey: "DiffA1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/DiffA1/File?node-id=1-2" }
      });
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
      assert.ok(Math.abs(payload.regions[0].bbox.x - 40) <= 8, `x=${payload.regions[0].bbox.x}`);
      assert.ok(Math.abs(payload.regions[0].bbox.y - 80) <= 8, `y=${payload.regions[0].bbox.y}`);
      assert.equal(payload.alignment.scale, 1);
      assert.equal(payload.regions[0].category, "missing");
      assert.deepEqual(payload.regions[0].designNode, { id: "1:2", name: "Card" });
      assert.equal(payload.designNodes, 1);
      assert.equal(payload.thresholds.pixelThreshold, 0.1);
      assert.deepEqual(payload.warnings, []);

      for (const file of ["report.json", "annotated.png", "design.png", "device.png"]) {
        assert.ok(fs.existsSync(path.join(payload.saved.dir, file)), `${file} missing`);
      }
      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.unit.design.source, "figma");
      assert.equal(report.unit.design.nodeId, "1:2");
      assert.equal(report.unit.device.mode, "live");
      assert.equal(report.summary.regions, 1);

      assert.deepEqual(fs.readFileSync(payload.saved.design), designPng);
      const savedDevice = PNG.sync.read(fs.readFileSync(payload.saved.device));
      assert.equal(savedDevice.width, 390);
      assert.equal(savedDevice.height, 844);
      const sample = (200 * savedDevice.width + 200) * 4;
      assert.deepEqual([...savedDevice.data.subarray(sample, sample + 3)], [255, 255, 255]);

      assert.equal(result.content.length, 2);
      assert.equal(result.content[1].type, "image");
      assert.equal(result.content[1].mimeType, "image/png");
      assert.ok(result.content[1].data.length > 0);
      assert.ok(figma.calls.some((href) => href.includes("render.example")));
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: dryRun 不取图不写盘", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(
    await designDeviceDiff(runtime, {
      design: { figmaUrl: "https://www.figma.com/design/DiffB2/File?node-id=9-9" },
      dryRun: true
    })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.match(payload.plannedDir, /diffs/);
  assert.match(path.basename(payload.plannedDir), /^9-9-/);
  assert.equal(payload.design.nodeId, "9:9");
  assert.equal(proxy.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
});

test("design_device_diff: ignoreRegions 屏蔽后无差异区域", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, figma } = makeDiffProject({ fileKey: "DiffC3" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/DiffC3/File?node-id=1-2" },
          alignment: { ignoreRegions: [{ x: 30, y: 70, width: 140, height: 80 }] }
        })
      );
      assert.equal(payload.summary.regions, 0, JSON.stringify(payload.regions));
      assert.deepEqual(payload.ignoredRegions, [{ x: 30, y: 70, width: 140, height: 80 }]);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 真机截图失败时报错且不残留产物", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeDiffProject({ fileKey: "DiffD4" });
    const proxy = new StubProxy({ running: true });
    proxy.callTool = async () => {
      throw new Error("device offline");
    };
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/DiffD4/File?node-id=1-2" }
      });
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /真机截图失败/);
      assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 缺 Figma token 时给引导且不写盘", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const previous = process.env.FIGMA_ACCESS_TOKEN;
  delete process.env.FIGMA_ACCESS_TOKEN;
  try {
    const result = await designDeviceDiff(runtime, {
      design: { figmaUrl: "https://www.figma.com/design/DiffE5/File?node-id=1-2" }
    });
    assert.equal(result.isError, true);
    assert.match(parseToolResult(result).error, /aos_configure/);
    assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
  } finally {
    if (previous !== undefined) process.env.FIGMA_ACCESS_TOKEN = previous;
  }
});

test("design_device_diff: insets 过大时差异计算报错且不写盘", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, figma } = makeDiffProject({ fileKey: "DiffF6" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/DiffF6/File?node-id=1-2" },
        alignment: { insets: { top: 1000, bottom: 1000 } }
      });
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /差异计算失败|insets 过大/);
      assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 写盘失败时清理并报错", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, figma } = makeDiffProject({ fileKey: "DiffG7" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    const designDir = path.join(dir, ".artemis", "design");
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(path.join(designDir, "diffs"), "occupied", "utf-8");
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/DiffG7/File?node-id=1-2" }
      });
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /产物写入失败/);
      assert.ok(!fs.existsSync(path.join(designDir, "diffs", "report.json")));
    } finally {
      figma.restore();
    }
  });
});
