import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  collectVisionScreens,
  penExtractFlows,
  renderPenFlowMap,
  screenshotAccounting,
  synthesizePenFlows,
  visionMaxScreens
} from "../dist/pen/flows.js";
import { figmaGenerateTests } from "../dist/figma/test-gen.js";
import { groundNodeId } from "../dist/design/vision.js";
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
  assert.ok(
    result.edges.every((edge) => edge.provenance === "inferred" && edge.confidence === "low"),
    "synthesized edges are inferred/low"
  );
  assert.ok(
    result.screens.every((screen) => screen.provenance === "inferred" && screen.confidence === "low"),
    "synthesized screens are inferred/low"
  );
  const main = result.screens.find((screen) => screen.name === "主頁");
  assert.deepEqual(main.textHints, [
    { text: "主頁", textClass: "annotation", nodeId: "s1-ft" }
  ]);
  const store = result.screens.find((screen) => screen.name === "門市");
  assert.deepEqual(store.textHints, [
    { text: "門市", textClass: "runtime-text", nodeId: "s3-t" }
  ]);

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

  const payload = parseToolResult(await penExtractFlows(runtime, { screens: false }));
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.screens, 3);
  assert.equal(payload.counts.inferredEdges, 2);
  assert.ok(fs.existsSync(payload.savedTo.json));
  assert.ok(fs.existsSync(payload.savedTo.markdown));

  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.deepEqual(flows.entryScreens, ["主頁"]);
  assert.equal(flows.schemaVersion, 3);
  assert.equal(flows.screens[0].provenance, "inferred");
  assert.equal(flows.screens[0].confidence, "low");
  assert.equal(flows.edges[0].provenance, "inferred");
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
  assert.match(generated.flows[0].steps[0], /^探索到达/, "pen synthesis generates exploration steps");
  assert.equal(generated.flows[0].expectations[0].kind, "explore");
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

test("synthesizePenFlows: annotation flood does not crowd out runtime texts", () => {
  const doc = fixtureDoc();
  doc.children[0].children[2].children.unshift(
    ...[1, 2, 3, 4, 5].map((index) => ({
      id: `fa${index}`,
      type: "frame",
      name: "Flow/Note",
      children: [{ id: `fa${index}t`, type: "text", content: `批注${index}` }]
    }))
  );

  const result = synthesizePenFlows(doc);
  const store = result.screens.find((screen) => screen.id === "s3");
  assert.ok(store, "flooded screen is still synthesized");
  assert.ok(
    store.textHints.some((hint) => hint.text === "門市" && hint.textClass === "runtime-text"),
    "runtime text survives an annotation flood"
  );
});

test("synthesizePenFlows: note/context/prompt node texts never become hints", () => {
  const doc = fixtureDoc();
  doc.children[0].children[2].children.push(
    { id: "n1", type: "note", content: "設計注記：此頁可跳轉" },
    { id: "n2", type: "context", content: "Context blurb" },
    { id: "n3", type: "prompt", content: "Prompt text" }
  );

  const result = synthesizePenFlows(doc);
  const store = result.screens.find((screen) => screen.name === "門市");
  assert.deepEqual(
    store.textHints,
    [{ text: "門市", textClass: "runtime-text", nodeId: "s3-t" }],
    "non-text node content stays out of hints"
  );
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

  const payload = parseToolResult(await penExtractFlows(runtime, { screens: false }));
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

test("synthesizePenFlows: acceptance criteria from Flow/AC groups and AC: lines", () => {
  const doc = fixtureDoc();
  doc.children[0].children[2].children.unshift(
    {
      id: "ac1",
      type: "frame",
      name: "Flow/AC",
      children: [{ id: "ac1t", type: "text", content: "確認可下單" }]
    },
    {
      id: "ac2",
      type: "frame",
      name: "Flow/Note",
      children: [{ id: "ac2t", type: "text", content: "AC: 金額正確" }]
    }
  );

  const result = synthesizePenFlows(doc);
  const store = result.screens.find((screen) => screen.id === "s3");
  assert.deepEqual(store.acceptance, ["確認可下單", "金額正確"]);
  const main = result.screens.find((screen) => screen.id === "s1");
  assert.equal(main.acceptance, undefined);
});

// ---------------------------------------------------------------------------
// 屏幕截图（design-screenshots T2）

function pngBytes(id) {
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(String(id))]);
}

