import assert from "node:assert/strict";
import test from "node:test";

import { diffScreens } from "../dist/diff/engine.js";

function solid(width, height, color) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

const node = {
  id: "1:1",
  name: "Hero",
  type: "FRAME",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  parentFill: "#FF0000"
};

test("diffScreens: 颜色差异区域带 designColor/deviceColor/colorDelta", () => {
  const result = diffScreens(solid(100, 100, [255, 0, 0]), solid(100, 100, [0, 255, 0]), {
    designNodes: [node],
    minAreaRatio: 0.01
  });
  assert.ok(result.regions.length > 0);
  const region = result.regions.find((entry) => entry.category === "color");
  assert.ok(region, JSON.stringify(result.regions));
  assert.equal(region.designColor, "#ff0000");
  assert.equal(region.deviceColor, "#00ff00");
  assert.ok(region.colorDelta > 300);
});

test("diffScreens: 颜色一致时无差异区域", () => {
  const result = diffScreens(solid(100, 100, [255, 0, 0]), solid(100, 100, [255, 0, 0]), {
    designNodes: [node],
    minAreaRatio: 0.01
  });
  assert.deepEqual(result.regions, []);
});

test("diffScreens: 缺节点填充色时不输出颜色证据", () => {
  const result = diffScreens(solid(100, 100, [255, 0, 0]), solid(100, 100, [0, 255, 0]), {
    designNodes: [{ ...node, parentFill: undefined }],
    minAreaRatio: 0.01
  });
  assert.ok(result.regions.length > 0);
  assert.equal(result.regions[0].designColor, undefined);
  assert.equal(result.regions[0].deviceColor, undefined);
});
