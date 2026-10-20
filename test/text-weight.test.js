import assert from "node:assert/strict";
import test from "node:test";

import { measureTextWeight } from "../dist/ui/text-weight.js";
import { createImage, fillRect } from "./helpers.js";

function bars({ stroke = 1, dark = false, shift = 0, height = 40, barHeight = 24, y = 8 } = {}) {
  const image = createImage(120, height, dark ? [0, 0, 0, 255] : [255, 255, 255, 255]);
  const ink = dark ? [255, 255, 255, 255] : [0, 0, 0, 255];
  for (let index = 0; index < 6; index += 1) {
    fillRect(image, 10 + index * 18 + shift, y, stroke, barHeight, ink);
  }
  return image;
}

test("text weight: bold strokes are heavier than regular", () => {
  const result = measureTextWeight({
    design: bars({ stroke: 1 }),
    device: bars({ stroke: 3 }),
    designWeight: 400,
    textPixelHeight: 40,
    sourceFormat: "png",
    lossless: true,
    localization: "baseline-bbox"
  });
  assert.equal(result.status, "checked", result.reason);
  assert.equal(result.weightHint, "heavier");
  assert.ok((result.delta ?? 0) > 0.18);
  assert.equal(result.designWeight, 400);
  assert.equal(result.experimental, true);
});

test("text weight: same regular strokes are similar", () => {
  const result = measureTextWeight({
    design: bars({ stroke: 1 }),
    device: bars({ stroke: 1 }),
    textPixelHeight: 40,
    sourceFormat: "png",
    lossless: true
  });
  assert.equal(result.status, "checked", result.reason);
  assert.equal(result.weightHint, "similar");
  assert.ok(Math.abs(result.delta ?? 1) < 0.08);
});

test("text weight: shifted content is unverified, not heavier", () => {
  const result = measureTextWeight({
    design: bars({ stroke: 1 }),
    device: bars({ stroke: 3, shift: 40 }),
    textPixelHeight: 40,
    sourceFormat: "png",
    lossless: true
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.reason, "content-or-wrap-mismatch");
});

test("text weight: dark background with light text is supported", () => {
  const result = measureTextWeight({
    design: bars({ stroke: 1, dark: true }),
    device: bars({ stroke: 3, dark: true }),
    textPixelHeight: 40,
    sourceFormat: "png",
    lossless: true
  });
  assert.equal(result.status, "checked", result.reason);
  assert.equal(result.weightHint, "heavier");
});

test("text weight: tiny text and JPEG sources are unverified", () => {
  const tiny = measureTextWeight({
    design: bars({ stroke: 1, height: 12, barHeight: 6, y: 3 }),
    device: bars({ stroke: 3, height: 12, barHeight: 6, y: 3 }),
    textPixelHeight: 8,
    sourceFormat: "png",
    lossless: true
  });
  assert.equal(tiny.status, "unverified");
  assert.equal(tiny.reason, "text-too-small");

  const jpeg = measureTextWeight({
    design: bars({ stroke: 1 }),
    device: bars({ stroke: 3 }),
    textPixelHeight: 40,
    sourceFormat: "jpeg",
    lossless: false
  });
  assert.equal(jpeg.status, "unverified");
  assert.equal(jpeg.reason, "lossy-source");
});
