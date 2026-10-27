import assert from "node:assert/strict";
import test from "node:test";

import { diffScreens, normalizeDesignCrop } from "../dist/diff/engine.js";
import { createImage, fillRect } from "./helpers.js";

function designImage() {
  const image = createImage(390, 1000, [255, 255, 255, 255]);
  fillRect(image, 0, 0, 390, 600, [220, 38, 38, 255]);
  fillRect(image, 0, 600, 390, 400, [30, 64, 175, 255]);
  return image;
}

function deviceImage() {
  return createImage(390, 400, [30, 64, 175, 255]);
}

test("designCrop: cropped lower section aligns 1:1 and removes false diffs", () => {
  const design = designImage();
  const device = deviceImage();
  const cropped = diffScreens(design, device, {
    designCrop: { x: 0, y: 600, width: 390, height: 400 }
  });
  assert.equal(cropped.alignment.scale, 1);
  assert.deepEqual(cropped.alignment.designCrop, { x: 0, y: 600, width: 390, height: 400 });
  assert.deepEqual(cropped.regions, []);

  const uncropped = diffScreens(design, device);
  assert.ok(uncropped.regions.length > 0);
  assert.equal(uncropped.alignment.designCrop, null);
});

test("designCrop: invalid values fail closed before producing regions", () => {
  const design = designImage();
  const device = deviceImage();
  assert.throws(
    () => diffScreens(design, device, { designCrop: { x: 0, y: 0, width: 0, height: 10 } }),
    /designCrop/
  );
  assert.throws(
    () => diffScreens(design, device, { designCrop: { x: 0, y: 900, width: 390, height: 200 } }),
    /designCrop/
  );
  assert.throws(
    () => diffScreens(design, device, { designCrop: { x: Number.NaN, y: 0, width: 10, height: 10 } }),
    /designCrop/
  );
  assert.equal(normalizeDesignCrop(undefined, design), null);
});

test("designCrop: design nodes are shifted into cropped coordinates", () => {
  const design = designImage();
  const device = deviceImage();
  fillRect(device, 50, 50, 80, 60, [220, 38, 38, 255]);
  const result = diffScreens(design, device, {
    designCrop: { x: 0, y: 600, width: 390, height: 400 },
    designNodes: [{ id: "list", name: "List", type: "FRAME", x: 0, y: 600, width: 390, height: 400 }]
  });
  assert.ok(result.regions.length >= 1);
  const region = result.regions[0];
  assert.equal(region.designNode?.id, "list");
  assert.ok(Math.abs(region.bbox.y - 50) <= 8, `y=${region.bbox.y}`);
});

test("designCrop: ignoreRegions use cropped-design coordinates", () => {
  const design = designImage();
  const device = deviceImage();
  fillRect(device, 0, 0, 390, 400, [220, 38, 38, 255]);
  const result = diffScreens(design, device, {
    designCrop: { x: 0, y: 600, width: 390, height: 400 },
    ignoreRegions: [{ x: 0, y: 0, width: 390, height: 400 }]
  });
  assert.deepEqual(result.regions, []);
  assert.deepEqual(result.ignoredRegions, [{ x: 0, y: 0, width: 390, height: 400 }]);
});
