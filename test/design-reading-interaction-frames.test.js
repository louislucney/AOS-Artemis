import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildInteractionReport } from "../dist/design/reading/frames.js";
import { runDesignReading } from "../dist/design/reading/run.js";
import { createImage, fillRect, makeTempDir, toPng } from "./helpers.js";

function penNode(id, name, text, y, height = 20) {
  return {
    type: "text",
    id,
    name,
    content: text,
    x: 0,
    y,
    width: 300,
    height
  };
}

function writeFixture() {
  const dir = makeTempDir("aos-interaction-frames-");
  const design = path.join(dir, "design");
  fs.mkdirSync(path.join(design, "screens", "pen-untitled"), { recursive: true });
  const shares = Array.from({ length: 10 }, (_, index) => `商品${index + 1}`);
  const mainChildren = [
    { type: "text", id: "tab-1", name: "Tab", content: "到店自取", x: 0, y: 44, width: 80, height: 20 },
    { type: "text", id: "tab-2", name: "Tab", content: "內用點餐", x: 80, y: 44, width: 80, height: 20 },
    ...shares.map((text, index) => penNode(`item-${index}`, "Item", text, 120 + index * 40))
  ];
  const stateChildren = [
    { type: "text", id: "tab-1", name: "Tab", content: "到店自取", x: 0, y: -316, width: 80, height: 20 },
    { type: "text", id: "tab-2", name: "Tab", content: "內用點餐", x: 80, y: -316, width: 80, height: 20 },
    ...shares.map((text, index) => penNode(`item-${index}`, "Item", text, 120 + index * 40 - 360)),
    { type: "text", id: "bar", name: "App Bar", content: "到店自取", x: 0, y: 0, width: 200, height: 20 }
  ];
  fs.writeFileSync(
    path.join(dir, "design.pen"),
    JSON.stringify({
      version: "2.20",
      children: [
        {
          type: "frame",
          id: "board",
          name: "Board",
          children: [
            { type: "frame", id: "m1", name: "行動預點", x: 0, y: 0, width: 375, height: 1713, children: mainChildren },
            { type: "frame", id: "s1", name: "行動預點-下滑", x: 0, y: 0, width: 375, height: 855, children: stateChildren }
          ]
        }
      ]
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(design, "flows.json"),
    JSON.stringify({
      schemaVersion: 3,
      source: "pen:design.pen",
      screens: [
        {
          id: "m1",
          name: "行動預點",
          sourceBoard: "b1",
          sourceFrameName: "Frame 1",
          states: [{ id: "s1", label: "下滑", frameName: "Frame 2" }],
          elements: []
        }
      ],
      edges: [],
      entryScreens: ["m1"],
      unresolvedDestinations: []
    }),
    "utf-8"
  );
  const mainImage = createImage(375, 1713);
  for (let y = 0; y < 1713; y += 40) fillRect(mainImage, 0, y, 375, 10, [0, 0, 0, 255]);
  const stateImage = createImage(375, 855);
  for (let y = 0; y < 855; y += 40) fillRect(stateImage, 0, y, 375, 10, [0, 0, 0, 255]);
  fs.writeFileSync(
    path.join(design, "screens", "pen-untitled", "m1.png"),
    toPng(mainImage)
  );
  fs.writeFileSync(
    path.join(design, "screens", "pen-untitled", "s1.png"),
    toPng(stateImage)
  );
  return dir;
}

test("interaction frames: builds main + state and finds MOP scroll", async () => {
  const dir = writeFixture();
  const report = await buildInteractionReport({
    designRoot: path.join(dir, "design"),
    flowsPath: path.join(dir, "design", "flows.json"),
    projectRoot: dir,
    visual: () => 0.68
  });
  assert.ok(report);
  assert.equal(report.frames, 2);
  assert.equal(report.stats.scrollCandidates, 1);
  const scroll = report.candidates.find((candidate) => candidate.kind === "scroll-collapse");
  assert.ok(scroll);
  assert.equal(scroll.beforeFrameId, "m1");
  assert.equal(scroll.afterFrameId, "s1");
  assert.equal(scroll.delta.designPx, 360);
  assert.equal(scroll.titleTakeover.bar.text, "到店自取");
});

test("reading integration: interaction candidates are written to reading.json", async () => {
  const dir = writeFixture();
  const flowsPath = path.join(dir, "design", "flows.json");
  const reply = JSON.stringify({
    screens: [
      {
        screenId: "m1",
        name: "行動預點",
        observed: {
          title: "行動預點",
          headerControls: [],
          persistentNav: { sideNav: [], bottomTabs: [], activeTab: null },
          contentGroups: [],
          floatingActions: [],
          annotations: []
        },
        states: [],
        inferredInteractions: []
      }
    ],
    crossScreenLinks: [],
    questions: []
  });
  const result = await runDesignReading({
    runtime: { configDirAbs: dir, project: { rootDir: dir } },
    flowsPath,
    model: "m",
    chat: async () => reply
  });
  assert.ok(result.reading);
  assert.ok(Array.isArray(result.reading.interactionCandidates));
  assert.ok(result.reading.interactionCandidates.some((candidate) => candidate.kind === "scroll-collapse"));
  assert.ok(result.reading.pairingStats);
  const saved = JSON.parse(fs.readFileSync(result.artifacts.json, "utf-8"));
  assert.ok(Array.isArray(saved.interactionCandidates));
  assert.ok(saved.pairingStats);
});
