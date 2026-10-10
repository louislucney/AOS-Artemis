import assert from "node:assert/strict";
import test from "node:test";

import { annotateOcclusionWarnings, computeOcclusions } from "../dist/ios/occlusion.js";

const SCREEN_AREA = 400 * 800;

function item(x, y, width, height, lineIndex, type = "Button") {
  return {
    rect: { x, y, width, height },
    type,
    hasText: true,
    lineIndex
  };
}

test("遮挡：≥50% 重叠输出 WARNING，低于阈值不输出", () => {
  const items = [
    item(0, 0, 100, 100, 1),
    item(80, 80, 100, 100, 2),
    item(0, 0, 100, 100, 3)
  ];
  const result = computeOcclusions(items, SCREEN_AREA);
  const lines = annotateOcclusionWarnings(["[1] a", "[2] b", "[3] c"], result);
  assert.match(lines[0], /WARNING: may overlap with \[3\], possible occlusion/);
  assert.doesNotMatch(lines[1], /WARNING/);
  assert.match(lines[2], /may overlap with \[1\]/);
});

test("遮挡：同心父子包含被排除，偏移的包含输出 WARNING", () => {
  const concentric = computeOcclusions(
    [item(0, 0, 200, 200, 1, "Window"), item(50, 50, 100, 100, 2)],
    SCREEN_AREA
  );
  assert.equal(concentric.perLine.size, 0);
  assert.equal(concentric.globalLine, null);

  const offset = computeOcclusions(
    [item(0, 0, 200, 100, 1, "Window"), item(0, 0, 40, 40, 2)],
    SCREEN_AREA
  );
  assert.ok(offset.perLine.get(1)?.includes("[2]"));
  assert.ok(offset.perLine.get(2)?.includes("[1]"));
});

test("遮挡：主导遮挡层合并为单条全局告警并抑制逐元素告警", () => {
  const items = [
    item(10, 420, 100, 40, 1, "TextField"),
    item(10, 470, 100, 40, 2, "TextField"),
    item(10, 520, 100, 40, 3, "TextField"),
    { rect: { x: 0, y: 400, width: 400, height: 350 }, type: "Keyboard", hasText: false, lineIndex: null }
  ];
  const result = computeOcclusions(items, SCREEN_AREA);
  assert.match(result.globalLine ?? "", /大面积遮挡层（Keyboard/);
  assert.equal(result.perLine.size, 0);
  const lines = annotateOcclusionWarnings(["[1] a", "[2] b", "[3] c"], result);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /大面积遮挡层/);
});

test("遮挡：全屏容器节点不参与告警（真机观察到的噪声源）", () => {
  const items = [
    item(0, 0, 400, 800, 1, "Application"),
    item(0, 100, 120, 40, 2, "Button"),
    item(0, 160, 120, 40, 3, "Button")
  ];
  const result = computeOcclusions(items, SCREEN_AREA);
  assert.equal(result.perLine.size, 0);
  assert.equal(result.globalLine, null);
});

test("遮挡：逐元素告警总量封顶（最多 5 对）", () => {
  const items = Array.from({ length: 8 }, (_, index) => item(0, 0, 100, 100, index + 1));
  const result = computeOcclusions(items, SCREEN_AREA);
  assert.equal(result.perLine.size, 6);
  assert.match(result.perLine.get(1) ?? "", /\(\+3 more\)/);
  assert.equal(result.globalLine, null);
});