function fakeScreenRender(calls, { onlyFirst = false, fail = false } = {}) {
  return async ({ screenIds, outDir }) => {
    calls.count += 1;
    calls.screenIds = screenIds;
    if (fail) {
      return { ok: false, dir: null, files: new Map(), missing: screenIds, error: "pen CLI 未登录" };
    }
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map();
    const ids = onlyFirst ? screenIds.slice(0, 1) : screenIds;
    for (const id of ids) {
      const file = path.join(outDir, `${id}.png`);
      fs.writeFileSync(file, pngBytes(id));
      files.set(id, file);
    }
    return { ok: true, dir: outDir, files, missing: screenIds.filter((id) => !files.has(id)) };
  };
}

async function makePenProject(dotenv = "") {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "design.pen"), "// pen fixture\n" + JSON.stringify(fixtureDoc()), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  return { dir, designDir, runtime };
}

test("pen_extract_flows: 默认渲染截图并嵌入 flow-map.md（幂等）", async () => {
  const { designDir, runtime } = await makePenProject();
  const calls = { count: 0 };
  const payload = parseToolResult(
    await penExtractFlows(runtime, { vision: false }, { render: fakeScreenRender(calls) })
  );
  assert.equal(payload.ok, true);
  assert.equal(calls.count, 1);
  assert.deepEqual(
    calls.screenIds,
    ["s1", "s3", "s4", "s2", "s5"],
    "主屏在前、变体在后（同一次渲染）"
  );
  assert.equal(payload.screenshots.rendered, 5);
  assert.equal(payload.screenshots.skipped, 0);
  assert.equal(payload.screenshots.screens, 3);
  assert.equal(payload.screenshots.states, 2);
  assert.equal(payload.screenshots.dir, "screens/pen-design");
  assert.deepEqual(payload.screenshots.skippedScreens, []);

  const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(map, /<img src="screens\/pen-design\/s1\.png"/);
  assert.match(map, /height="200"/);
  const first = path.join(designDir, "screens", "pen-design", "s1.png");
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.readFileSync(first).subarray(0, 4).toString("hex"), "89504e47");
  const mtime = fs.statSync(first).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 25));
  const again = parseToolResult(
    await penExtractFlows(runtime, { vision: false }, { render: fakeScreenRender(calls) })
  );
  assert.equal(calls.count, 2);
  assert.equal(again.screenshots.rendered, 5);
  assert.equal(fs.statSync(first).mtimeMs, mtime, "同内容跳过重写（mtime 稳定）");
});

test("pen_extract_flows: 截图降级不阻断（通道失败 / 部分缺屏）", async () => {
  const { runtime } = await makePenProject();
  const failed = parseToolResult(
    await penExtractFlows(runtime, { vision: false }, { render: fakeScreenRender({ count: 0 }, { fail: true }) })
  );
  assert.equal(failed.ok, true);
  assert.equal(failed.screenshots.rendered, 0);
  assert.equal(failed.screenshots.skipped, 5);
  assert.ok(failed.warnings.some((warning) => warning.code === "screenshot-render-unavailable"));
  assert.ok(!failed.warnings.some((warning) => warning.code === "screenshot-skipped"));
  const mapFailed = fs.readFileSync(failed.savedTo.markdown, "utf-8");
  assert.doesNotMatch(mapFailed, /<img/);
  assert.match(mapFailed, /截图已跳过/);

  const partial = parseToolResult(
    await penExtractFlows(
      runtime,
      { vision: false },
      { render: fakeScreenRender({ count: 0 }, { onlyFirst: true }) }
    )
  );
  assert.equal(partial.screenshots.rendered, 1);
  assert.equal(partial.screenshots.skipped, 4);
  assert.ok(partial.warnings.some((warning) => warning.code === "screenshot-skipped"));
  const mapPartial = fs.readFileSync(partial.savedTo.markdown, "utf-8");
  assert.match(mapPartial, /<img/);
});

