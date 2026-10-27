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
  stubDevice,
  stubFigmaFetch,
  stubStepScreenshots,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

const REPORT_KEYS_WITH_DETAIL = [
  "schemaVersion",
  "unit",
  "alignment",
  "designScreens",
  "ignoredRegions",
  "dynamicIgnoreRegions",
  "dynamicRegions",
  "designNodes",
  "thresholds",
  "warnings",
  "regions",
  "summary",
  "detail",
  "regionDetails",
  "elapsedMs"
];

const REPORT_KEYS_LEGACY = [
  "schemaVersion",
  "unit",
  "alignment",
  "designScreens",
  "ignoredRegions",
  "dynamicIgnoreRegions",
  "dynamicRegions",
  "designNodes",
  "thresholds",
  "warnings",
  "regions",
  "summary",
  "elapsedMs"
];

function makeDetailProject({ fileKey, document, failNodes } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);

  const deviceImage = createImage(390, 844);
  const devicePng = toPng(deviceImage);
  const deviceJpeg = toJpeg(deviceImage, 90);
  const devicePath = path.join(dir, "device.jpg");
  fs.writeFileSync(devicePath, deviceJpeg);

  const figma = stubFigmaFetch(designPng, "1:2", fileKey, {
    ...(document ? { document } : {}),
    ...(failNodes ? { failNodes: true } : {})
  });
  return { dir, designPng, devicePng, deviceJpeg, devicePath, figma };
}

function okCapture(bytes) {
  return async () => ({ ok: true, bytes, serial: "S1", adb: { path: "/fake/adb", source: "env" } });
}

test("design_device_diff: 默认 auto 区域核验——对图内联、regionDetails、产物与报告扩展", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailA1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    let captureCalls = 0;
    try {
      const result = await designDeviceDiff(
        runtime,
        { design: { figmaUrl: "https://www.figma.com/design/DetailA1/File?node-id=1-2" } },
        {
          capturePng: async () => {
            captureCalls += 1;
            return { ok: true, bytes: devicePng, serial: "S1", adb: { path: "/fake/adb", source: "env" } };
          }
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(captureCalls, 1, "细节通道应二次无损抓图一次");
      assert.equal(payload.detail.enabled, true);
      assert.equal(payload.detail.textStyles.scope, "text-regions");
      assert.equal(payload.detail.zoom, 2);
      assert.equal(payload.detail.tilesUsed, false);
      assert.equal(payload.detail.truncated, false);
      assert.equal(payload.detail.degraded, false, JSON.stringify(payload.warnings));
      assert.deepEqual(payload.detail.deviceSource, { format: "png", lossless: true });
      assert.deepEqual(payload.warnings, []);
      assert.ok(payload.detail.regionCount >= 1, JSON.stringify(payload.regionDetails));
      assert.ok(payload.regionDetails.some((region) => region.localSummary.hasDiff));
      assert.ok(
        payload.regionDetails.every(
          (region) => typeof region.idx === "number" && region.bbox && region.localSummary && region.source
        )
      );
      assert.equal(payload.detail.returned, Math.min(payload.detail.regionCount, 8));
      assert.equal(result.content.length, 2 + payload.detail.returned);
      assert.equal(result.content[2].type, "image");
      assert.equal(result.content[2].mimeType, "image/png");

      const first = payload.regionDetails[0];
      assert.match(first.crops.pair, /^regions\//);
      assert.ok(fs.existsSync(path.join(payload.saved.dir, first.crops.pair)), first.crops.pair);
      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.deepEqual(Object.keys(report), REPORT_KEYS_WITH_DETAIL);
      assert.equal(report.detail.enabled, true);
      assert.equal(report.regionDetails.length, payload.detail.regionCount);
      assert.equal(figma.calls.filter((href) => href.includes("/images/")).length, 1, "S≈1 时不应二次渲染");
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: regions:none 保持旧契约（无 detail 键、content=2、无二次抓图）", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, figma } = makeDetailProject({ fileKey: "DetailNone1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    let captureCalls = 0;
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/DetailNone1/File?node-id=1-2" },
          regions: "none"
        },
        {
          capturePng: async () => {
            captureCalls += 1;
            return { ok: false, serial: null, adb: { path: null, source: "missing" }, error: "n/a" };
          }
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true);
      assert.equal(captureCalls, 0);
      assert.equal(result.content.length, 2);
      assert.equal("detail" in payload, false);
      assert.equal("regionDetails" in payload, false);
      assert.deepEqual(payload.warnings, []);
      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.deepEqual(Object.keys(report), REPORT_KEYS_LEGACY);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 无损二次抓图失败 → degraded + lossy-source 警告", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, figma } = makeDetailProject({ fileKey: "DetailDeg1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        { design: { figmaUrl: "https://www.figma.com/design/DetailDeg1/File?node-id=1-2" } },
        {
          capturePng: async () => ({ ok: false, serial: null, adb: { path: null, source: "missing" }, error: "adb-not-found" })
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true);
      assert.equal(payload.detail.degraded, true);
      assert.match(payload.warnings.join(" "), /lossy-source/);
      assert.ok(payload.regionDetails.some((region) => region.localSummary.hasDiff));
      assert.equal(result.content.length, 2 + payload.detail.returned);
    } finally {
      figma.restore();
    }
  });
});

