import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parsePenText, stripJsonComments, summarizePen, validatePen } from "../dist/pen/read.js";
import { penInspect } from "../dist/pen/inspect.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

const SAMPLE = `{
  // pen.dev 文档允许注释
  "version": "2.19",
  "themes": { "Mode": ["Light", "Dark"] },
  "variables": {
    "color.bg": { "type": "color", "value": [{ "value": "#FFFFFF" }, { "value": "#000000", "theme": { "Mode": "Dark" } }] },
    "radius.card": { "type": "number", "value": 12 }
  },
  "children": [
    {
      "id": "screen-home", "type": "frame", "name": "Home", "x": 0, "y": 0, "width": 390, "height": 844,
      "fill": "$color.bg", "layout": "none",
      "children": [
        { "id": "label", "type": "text", "name": "Title", "content": "Welcome", "fill": "$color.bg", "x": 16, "y": 24 },
        { "id": "card-def", "type": "frame", "name": "Card", "reusable": true, "width": 200, "height": 120, "cornerRadius": "$radius.card", "layout": "none" },
        { "id": "card-1", "type": "ref", "ref": "card-def", "x": 16, "y": 80 },
        {
          "id": "hero-img", "type": "rectangle", "name": "Hero", "width": 100, "height": 100,
          "fill": { "type": "image", "url": "./starbucks-assets/hero.png", "mode": "fill" }
        }
      ]
    }
  ]
}`;

test("pen: JSONC 注释剥离不破坏字符串中的 //", () => {
  const text = '{ "url": "https://x.dev/a//b.png", // note\n "n": 1 }';
  const stripped = stripJsonComments(text);
  assert.ok(stripped.includes("https://x.dev/a//b.png"));
  assert.ok(!stripped.includes("note"));
  assert.deepEqual(JSON.parse(stripped), { url: "https://x.dev/a//b.png", n: 1 });
});

test("pen: 解析 + 摘要", () => {
  const doc = parsePenText(SAMPLE);
  const summary = summarizePen(doc);
  assert.equal(summary.version, "2.19");
  assert.equal(summary.topLevel, 1);
  assert.equal(summary.screens.length, 1);
  assert.equal(summary.screens[0].name, "Home");
  assert.equal(summary.components.length, 1);
  assert.equal(summary.components[0].name, "Card");
  assert.equal(summary.instances, 1);
  assert.equal(summary.texts, 1);
  assert.deepEqual(summary.textSamples, ["Welcome"]);
  assert.equal(summary.variables.total, 2);
  assert.deepEqual(summary.variables.byType, { color: 1, number: 1 });
  assert.deepEqual(summary.images, ["./starbucks-assets/hero.png"]);
  assert.equal(summary.byType.text, 1);
  assert.deepEqual(summary.themes, { Mode: ["Light", "Dark"] });
});

test("pen: 校验（重复 id / 悬空 ref / 非法变量名 / 未定义变量）", () => {
  const doc = parsePenText(
    JSON.stringify({
      version: "2.19",
      variables: { "bad:name": { type: "color", value: "#FFF" } },
      children: [
        { id: "a", type: "frame", children: [{ id: "a", type: "rectangle" }] },
        { id: "r", type: "ref", ref: "ghost" },
        { id: "t", type: "text", content: "x", fill: "$missing.var" },
        { id: "slash/x", type: "rectangle" }
      ]
    })
  );
  const { errors, warnings } = validatePen(doc);
  assert.ok(errors.some((entry) => entry.includes("id 重复")), errors.join("; "));
  assert.ok(errors.some((entry) => entry.includes("ref 悬空")), errors.join("; "));
  assert.ok(errors.some((entry) => entry.includes("格式禁止")), errors.join("; "));
  assert.ok(errors.some((entry) => entry.includes("变量名非法")), errors.join("; "));
  assert.ok(warnings.some((entry) => entry.includes("$missing.var")), warnings.join("; "));
});

test("pen_inspect: 自动选择最新 .pen、输出摘要、save 落盘；无效文件报错", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "sample.pen"), SAMPLE, "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const result = await penInspect(runtime, {});
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true, JSON.stringify(payload.errors));
  assert.equal(payload.counts.screens, 1);
  assert.equal(payload.counts.components, 1);
  assert.equal(payload.counts.variables, 2);
  assert.equal(payload.counts.images, 1);
  assert.equal(payload.counts.missingImages, 1);

  const saved = await penInspect(runtime, { save: true });
  const savedPayload = parseToolResult(saved);
  assert.ok(savedPayload.savedTo.endsWith("summary.json"));
  assert.ok(fs.existsSync(savedPayload.savedTo));

  fs.writeFileSync(path.join(designDir, "broken.pen"), "{ not json", "utf-8");
  const broken = await penInspect(runtime, { path: ".artemis/design/broken.pen" });
  const brokenPayload = parseToolResult(broken);
  assert.equal(broken.isError, true);
  assert.match(brokenPayload.error, /解析失败/);

  const missing = await penInspect(runtime, { path: ".artemis/design/nope.pen" });
  assert.equal(parseToolResult(missing).ok, false);
});