test("pen_extract_flows: screens:false / AOS_SCREENS=0 关闭；显式 true 覆盖 env", async () => {
  const { runtime } = await makePenProject();
  const calls = { count: 0 };
  const off = parseToolResult(
    await penExtractFlows(runtime, { vision: false, screens: false }, { render: fakeScreenRender(calls) })
  );
  assert.equal(calls.count, 0);
  assert.equal(off.screenshots, undefined);
  assert.doesNotMatch(fs.readFileSync(off.savedTo.markdown, "utf-8"), /<img/);

  const { runtime: envRuntime } = await makePenProject("AOS_SCREENS=0\n");
  const envOff = parseToolResult(
    await penExtractFlows(envRuntime, { vision: false }, { render: fakeScreenRender(calls) })
  );
  assert.equal(calls.count, 0);
  assert.equal(envOff.screenshots, undefined);

  const forced = parseToolResult(
    await penExtractFlows(envRuntime, { vision: false, screens: true }, { render: fakeScreenRender(calls) })
  );
  assert.equal(calls.count, 1);
  assert.equal(forced.screenshots.rendered, 5);
});

// ---------------------------------------------------------------------------
// 候选/变体采集与静默路径（no-silent-omission P0）

function boardOf(children) {
  return {
    version: "2.20",
    children: [
      { id: "board", type: "frame", name: "1. 主流程", x: 0, y: 0, children }
    ]
  };
}

function collectionDoc() {
  return boardOf([
    {
      id: "main",
      type: "frame",
      name: "Frame 101",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      children: [
        { id: "main-title", type: "text", content: "主頁" },
        {
          id: "cta",
          type: "frame",
          name: "主要/Button",
          x: 20,
          y: 700,
          width: 200,
          height: 48,
          children: [
            { id: "cta-label", type: "text", content: "立即購買" },
            { id: "cta-icon", type: "image", name: "Bag", x: 0, y: 0, width: 24, height: 24 }
          ]
        },
        {
          id: "cart",
          type: "frame",
          name: "Cart/入口",
          x: 320,
          y: 760,
          width: 48,
          height: 48,
          children: [{ id: "cart-bag", type: "image", name: "Bag", width: 48, height: 48 }]
        },
        {
          id: "flow-note",
          type: "frame",
          name: "Flow/Note",
          children: [{ id: "flow-button", type: "frame", name: "Button", width: 10, height: 10 }]
        }
      ]
    },
    {
      id: "variant",
      type: "frame",
      name: "Frame 102",
      x: 420,
      y: 0,
      width: 390,
      height: 844,
      children: [
        { id: "variant-title", type: "text", content: "主頁-登入" },
        { id: "login", type: "frame", name: "登入 Button", x: 40, y: 600, width: 180, height: 44 }
      ]
    }
  ]);
}

test("collectVisionScreens: >300 几何节点按候选→叶子→容器排序并锁定 grounding 结果", () => {
  const leaves = Array.from({ length: 305 }, (_, index) => ({
    id: `leaf-${index}`,
    type: "frame",
    name: `Leaf ${index}`,
    x: (index % 10) * 30,
    y: 400 + Math.floor(index / 10) * 30,
    width: 20,
    height: 20
  }));
  const doc = boardOf([
    {
      id: "big",
      type: "frame",
      name: "Frame 900",
      x: 0,
      y: 0,
      width: 390,
      height: 1688,
      children: [
        {
          id: "panel",
          type: "frame",
          name: "Panel",
          x: 0,
          y: 0,
          width: 300,
          height: 300,
          children: [{ id: "panel-inner", type: "frame", name: "Inner", x: 0, y: 0, width: 10, height: 10 }]
        },
        ...leaves,
        {
          id: "cta",
          type: "frame",
          name: "主要/Button",
          x: 10,
          y: 350,
          width: 100,
          height: 40,
          children: [{ id: "cta-label", type: "text", content: "购买" }]
        }
      ]
    }
  ]);
  const collected = collectVisionScreens(doc, [{ id: "big", name: "大屏", states: [] }]);
  const target = collected.targets[0];
  assert.equal(target.designNodes, 309, "全部访问到的非 Flow 节点都计数");
  assert.equal(target.nodes.length, 300);
  assert.equal(collected.groundingTruncated, 8);
  assert.equal(target.nodes[0].id, "cta", "候选优先于插入顺序");
  assert.deepEqual(
    target.nodes.slice(0, 3).map((node) => node.id),
    ["cta", "panel-inner", "leaf-0"],
    "候选 → 叶子（遍历序）"
  );
  assert.equal(target.nodes.at(-1).id, "leaf-297", "300 上限保留前 298 个叶子");
  assert.equal(groundNodeId({ x: 210, y: 1270, width: 20, height: 20 }, target), "leaf-297");
  assert.ok(
    !target.nodes.some((node) => node.id === "panel"),
    "容器兜底且超过 300 时不进入 grounding"
  );
  assert.equal(
    groundNodeId({ x: 0, y: 0, width: 300, height: 300 }, target),
    undefined,
    "容器被挤出 grounding（旧行为会命中 panel）"
  );
  assert.equal(groundNodeId({ x: 10, y: 350, width: 100, height: 40 }, target), "cta");
});

