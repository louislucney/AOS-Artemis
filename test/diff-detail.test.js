import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDetailPair,
  extractDetailPair,
  mapRegionToDeviceRect,
  proposeDetailRegions,
  resolveDetailGeometry,
  runDetailDiff,
  scaleDetailNodes
} from "../dist/diff/detail.js";
import { decodeImage } from "../dist/diff/engine.js";
import { createImage, fillRect } from "./helpers.js";

function node(overrides) {
  return {
    id: "n",
    name: "node",
    type: "RECTANGLE",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    depth: 1,
    ...overrides
  };
}

const SCREEN = { designWidth: 390, designHeight: 844 };

test("propose: 节点过滤——整屏背景与零面积剔除、细线与文本保留、padding 外扩", () => {
  const background = node({ id: "bg", name: "bg", x: 0, y: 0, width: 390, height: 844, depth: 0 });
  const divider = node({ id: "line", name: "Divider", type: "RECTANGLE", x: 24, y: 200, width: 300, height: 3, depth: 2 });
  const text = node({ id: "t", name: "Label", type: "TEXT", x: 40, y: 300, width: 100, height: 20, depth: 2 });
  const zero = node({ id: "z", name: "zero", x: 10, y: 10, width: 0, height: 12, depth: 2 });
  const result = proposeDetailRegions({
    ...SCREEN,
    nodes: [background, divider, text, zero],
    screenRegionBboxes: [],
    mode: "nodes",
    maxRegions: 20
  });
  assert.equal(result.regions.length, 2, JSON.stringify(result.regions));
  assert.equal(result.tilesUsed, false);
  assert.equal(result.truncated, false);
  const lineRegion = result.regions.find((r) => r.name === "Divider");
  assert.deepEqual(lineRegion.bbox, { x: 8, y: 184, width: 332, height: 35 });
  const textRegion = result.regions.find((r) => r.name === "Label");
  assert.deepEqual(textRegion.bbox, { x: 24, y: 284, width: 132, height: 52 });
  assert.ok(result.regions.every((r) => r.source === "node" && Number.isInteger(r.idx)));
});

test("propose: 相邻节点合并（外扩后间隙 ≤12）、远距节点不合并", () => {
  const a = node({ id: "a", name: "A", x: 40, y: 100, width: 100, height: 20, depth: 2 });
  const b = node({ id: "b", name: "B", x: 170, y: 100, width: 100, height: 20, depth: 2 });
  const c = node({ id: "c", name: "C", x: 40, y: 400, width: 60, height: 20, depth: 2 });
  const d = node({ id: "d", name: "D", x: 240, y: 400, width: 60, height: 20, depth: 2 });
  const result = proposeDetailRegions({ ...SCREEN, nodes: [a, b, c, d], screenRegionBboxes: [], mode: "nodes", maxRegions: 20 });
  assert.equal(result.regions.length, 3, JSON.stringify(result.regions));
  const merged = result.regions.find((r) => r.bbox.y < 200);
  assert.deepEqual(merged.bbox, { x: 24, y: 84, width: 262, height: 52 });
  const tail = result.regions.filter((r) => r.bbox.y > 200).map((r) => r.bbox.x);
  assert.deepEqual(tail.sort((l, r) => l - r), [24, 224]);
});

