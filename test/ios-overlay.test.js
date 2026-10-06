import assert from "node:assert/strict";
import test from "node:test";

import { PNG } from "pngjs";

import { renderActionOverlay } from "../dist/ios/overlay.js";

function blankPng(width, height) {
  return PNG.sync.write(new PNG({ width, height }));
}

test("renderActionOverlay: 逻辑点乘以 scale 落到像素坐标", () => {
  const out = renderActionOverlay(blankPng(100, 200), "tap", { x: 10, y: 20 }, 2);
  assert.ok(out);
  const decoded = PNG.sync.read(out);
  const onRing = (decoded.width * (40 - 32) + 20) << 2;
  assert.equal(decoded.data[onRing], 255);
  assert.equal(decoded.data[onRing + 1], 0);
  assert.equal(decoded.data[onRing + 3], 255);
  const center = (decoded.width * 40 + 20) << 2;
  assert.equal(decoded.data[center + 3], 0);
  const unscaled = (decoded.width * 20 + 10) << 2;
  assert.equal(decoded.data[unscaled + 3], 0);
});

test("renderActionOverlay: 无坐标动作与缺失 scale 显式返回 null", () => {
  const bytes = blankPng(8, 8);
  assert.equal(renderActionOverlay(bytes, "fail", { reason: "x" }, 1), null);
  assert.equal(renderActionOverlay(bytes, "tap", { x: 1, y: 1 }, null), null);
  assert.ok(renderActionOverlay(bytes, "swipe", { x1: 1, y1: 1, x2: 3, y2: 3 }, 1));
  assert.ok(renderActionOverlay(bytes, "text", { text: "a", x: 2, y: 2 }, 1));
});
