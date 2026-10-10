import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPerceptionPrompt,
  fuseVisionElements,
  parseVisionElements
} from "../dist/ios/perception.js";

test("parseVisionElements：数组/围栏解析，垃圾与非法项处理", () => {
  const fenced = '```json\n[{"text":"搜索","bounds_px":[10,20,30,40]}]\n```';
  const parsed = parseVisionElements(fenced);
  assert.equal(parsed.elements.length, 1);
  assert.deepEqual(parsed.elements[0].boundsPx, [10, 20, 30, 40]);

  assert.equal(parseVisionElements("不是 JSON"), null);
  const wrongShape = parseVisionElements("[1,2,3]");
  assert.equal(wrongShape.elements.length, 0);
  assert.equal(wrongShape.dropped, 3);

  const mixed = parseVisionElements(
    JSON.stringify([
      { text: "有效", bounds_px: [0, 0, 10, 10] },
      { text: "", bounds_px: [0, 0, 10, 10] },
      { text: "缺边界" },
      "junk"
    ])
  );
  assert.equal(mixed.elements.length, 1);
  assert.equal(mixed.dropped, 3);
});

test("fuseVisionElements：像素→pt、Center、去重、越界丢弃与配额", () => {
  const fused = fuseVisionElements({
    elements: [
      { text: "搜索", boundsPx: [100, 200, 140, 240] },
      { text: "返回", boundsPx: [0, 0, 40, 40] }
    ],
    scale: 2,
    width: 200,
    height: 400,
    existing: [{ label: "", value: "" }]
  });
  assert.equal(fused.lines.length, 2);
  assert.match(
    fused.lines[0],
    /\[V1\] \(模型视觉，可能有误\) OCR Text: '搜索' \| Center: \(60,110\) \| Bounds: \[50,100\]\[70,120\]/
  );

  const deduped = fuseVisionElements({
    elements: [{ text: "搜索", boundsPx: [0, 0, 10, 10] }],
    scale: 1,
    width: 100,
    height: 100,
    existing: [{ label: "搜索框", value: "" }]
  });
  assert.equal(deduped.lines.length, 0);
  assert.equal(deduped.droppedDuplicate, 1);

  const outOfRange = fuseVisionElements({
    elements: [{ text: "幽灵", boundsPx: [500, 500, 520, 520] }],
    scale: 1,
    width: 100,
    height: 100,
    existing: []
  });
  assert.equal(outOfRange.lines.length, 0);
  assert.equal(outOfRange.droppedInvalid, 1);

  const overflow = fuseVisionElements({
    elements: [
      { text: "A", boundsPx: [0, 0, 10, 10] },
      { text: "B", boundsPx: [0, 0, 10, 10] }
    ],
    scale: 1,
    width: 100,
    height: 100,
    existing: [],
    maxLines: 1
  });
  assert.equal(overflow.lines.length, 1);
  assert.equal(overflow.droppedOverflow, 1);

  const noScale = fuseVisionElements({
    elements: [{ text: "A", boundsPx: [0, 0, 10, 10] }],
    scale: null,
    width: 100,
    height: 100,
    existing: []
  });
  assert.equal(noScale.lines.length, 0);
  assert.equal(noScale.droppedNoScale, 1);
});

test("buildPerceptionPrompt：包含像素尺寸与 JSON 约定", () => {
  const prompt = buildPerceptionPrompt(804, 1748);
  assert.match(prompt, /804x1748 px/);
  assert.match(prompt, /bounds_px/);
  assert.match(prompt, /只输出 JSON 数组/);
});