test("propose: 截断优先级——diff 命中优先、其后小面积优先", () => {
  const diffs = [
    { x: 0, y: 0, width: 200, height: 200 },
    { x: 0, y: 300, width: 150, height: 150 }
  ];
  const nodes = [
    node({ id: "n1", name: "n1", x: 10, y: 500, width: 100, height: 20, depth: 2 }),
    node({ id: "n2", name: "n2", x: 10, y: 570, width: 50, height: 20, depth: 2 }),
    node({ id: "n3", name: "n3", x: 10, y: 640, width: 25, height: 20, depth: 2 }),
    node({ id: "n4", name: "n4", x: 10, y: 710, width: 5, height: 20, depth: 2 })
  ];
  const result = proposeDetailRegions({ ...SCREEN, nodes, screenRegionBboxes: diffs, mode: "auto", maxRegions: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.regions.length, 3);
  assert.equal(result.regions.filter((r) => r.source === "diff").length, 2);
  const keptNode = result.regions.find((r) => r.source === "node");
  assert.equal(keptNode.name, "n4");
  assert.deepEqual(result.regions.map((r) => r.idx), [1, 2, 3]);
});

test("propose: tiles 带重叠——接缝特征被某个 tile 完整包含", () => {
  const result = proposeDetailRegions({
    designWidth: 1600,
    designHeight: 1600,
    nodes: [],
    screenRegionBboxes: [],
    mode: "tiles",
    maxRegions: 50,
    tileSize: 768,
    tileOverlap: 128
  });
  assert.equal(result.tilesUsed, true);
  const containing = result.regions.filter(
    (r) => r.bbox.x <= 766 && r.bbox.x + r.bbox.width >= 769 && r.bbox.y <= 700 && r.bbox.y + r.bbox.height >= 703
  );
  assert.ok(containing.length >= 1, JSON.stringify(result.regions));
  assert.ok(result.regions.every((r) => r.bbox.width <= 768 && r.bbox.height <= 768));
});

test("propose: auto 分支——有节点=节点∪diff；无节点=tiles∪diff", () => {
  const diff = { x: 5, y: 5, width: 40, height: 40 };
  const withNodes = proposeDetailRegions({
    ...SCREEN,
    nodes: [node({ id: "a", name: "A", x: 100, y: 100, width: 50, height: 20, depth: 2 })],
    screenRegionBboxes: [diff],
    mode: "auto",
    maxRegions: 20
  });
  assert.equal(withNodes.tilesUsed, false);
  assert.deepEqual(withNodes.regions.map((r) => r.source).sort(), ["diff", "node"]);
  const noNodes = proposeDetailRegions({ ...SCREEN, nodes: [], screenRegionBboxes: [diff], mode: "auto", maxRegions: 20 });
  assert.equal(noNodes.tilesUsed, true);
  assert.ok(noNodes.regions.some((r) => r.source === "tile"));
  assert.ok(noNodes.regions.some((r) => r.source === "diff"));
});

test("propose: manual 原样转区域——排序、idx 递增、超限截断", () => {
  const boxes = [
    { x: 10, y: 400, width: 50, height: 20 },
    { x: 10, y: 100, width: 50, height: 20 },
    { x: 10, y: 700, width: 50, height: 20 }
  ];
  const result = proposeDetailRegions({ ...SCREEN, nodes: [], screenRegionBboxes: [], mode: boxes, maxRegions: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.regions.map((r) => r.idx), [1, 2]);
  assert.deepEqual(result.regions.map((r) => r.bbox.y), [100, 400]);
  assert.ok(result.regions.every((r) => r.source === "manual" && r.bbox.width === 50));
});

test("propose: mode none → 空结果", () => {
  const result = proposeDetailRegions({ ...SCREEN, nodes: [node({ id: "a" })], screenRegionBboxes: [], mode: "none", maxRegions: 20 });
  assert.deepEqual(result, { regions: [], truncated: false, tilesUsed: false });
});

test("propose: 容器剔除（更深节点覆盖 ≥90% 自身面积）、子节点合并、确定性", () => {
  const parent = node({ id: "card", name: "Card", x: 24, y: 24, width: 300, height: 200, depth: 1 });
  const c1 = node({ id: "c1", name: "c1", x: 24, y: 24, width: 300, height: 95, depth: 2 });
  const c2 = node({ id: "c2", name: "c2", x: 24, y: 129, width: 300, height: 95, depth: 2 });
  const input = { ...SCREEN, nodes: [parent, c1, c2], screenRegionBboxes: [], mode: "nodes", maxRegions: 20 };
  const first = proposeDetailRegions(input);
  const second = proposeDetailRegions(input);
  assert.deepEqual(first, second);
  assert.ok(!first.regions.some((r) => r.name === "Card"), JSON.stringify(first.regions));
  assert.equal(first.regions.length, 1, JSON.stringify(first.regions));
  assert.deepEqual(first.regions[0].bbox, { x: 8, y: 8, width: 332, height: 232 });
});

test("scaleDetailNodes: 几何 ×factor，其余字段保留，输入不改", () => {
  const n = node({ id: "x", name: "X", x: 10, y: 20, width: 30, height: 40, depth: 2, text: "hi" });
  const original = structuredClone(n);
  const scaled = scaleDetailNodes([n], 3);
  assert.deepEqual(scaled[0], { ...original, x: 30, y: 60, width: 90, height: 120 });
  assert.deepEqual(n, original);
});

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

test("detail 几何: ratio=设备裁剪宽/设计宽，offset=insets 左上", () => {
  const geometry = resolveDetailGeometry({ width: 390, height: 844 }, { width: 1170, height: 2532 }, { top: 100, right: 0, bottom: 0, left: 0 });
  assert.equal(geometry.ratio, 3);
  assert.deepEqual(geometry.offset, { x: 0, y: 100 });
  const oneToOne = resolveDetailGeometry({ width: 390, height: 844 }, { width: 390, height: 844 }, NO_INSETS);
  assert.equal(oneToOne.ratio, 1);
  assert.deepEqual(oneToOne.offset, { x: 0, y: 0 });
});

test("detail 映射: 区域→设备矩形（含 insets）、越界钳制与不可见判定", () => {
  const geometry = resolveDetailGeometry({ width: 390, height: 844 }, { width: 1170, height: 2532 }, { top: 100, right: 0, bottom: 0, left: 0 });
  const device = { width: 1170, height: 2532 };
  const mapped = mapRegionToDeviceRect({ x: 40, y: 80, width: 120, height: 60 }, geometry, device);
  assert.deepEqual(mapped.bbox, { x: 120, y: 340, width: 360, height: 180 });
  assert.equal(mapped.clipped, false);
  assert.equal(mapped.visible, true);

  const edge = mapRegionToDeviceRect({ x: 380, y: 800, width: 40, height: 30 }, geometry, device);
  assert.equal(edge.clipped, true);
  assert.equal(edge.visible, true);
  assert.ok(edge.bbox.x + edge.bbox.width <= device.width && edge.bbox.y + edge.bbox.height <= device.height, JSON.stringify(edge.bbox));

  const gone = mapRegionToDeviceRect({ x: 390, y: 800, width: 40, height: 30 }, geometry, device);
  assert.equal(gone.visible, false);
});

test("detail 配对: 尺寸对齐、升/降采样标注、像素位置保真、越界返回 null", () => {
  const design = createImage(100, 100);
  const device = createImage(300, 300);
  fillRect(device, 0, 0, 150, 300, [255, 0, 0, 255]);
  fillRect(device, 150, 0, 150, 300, [0, 0, 255, 255]);
  const geometry = resolveDetailGeometry({ width: 100, height: 100 }, { width: 300, height: 300 }, NO_INSETS);
  const px = (img, x, y) => {
    const position = (y * img.width + x) * 4;
    return [img.data[position], img.data[position + 1], img.data[position + 2]];
  };

  const left = extractDetailPair({ design, device, region: { x: 0, y: 0, width: 50, height: 100 }, geometry });
  assert.ok(left);
  assert.equal(left.device.width, 150);
  assert.equal(left.device.height, 300);
  assert.equal(left.design.width, 150);
  assert.equal(left.design.height, 300);
  assert.equal(left.upscaled, true);
  assert.equal(left.designDownscaled, false);
  assert.equal(left.clipped, false);
  assert.deepEqual(px(left.device, 10, 10), [255, 0, 0]);
  assert.deepEqual(px(left.design, 10, 10), [255, 255, 255]);

  const right = extractDetailPair({ design, device, region: { x: 50, y: 0, width: 50, height: 100 }, geometry });
  assert.deepEqual(px(right.device, 10, 10), [0, 0, 255]);
  assert.deepEqual(px(right.design, 10, 10), [255, 255, 255]);

  const down = extractDetailPair({
    design: createImage(600, 600),
    device: createImage(300, 300),
    region: { x: 0, y: 0, width: 600, height: 600 },
    geometry: resolveDetailGeometry({ width: 600, height: 600 }, { width: 300, height: 300 }, NO_INSETS)
  });
  assert.equal(down.design.width, 300);
  assert.equal(down.designDownscaled, true);
  assert.equal(down.upscaled, false);

  const near = extractDetailPair({
    design: createImage(601, 100),
    device: createImage(600, 100),
    region: { x: 0, y: 0, width: 601, height: 100 },
    geometry: resolveDetailGeometry({ width: 601, height: 100 }, { width: 600, height: 100 }, NO_INSETS)
  });
  assert.equal(near.design.width, 600);
  assert.equal(near.upscaled, false);
  assert.equal(near.designDownscaled, false);

  assert.equal(extractDetailPair({ design, device, region: { x: 100, y: 0, width: 40, height: 100 }, geometry }), null);
});

function textBlock(width = 200, height = 80) {
  const image = createImage(width, height);
  fillRect(image, 40, 20, 60, 30, [30, 30, 30, 255]);
  return image;
}

test("detail 判定: 四类细节差异在细节档全部命中、相同内容不命中", () => {
  const device = textBlock();
  const bold = textBlock();
  fillRect(bold, 39, 19, 62, 32, [30, 30, 30, 255]);
  assert.equal(runDetailDiff(bold, device).hasDiff, true);

  const missingDevice = textBlock();
  fillRect(missingDevice, 120, 30, 30, 20, [160, 160, 160, 255]);
  assert.equal(runDetailDiff(textBlock(), missingDevice).hasDiff, true);

  const shiftDesign = createImage(200, 80);
  fillRect(shiftDesign, 50, 20, 60, 30, [30, 30, 30, 255]);
  const shiftDevice = createImage(200, 80);
  fillRect(shiftDevice, 40, 20, 60, 30, [30, 30, 30, 255]);
  assert.equal(runDetailDiff(shiftDesign, shiftDevice).hasDiff, true);

  const lineDevice = textBlock();
  fillRect(lineDevice, 20, 60, 160, 3, [232, 232, 232, 255]);
  assert.equal(runDetailDiff(textBlock(), lineDevice).hasDiff, true);

  assert.equal(runDetailDiff(textBlock(), textBlock()).hasDiff, false);
});

test("detail 判定: 降级档行为锁定——细线不命中、加粗仍命中", () => {
  const device = textBlock();
  const lineDevice = textBlock();
  fillRect(lineDevice, 20, 60, 160, 3, [232, 232, 232, 255]);
  assert.equal(runDetailDiff(textBlock(), lineDevice, { degraded: true }).hasDiff, false);

  const bold = textBlock();
  fillRect(bold, 39, 19, 62, 32, [30, 30, 30, 255]);
  assert.equal(runDetailDiff(bold, device, { degraded: true }).hasDiff, true);
});

test("detail 判定: 超 maxEdge 的宽裁剪不做降采样（低对比细线在原生栅格可检出）", () => {
  const width = 3000;
  const device = createImage(width, 100);
  const design = createImage(width, 100);
  fillRect(device, 0, 50, width, 1, [232, 232, 232, 255]);
  const result = runDetailDiff(design, device);
  assert.equal(result.hasDiff, true, JSON.stringify(result.clusters));
  assert.ok(result.clusters.every((cluster) => cluster.bbox.x + cluster.bbox.width <= width && cluster.bbox.y + cluster.bbox.height <= 100));
});

test("composeDetailPair: 左 device 右 design、gap 白、zoom 钳制、确定性", () => {
  const device = createImage(200, 80);
  fillRect(device, 0, 0, 200, 80, [255, 0, 0, 255]);
  const design = createImage(200, 80);
  fillRect(design, 0, 0, 200, 80, [0, 0, 255, 255]);
  const pair = composeDetailPair(device, design);
  assert.equal(pair.scale, 2);
  assert.equal(pair.width, 200 * 2 + 24 + 200 * 2);
  assert.equal(pair.height, 160);
  const decoded = decodeImage(new Uint8Array(pair.png));
  const px = (image, x, y) => {
    const position = (y * image.width + x) * 4;
    return [image.data[position], image.data[position + 1], image.data[position + 2]];
  };
  assert.deepEqual(px(decoded, 10, 10), [255, 0, 0]);
  assert.deepEqual(px(decoded, decoded.width - 10, 10), [0, 0, 255]);
  assert.deepEqual(px(decoded, 400 + 12, 40), [255, 255, 255]);

  const wide = composeDetailPair(createImage(800, 50), createImage(800, 50));
  assert.equal(wide.scale, 0.8);
  assert.equal(wide.width, 640 + 24 + 640);

  const tall = composeDetailPair(createImage(100, 900), createImage(100, 900));
  assert.ok(Math.abs(tall.scale - 1200 / 900) < 1e-9);
  assert.equal(tall.height, 1200);

  assert.ok(composeDetailPair(device, design).png.equals(pair.png));
});
