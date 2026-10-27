import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildUiContract } from "../dist/ui/contract.js";
import { baseConfig, loadTestRuntime, makeTempProject } from "./helpers.js";

function writeDesign(dir, { withPen }) {
  const design = path.join(dir, ".artemis", "design");
  fs.mkdirSync(path.join(design, "pen", "screens"), { recursive: true });
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      screens: [
        { id: "s1", name: "首頁", sourceFrameName: "Screen 1" },
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
                    content: "早安"
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
}

test("ui contract: projects flows + per-screen pen tokens with four-state status", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  writeDesign(dir, { withPen: true });
  const { runtime } = await loadTestRuntime(dir);
  const built = buildUiContract(runtime, { designRoot: path.join(dir, ".artemis", "design") });

  const screen = built.contract.screens.find((entry) => entry.id === "s1");
  assert.equal(screen.status, "extracted");
  assert.equal(screen.geometry.nodes, 3);
  assert.equal(screen.geometry.withGeometry, 3);
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

  const missing = built.contract.screens.find((entry) => entry.id === "s2");
  assert.equal(missing.status, "no-baseline");
  assert.equal(built.contract.summary["no-baseline"], 1);
  assert.equal(built.contract.source.fingerprint.length, 64);
  assert.ok(fs.existsSync(built.jsonPath));
  assert.match(fs.readFileSync(built.markdownPath, "utf-8"), /首頁/);
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
