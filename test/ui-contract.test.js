import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildUiContract } from "../dist/ui/contract.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function writeDesign(dir, { withPen, withStatePen = false }) {
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(path.join(design, "pen", "screens"), { recursive: true });
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        {
          id: "s1",
          name: "首頁",
          sourceFrameName: "Screen 1",
          ...(withStatePen
            ? {
                states: [
                  { id: "st1", label: "首頁-下滑", frameName: "Screen 1 Scrolled" },
                  { id: "st1-dup", label: "首頁／下滑", frameName: "Screen 1 Scrolled (dup)" }
                ]
              }
            : {})
        },
        { id: "s2", name: "彈窗", sourceFrameName: "Popup" }
      ],
      edges: [],
      entryScreens: ["s1"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  if (withPen) {
    fs.writeFileSync(
      path.join(design, "pen", "screens", "s1.pen"),
      JSON.stringify({
        version: "2.20",
        children: [
          {
            type: "frame",
            id: "s1",
            name: "Screen 1",
            x: 0,
            y: 0,
            width: 375,
            height: 812,
            children: [
              {
                type: "frame",
                id: "card",
                name: "Card",
                x: 16,
                y: 20,
                width: 343,
                height: 120,
                cornerRadius: 10,
                fill: "#ffffffff",
                children: [
                  {
                    type: "text",
                    id: "title",
                    name: "Title",
                    x: 32,
                    y: 40,
                    width: 200,
                    height: 24,
                    fontSize: 16,
                    fontFamily: "SF Pro Text",
                    fontWeight: "600",
                    lineHeight: 24,
                    letterSpacing: 0.5,
                    maxLines: 2,
                    textAlign: "left",
                    content: "早安"
                  },
                  {
                    type: "image",
                    id: "hero",
                    name: "Hero",
                    x: 32,
                    y: 64,
                    width: 343,
                    height: 120,
                    fill: { type: "image", url: "./assets/hero.png", mode: "cover" }
                  }
                ]
              }
            ]
          }
        ]
      }),
      "utf-8"
    );
  }
  if (withStatePen) {
    fs.mkdirSync(path.join(design, "pen", "states"), { recursive: true });
    fs.writeFileSync(
      path.join(design, "pen", "states", "st1.pen"),
      JSON.stringify({
        version: "2.20",
        children: [
          {
            type: "frame",
            id: "st1",
            name: "Screen 1 Scrolled",
            x: 0,
            y: 0,
            width: 375,
            height: 812,
            children: [
              {
                type: "text",
                id: "state-title",
                name: "Title",
                x: 16,
                y: 20,
                width: 200,
                height: 24,
                fontSize: 18,
                fontFamily: "SF Pro Text",
                fontWeight: "700",
                content: "已折叠"
              }
            ]
          }
        ]
      }),
      "utf-8"
    );
  }
}

test("ui contract: projects flows + per-screen pen tokens with four-state status", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir, { withPen: true });
  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime, { designRoot: path.join(dir, ".artemis", "design") });

  const screen = built.contract.screens.find((entry) => entry.id === "s1");
  assert.equal(screen.status, "extracted");
  assert.equal(screen.geometry.nodes, 4);
  assert.equal(screen.geometry.withGeometry, 4);
  assert.ok(screen.tokens.cornerRadius.includes(10));
  assert.ok(screen.tokens.colors.includes("#ffffffff"));
  assert.ok(screen.tokens.fontSizes.includes(16));
  assert.equal(screen.tokens.fontWeights.includes("600"), true);
  assert.equal(screen.texts.length, 1);
  assert.equal(screen.texts[0].content, "早安");
  assert.equal(screen.texts[0].fontWeight, 600);
  assert.equal(screen.texts[0].fontSize, 16);
  assert.equal(screen.texts[0].geometryStatus, "extracted");
  assert.deepEqual(screen.texts[0].bbox, { x: 32, y: 40, width: 200, height: 24 });
  assert.equal(screen.texts[0].lineHeight, 24);
  assert.equal(screen.texts[0].letterSpacing, 0.5);
  assert.equal(screen.texts[0].maxLines, 2);
  assert.equal(screen.texts[0].textAlign, "left");
  assert.equal(screen.images.length, 1);
  assert.equal(screen.images[0].assetKey, "hero");
  assert.equal(screen.images[0].fit, "cover");
  assert.equal(screen.images[0].geometryStatus, "extracted");
  assert.deepEqual(screen.images[0].bbox, { x: 32, y: 64, width: 343, height: 120 });

  const missing = built.contract.screens.find((entry) => entry.id === "s2");
  assert.equal(missing.status, "no-baseline");
  assert.equal(built.contract.summary["no-baseline"], 1);
  assert.equal(built.contract.source.fingerprint.length, 64);
  assert.ok(fs.existsSync(built.jsonPath));
  assert.match(fs.readFileSync(built.markdownPath, "utf-8"), /首頁/);
});

