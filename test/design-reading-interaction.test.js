import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFrame,
  normalizeForMatch,
  normalizeTextForSet,
  pairContainers
} from "../dist/design/reading/interaction.js";

const VIEWPORT = { width: 375, height: 855 };

function box(y, height = 20, width = 200, x = 0) {
  return { kind: "exact", box: { x, y, width, height }, space: "design-px", absolute: true };
}

function node(id, name, text, y, height = 20) {
  return { id, name, text, geometry: box(y, height), children: [] };
}

function frame(id, { name = id, board = "b1", parent = null, width = 375, height = 855, nodes = [] } = {}) {
  return {
    id,
    name,
    boardId: board,
    parentId: parent,
    rendered: { width, height },
    viewport: VIEWPORT,
    nodes
  };
}

function mopFrames() {
  const shares = Array.from({ length: 10 }, (_, index) => `商品${index + 1}`);
  const beforeNodes = [
    node("tab-1", "Tab/Icon+Text", "到店自取", 44),
    node("tab-2", "Tab/Icon+Text", "內用點餐", 44),
    node("tab-3", "Tab/Icon+Text", "店外取餐", 44),
    node("tab-4", "Tab/Icon+Text", "車道取餐", 44),
    ...shares.map((text, index) => node(`item-${index}`, "Item", text, 120 + index * 50)),
    node("note", "Text", "固定说明", 100)
  ];
  const afterNodes = [
    node("tab-1", "Tab/Icon+Text", "到店自取", -316),
    node("tab-2", "Tab/Icon+Text", "內用點餐", -316),
    node("tab-3", "Tab/Icon+Text", "店外取餐", -316),
    node("tab-4", "Tab/Icon+Text", "車道取餐", -316),
    ...shares.map((text, index) => node(`item-${index}`, "Item", text, 120 + index * 50 - 360)),
    node("note", "Text", "固定说明", -260),
    node("bar", "App Bar", "到店自取", 0)
  ];
  return {
    before: frame("mop-before", { height: 1713, nodes: beforeNodes }),
    after: frame("mop-after", { height: 855, nodes: afterNodes })
  };
}

test("interaction: classify fixed viewport, full-content, overlay", () => {
  assert.equal(classifyFrame({ width: 375, height: 855 }, VIEWPORT).kind, "viewport-state");
  assert.equal(classifyFrame({ width: 386, height: 855 }, VIEWPORT).kind, "viewport-state");
  assert.equal(classifyFrame({ width: 375, height: 1713 }, VIEWPORT).kind, "full-content");
  assert.equal(classifyFrame({ width: 475, height: 1040 }, VIEWPORT).kind, "overlay");
  assert.equal(classifyFrame({ width: 4546, height: 1487 }, VIEWPORT).kind, "overlay");
});

test("interaction: text normalization is shared by matching and Jaccard", () => {
  assert.equal(normalizeTextForSet("  Ａ，B  "), "ab");
  assert.equal(normalizeForMatch("2026/10/27 17:15 $120"), "<date><time><price>");
});

test("interaction: MOP full-content + viewport-state -> scroll-collapse with takeover", () => {
  const { before, after } = mopFrames();
  const result = pairContainers([before, after], {
    visual: () => 0.68
  });
  const scroll = result.candidates.filter((candidate) => candidate.kind === "scroll-collapse");
  assert.equal(scroll.length, 1);
  const candidate = scroll[0];
  assert.equal(candidate.beforeFrameId, "mop-before");
  assert.equal(candidate.afterFrameId, "mop-after");
  assert.equal(candidate.delta.designPx, 360);
  assert.equal(candidate.pairing.support, 1);
  assert.equal(candidate.titleTakeover.bar.text, "到店自取");
  assert.equal(candidate.titleTakeover.bar.region, "header");
  assert.ok(candidate.collapsed.some((entry) => entry.text === "到店自取"));
});

test("interaction: search-like content diff -> state-change, not scroll", () => {
  const beforeNodes = Array.from({ length: 10 }, (_, index) => node(`s-${index}`, "Result", `结果${index}`, 100 + index * 40));
  const afterNodes = beforeNodes.slice(0, 8);
  const before = frame("search-before", { width: 386, height: 855, nodes: beforeNodes });
  const after = frame("search-after", { width: 386, height: 855, nodes: afterNodes });
  const result = pairContainers([before, after], { visual: () => 0.975 });
  assert.equal(result.candidates.some((candidate) => candidate.kind === "scroll-collapse"), false);
  const state = result.candidates.find((candidate) => candidate.kind === "state-change");
  assert.ok(state);
  assert.equal(state.beforeFrameId, "search-before");
  assert.equal(state.afterFrameId, "search-after");
});

test("interaction: renamed/copied ids do not change the result", () => {
  const { before, after } = mopFrames();
  const renamedBefore = { ...before, id: "renamed-before", name: "Frame 9001" };
  const renamedAfter = { ...after, id: "renamed-after", name: "Frame 9002" };
  const result = pairContainers([renamedBefore, renamedAfter], { visual: () => 0.68 });
  const scroll = result.candidates.find((candidate) => candidate.kind === "scroll-collapse");
  assert.ok(scroll);
  assert.equal(scroll.beforeFrameId, "renamed-before");
  assert.equal(scroll.afterFrameId, "renamed-after");
  assert.equal(scroll.delta.designPx, 360);
});

test("interaction: same board keeps only one scroll representative", () => {
  const { before, after } = mopFrames();
  const secondAfter = { ...after, id: "mop-after-2", name: "Frame 9002" };
  const result = pairContainers([before, after, secondAfter], { visual: () => 0.68 });
  const scroll = result.candidates.filter((candidate) => candidate.kind === "scroll-collapse");
  assert.equal(scroll.length, 1);
});

test("interaction: questions are capped", () => {
  const before = frame("q-before", { nodes: [node("a", "Text", "A", 100)] });
  const after = frame("q-after", { nodes: [node("b", "Text", "B", 100)] });
  const result = pairContainers([before, after], { visual: () => 0.95, maxQuestions: 0 });
  assert.equal(result.questions.length, 0);
});
