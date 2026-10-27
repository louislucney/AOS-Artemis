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
  const devicePng = toPng(deviceImage);
  const deviceJpeg = toJpeg(deviceImage, 85);
  const devicePath = path.join(dir, "device-screen.jpg");
  fs.writeFileSync(devicePath, deviceJpeg);

  const figma = stubFigmaFetch(designPng, "1:2", fileKey);
  return { dir, designPng, devicePng, deviceJpeg, devicePath, figma };
}

test("design_device_diff: Figma × 实时截图 → 差异报告 + 标注图 + 产物落盘", async () => {
  await withFigmaToken(async () => {
    const { dir, designPng, deviceJpeg, devicePath, devicePng, figma } = makeDiffProject({ fileKey: "DiffA1" });
    const contractDir = path.join(dir, ".artemis", "design");
    fs.mkdirSync(contractDir, { recursive: true });
    fs.writeFileSync(
      path.join(contractDir, "ui-contract.json"),
      JSON.stringify({
        schemaVersion: 1,
        screens: [
          {
            id: "1:2",
            frameWidth: 390,
            texts: [
              {
                id: "t1",
                content: "Card",
                fontFamily: "Test",
                fontWeight: 600,
                fontSize: 16,
                bbox: { x: 40, y: 80, width: 120, height: 60 },
                bboxSpace: "design-px",
                geometryStatus: "extracted"
              }
            ]
          }
        ]
      }),
      "utf-8"
    );
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/DiffA1/File?node-id=1-2" }
        },
        {
          capturePng: async () => ({ ok: true, bytes: devicePng, serial: "S1", adb: { path: "/fake/adb", source: "env" } })
        }
      );
      const payload = parseToolResult(result);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.detail.textStyles.scope, "contract");
      assert.equal(payload.detail.textStyles.textsTotal, 1);
      assert.equal(
        payload.detail.textStyles.checked + payload.detail.textStyles.unverified,
        payload.detail.textStyles.textsTotal
      );
      assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
      assert.ok(Math.abs(payload.regions[0].bbox.x - 40) <= 8, `x=${payload.regions[0].bbox.x}`);
      assert.ok(Math.abs(payload.regions[0].bbox.y - 80) <= 8, `y=${payload.regions[0].bbox.y}`);
      assert.equal(payload.alignment.scale, 1);
      assert.equal(payload.regions[0].category, "missing");
      assert.deepEqual(payload.regions[0].designNode, { id: "1:2", name: "Card" });
      assert.equal(payload.designNodes, 2);
      assert.equal(payload.thresholds.pixelThreshold, 0.1);
      assert.deepEqual(payload.warnings, []);

      for (const file of ["report.json", "annotated.png", "design.png", "device.png"]) {
        assert.ok(fs.existsSync(path.join(payload.saved.dir, file)), `${file} missing`);
      }
      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.deepEqual(Object.keys(report), [
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
      ]);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.unit.design.source, "figma");
      assert.equal(report.unit.design.nodeId, "1:2");
      assert.equal(report.unit.device.mode, "live");
      assert.equal(report.unit.device.sourceFormat, "jpeg");
      assert.equal(report.unit.device.lossless, false);
      assert.equal(report.summary.regions, 1);

      assert.deepEqual(fs.readFileSync(payload.saved.design), designPng);
      const savedDevice = PNG.sync.read(fs.readFileSync(payload.saved.device));
      assert.equal(savedDevice.width, 390);
      assert.equal(savedDevice.height, 844);
      const sample = (200 * savedDevice.width + 200) * 4;
      assert.deepEqual([...savedDevice.data.subarray(sample, sample + 3)], [255, 255, 255]);

      assert.equal(result.content.length, 2 + payload.detail.returned);
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
    const { dir, devicePath, devicePng, figma } = makeDiffProject({ fileKey: "DiffC3" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(
          runtime,
          {
            design: { figmaUrl: "https://www.figma.com/design/DiffC3/File?node-id=1-2" },
            alignment: { ignoreRegions: [{ x: 30, y: 70, width: 140, height: 80 }] }
          },
          {
            capturePng: async () => ({ ok: true, bytes: devicePng, serial: "S1", adb: { path: "/fake/adb", source: "env" } })
          }
        )
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
  const devicePath = path.join(dir, "device.jpg");
  fs.writeFileSync(devicePath, toJpeg(createImage(390, 844), 85));
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
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

test("design_device_diff: image source accepts a PNG and reports raster-only degradation", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const designPng = toPng(designImage);
  const designPath = path.join(dir, ".artemis", "design", "screens", "home.png");
  fs.mkdirSync(path.dirname(designPath), { recursive: true });
  fs.writeFileSync(designPath, designPng);

  const deviceImage = createImage(390, 844);
  const devicePng = toPng(deviceImage);
  const devicePath = path.join(dir, "device-screen.png");
  fs.writeFileSync(devicePath, devicePng);
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const result = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      regions: "none",
      save: false
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
  assert.deepEqual(payload.design, {
    source: "image",
    path: ".artemis/design/screens/home.png",
    format: "png"
  });
  assert.equal(payload.designNodes, 0);
  assert.equal(payload.alignment.scale, 1);
  assert.equal(payload.regions.length, 1);
  assert.equal(payload.regions[0].category, "pixel");
  assert.ok(
    payload.warnings.some((warning) => warning.includes("image-source")),
    "明确标注无节点几何/像素分类"
  );
});

test("design_device_diff: image source low resolution warns design-upscaled", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(195, 422);
  fillRect(designImage, 20, 40, 60, 30, [200, 40, 40, 255]);
  const designPath = path.join(dir, ".artemis", "design", "screens", "small.png");
  fs.mkdirSync(path.dirname(designPath), { recursive: true });
  fs.writeFileSync(designPath, toPng(designImage));

  const deviceImage = createImage(390, 844);
  const devicePng = toPng(deviceImage);
  const devicePath = path.join(dir, "device-screen.png");
  fs.writeFileSync(devicePath, devicePng);
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const result = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/small.png" },
      save: false
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
  assert.equal(payload.alignment.scale, 0.5);
  assert.equal(payload.detail.tilesUsed, true);
  assert.ok(
    payload.warnings.some((warning) => warning.includes("design-upscaled")),
    JSON.stringify(payload.warnings)
  );
});

