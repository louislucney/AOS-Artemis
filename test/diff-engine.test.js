import assert from "node:assert/strict";
import test from "node:test";

import { PNG } from "pngjs";

import { renderAnnotatedPng } from "../dist/diff/annotate.js";
import { decodeImage, diffScreens } from "../dist/diff/engine.js";
import { createImage, fillRect, toJpeg, toPng } from "./helpers.js";

function sampleDesign() {
  const design = createImage(400, 800);
  fillRect(design, 24, 40, 200, 40, [30, 64, 175, 255]);
  fillRect(design, 24, 120, 352, 120, [229, 231, 235, 255]);
  fillRect(design, 24, 700, 352, 60, [17, 24, 39, 255]);
  return design;
}

test("decodeImage: PNG 与 JPEG 均按尺寸解码为 RGBA", () => {
  const image = sampleDesign();
  const fromPng = decodeImage(toPng(image));
  assert.equal(fromPng.width, 400);
  assert.equal(fromPng.height, 800);
  assert.equal(fromPng.data.length, 400 * 800 * 4);

  const fromJpeg = decodeImage(toJpeg(image));
  assert.equal(fromJpeg.width, 400);
  assert.equal(fromJpeg.height, 800);
  assert.equal(fromJpeg.data.length, 400 * 800 * 4);
});

test("diffScreens: 相同内容经 JPEG 有损后不产生误报区域", () => {
  const design = sampleDesign();
  const device = decodeImage(toJpeg(design, 80));
  const result = diffScreens(design, device);
  assert.equal(result.regions.length, 0, JSON.stringify(result.regions));
});

test("diffScreens: 注入色块差异 → 区域位置/比例正确", () => {
  const design = sampleDesign();
  const deviceImage = sampleDesign();
  fillRect(deviceImage, 200, 300, 80, 100, [220, 38, 38, 255]);
  const device = decodeImage(toJpeg(deviceImage, 90));

  const result = diffScreens(design, device);
  assert.ok(result.regions.length >= 1, "expected a diff region");
  const region = result.regions[0];
  assert.ok(Math.abs(region.bbox.x - 200) <= 8, `x=${region.bbox.x}`);
  assert.ok(Math.abs(region.bbox.y - 300) <= 8, `y=${region.bbox.y}`);
  assert.ok(region.bbox.width >= 60 && region.bbox.width <= 100, `w=${region.bbox.width}`);
  assert.ok(region.bbox.height >= 80 && region.bbox.height <= 120, `h=${region.bbox.height}`);
  assert.ok(region.pixelDiffRatio > 0.8, `ratio=${region.pixelDiffRatio}`);
  assert.equal(region.category, "pixel");
});

test("diffScreens: ignoreRegions 屏蔽区域不产生差异且被记录", () => {
  const design = sampleDesign();
  const deviceImage = sampleDesign();
  fillRect(deviceImage, 200, 300, 80, 100, [220, 38, 38, 255]);
  const device = decodeImage(toJpeg(deviceImage, 90));

  const result = diffScreens(design, device, {
    ignoreRegions: [{ x: 190, y: 290, width: 100, height: 120 }]
  });
  assert.equal(result.regions.length, 0, JSON.stringify(result.regions));
  assert.deepEqual(result.ignoredRegions, [{ x: 190, y: 290, width: 100, height: 120 }]);
});

test("diffScreens: 同输入两次运行结果逐字节一致", () => {
  const design = sampleDesign();
  const deviceImage = sampleDesign();
  fillRect(deviceImage, 200, 300, 80, 100, [220, 38, 38, 255]);
  const device = decodeImage(toJpeg(deviceImage, 90));
  const first = JSON.stringify(diffScreens(design, device));
  const second = JSON.stringify(diffScreens(design, device));
  assert.equal(first, second);
});

test("diffScreens: 大图降采样且区域坐标还原到设计坐标", () => {
  const design = createImage(2000, 1000);
  const deviceImage = createImage(2000, 1000);
  fillRect(deviceImage, 1400, 400, 200, 200, [220, 38, 38, 255]);
  const device = decodeImage(toJpeg(deviceImage, 90));

  const result = diffScreens(design, device, { maxEdge: 1000 });
  assert.equal(result.alignment.downsampledTo, 1000);
  assert.ok(result.regions.length >= 1);
  const region = result.regions[0];
  assert.ok(Math.abs(region.bbox.x - 1400) <= 16, `x=${region.bbox.x}`);
  assert.ok(Math.abs(region.bbox.y - 400) <= 16, `y=${region.bbox.y}`);
});

test("diffScreens: 小噪点被最小面积过滤", () => {
  const design = createImage(400, 800);
  const deviceImage = createImage(400, 800);
  fillRect(deviceImage, 100, 100, 3, 3, [220, 38, 38, 255]);
  const device = decodeImage(toJpeg(deviceImage, 95));
  const result = diffScreens(design, device);
  assert.equal(result.regions.length, 0);
});

test("diffScreens: insets 裁剪设备后内容对齐", () => {
  const design = createImage(100, 200, [255, 255, 255, 255]);
  fillRect(design, 10, 50, 80, 100, [30, 64, 175, 255]);
  const deviceImage = createImage(100, 260, [0, 0, 0, 255]);
  fillRect(deviceImage, 0, 30, 100, 200, [255, 255, 255, 255]);
  fillRect(deviceImage, 10, 80, 80, 100, [30, 64, 175, 255]);
  const device = decodeImage(toJpeg(deviceImage, 95));

  const result = diffScreens(design, device, { insets: { top: 30, bottom: 30 } });
  assert.equal(result.regions.length, 0, JSON.stringify(result.regions));
  assert.equal(result.alignment.insets.top, 30);
  assert.equal(result.alignment.insets.bottom, 30);
});

test("renderAnnotatedPng: 输出 PNG 且差异框有标注色", () => {
  const design = sampleDesign();
  const annotated = renderAnnotatedPng(design, [
    { bbox: { x: 200, y: 300, width: 80, height: 100 }, category: "pixel", severity: "blocker", pixelDiffRatio: 1 }
  ]);
  assert.deepEqual([...annotated.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const decoded = PNG.sync.read(annotated);
  assert.equal(decoded.width, 400);
  assert.equal(decoded.height, 800);
  const index = (300 * decoded.width + 200) * 4;
  assert.ok(decoded.data[index] > 200 && decoded.data[index + 1] < 80, `pixel=${[...decoded.data.subarray(index, index + 4)]}`);
});