function truncationDocument() {
  const rect = (id, name, y, width) => ({
    id,
    type: "RECTANGLE",
    name,
    absoluteBoundingBox: { x: 20, y, width, height: 20 },
    fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }]
  });
  return {
    id: "0:1",
    type: "FRAME",
    name: "Screen",
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      {
        id: "1:2",
        type: "RECTANGLE",
        name: "Card",
        absoluteBoundingBox: { x: 40, y: 80, width: 120, height: 60 },
        fills: [{ type: "SOLID", color: { r: 0.118, g: 0.251, b: 0.686, a: 1 } }]
      },
      rect("1:3", "Wide", 300, 100),
      rect("1:4", "Mid", 400, 50),
      rect("1:5", "Small", 500, 25),
      rect("1:6", "Tiny", 600, 5)
    ]
  };
}

test("design_device_diff: 区域截断——diff 命中与小面积优先、truncated 标记", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailTrunc1", document: truncationDocument() });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/DetailTrunc1/File?node-id=1-2" },
          diff: { maxRegions: 2 }
        },
        { capturePng: okCapture(devicePng) }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true);
      assert.equal(payload.detail.truncated, true);
      assert.equal(payload.detail.regionCount, 2);
      assert.ok(payload.regionDetails.some((region) => region.source === "diff"));
      assert.ok(payload.regionDetails.some((region) => region.name === "Tiny"));
      assert.match(payload.warnings.join(" "), /detail-truncated/);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 无节点源 → tiles 兜底（tilesUsed=true）且不降级", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailTiles1", failNodes: true });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        { design: { figmaUrl: "https://www.figma.com/design/DetailTiles1/File?node-id=1-2" } },
        { capturePng: okCapture(devicePng) }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.detail.tilesUsed, true);
      assert.ok(payload.detail.regionCount >= 1, JSON.stringify(payload.regionDetails));
      assert.ok(payload.regionDetails.some((region) => region.source === "tile"));
      assert.match(payload.warnings.join(" "), /设计节点几何获取失败/);
      assert.equal(payload.detail.degraded, false);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: bbox 分页——第二轮仅核验回传区域（source=manual）", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailPage1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const first = parseToolResult(
        await designDeviceDiff(
          runtime,
          { design: { figmaUrl: "https://www.figma.com/design/DetailPage1/File?node-id=1-2" } },
          { capturePng: okCapture(devicePng) }
        )
      );
      const boxes = first.regionDetails.map((region) => region.bbox);
      assert.ok(boxes.length >= 1);
      const second = parseToolResult(
        await designDeviceDiff(
          runtime,
          { design: { figmaUrl: "https://www.figma.com/design/DetailPage1/File?node-id=1-2" }, regions: boxes },
          { capturePng: okCapture(devicePng) }
        )
      );
      assert.equal(second.ok, true);
      assert.deepEqual(second.regionDetails.map((region) => region.bbox), boxes);
      assert.ok(second.regionDetails.every((region) => region.source === "manual"));
      assert.equal(second.detail.regionCount, boxes.length);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: save:false 不写盘、crops 省略、内联仍在", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailNoSave1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        { design: { figmaUrl: "https://www.figma.com/design/DetailNoSave1/File?node-id=1-2" }, save: false },
        { capturePng: okCapture(devicePng) }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true);
      assert.equal(payload.saved, undefined);
      assert.ok(payload.regionDetails.every((region) => region.crops === undefined));
      assert.equal(result.content.length, 2 + payload.detail.returned);
      assert.equal(fs.existsSync(path.join(dir, ".artemis", "design", "diffs")), false);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: dryRun 维持旧语义（不取图、无 detail 键）", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeDetailProject({ fileKey: "DetailDry1" });
    const proxy = new StubProxy({ running: true });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    let captureCalls = 0;
    try {
      const result = await designDeviceDiff(
        runtime,
        { design: { figmaUrl: "https://www.figma.com/design/DetailDry1/File?node-id=1-2" }, dryRun: true },
        { capturePng: async () => { captureCalls += 1; return { ok: false, serial: null, adb: { path: null, source: "missing" }, error: "n/a" }; } }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.dryRun, true);
      assert.equal(captureCalls, 0);
      assert.equal("detail" in payload, false);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: step 源为 JPEG 时按降级档并给出 lossy-source 警告", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeDetailProject({ fileKey: "DetailStep1" });
    const proxy = new StubProxy({ running: true });
    const stepJpeg = path.join(dir, "step.jpg");
    fs.writeFileSync(stepJpeg, toJpeg(createImage(390, 844), 85));
    stubStepScreenshots(proxy, { ok: true, step_number: 2, after_screenshot: stepJpeg });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/DetailStep1/File?node-id=1-2" },
          device: { mode: "step", traceId: "trace-step-jpeg", stepNumber: 2 }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.detail.degraded, true);
      assert.match(payload.warnings.join(" "), /lossy-source/);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 部分截断区域按可见窗口核验并计入 out-of-bounds", async () => {
  await withFigmaToken(async () => {
    const doc = {
      id: "0:1",
      type: "FRAME",
      name: "Screen",
      absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
      children: [
        {
          id: "1:2",
          type: "RECTANGLE",
          name: "Card",
          absoluteBoundingBox: { x: 40, y: 80, width: 120, height: 60 },
          fills: [{ type: "SOLID", color: { r: 0.118, g: 0.251, b: 0.686, a: 1 } }]
        },
        {
          id: "1:7",
          type: "RECTANGLE",
          name: "Edge",
          absoluteBoundingBox: { x: 20, y: 340, width: 50, height: 20 },
          fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }]
        }
      ]
    };
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailOob1", document: doc });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(
          runtime,
          {
            design: { figmaUrl: "https://www.figma.com/design/DetailOob1/File?node-id=1-2" },
            alignment: { insets: { top: 500 } }
          },
          { capturePng: okCapture(devicePng) }
        )
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.match(payload.warnings.join(" "), /out-of-bounds/);
      assert.ok(payload.regionDetails.some((region) => region.name === "Edge"));
    } finally {
      figma.restore();
    }
  });
});