test("design_device_diff: image source dryRun and validation errors", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designPath = path.join(dir, ".artemis", "design", "screens", "home.png");
  fs.mkdirSync(path.dirname(designPath), { recursive: true });
  fs.writeFileSync(designPath, toPng(createImage(390, 844)));
  const jpegPath = path.join(dir, ".artemis", "design", "screens", "home.jpg");
  fs.writeFileSync(jpegPath, toJpeg(createImage(390, 844), 85));
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, designPath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const dry = parseToolResult(
    await designDeviceDiff(runtime, {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      dryRun: true
    })
  );
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.design, {
    source: "image",
    imagePath: ".artemis/design/screens/home.png",
    resolved: ".artemis/design/screens/home.png",
    format: "png"
  });

  const missingPath = parseToolResult(
    await designDeviceDiff(runtime, { design: { source: "image" }, dryRun: true })
  );
  assert.match(missingPath.error, /需要 design\.imagePath/);

  const jpeg = parseToolResult(
    await designDeviceDiff(runtime, {
      design: { source: "image", imagePath: ".artemis/design/screens/home.jpg" },
      dryRun: true
    })
  );
  assert.equal(jpeg.ok, true, "dryRun 不读盘/不校验格式");

  const ambiguous = parseToolResult(
    await designDeviceDiff(runtime, {
      design: {
        source: "image",
        imagePath: ".artemis/design/screens/home.png",
        figmaUrl: "https://www.figma.com/design/DiffH8/File?node-id=1-2"
      },
      dryRun: true
    })
  );
  assert.match(ambiguous.error, /只能给/);

  const capturePng = async () => ({
    ok: true,
    bytes: toPng(createImage(390, 844)),
    serial: "S1",
    adb: { path: "/fake/adb", source: "env" }
  });
  const jpegActual = parseToolResult(
    await designDeviceDiff(
      runtime,
      { design: { source: "image", imagePath: ".artemis/design/screens/home.jpg" } },
      { capturePng }
    )
  );
  assert.match(jpegActual.error, /仅支持 PNG/);

  const missingActual = parseToolResult(
    await designDeviceDiff(
      runtime,
      { design: { source: "image", imagePath: ".artemis/design/screens/missing.png" } },
      { capturePng }
    )
  );
  assert.match(missingActual.error, /不存在/);
});

