import assert from "node:assert/strict";
import test from "node:test";

import { DESIGN_NATIVE_TOOLS } from "../dist/tools/native-tools/design.js";

test("design_device_diff MCP schema preserves designCrop and ui", () => {
  const tool = DESIGN_NATIVE_TOOLS.find((entry) => entry.name === "design_device_diff");
  assert.ok(tool);
  const parsed = tool.schema.safeParse({
    design: { source: "image", imagePath: "home.png" },
    alignment: {
      designCrop: { x: 0, y: 600, width: 390, height: 400 },
      ignoreRegions: [{ x: 0, y: 0, width: 390, height: 400 }]
    },
    ui: {
      semanticsPath: ".artemis/design/ui-semantics.json",
      screenId: "home",
      ignoreDynamicRegions: true,
      expectedAssets: true
    }
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.alignment.designCrop, { x: 0, y: 600, width: 390, height: 400 });
  assert.deepEqual(parsed.data.ui, {
    semanticsPath: ".artemis/design/ui-semantics.json",
    screenId: "home",
    ignoreDynamicRegions: true,
    expectedAssets: true
  });
});