function makeScale3Project({ fileKey, failDetailRender } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);
  const designHi = createImage(1170, 2532);
  fillRect(designHi, 120, 240, 360, 180, [30, 64, 175, 255]);
  const design3x = toPng(designHi);

  const deviceImage = createImage(1170, 2532);
  const devicePng = Buffer.from(toPng(deviceImage));
  const devicePath = path.join(dir, "device.jpg");
  fs.writeFileSync(devicePath, toJpeg(deviceImage, 85));

  const figma = stubFigmaFetch(designPng, "1:2", fileKey, {
    renderByScale: { "3": design3x },
    ...(failDetailRender ? { failRenderAtScale: "3" } : {})
  });
  return { dir, designPng, design3x, devicePng, devicePath, figma };
}

test("design_device_diff: Figma 按设备倍率二次渲染（S=3）→ 节点坐标 ×3、无降级", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeScale3Project({ fileKey: "DetailHi1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(
          runtime,
          { design: { figmaUrl: "https://www.figma.com/design/DetailHi1/File?node-id=1-2" } },
          { capturePng: okCapture(devicePng) }
        )
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(figma.calls.filter((href) => href.includes("/images/")).length, 2, "S>1 应二次渲染");
      assert.equal(payload.detail.degraded, false, JSON.stringify(payload.warnings));
      const nodeRegion = payload.regionDetails.find((region) => region.source === "node");
      assert.deepEqual(nodeRegion.bbox, { x: 104, y: 224, width: 392, height: 212 });
      assert.ok(payload.regionDetails.some((region) => region.localSummary.hasDiff));
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 高保真渲染失败回退低尺度 → design-upscaled 降级警告", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeScale3Project({ fileKey: "DetailHiFail1", failDetailRender: true });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(
          runtime,
          { design: { figmaUrl: "https://www.figma.com/design/DetailHiFail1/File?node-id=1-2" } },
          { capturePng: okCapture(devicePng) }
        )
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.detail.degraded, true);
      assert.match(payload.warnings.join(" "), /design-upscaled/);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: zoom/returnCrops/detail 参数覆盖生效", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePng, devicePath, figma } = makeDetailProject({ fileKey: "DetailParams1" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/DetailParams1/File?node-id=1-2" },
          zoom: 3,
          returnCrops: 1,
          detail: { pixelThreshold: 0.05 }
        },
        { capturePng: okCapture(devicePng) }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.detail.zoom, 3);
      assert.equal(payload.detail.returned, 1);
      assert.equal(result.content.length, 3);
    } finally {
      figma.restore();
    }
  });
});
