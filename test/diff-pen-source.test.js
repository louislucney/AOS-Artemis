import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { penDesignNodes } from "../dist/diff/pen-source.js";
import { parsePenText } from "../dist/pen/read.js";
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
  toJpeg,
  toPng
} from "./helpers.js";

const PEN_FIXTURE = `{
  // 票据 05 fixture
  "version": "2.19",
  "variables": {
    "color.bg": { "type": "color", "value": "#FFFFFF" }
  },
  "children": [
    {
      "id": "screen", "type": "frame", "name": "Home", "x": 0, "y": 0, "width": 390, "height": 844,
      "fill": "$color.bg", "layout": "none",
      "children": [
        { "id": "card", "type": "rectangle", "name": "Card", "x": 40, "y": 80, "width": 120, "height": 60, "fill": "#1E40B0" },
        { "id": "title", "type": "text", "name": "Title", "content": "Hello", "x": 40, "y": 20, "width": 200, "height": 30 }
      ]
    },
    {
      "id": "row", "type": "frame", "name": "Row", "x": 0, "y": 900, "width": 300, "height": 100, "layout": "horizontal",
      "children": [
        { "id": "flex-child", "type": "rectangle", "name": "Child", "width": 50, "height": 50 }
      ]
    }
  ]
}`;

function designPngFixture() {
  const image = createImage(390, 844);
  fillRect(image, 40, 80, 120, 60, [30, 64, 176, 255]);
  return toPng(image);
}

function makePenProject({ fileKey = "pen" } = {}) {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "demo.pen"), PEN_FIXTURE, "utf-8");
  const devicePath = path.join(dir, "device.jpg");
  fs.writeFileSync(devicePath, toJpeg(createImage(390, 844), 85));
  return { dir, devicePath };
}

function stubEnsure() {
  return async () => ({ ok: true, source: "path", path: "/fake/pen", installed: false });
}

function fakePen(designPng, { fail } = {}) {
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    if (fail) return fail;
    const output = args[args.indexOf("--export") + 1];
    fs.writeFileSync(output, designPng);
    return { code: 0, stdout: `Export saved to: ${output}\n`, stderr: "" };
  };
  return { exec, calls };
}

test("penDesignNodes: 嵌套绝对坐标、父级填充与 $变量解析，flex 子节点跳过", () => {
  const nodes = penDesignNodes(parsePenText(PEN_FIXTURE));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.deepEqual(
    nodes.map((node) => node.id),
    ["screen", "card", "title", "row"]
  );
  assert.equal(byId.get("screen").x, 0);
  assert.equal(byId.get("card").x, 40);
  assert.equal(byId.get("card").y, 80);
  assert.equal(byId.get("card").parentFill, "#FFFFFFFF");
  assert.equal(byId.get("title").text, "Hello");
  assert.equal(byId.get("row").y, 900);
  assert.ok(!byId.has("flex-child"), "flex 布局子节点无坐标应跳过");
});

test("design_device_diff: .pen 设计源渲染 + 分类 + 产物", async () => {
  const { dir, devicePath } = makePenProject();
  const designPng = designPngFixture();
  const { exec, calls } = fakePen(designPng);
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(
    await designDeviceDiff(
      runtime,
      { design: { source: "pen", penPath: ".artemis/design/demo.pen" } },
      { exec, ensure: stubEnsure() }
    )
  );
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.design.source, "pen");
  assert.equal(payload.summary.regions, 1, JSON.stringify(payload.regions));
  assert.equal(payload.regions[0].category, "missing");
  assert.deepEqual(payload.regions[0].designNode, { id: "card", name: "Card" });
  assert.equal(payload.designNodes, 4);

  const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
  assert.equal(report.unit.design.source, "pen");
  assert.equal(report.unit.design.name, path.join(".artemis", "design", "demo.pen"));
  assert.deepEqual(
    report.designScreens.map((screen) => screen.name),
    ["Home", "Row"]
  );
  assert.deepEqual(fs.readFileSync(payload.saved.design), designPng);

  assert.equal(calls.length, 1);
  const exportPath = calls[0].args[calls[0].args.indexOf("--export") + 1];
  assert.equal(exportPath, path.join(dir, ".artemis", "design", "pen", "demo.png"));
  assert.equal(calls[0].args[calls[0].args.indexOf("--export-scale") + 1], "1");
  assert.ok(fs.existsSync(exportPath));
});

test("design_device_diff: source=pen 缺省取最新 .pen", async () => {
  const { dir, devicePath } = makePenProject();
  const { exec, calls } = fakePen(designPngFixture());
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(await designDeviceDiff(runtime, { design: { source: "pen" } }, { exec, ensure: stubEnsure() }));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.match(String(payload.design.path), /demo\.pen$/);
  assert.equal(calls.length, 1);
});

test("design_device_diff: pen CLI 失败时结构化报错", async () => {
  const { dir, devicePath } = makePenProject();
  const { exec } = fakePen(Buffer.alloc(0), {
    fail: { code: 1, stdout: "", stderr: "Not logged in. Run pen login." }
  });
  const proxy = new StubProxy({ running: true });
  stubDevice(proxy, devicePath);
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const result = await designDeviceDiff(
    runtime,
    { design: { source: "pen", penPath: ".artemis/design/demo.pen" } },
    { exec, ensure: stubEnsure() }
  );
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.match(payload.error, /pen 渲染失败/);
  assert.match(payload.hint, /@pen\.dev/);
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
});

test("design_device_diff: 设计源参数校验", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const neither = await designDeviceDiff(runtime, { design: {} });
  assert.equal(neither.isError, true);
  assert.match(parseToolResult(neither).error, /figmaUrl|pen/);

  const both = await designDeviceDiff(runtime, {
    design: { figmaUrl: "https://www.figma.com/design/X/File?node-id=1-2", penPath: "a.pen" }
  });
  assert.equal(both.isError, true);
  assert.match(parseToolResult(both).error, /只能给/);

  const figmaWithoutUrl = await designDeviceDiff(runtime, { design: { source: "figma" } });
  assert.equal(figmaWithoutUrl.isError, true);
  assert.match(parseToolResult(figmaWithoutUrl).error, /figmaUrl/);

  const dryRun = parseToolResult(
    await designDeviceDiff(runtime, { design: { source: "pen", penPath: ".artemis/design/demo.pen" }, dryRun: true })
  );
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.design.source, "pen");
  assert.match(dryRun.plannedDir, /demo-<timestamp>$/);
});
