import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { penExtractFlows, renderPenFlowMap, synthesizePenFlows } from "../dist/pen/flows.js";
import { figmaGenerateTests } from "../dist/figma/test-gen.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

function screen(id, name, x, { label, flowLabel, width = 390, height = 844 } = {}) {
  const children = [];
  if (flowLabel) {
    children.push({
      id: `${id}-fh`,
      type: "frame",
      name: "Flow/Header",
      children: [{ id: `${id}-ft`, type: "text", content: flowLabel }]
    });
  }
  if (label) children.push({ id: `${id}-t`, type: "text", content: label });
  return { id, type: "frame", name, x, y: 0, width, height, children };
}

function fixtureDoc() {
  return {
    version: "2.20",
    children: [
      {
        id: "b1",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: [
          screen("s1", "Frame 101", 0, { flowLabel: "主頁" }),
          screen("s2", "Frame 102", 420, { label: "主頁-下滑" }),
          screen("s3", "Frame 103", 840, { label: "門市" }),
          { id: "v1", type: "vector", name: "Vector 1" },
          {
            id: "small",
            type: "frame",
            name: "Flow/Note",
            width: 100,
            height: 40,
            children: [{ id: "sn", type: "text", content: "註記" }]
          }
        ]
      },
      {
        id: "b2",
        type: "frame",
        name: "2. 後續",
        x: 0,
        y: 1000,
        children: [
          screen("s4", "Frame 201", 0, { label: "單品頁" }),
          screen("s5", "Frame 202", 420, { label: "單品頁" })
        ]
      }
    ]
  };
}

test("synthesizePenFlows: labels, state merge, inferred chain and fragmentation warnings", () => {
  const result = synthesizePenFlows(fixtureDoc());

  assert.deepEqual(result.synthesis.boards, ["1. 主流程", "2. 後續"]);
  assert.equal(result.synthesis.candidateFrames, 5);
  assert.equal(result.synthesis.genericNamed, 5);
  assert.equal(result.synthesis.labelFromFlowNote, 1);
  assert.equal(result.synthesis.labelFromText, 4);
  assert.equal(result.synthesis.statesMerged, 2);

  assert.deepEqual(
    result.screens.map((entry) => entry.name),
    ["主頁", "門市", "單品頁"]
  );
  assert.deepEqual(
    result.screens[0].states.map((state) => state.label),
    ["主頁-下滑"]
  );
  assert.deepEqual(result.entryScreens, ["主頁"]);
  assert.equal(result.synthesis.inferredEdges, 2);
  assert.deepEqual(
    result.edges.map((edge) => `${edge.from.name} → ${edge.to.name}`),
    ["主頁 → 門市", "門市 → 單品頁"],
    "chain follows board order and canvas layout"
  );
  assert.ok(result.edges.every((edge) => edge.trigger === "INFERRED" && edge.actionType === "INFERRED"));

  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("pen-no-interactions"));
  assert.ok(codes.includes("pen-generic-names"));
  assert.ok(codes.includes("pen-state-merges"));

  const first = synthesizePenFlows(fixtureDoc());
  const second = synthesizePenFlows(fixtureDoc());
  assert.deepEqual(JSON.stringify(first), JSON.stringify(second), "synthesis is deterministic");
});

test("renderPenFlowMap: global map with main chain and states", () => {
  const markdown = renderPenFlowMap({
    file: "design.pen",
    generatedAt: "2026-10-08T00:00:00.000Z",
    result: synthesizePenFlows(fixtureDoc())
  });
  assert.match(markdown, /# Pen 交互地图/);
  assert.match(markdown, /### 1\. 主流程/);
  assert.match(markdown, /主頁（状态：主頁-下滑）/);
  assert.match(markdown, /## 推断主链/);
  assert.match(markdown, /主頁 → 門市 → 單品頁/);
  assert.match(markdown, /\[pen-no-interactions\]/);
});

test("pen_extract_flows: saves flows.json + flow-map.md and feeds the test loop", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "design.pen"), "// pen fixture\n" + JSON.stringify(fixtureDoc()), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await penExtractFlows(runtime, {}));
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.screens, 3);
  assert.equal(payload.counts.inferredEdges, 2);
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));

  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.deepEqual(flows.entryScreens, ["主頁"]);
  assert.deepEqual(
    flows.screens.map((screen) => screen.name),
    ["主頁", "門市", "單品頁"]
  );
  assert.deepEqual(
    flows.screens[0].states.map((state) => state.label),
    ["主頁-下滑"],
    "saved flows.json keeps merged states for review"
  );

  const generated = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(generated.ok, true);
  assert.equal(generated.coverage.complete, true);
  assert.equal(generated.flows.length, 1);
  assert.match(generated.flows[0].name, /主頁 → 門市 → 單品頁/);
});

function walkNodes(doc, visit) {
  const step = (node) => {
    visit(node);
    for (const child of node.children ?? []) step(child);
  };
  for (const child of doc.children ?? []) step(child);
}

test("synthesizePenFlows: interaction signals flip the no-interactions warning", () => {
  const doc = fixtureDoc();
  let tagged = 0;
  walkNodes(doc, (node) => {
    if (tagged === 0 && node.type === "text") {
      node.href = "https://example.com/offer";
      tagged = 1;
    }
  });
  doc.children[0].children[2].metadata = { type: "interaction", target: "s4" };

  const result = synthesizePenFlows(doc);
  assert.equal(result.synthesis.interactionSignals, 2);
  assert.equal(result.synthesis.inferredEdges, 2, "synthesis still proceeds (explicitly annotated)");

  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("pen-interactions-present"));
  assert.ok(!codes.includes("pen-no-interactions"));

  const warning = result.warnings.find((entry) => entry.code === "pen-interactions-present");
  assert.match(warning.message, /未解析/);
  assert.ok((warning.details ?? []).some((line) => line.includes("href")));
  assert.ok((warning.details ?? []).some((line) => line.includes("metadata:interaction")));

  const markdown = renderPenFlowMap({
    file: "design.pen",
    generatedAt: "2026-10-08T00:00:00.000Z",
    result
  });
  assert.match(markdown, /\[pen-interactions-present\]/);
  assert.match(markdown, /交互线索/);
});

test("synthesizePenFlows: blank signal values are not interaction signals", () => {
  const doc = fixtureDoc();
  walkNodes(doc, (node) => {
    if (node.type === "text") node.href = "  ";
  });
  doc.children[0].children[2].interactions = [];
  doc.children[0].children[1].prototype = "";
  doc.children[0].children[1].onClick = false;
  doc.children[0].children[3].hotspot = 0;
  doc.children[0].children[3].metadata = {};

  const result = synthesizePenFlows(doc);
  assert.equal(result.synthesis.interactionSignals, 0);
  const codes = result.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("pen-no-interactions"));
  assert.ok(!codes.includes("pen-interactions-present"));
});

test("pen_extract_flows: interaction signals surface in response and saved artifact", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  const doc = fixtureDoc();
  let tagged = 0;
  walkNodes(doc, (node) => {
    if (tagged === 0 && node.type === "text") {
      node.href = "https://example.com/offer";
      tagged = 1;
    }
  });
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(doc), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await penExtractFlows(runtime, {}));
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.interactionSignals, 1);
  const codes = payload.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("pen-interactions-present"));
  assert.ok(!codes.includes("pen-no-interactions"));

  const saved = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.equal(saved.synthesis.interactionSignals, 1);
  assert.ok(saved.warnings.some((warning) => warning.code === "pen-interactions-present"));
  const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(map, /交互线索/);
});