test("ui contract: flows states become state contracts with parent + state pen", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir, { withPen: true, withStatePen: true });
  const design = path.join(dir, ".artemis", "design");
  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime, { designRoot: design });

  const state = built.contract.screens.find((entry) => entry.id === "st1");
  assert.ok(state, "状态变体进入契约");
  assert.equal(state.presentation, "state");
  assert.equal(state.parentScreenId, "s1");
  assert.equal(state.name, "首頁-下滑");
  assert.equal(state.sourceFrameName, "Screen 1 Scrolled");
  assert.equal(state.status, "extracted");
  assert.ok(state.tokens.fontSizes.includes(18));
  assert.equal(
    built.contract.screens.filter((entry) => entry.name === "首頁-下滑").length,
    1,
    "重复状态标签只保留第一条"
  );
  assert.deepEqual(built.contract.counts, { screens: 2, states: 1 });
  assert.match(fs.readFileSync(built.markdownPath, "utf-8"), /首頁-下滑/);

  const before = built.contract.source.fingerprint;
  fs.appendFileSync(path.join(design, "pen", "states", "st1.pen"), " ");
  const after = buildUiContract(runtime, { designRoot: design });
  assert.notEqual(after.contract.source.fingerprint, before, "状态 .pen 变化会推进契约指纹");
});

test("ui contract: boundsProvider resolves auto-layout text geometry", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir, { withPen: true });
  const pen = path.join(dir, ".artemis", "design", "pen", "screens", "s1.pen");
  const doc = JSON.parse(fs.readFileSync(pen, "utf-8"));
  doc.children[0].children.push({
    type: "text",
    id: "auto",
    name: "Auto",
    content: "自動排版",
    fontSize: 16,
    fontWeight: "600"
  });
  fs.writeFileSync(pen, JSON.stringify(doc), "utf-8");

  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime, {
    designRoot: path.join(dir, ".artemis", "design"),
    boundsProvider: () => [{ id: "auto", x: 10, y: 20, width: 30, height: 18 }]
  });
  const text = built.contract.screens.find((entry) => entry.id === "s1").texts.find((entry) => entry.id === "auto");
  assert.equal(text.geometryStatus, "extracted");
  assert.deepEqual(text.bbox, { x: 10, y: 20, width: 30, height: 18 });
  assert.equal(text.fontWeight, 600);
});

test("ui contract: partial geometry and missing token availability are explicit", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir, { withPen: true });
  const pen = path.join(dir, ".artemis", "design", "pen", "screens", "s1.pen");
  const doc = JSON.parse(fs.readFileSync(pen, "utf-8"));
  doc.children[0].children.push({ type: "frame", id: "auto", name: "Auto", width: 100 });
  fs.writeFileSync(pen, JSON.stringify(doc), "utf-8");

  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime, { designRoot: path.join(dir, ".artemis", "design") });
  const screen = built.contract.screens.find((entry) => entry.id === "s1");
  assert.equal(screen.status, "partial");
  assert.equal(screen.geometry.missingGeometry, 1);
  assert.ok(screen.warnings.some((warning) => warning.includes("部分节点无显式几何")));
});

test("ui contract: missing flows.json is an explicit error", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir);
  assert.throws(
    () => buildUiContract(runtime, { designRoot: path.join(dir, ".artemis", "design") }),
    /缺少 flows\.json/
  );
});

test("ui contract: pen 源缺逐屏 .pen 时从源文档自动拆分", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(design, { recursive: true });
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      source: "pen:design.pen",
      screens: [{ id: "s1", name: "首頁", sourceFrameName: "Screen 1" }],
      edges: [],
      entryScreens: ["s1"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(dir, "design.pen"),
    JSON.stringify({
      version: "2.20",
      fileToken: "token-1",
      children: [
        {
          type: "frame",
          id: "board",
          name: "Board",
          children: [
            {
              type: "frame",
              id: "s1",
              name: "Screen 1",
              x: 100,
              y: 200,
              width: 375,
              height: 812,
              children: [
                {
                  type: "frame",
                  id: "card",
                  name: "Card",
                  x: 16,
                  y: 20,
                  width: 343,
                  height: 120,
                  cornerRadius: 10,
                  fill: "#ffffffff"
                }
              ]
            }
          ]
        }
      ]
    }),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime);

  assert.ok(fs.existsSync(path.join(design, "pen", "screens", "s1.pen")));
  assert.notEqual(built.contract.screens[0].status, "no-baseline");
  assert.equal(built.contract.screens[0].geometry.nodes, 2);
  assert.equal(built.contract.screens[0].geometry.withGeometry, 2);
});