test("design_device_diff: 写盘失败时清理并报错", async () => {
  await withFigmaToken(async () => {
    const { dir, devicePath, devicePng, figma } = makeDiffProject({ fileKey: "DiffG7" });
    const proxy = new StubProxy({ running: true });
    stubDevice(proxy, devicePath);
    const { runtime } = await loadTestRuntime(dir, { proxy });
    const designDir = path.join(dir, ".artemis", "design");
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(path.join(designDir, "diffs"), "occupied", "utf-8");
    try {
      const result = await designDeviceDiff(
        runtime,
        {
          design: { figmaUrl: "https://www.figma.com/design/DiffG7/File?node-id=1-2" }
        },
        {
          capturePng: async () => ({ ok: true, bytes: devicePng, serial: "S1", adb: { path: "/fake/adb", source: "env" } })
        }
      );
      assert.equal(result.isError, true);
      assert.match(parseToolResult(result).error, /产物写入失败/);
      assert.ok(!fs.existsSync(path.join(designDir, "diffs", "report.json")));
    } finally {
      figma.restore();
    }
  });
});

function writeSemantics(root, regions, screenId = "home") {
  const dir = path.join(root, ".artemis", "design");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ui-semantics.json"),
    JSON.stringify({
      version: 1,
      screens: [{ screenId, screenName: "Home", viewport: { width: 390, height: 400, scale: 1 }, regions }]
    })
  );
}

function cropFixture() {
  const dir = makeTempProject({ config: baseConfig() });
  const design = createImage(390, 1000, [255, 255, 255, 255]);
  fillRect(design, 0, 0, 390, 600, [220, 38, 38, 255]);
  fillRect(design, 0, 600, 390, 400, [30, 64, 175, 255]);
  const designPath = path.join(dir, ".artemis", "design", "screens", "home.png");
  fs.mkdirSync(path.dirname(designPath), { recursive: true });
  fs.writeFileSync(designPath, toPng(design));

  const device = createImage(390, 400, [30, 64, 175, 255]);
  const devicePath = path.join(dir, "device.png");
  fs.writeFileSync(devicePath, toPng(device));
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  return { dir, designPath, device, devicePath, proxy };
}

test("design_device_diff: designCrop aligns lower section and reports crop", async () => {
  const fixture = cropFixture();
  const { runtime } = await loadTestRuntime(fixture.dir, { proxy: fixture.proxy });
  const capturePng = async () => ({
    ok: true,
    bytes: toPng(fixture.device),
    serial: "S1",
    adb: { path: "/fake/adb", source: "env" }
  });

  const cropped = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      alignment: { designCrop: { x: 0, y: 600, width: 390, height: 400 } },
      regions: "none",
      save: false
    },
    { capturePng }
  );
  const payload = parseToolResult(cropped);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.deepEqual(payload.alignment.designCrop, { x: 0, y: 600, width: 390, height: 400 });
  assert.equal(payload.alignment.scale, 1);
  assert.equal(payload.regions.length, 0);

  const uncropped = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      regions: "none",
      save: false
    },
    { capturePng }
  );
  assert.ok(parseToolResult(uncropped).regions.length > 0);
});

test("design_device_diff: invalid designCrop fails before writing artifacts", async () => {
  const fixture = cropFixture();
  const { runtime } = await loadTestRuntime(fixture.dir, { proxy: fixture.proxy });
  const result = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      alignment: { designCrop: { x: 0, y: 600, width: 390, height: 500 } }
    },
    {
      capturePng: async () => ({
        ok: true,
        bytes: toPng(fixture.device),
        serial: "S1",
        adb: { path: "/fake/adb", source: "env" }
      })
    }
  );
  assert.equal(result.isError, true);
  assert.match(parseToolResult(result).error, /designCrop/);
  assert.equal(fs.existsSync(path.join(fixture.dir, ".artemis", "design", "diffs")), false);
});

