import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { screenMap } from "../dist/diff/screen-map.js";
import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubDevice,
  stubFigmaFetch,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

const HOME_DOCUMENT = {
  id: "1:2",
  type: "FRAME",
  name: "Home",
  absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
  children: [
    {
      id: "1:3",
      type: "RECTANGLE",
      name: "Card",
      absoluteBoundingBox: { x: 40, y: 80, width: 120, height: 60 },
      fills: [{ type: "SOLID", color: { r: 0.118, g: 0.251, b: 0.686, a: 1 } }]
    }
  ]
};

function makeMapProject({ buildBrief = true, flutter = true } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  if (flutter) fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: demo\n");
  if (buildBrief) {
    fs.writeFileSync(
      path.join(designDir, "build-brief.json"),
      JSON.stringify({
        ok: true,
        summary: {},
        brief: {
          screens: [
            { page: "pen", name: "Home", suggestedRoute: "/" },
            { page: "pen", name: "Frame 427", suggestedRoute: "/frame-427" }
          ],
          components: [{ id: "c1", name: "Card", type: "COMPONENT" }]
        }
      })
    );
  }
  return dir;
}

async function makeDiffRuntime(dir, { fileKey, document = HOME_DOCUMENT } = {}) {
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const figma = stubFigmaFetch(toPng(designImage), "1:2", fileKey, { document });
  const devicePath = path.join(dir, "device.jpg");
  fs.writeFileSync(devicePath, toJpeg(createImage(390, 844), 85));
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });
  return { runtime, figma };
}

test("screen_map propose: 基于 build-brief + 栈约定给出候选与 unmatched", async () => {
  const dir = makeMapProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await screenMap(runtime, { action: "propose" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.stack, "flutter");
  const home = payload.candidates.find((entry) => entry.design.screen === "Home");
  assert.equal(home.code.route, "/");
  assert.equal(home.code.component, "HomeScreen");
  assert.equal(home.code.file, path.join("lib", "components", "home_screen.dart"));
  assert.equal(home.confidence, 0.6);
  const card = payload.candidates.find((entry) => entry.design.component === "Card");
  assert.equal(card.design.screen, undefined);
  assert.equal(card.code.file, path.join("lib", "components", "card.dart"));
  assert.ok(payload.unmatched.some((item) => item.design === "Frame 427"));
});

test("screen_map propose: 缺 build-brief 时报错并给引导", async () => {
  const dir = makeMapProject({ buildBrief: false });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const result = await screenMap(runtime, { action: "propose" });
  assert.equal(result.isError, true);
  assert.match(parseToolResult(result).hint, /build-brief/);
});

test("screen_map save/list: 显式写入、幂等、merge 与非法条目", async () => {
  const dir = makeMapProject({ buildBrief: false });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const empty = parseToolResult(await screenMap(runtime, { action: "list" }));
  assert.deepEqual(empty.entries, []);
  assert.match(empty.hint, /propose/);

  const entry = {
    design: { screen: "Home" },
    code: { route: "/", component: "HomeScreen", file: "lib/components/home_screen.dart" }
  };
  const first = parseToolResult(await screenMap(runtime, { action: "save", entries: [entry] }));
  assert.equal(first.action, "written");
  assert.equal(first.entries, 1);

  const second = parseToolResult(await screenMap(runtime, { action: "save", entries: [entry] }));
  assert.equal(second.action, "unchanged");

  const secondEntry = { design: { screen: "Profile" }, code: { file: "lib/components/profile.dart" } };
  const merged = parseToolResult(
    await screenMap(runtime, { action: "save", entries: [secondEntry], merge: true })
  );
  assert.equal(merged.entries, 2);

  const listed = parseToolResult(await screenMap(runtime, { action: "list" }));
  assert.deepEqual(
    listed.entries.map((item) => item.design.screen),
    ["Home", "Profile"]
  );

  const invalid = await screenMap(runtime, { action: "save", entries: [{ design: { screen: "" }, code: {} }] });
  assert.equal(invalid.isError, true);
  assert.match(parseToolResult(invalid).error, /非法/);
  const emptySave = await screenMap(runtime, { action: "save", entries: [] });
  assert.equal(emptySave.isError, true);
});

test("design_device_diff: 已映射区域输出 localized.mapped", async () => {
  await withFigmaToken(async () => {
    const dir = makeMapProject({ buildBrief: false });
    const { runtime, figma } = await makeDiffRuntime(dir, { fileKey: "MapA1" });
    await screenMap(runtime, {
      action: "save",
      entries: [
        {
          design: { screen: "Home" },
          code: { route: "/", component: "HomeScreen", file: "lib/components/home_screen.dart" }
        }
      ]
    });
    const mapPath = path.join(dir, ".artemis", "design", "screen-map.json");
    const before = fs.readFileSync(mapPath, "utf-8");
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/MapA1/File?node-id=1-2" }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1);
      assert.equal(payload.regions[0].localized.status, "mapped");
      assert.equal(payload.regions[0].localized.mapEntry.code.file, "lib/components/home_screen.dart");
      assert.deepEqual(payload.designScreens.map((screen) => screen.name), ["Home"]);
      assert.equal(fs.readFileSync(mapPath, "utf-8"), before, "diff 流程不应改写 screen-map.json");
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 未映射区域给候选或 no-candidates", async () => {
  await withFigmaToken(async () => {
    const dir = makeMapProject();
    const { runtime, figma } = await makeDiffRuntime(dir, { fileKey: "MapB2" });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/MapB2/File?node-id=1-2" }
        })
      );
      assert.equal(payload.regions[0].localized.status, "unmapped");
      assert.equal(payload.regions[0].localized.candidates[0].design.screen, "Home");
    } finally {
      figma.restore();
    }
  });

  await withFigmaToken(async () => {
    const dir = makeMapProject({ buildBrief: false });
    const { runtime, figma } = await makeDiffRuntime(dir, { fileKey: "MapC3" });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/MapC3/File?node-id=1-2" }
        })
      );
      assert.equal(payload.regions[0].localized.status, "no-candidates");
      assert.match(payload.regions[0].localized.reason, /build-brief/);
    } finally {
      figma.restore();
    }
  });
});
