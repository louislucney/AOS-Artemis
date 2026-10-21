import assert from "node:assert/strict";
import test from "node:test";

import { synthesizeStaticFlows } from "../dist/figma/static-flows.js";

function frame(id, name, x, texts = []) {
  return {
    id,
    name,
    type: "FRAME",
    absoluteBoundingBox: { x, y: 0, width: 375, height: 812 },
    children: texts.map((text, index) => ({
      id: `${id}-t${index}`,
      name: text,
      type: "TEXT",
      characters: text,
      absoluteBoundingBox: { x: x + 20, y: 40 + index * 30, width: 200, height: 24 }
    }))
  };
}

function fileWith(children) {
  return {
    name: "Demo",
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children }]
    }
  };
}

const ARROW = {
  id: "9:1",
  name: "箭头",
  type: "LINE",
  absoluteBoundingBox: { x: 380, y: 400, width: 100, height: 8 }
};

const NOTE = {
  id: "9:2",
  name: "说明",
  type: "TEXT",
  characters: "点击订单进入订单列表",
  absoluteBoundingBox: { x: 520, y: 830, width: 220, height: 24 }
};

test("static flows: arrow and annotation become inferred edges", async () => {
  const { graph, warnings } = await synthesizeStaticFlows(
    fileWith([
      frame("1:1", "登录页", 0, ["登录"]),
      frame("1:2", "首页", 500, ["首页"]),
      frame("1:3", "订单列表", 1000, ["订单"]),
      ARROW,
      NOTE
    ])
  );
  assert.deepEqual(
    graph.screens.map((screen) => screen.name),
    ["登录页", "首页", "订单列表"]
  );
  assert.equal(graph.edges.length, 2);
  const first = graph.edges.find((edge) => edge.from.name === "登录页");
  assert.ok(first);
  assert.equal(first.to?.name, "首页");
  assert.equal(first.provenance, "inferred");
  assert.equal(first.confidence, "low");
  const second = graph.edges.find((edge) => edge.from.name === "首页");
  assert.ok(second);
  assert.equal(second.to?.name, "订单列表");
  assert.equal(second.element.type, "annotation");
  assert.deepEqual(graph.entryScreens, ["登录页"]);
  assert.ok(warnings.some((warning) => warning.code === "static-flow-inferred"));
});

test("static flows: layout order is the fallback when no clues exist", async () => {
  const { graph, warnings } = await synthesizeStaticFlows(
    fileWith([frame("1:1", "A", 0), frame("1:2", "B", 500), frame("1:3", "C", 1000)])
  );
  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.name, edge.to?.name]),
    [
      ["A", "B"],
      ["B", "C"]
    ]
  );
  assert.ok(graph.edges.every((edge) => edge.element.type === "layout"));
  assert.ok(warnings.some((warning) => warning.code === "layout-fallback"));
});

test("static flows: empty document reports no-screens", async () => {
  const { graph, warnings } = await synthesizeStaticFlows(fileWith([]));
  assert.equal(graph.screens.length, 0);
  assert.equal(graph.edges.length, 0);
  assert.ok(warnings.some((warning) => warning.code === "no-screens"));
});
