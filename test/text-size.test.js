import assert from "node:assert/strict";
import test from "node:test";

import { estimateTextSize } from "../dist/ui/text-size.js";

function image(width, height, bands, background = [255, 255, 255], ink = [0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const inBand = bands.some((band) => y >= band.start && y < band.end);
    const color = inBand ? ink : background;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test("estimateTextSize: 两行文本取行高中位数 × 0.7", () => {
  const result = estimateTextSize(
    image(100, 60, [
      { start: 5, end: 15 },
      { start: 30, end: 50 }
    ])
  );
  assert.equal(result.lineCount, 2);
  assert.equal(result.estimatedLineHeightPx, 15);
  assert.equal(result.estimatedFontSizePx, 11);
  assert.equal(result.confidence, "medium");
  assert.equal(result.reportOnly, true);
  assert.equal(result.method, "line-height-median");
});

test("estimateTextSize: 单行给 low；无损也最多 low", () => {
  const result = estimateTextSize(image(100, 40, [{ start: 8, end: 18 }]));
  assert.equal(result.lineCount, 1);
  assert.equal(result.estimatedLineHeightPx, 10);
  assert.equal(result.estimatedFontSizePx, 7);
  assert.equal(result.confidence, "low");
});

test("estimateTextSize: 有损来源降 low 并标 reason", () => {
  const result = estimateTextSize(
    image(100, 60, [
      { start: 5, end: 15 },
      { start: 30, end: 50 }
    ]),
    { lossless: false }
  );
  assert.equal(result.confidence, "low");
  assert.equal(result.reason, "lossy-source");
});

test("estimateTextSize: 无文字行/过小图片返回空估计", () => {
  const blank = estimateTextSize(image(100, 60, []));
  assert.equal(blank.estimatedFontSizePx, null);
  assert.equal(blank.reason, "no-text-lines");

  const tiny = estimateTextSize(image(5, 5, [{ start: 1, end: 4 }]));
  assert.equal(tiny.estimatedFontSizePx, null);
  assert.equal(tiny.reason, "image-too-small");
});

test("estimateTextSize: 深色背景也能估算", () => {
  const result = estimateTextSize(
    image(
      120,
      80,
      [
        { start: 10, end: 22 },
        { start: 40, end: 58 }
      ],
      [0, 0, 0],
      [255, 255, 255]
    )
  );
  assert.equal(result.lineCount, 2);
  assert.equal(result.estimatedLineHeightPx, 15);
});
