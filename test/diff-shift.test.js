import assert from "node:assert/strict";
import test from "node:test";

import { estimateRegionShift, groupRegionShifts } from "../dist/diff/shift.js";

function image(width, height, rect) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test("estimateRegionShift: 水平位移 10px", () => {
  const design = image(100, 100, { x: 20, y: 20, width: 20, height: 20 });
  const device = image(100, 100, { x: 30, y: 20, width: 20, height: 20 });
  const shift = estimateRegionShift(design, device, { x: 15, y: 15, width: 40, height: 30 }, {
    range: 16,
    minShift: 4
  });
  assert.ok(shift);
  assert.equal(shift.dx, 10);
  assert.equal(shift.dy, 0);
  assert.ok(shift.gain > 0.5);
});

test("estimateRegionShift: 垂直位移 10px", () => {
  const design = image(100, 100, { x: 20, y: 20, width: 20, height: 20 });
  const device = image(100, 100, { x: 20, y: 30, width: 20, height: 20 });
  const shift = estimateRegionShift(design, device, { x: 15, y: 15, width: 30, height: 40 }, {
    range: 16,
    minShift: 4
  });
  assert.ok(shift);
  assert.equal(shift.dx, 0);
  assert.equal(shift.dy, 10);
});

test("estimateRegionShift: 相同图像/小于阈值返回 null", () => {
  const design = image(100, 100, { x: 20, y: 20, width: 20, height: 20 });
  assert.equal(
    estimateRegionShift(design, design, { x: 15, y: 15, width: 30, height: 30 }, { range: 16 }),
    null
  );
  const tiny = image(100, 100, { x: 20, y: 20, width: 20, height: 20 });
  const moved = image(100, 100, { x: 22, y: 20, width: 20, height: 20 });
  assert.equal(
    estimateRegionShift(tiny, moved, { x: 15, y: 15, width: 30, height: 30 }, {
      range: 16,
      minShift: 4
    }),
    null
  );
});

test("groupRegionShifts: ≥3 个同向区域合成整块偏移", () => {
  const regions = [
    { bbox: { x: 0, y: 0, width: 10, height: 10 }, shift: { dx: 0, dy: 10, gain: 0.8 } },
    { bbox: { x: 20, y: 20, width: 10, height: 10 }, shift: { dx: 0, dy: 11, gain: 0.7 } },
    { bbox: { x: 40, y: 40, width: 10, height: 10 }, shift: { dx: 0, dy: 9, gain: 0.9 } }
  ];
  const global = groupRegionShifts(regions);
  assert.equal(global.length, 1);
  assert.equal(global[0].axis, "y");
  assert.equal(global[0].delta, 10);
  assert.equal(global[0].regionCount, 3);
  assert.deepEqual(global[0].bbox, { x: 0, y: 0, width: 50, height: 50 });
});

test("groupRegionShifts: 少于 3 个区域不报整块偏移", () => {
  const regions = [
    { bbox: { x: 0, y: 0, width: 10, height: 10 }, shift: { dx: 0, dy: 10, gain: 0.8 } },
    { bbox: { x: 20, y: 20, width: 10, height: 10 }, shift: { dx: 0, dy: 10, gain: 0.7 } }
  ];
  assert.deepEqual(groupRegionShifts(regions), []);
});