test("collectVisionScreens: ref/reusable 无词表命名也是候选；嵌套只留最外层", () => {
  const doc = boardOf([
    {
      id: "components",
      type: "frame",
      name: "Frame 300",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
      children: [
        { id: "ref-generic", type: "ref", name: "Header 1", x: 0, y: 0, width: 100, height: 40 },
        { id: "reusable-generic", type: "frame", reusable: true, x: 0, y: 60, width: 100, height: 40 },
        {
          id: "outer-ref",
          type: "ref",
          name: "Card",
          x: 0,
          y: 120,
          width: 100,
          height: 100,
          children: [{ id: "inner-ref", type: "ref", name: "Nested", x: 10, y: 10, width: 20, height: 20 }]
        },
        { id: "anon-ref", type: "ref", x: 0, y: 240, width: 40, height: 40 }
      ]
    }
  ]);
  const collected = collectVisionScreens(doc, [{ id: "components", name: "元件屏", states: [] }]);
  const target = collected.targets[0];
  assert.deepEqual(
    target.candidates.map((candidate) => candidate.id),
    ["ref-generic", "reusable-generic", "outer-ref", "anon-ref"]
  );
  assert.equal(
    target.candidates.find((candidate) => candidate.id === "anon-ref").name,
    "ref",
    "无名称时回退 type"
  );
  assert.ok(
    !target.candidates.some((candidate) => candidate.id === "inner-ref"),
    "嵌套 ref 不重复采集"
  );
});

test("collectVisionScreens: 帧缺 id/重复 id → excluded frame-missing + duplicateIds，不静默 continue", () => {
  const doc = boardOf([
    { id: "dup", type: "frame", name: "重複 A", width: 390, height: 844, children: [] },
    { id: "dup", type: "frame", name: "重複 B", width: 390, height: 844, children: [] }
  ]);
  const collected = collectVisionScreens(doc, [
    { id: "ghost", name: "幽靈屏", states: [] },
    { id: "", name: "無 id 屏", states: [] },
    { id: "dup", name: "重複屏", states: [] }
  ]);

  assert.deepEqual(collected.duplicateIds, ["dup"]);
  assert.deepEqual(
    collected.targets.map((target) => target.id),
    ["dup"]
  );
  const ghost = collected.excluded.find((entry) => entry.screenId === "ghost");
  assert.equal(ghost.reason, "frame-missing");
  assert.equal(ghost.screenName, "幽靈屏");
  assert.equal(ghost.state, null);
  assert.deepEqual(ghost.candidates, []);
  assert.equal(ghost.designNodes, 0);
  assert.ok(
    collected.excluded.some((entry) => entry.screenId === "" && entry.reason === "frame-missing"),
    "缺 id 的屏同样具名进入 excluded（不静默 continue）"
  );
});

test("collectVisionScreens: 主屏在前、states 在后；state target 带 stateOf/stateName", () => {
  const doc = collectionDoc();
  const screens = [
    {
      id: "main",
      name: "主頁",
      states: [{ id: "variant", label: "主頁-登入", frameName: "Frame 102" }]
    }
  ];
  const collected = collectVisionScreens(doc, screens);
  assert.deepEqual(
    collected.targets.map((target) => target.id),
    ["main", "variant"],
    "主屏先于变体"
  );
  const [main, variant] = collected.targets;
  assert.equal(main.stateOf, undefined);
  assert.equal(main.stateName, undefined);
  assert.ok(main.candidates.every((candidate) => candidate.state === null));
  assert.equal(variant.stateOf, "main");
  assert.equal(variant.stateName, "主頁-登入");
  assert.ok(
    variant.candidates.every((candidate) => candidate.state === "主頁-登入"),
    "变体候选归属该 state"
  );
  assert.deepEqual(
    variant.candidates.map((candidate) => candidate.id),
    ["login"]
  );
});

