import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { encode as encodeJpeg } from "jpeg-js";

import { decodeImage, diffScreens, resize } from "../dist/diff/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, "fixtures", "diff-bench");

function loadFixture() {
  const truth = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "ground-truth.json"), "utf-8"));
  const design = decodeImage(fs.readFileSync(path.join(FIXTURE_DIR, "design.png")));
  const device = decodeImage(fs.readFileSync(path.join(FIXTURE_DIR, "device.jpg")));
  assert.equal(design.width, truth.design.width, "fixture design.png 与 ground-truth 宽度不一致");
  assert.equal(design.height, truth.design.height, "fixture design.png 与 ground-truth 高度不一致");
  return { truth, design, device };
}

function nodesFromTruth(truth) {
  return truth.cases.map((entry) => ({
    id: entry.node.id,
    name: entry.node.name,
    type: entry.node.type,
    x: entry.bbox.x,
    y: entry.bbox.y,
    width: entry.bbox.width,
    height: entry.bbox.height,
    parentFill: entry.node.parentFill
  }));
}

const CENTER_SLACK = 16;

function centerIn(bbox, region) {
  const cx = region.bbox.x + region.bbox.width / 2;
  const cy = region.bbox.y + region.bbox.height / 2;
  return (
    cx >= bbox.x - CENTER_SLACK &&
    cx <= bbox.x + bbox.width + CENTER_SLACK &&
    cy >= bbox.y - CENTER_SLACK &&
    cy <= bbox.y + bbox.height + CENTER_SLACK
  );
}

test("真实设备基准：区域召回与类别命中（无设备/网络）", () => {
  const { truth, design, device } = loadFixture();
  const result = diffScreens(design, device, {
    insets: truth.insets,
    designNodes: nodesFromTruth(truth)
  });

  const misses = [];
  const wrongCategory = [];
  for (const entry of truth.cases) {
    const hit = result.regions.find((region) => centerIn(entry.bbox, region));
    if (!hit) {
      misses.push(entry.id);
      continue;
    }
    if (hit.category !== entry.expectedCategory) {
      wrongCategory.push(`${entry.id}: expected ${entry.expectedCategory}, got ${hit.category}`);
    }
  }

  const detail = JSON.stringify({ found: result.regions, expected: truth.cases }, null, 2);
  assert.deepEqual(misses, [], `基准用例未检出：${misses.join(", ")}\n${detail}`);
  assert.deepEqual(wrongCategory, [], `类别命中失败：${wrongCategory.join("; ")}\n${detail}`);

  assert.equal(
    result.regions.length,
    truth.cases.length,
    `真实基准不应出现额外区域（噪声）：\n${detail}`
  );
});

test("真实设备基准：报告 schema 快照", () => {
  const { truth, design, device } = loadFixture();
  const result = diffScreens(design, device, {
    insets: truth.insets,
    designNodes: nodesFromTruth(truth)
  });

  const topKeys = Object.keys(result).sort();
  for (const key of ["alignment", "ignoredRegions", "regions", "summary", "thresholds"]) {
    assert.ok(topKeys.includes(key), key);
  }
  for (const key of topKeys) {
    assert.ok(
      ["alignment", "globalShifts", "ignoredRegions", "regions", "summary", "thresholds"].includes(key),
      `unexpected top-level key: ${key}`
    );
  }
  assert.deepEqual(Object.keys(result.thresholds).sort(), [
    "clusterGap",
    "colorTolerance",
    "maxEdge",
    "maxRegions",
    "minAreaRatio",
    "nodeProximity",
    "pixelThreshold",
    "systemBandRatio"
  ]);
  const region = result.regions[0];
  assert.ok(region);
  const regionKeys = Object.keys(region).sort();
  for (const key of ["bbox", "category", "pixelDiffRatio", "severity"]) {
    assert.ok(regionKeys.includes(key), key);
  }
  for (const key of regionKeys) {
    assert.ok(
      ["bbox", "category", "colorDelta", "designColor", "designNode", "deviceColor", "pixelDiffRatio", "severity", "shift", "suspected"].includes(key),
      `unexpected region key: ${key}`
    );
  }
  assert.deepEqual(Object.keys(region.bbox).sort(), ["height", "width", "x", "y"]);
  assert.deepEqual(Object.keys(result.alignment).sort(), ["designCrop", "insets", "offset", "scale"]);
  assert.deepEqual(Object.keys(result.summary).sort(), ["byCategory", "bySeverity", "regions"]);
});

test("真实设备基准：抗噪（设备 JPEG 低质量重编码不产生误报）", () => {
  const { truth, device } = loadFixture();
  const { top, bottom } = truth.insets;
  const height = device.height - top - bottom;
  const cropped = { width: device.width, height, data: new Uint8Array(device.width * height * 4) };
  for (let row = 0; row < height; row += 1) {
    const from = ((row + top) * device.width) * 4;
    cropped.data.set(device.data.subarray(from, from + device.width * 4), row * device.width * 4);
  }
  const cleanDesign = resize(cropped, 390, Math.round((height * 390) / device.width));
  const reencoded = Buffer.from(
    encodeJpeg({ data: Buffer.from(device.data), width: device.width, height: device.height }, 60).data
  );
  const noisyDevice = decodeImage(reencoded);

  const result = diffScreens(cleanDesign, noisyDevice, { insets: truth.insets });
  assert.equal(
    result.regions.length,
    0,
    `q60 重编码产生误报区域：${JSON.stringify(result.regions, null, 2)}`
  );
});

test("真实设备基准：ignoreRegions 在真实图上生效且不改写判定", () => {
  const { truth, design, device } = loadFixture();
  const ignored = truth.cases[0].bbox;
  const result = diffScreens(design, device, {
    insets: truth.insets,
    designNodes: nodesFromTruth(truth),
    ignoreRegions: [ignored]
  });
  assert.equal(result.regions.length, 1, JSON.stringify(result.regions));
  assert.equal(result.regions[0].category, truth.cases[1].expectedCategory);
  assert.deepEqual(result.ignoredRegions, [ignored]);
});

test("真实设备基准：不裁剪 insets 时系统条带差异标记 system-area 并降级", () => {
  const { truth, design, device } = loadFixture();
  const result = diffScreens(design, device, { designNodes: [] });
  const systemRegions = result.regions.filter((region) => region.suspected === "system-area");
  assert.ok(systemRegions.length >= 1, `未标记 system-area：${JSON.stringify(result.regions)}`);
  for (const region of systemRegions) {
    assert.equal(region.severity, "info");
  }
  assert.ok(result.regions.length > truth.cases.length, "未裁剪时应有额外条带差异");
});