test("design_device_diff: ignoreDynamicRegions keeps invariant area compared", async () => {
  const fixture = cropFixture();
  const design = createImage(390, 1000, [255, 255, 255, 255]);
  fillRect(design, 0, 600, 390, 100, [30, 64, 175, 255]);
  fillRect(design, 0, 700, 390, 300, [22, 163, 74, 255]);
  fs.writeFileSync(fixture.designPath, toPng(design));
  const device = createImage(390, 400, [30, 64, 175, 255]);
  fillRect(device, 0, 0, 390, 100, [220, 38, 38, 255]);
  fillRect(device, 0, 100, 390, 300, [234, 179, 8, 255]);
  fs.writeFileSync(fixture.devicePath, toPng(device));
  writeSemantics(fixture.dir, [
    { id: "list", role: "product-list", isDynamic: true, designBbox: { x: 0, y: 700, width: 390, height: 300 } }
  ]);
  const { runtime } = await loadTestRuntime(fixture.dir, { proxy: fixture.proxy });
  const result = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      alignment: { designCrop: { x: 0, y: 600, width: 390, height: 400 } },
      ui: { screenId: "home", ignoreDynamicRegions: true },
      regions: "none",
      save: false
    },
    {
      capturePng: async () => ({
        ok: true,
        bytes: toPng(device),
        serial: "S1",
        adb: { path: "/fake/adb", source: "env" }
      })
    }
  );
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.deepEqual(payload.dynamicIgnoreRegions, [{ x: 0, y: 100, width: 390, height: 300 }]);
  assert.equal(payload.dynamicRegions.ignored, 1);
  assert.ok(payload.regions.length >= 1);
  assert.ok(payload.regions[0].bbox.y < 100, `y=${payload.regions[0].bbox.y}`);
});

test("design_device_diff: dynamic region without bbox is warned, expectedAssets is not ignored", async () => {
  const fixture = cropFixture();
  writeSemantics(fixture.dir, [
    { id: "no-bbox", role: "banner", isDynamic: true },
    {
      id: "hero",
      role: "banner",
      dynamicAssets: true,
      expectedAssets: 1,
      designBbox: { x: 0, y: 600, width: 390, height: 400 }
    }
  ]);
  const { runtime } = await loadTestRuntime(fixture.dir, { proxy: fixture.proxy });
  const result = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      alignment: { designCrop: { x: 0, y: 600, width: 390, height: 400 } },
      ui: { screenId: "home", ignoreDynamicRegions: true, expectedAssets: true },
      regions: "none",
      save: false
    },
    {
      capturePng: async () => ({
        ok: true,
        bytes: toPng(fixture.device),
        serial: "S1",
        adb: { path: "/fake/adb", source: "env" }
      })
    }
  );
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.dynamicRegions.ignored, 0);
  assert.equal(payload.dynamicRegions.skipped, 1);
  assert.ok(payload.warnings.some((warning) => warning.includes("dynamic-region-without-bbox")));
  assert.ok(payload.warnings.some((warning) => warning.includes("dynamic-assets-not-ignored")));

  const onlyAssets = await designDeviceDiff(
    runtime,
    {
      design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
      alignment: { designCrop: { x: 0, y: 600, width: 390, height: 400 } },
      ui: { screenId: "home", expectedAssets: true },
      regions: "none",
      save: false
    },
    {
      capturePng: async () => ({
        ok: true,
        bytes: toPng(fixture.device),
        serial: "S1",
        adb: { path: "/fake/adb", source: "env" }
      })
    }
  );
  const onlyAssetsPayload = parseToolResult(onlyAssets);
  assert.equal(onlyAssetsPayload.ok, true, JSON.stringify(onlyAssetsPayload));
  assert.equal(onlyAssetsPayload.dynamicIgnoreRegions.length, 0);
  assert.ok(onlyAssetsPayload.warnings.some((warning) => warning.includes("dynamic-assets-not-ignored")));
});

test("design_device_diff: dryRun reports crop and ui plan", async () => {
  const fixture = cropFixture();
  const { runtime } = await loadTestRuntime(fixture.dir, { proxy: fixture.proxy });
  const result = await designDeviceDiff(runtime, {
    design: { source: "image", imagePath: ".artemis/design/screens/home.png" },
    alignment: { designCrop: { x: 0, y: 600, width: 390, height: 400 } },
    ui: { ignoreDynamicRegions: true, expectedAssets: true },
    dryRun: true
  });
  const payload = parseToolResult(result);
  assert.equal(payload.dryRun, true);
  assert.deepEqual(payload.alignment.designCrop, { x: 0, y: 600, width: 390, height: 400 });
  assert.deepEqual(payload.ui, { ignoreDynamicRegions: true, expectedAssets: true });
});