test("collectVisionScreens: Button/Icon/Bag 候选命中；Flow/* 排除；嵌套保留最外层", () => {
  const doc = collectionDoc();
  const collected = collectVisionScreens(doc, [
    { id: "main", name: "主頁", states: [] }
  ]);
  const target = collected.targets[0];
  assert.deepEqual(
    target.candidates.map((candidate) => candidate.id),
    ["cta", "cart"],
    "命中 Button/Cart 且嵌套的 Bag 不重复采集"
  );
  const cta = target.candidates[0];
  assert.equal(cta.name, "主要/Button");
  assert.deepEqual(cta.bbox, { x: 20, y: 700, width: 200, height: 48 });
  assert.deepEqual(cta.textHints, ["立即購買"], "文本提示来自候选子树");
  assert.ok(
    !target.candidates.some((candidate) => candidate.id.startsWith("flow-")),
    "Flow/* 子树整体排除"
  );
  assert.ok(
    !target.candidates.some((candidate) => candidate.id === "cart-bag"),
    "嵌套候选保留最外层（Cart 而非 Bag）"
  );
  assert.deepEqual(
    target.nodes.slice(0, 2).map((node) => node.id),
    ["cta", "cart"],
    "grounding 节点候选优先"
  );
});

test("collectVisionScreens: auto-layout 无几何候选 bbox 缺省；200 上限 candidatesTruncated", () => {
  const buttons = Array.from({ length: 250 }, (_, index) => ({
    id: `btn-${index + 1}`,
    type: "frame",
    name: `Button ${index + 1}`,
    x: index + 1,
    y: 10,
    width: 40,
    height: 40
  }));
  const doc = boardOf([
    {
      id: "auto",
      type: "frame",
      name: "Frame 201",
      x: 0,
      y: 0,
      width: "fill_container",
      children: [
        { id: "no-size", type: "frame", name: "Bag", x: 10, y: 10 },
        ...buttons
      ]
    }
  ]);
  const screens = [{ id: "auto", name: "自動佈局", states: [] }];
  const collected = collectVisionScreens(doc, screens, () => ({ width: 390, height: 844 }));
  assert.equal(collected.targets.length, 1);
  assert.equal(collected.targets[0].width, 390);
  assert.equal(collected.targets[0].height, 844);
  assert.equal(collected.targets[0].candidates.length, 200);
  assert.equal(collected.candidatesTruncated, 51);
  assert.equal(collected.targets[0].candidates[0].id, "no-size");
  assert.equal(
    collected.targets[0].candidates[0].bbox,
    undefined,
    "x/y 齐全但缺 w/h 时不给 bbox（不可核验，不伪造）"
  );

  const noFallback = collectVisionScreens(doc, screens);
  assert.equal(noFallback.targets.length, 0);
  assert.equal(noFallback.excluded[0].reason, "no-geometry");
  assert.ok(noFallback.excluded[0].candidates.length > 0, "excluded 保留已采集候选");
  assert.ok(noFallback.excluded[0].designNodes > 0);
});

test("collectVisionScreens: state 帧缺失 → excluded frame-missing（statesFrameMissing 可计）", () => {
  const doc = collectionDoc();
  const collected = collectVisionScreens(doc, [
    {
      id: "main",
      name: "主頁",
      states: [{ id: "ghost-state", label: "主頁-錯誤", frameName: "Frame 999" }]
    }
  ]);
  assert.deepEqual(
    collected.targets.map((target) => target.id),
    ["main"]
  );
  const missing = collected.excluded.find((entry) => entry.screenId === "ghost-state");
  assert.equal(missing.reason, "frame-missing");
  assert.equal(missing.screenName, "主頁");
  assert.equal(missing.state, "主頁-錯誤");
  assert.equal(
    collected.excluded.filter((entry) => entry.state !== null).length,
    1,
    "statesFrameMissing 可由 excluded 的 state 计数得出"
  );
});

test("renderPenFlowMap: 每屏/变体一行覆盖摘要（识别/候选/覆盖/未覆盖/不可核验/未评估）", () => {
  const result = synthesizePenFlows(fixtureDoc());
  const main = result.screens.find((entry) => entry.name === "主頁");
  main.elements = [
    {
      id: "vision-s1-1",
      class: "cta",
      intent: "submit",
      label: "提交",
      nodeId: "s1-t",
      provenance: "vision-inferred",
      confidence: "low"
    }
  ];
  main.elementsCoverage = [
    {
      state: null,
      designNodes: 2,
      candidateNodes: 2,
      recognizedElements: 1,
      groundedElements: 1,
      ungroundedElements: 0,
      coveredCandidates: 1,
      uncoveredCandidates: 1,
      unverifiableCandidates: 0,
      notEvaluatedCandidates: 0,
      details: []
    }
  ];
  const state = main.states.find((entry) => entry.label === "主頁-下滑");
  state.elementsCoverage = [
    {
      state: "主頁-下滑",
      designNodes: 1,
      candidateNodes: 1,
      recognizedElements: 0,
      groundedElements: 0,
      ungroundedElements: 0,
      coveredCandidates: 0,
      uncoveredCandidates: 0,
      unverifiableCandidates: 0,
      notEvaluatedCandidates: 1,
      notEvaluated: true,
      notEvaluatedReason: "capped",
      details: []
    }
  ];
  result.screens.push({
    id: "ghost",
    name: "缺失屏",
    suggestedRoute: "/ghost",
    childNames: [],
    textHints: [],
    sourceBoard: "1. 主流程",
    sourceFrameName: "Frame 999",
    inferredName: false,
    states: [],
    elementsCoverage: [
      {
        state: null,
        designNodes: 0,
        candidateNodes: 0,
        recognizedElements: 0,
        groundedElements: 0,
        ungroundedElements: 0,
        coveredCandidates: 0,
        uncoveredCandidates: 0,
        unverifiableCandidates: 0,
        notEvaluatedCandidates: 0,
        notEvaluated: true,
        notEvaluatedReason: "frame-missing",
        details: []
      }
    ],
    provenance: "inferred",
    confidence: "low"
  });

  const markdown = renderPenFlowMap({
    file: "design.pen",
    generatedAt: "2026-10-08T00:00:00.000Z",
    result
  });
  assert.match(markdown, /覆盖：识别 1 · 候选 2 · 覆盖 1 · 未覆盖 1 · 不可核验 0 · 未评估 0/);
  assert.match(markdown, /状态「主頁-下滑」/);
  assert.match(
    markdown,
    /覆盖：识别 0 · 候选 1 · 覆盖 0 · 未覆盖 0 · 不可核验 0 · 未评估 1（未评估：capped）/,
    "变体未评估原因可见"
  );
  assert.match(
    markdown,
    /覆盖：识别 0 · 候选 0 · 覆盖 0 · 未覆盖 0 · 不可核验 0 · 未评估 0（未评估：frame-missing）/,
    "零候选的排除 target 也标出未评估原因"
  );
});

test("screenshotAccounting: 请求 = 渲染 + 跳过；人为破坏 → mismatch 数字入消息", () => {
  const ok = screenshotAccounting({ screens: 3, states: 2, rendered: 4, skipped: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.requested, 5);

  const broken = screenshotAccounting({ screens: 3, states: 2, rendered: 4, skipped: 0 });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /请求 5/);
  assert.match(broken.message, /渲染 4 \+ 跳过 0/);
  assert.match(broken.message, /主屏 3/);
  assert.match(broken.message, /变体 2/);
});

test("visionMaxScreens: AOS_VISION_MAX_TARGETS 优先于旧名；0/all 不限", () => {
  assert.equal(visionMaxScreens({ AOS_VISION_MAX_TARGETS: "3" }), 3);
  assert.equal(
    visionMaxScreens({ AOS_VISION_MAX_TARGETS: "3", AOS_VISION_MAX_SCREENS: "1" }),
    3
  );
  assert.equal(visionMaxScreens({ AOS_VISION_MAX_SCREENS: "7" }), 7);
  assert.equal(visionMaxScreens({ AOS_VISION_MAX_TARGETS: "0" }), Number.POSITIVE_INFINITY);
  assert.equal(visionMaxScreens({ AOS_VISION_MAX_TARGETS: "all" }), Number.POSITIVE_INFINITY);
  assert.equal(visionMaxScreens({ AOS_VISION_MAX_TARGETS: "unlimited" }), Number.POSITIVE_INFINITY);
});
