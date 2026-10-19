import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { penExtractFlows } from "../dist/pen/flows.js";
import { figmaGenerateTests } from "../dist/figma/test-gen.js";
import {
  accountingWarnings,
  isVisionCapableModel,
  parseVisionReply,
  runVisionPass,
  visionAccounting
} from "../dist/design/vision.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

/** Shopping-bag fixture: home screen with an icon-only cart FAB (badge "2"),
 * a plain store screen, and no interaction data anywhere (ADR-0010). */
function visionDoc() {
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
          {
            id: "home",
            type: "frame",
            name: "Frame 101",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            children: [
              { id: "home-title", type: "text", content: "主頁" },
              {
                id: "cart-fab",
                type: "frame",
                name: "Cart FAB",
                x: 300,
                y: 760,
                width: 60,
                height: 60,
                children: [
                  { id: "cart-icon", type: "image", name: "bag", url: "./bag.png", width: 60, height: 60 },
                  { id: "cart-badge", type: "rectangle", name: "Badge", x: 40, y: 0, width: 20, height: 20 },
                  { id: "cart-count", type: "text", content: "2" }
                ]
              }
            ]
          },
          {
            id: "store",
            type: "frame",
            name: "Frame 102",
            x: 420,
            y: 0,
            width: 390,
            height: 844,
            children: [{ id: "store-title", type: "text", content: "門市" }]
          }
        ]
      }
    ]
  };
}

const CART_BBOX = { x: 300 / 390, y: 760 / 844, width: 60 / 390, height: 60 / 844 };

/** Auto-layout screens carry `fill_container` / `fit_content` widths and often
 * no height at all; the rendered PNG is the only source of their pixel size. */
function autoLayoutDoc() {
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
          {
            id: "home",
            type: "frame",
            name: "Frame 101",
            x: 0,
            y: 0,
            width: "fill_container",
            children: [
              { id: "home-title", type: "text", content: "主頁" },
              { id: "cart-fab", type: "frame", name: "Cart FAB", x: 300, y: 760, width: 60, height: 60 }
            ]
          },
          {
            id: "store",
            type: "frame",
            name: "Frame 102",
            x: 420,
            y: 0,
            width: "fill_container",
            children: [{ id: "store-title", type: "text", content: "門市" }]
          }
        ]
      }
    ]
  };
}

/** Minimal PNG header carrying real IHDR dimensions (enough for the store and
 * the dimension reader; pixel data is never decoded here). */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function sizedRender(width, height) {
  return async ({ screenIds, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map();
    for (const id of screenIds) {
      const file = path.join(outDir, `${id}.png`);
      fs.writeFileSync(file, pngHeader(width, height));
      files.set(id, file);
    }
    return { ok: true, dir: outDir, files, missing: [] };
  };
}

/** Many flat screens: no text, unique layer names, no state merging. */
function manyScreensDoc(count) {
  return {
    version: "2.20",
    children: [
      {
        id: "board",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: Array.from({ length: count }, (_, index) => ({
          id: `screen${index + 1}`,
          type: "frame",
          name: `Screen${index + 1}`,
          x: index * 400,
          y: 0,
          width: 390,
          height: 844,
          children: [{ id: `label${index + 1}`, type: "text", content: `頁面${index + 1}` }]
        }))
      }
    ]
  };
}

function makeProject({ dotenv = "" } = {}) {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(visionDoc()), "utf-8");
  return dir;
}

/** Same screen with a merged state variant: synthesis keeps it out of
 * `screens` but vision/states must still be rendered and processed. */
function statefulDoc() {
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
          {
            id: "home",
            type: "frame",
            name: "Frame 101",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            children: [{ id: "home-title", type: "text", content: "主頁" }]
          },
          {
            id: "home-loading",
            type: "frame",
            name: "Frame 102",
            x: 420,
            y: 0,
            width: 390,
            height: 844,
            children: [
              { id: "loading-title", type: "text", content: "主頁-載入" },
              { id: "loading-cta", type: "frame", name: "取消 Button", x: 40, y: 600, width: 180, height: 44 }
            ]
          },
          {
            id: "store",
            type: "frame",
            name: "Frame 103",
            x: 840,
            y: 0,
            width: 390,
            height: 844,
            children: [{ id: "store-title", type: "text", content: "門市" }]
          }
        ]
      }
    ]
  };
}

function makeProjectWithDoc(doc, { dotenv = "" } = {}) {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(doc), "utf-8");
  return dir;
}

function fakeChat() {
  return async (messages) => {
    const text = messages[1].content[0].text;
    if (text.includes("主頁")) {
      return JSON.stringify({
        elements: [
          { class: "cart-entry", intent: "navigate", label: "购物袋", bbox: CART_BBOX, confidence: 0.9 }
        ]
      });
    }
    return JSON.stringify({ elements: [] });
  };
}

function fakeRender() {
  return async ({ screenIds, outDir }) => {
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map();
    for (const id of screenIds) {
      const file = path.join(outDir, `${id}.png`);
      fs.writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
      files.set(id, file);
    }
    return { ok: true, dir: outDir, files, missing: [] };
  };
}

test("vision: grounds the cart entry, emits an unresolved edge and feeds exploration cases", async () => {
  const dir = makeProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const renderCalls = { count: 0 };
  const countingRender = async (input) => {
    renderCalls.count += 1;
    return fakeRender()(input);
  };
  const payload = parseToolResult(
    await penExtractFlows(runtime, { vision: "auto" }, { chat: fakeChat(), render: countingRender })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.counts.visionElements, 1);
  assert.equal(payload.counts.visionEdges, 1);
  assert.equal(payload.vision.active, true);
  assert.equal(payload.vision.screensProcessed, 2);
  assert.equal(payload.vision.failures, 0);
  assert.equal(renderCalls.count, 1, "截图与 vision 共享同一次渲染");

  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.equal(flows.schemaVersion, 3);
  const home = flows.screens.find((screen) => screen.name === "主頁");
  assert.equal(home.elements.length, 1);
  const element = home.elements[0];
  assert.equal(element.class, "cart-entry");
  assert.equal(element.intent, "navigate");
  assert.equal(element.label, "购物袋");
  assert.equal(element.nodeId, "cart-fab", "bbox grounds onto the design node");
  assert.equal(element.provenance, "vision-inferred");
  assert.equal(element.confidence, "low");
  assert.match(element.evidence.render, /\.artemis\/design\/screens\//);

  const visionEdge = flows.edges.find((edge) => edge.trigger === "VISION");
  assert.ok(visionEdge, "vision edge persisted");
  assert.equal(visionEdge.to, null, "destination stays unresolved (no guessing)");
  assert.equal(visionEdge.provenance, "vision-inferred");
  assert.equal(visionEdge.element.name, "购物袋");
  assert.equal(flows.unresolvedDestinations.length, 1);
  assert.match(flows.unresolvedDestinations[0], /主頁 · 购物袋/);

  const codes = payload.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("vision-no-elements"), "empty screen reports explicitly");
  assert.ok(!codes.includes("vision-unavailable"));

  const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(map, /## 视觉识别（vision-inferred）/);
  assert.match(map, /\[cart-entry\/navigate\] 购物袋 → cart-fab/);

  const generated = parseToolResult(await figmaGenerateTests(runtime, { save: false }));
  assert.equal(generated.ok, true);
  assert.equal(generated.coverage.complete, true, "vision edges never gate the hard coverage");
  const cartCase = generated.flows.find((flowCase) => flowCase.steps.some((step) => /购物袋/.test(step)));
  assert.ok(cartCase, "the unresolved vision edge keeps its exploration case");
  const cartIndex = cartCase.steps.findIndex((step) => /购物袋/.test(step));
  assert.match(cartCase.steps[cartIndex], /^探索未知跳转「购物袋」/);
  assert.equal(cartCase.expectations[cartIndex].kind, "explore");
});

test("vision: explicit false disables the pass without warnings", async () => {
  const dir = makeProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { vision: false }, { chat: fakeChat(), render: fakeRender() })
  );
  assert.equal(payload.counts.visionElements, 0);
  assert.equal(payload.counts.visionEdges, 0);
  assert.equal(payload.vision.active, false);
  assert.ok(!payload.warnings.some((warning) => warning.code.startsWith("vision-")));
  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.equal(flows.screens[0].elements, undefined);
});

test("vision: no usable active LLM degrades explicitly (auto)", async () => {
  const dir = makeProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await penExtractFlows(runtime, { screens: false }));
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, false);
  assert.equal(payload.counts.visionElements, 0);
  const codes = payload.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("vision-unavailable"), "silent skip is forbidden");
  assert.match(
    payload.warnings.find((warning) => warning.code === "vision-unavailable").message,
    /视觉识别已跳过/
  );
});

test("vision: auto passes the gate for deepseek-flash and uses the real chat channel", async () => {
  const dir = makeProject({
    dotenv:
      "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com\nAOS_LLM_API_KEY=sk-vision-test\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const body = JSON.parse(String(init.body));
    requests.push({ href, body });
    if (href !== "https://api.deepseek.com/chat/completions") {
      throw new Error(`unexpected fetch ${href}`);
    }
    const prompt = body.messages[1].content[0].text;
    const elements = prompt.includes("主頁")
      ? [{ class: "cart-entry", intent: "navigate", label: "购物袋", bbox: CART_BBOX, confidence: 0.9 }]
      : [];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ elements }) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const payload = parseToolResult(await penExtractFlows(runtime, {}, { render: fakeRender() }));
    assert.equal(payload.ok, true);
    assert.equal(payload.vision.active, true, "auto 不再被模型名假阴性挡住");
    assert.equal(payload.counts.visionElements, 1);
    assert.equal(payload.counts.visionEdges, 1);
    assert.ok(!payload.warnings.map((warning) => warning.code).includes("vision-unavailable"));

    assert.equal(requests.length, 2, "每屏一次 chat 调用");
    assert.equal(requests[0].href, "https://api.deepseek.com/chat/completions");
    assert.equal(requests[0].body.model, "deepseek-flash");
    const blocks = requests[0].body.messages[1].content;
    assert.ok(
      blocks.some((block) => block.type === "image_url" && /^data:image\/png;base64,/.test(block.image_url.url)),
      "渲染图以 image_url 附在 user 消息"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("vision: AOS_LLM_VISION=0 声明优先于启发式，auto 不探测直接跳过", async () => {
  const dir = makeProject({
    dotenv:
      "AOS_LLM_VISION=0\nAOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com\nAOS_LLM_API_KEY=sk-vision-test\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("declared-no must not probe");
  };
  try {
    const payload = parseToolResult(await penExtractFlows(runtime, {}, { render: fakeRender() }));
    assert.equal(payload.vision.active, false);
    assert.equal(fetchCalls, 0, "声明为无视觉时不应发探测请求");
    assert.match(
      payload.warnings.find((warning) => warning.code === "vision-unavailable").message,
      /AOS_LLM_VISION/
    );
    assert.ok(!fs.existsSync(path.join(dir, ".artemis", "llm-capabilities.json")), "声明不是探测结论，不写缓存");
  } finally {
    globalThis.fetch = original;
  }
});

test("vision: 未知模型被拒（400 不支持图片）→ 中止并记录缓存，下一次不再探测", async () => {
  const dir = makeProject({
    dotenv:
      "AOS_LLM_MODEL=my-gateway-model\nAOS_LLM_BASE_URL=https://gw.example.com/v1\nAOS_LLM_API_KEY=sk-gw\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ error: { message: "This model does not support image" } }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  };
  try {
    const first = parseToolResult(await penExtractFlows(runtime, {}, { render: fakeRender() }));
    assert.equal(first.vision.active, false);
    assert.equal(calls.length, 1, "首个屏幕被拒后不再继续对后续屏幕发请求");
    assert.equal(first.vision.screensSkipped, 2, "当前屏 + 其后未处理屏都进 skipped");
    assert.equal(first.vision.screensFailed, 0, "拒图不属于 failed 桶");
    assert.equal(first.vision.screensInput, 2);
    assert.equal(first.vision.screensRequested, 2);
    assert.equal(first.vision.accounting.ok, true);
    const codes = first.warnings.map((warning) => warning.code);
    assert.ok(codes.includes("vision-model-rejected"), "保留原始拒绝证据");
    assert.ok(codes.includes("vision-unavailable"), "对外仍是明确的不可用降级");

    const cache = JSON.parse(
      fs.readFileSync(path.join(dir, ".artemis", "llm-capabilities.json"), "utf-8")
    );
    assert.equal(cache.entries["https://gw.example.com/v1|my-gateway-model"].vision, false);

    const callsBefore = calls.length;
    const second = parseToolResult(await penExtractFlows(runtime, {}, { render: fakeRender() }));
    assert.equal(second.vision.active, false);
    assert.equal(calls.length, callsBefore, "缓存命中后不再发探测请求");
    assert.match(
      second.warnings.find((warning) => warning.code === "vision-unavailable").message,
      /已记录/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("vision: 未知模型尝试成功 → 记录能力缓存（下一次跳过重探）", async () => {
  const dir = makeProject({
    dotenv:
      "AOS_LLM_MODEL=my-gateway-model\nAOS_LLM_BASE_URL=https://gw.example.com/v1\nAOS_LLM_API_KEY=sk-gw\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const prompt = body.messages[1].content[0].text;
    const elements = prompt.includes("主頁")
      ? [{ class: "cart-entry", intent: "navigate", label: "购物袋", bbox: CART_BBOX, confidence: 0.9 }]
      : [];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ elements }) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const payload = parseToolResult(await penExtractFlows(runtime, {}, { render: fakeRender() }));
    assert.equal(payload.vision.active, true);
    assert.equal(payload.counts.visionElements, 1);
    const cache = JSON.parse(
      fs.readFileSync(path.join(dir, ".artemis", "llm-capabilities.json"), "utf-8")
    );
    assert.equal(cache.entries["https://gw.example.com/v1|my-gateway-model"].vision, true, "成功即学习");
  } finally {
    globalThis.fetch = original;
  }
});

test("vision: AOS_VISION=0 disables the pass with an explicit warning", async () => {
  const dir = makeProject({ dotenv: "AOS_VISION=0\n" });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, {}, { chat: fakeChat(), render: fakeRender() })
  );
  assert.equal(payload.vision.active, false);
  assert.ok(payload.warnings.some((warning) => warning.code === "vision-disabled-by-env"));
  assert.equal(payload.counts.visionElements, 0);
});

test("vision: 未进入 pass 的候选仍落 not-evaluated（vision-off / unavailable / render-missing）", async () => {
  const offProject = makeProject();
  const offRuntime = (await loadTestRuntime(offProject, { proxy: new StubProxy() })).runtime;
  const off = parseToolResult(
    await penExtractFlows(offRuntime, { vision: false, screens: false })
  );
  const offFlows = JSON.parse(fs.readFileSync(off.savedTo.json, "utf-8"));
  const offCoverage = offFlows.screens
    .find((screen) => screen.name === "主頁")
    .elementsCoverage[0];
  assert.equal(offCoverage.notEvaluated, true);
  assert.equal(offCoverage.notEvaluatedReason, "vision-off");
  assert.equal(offCoverage.coveredCandidates, 0);
  assert.equal(offCoverage.notEvaluatedCandidates, 1);
  assert.deepEqual(
    offCoverage.details.map((detail) => [detail.status, detail.reason]),
    [["not-evaluated", "vision-off"]]
  );

  const unavailableProject = makeProject();
  const unavailableRuntime = (
    await loadTestRuntime(unavailableProject, { proxy: new StubProxy() })
  ).runtime;
  const unavailable = parseToolResult(
    await penExtractFlows(unavailableRuntime, { screens: false })
  );
  const unavailableFlows = JSON.parse(fs.readFileSync(unavailable.savedTo.json, "utf-8"));
  const unavailableCoverage = unavailableFlows.screens
    .find((screen) => screen.name === "主頁")
    .elementsCoverage[0];
  assert.equal(unavailableCoverage.notEvaluatedReason, "vision-unavailable");
  assert.equal(unavailableCoverage.coveredCandidates, 0);

  const renderProject = makeProject();
  const renderRuntime = (await loadTestRuntime(renderProject, { proxy: new StubProxy() })).runtime;
  const renderFailed = parseToolResult(
    await penExtractFlows(
      renderRuntime,
      { screens: false },
      {
        chat: fakeChat(),
        render: async () => ({
          ok: false,
          dir: null,
          files: new Map(),
          missing: ["home", "store"],
          error: "pen CLI 未登录"
        })
      }
    )
  );
  const renderFlows = JSON.parse(fs.readFileSync(renderFailed.savedTo.json, "utf-8"));
  const renderCoverage = renderFlows.screens
    .find((screen) => screen.name === "主頁")
    .elementsCoverage[0];
  assert.equal(renderCoverage.notEvaluatedReason, "render-missing");
  assert.equal(renderCoverage.coveredCandidates, 0);
  assert.ok(
    renderCoverage.details.every((detail) => detail.status === "not-evaluated"),
    "渲染失败不得伪造 covered"
  );
});

test("vision: AOS_VISION_CANDIDATE_TOKENS 项目 .env 与进程 env 都能追加词表", async () => {
  const doc = {
    version: "2.20",
    children: [
      {
        id: "b1",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: [
          {
            id: "promo-screen",
            type: "frame",
            name: "Frame 500",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            children: [
              {
                id: "promo-banner",
                type: "frame",
                name: "Promo/Banner",
                x: 20,
                y: 20,
                width: 200,
                height: 80
              }
            ]
          }
        ]
      }
    ]
  };

  const withToken = makeProjectWithDoc(doc, {
    dotenv: "AOS_VISION_CANDIDATE_TOKENS=Promo\n"
  });
  const tokenRuntime = (await loadTestRuntime(withToken, { proxy: new StubProxy() })).runtime;
  const tokenPayload = parseToolResult(
    await penExtractFlows(tokenRuntime, { vision: false, screens: false })
  );
  const tokenFlows = JSON.parse(fs.readFileSync(tokenPayload.savedTo.json, "utf-8"));
  assert.equal(
    tokenFlows.screens[0].elementsCoverage[0].candidateNodes,
    1,
    "项目 .env 的追加词命中 Promo/Banner"
  );

  const withoutToken = makeProjectWithDoc(doc);
  const plainRuntime = (await loadTestRuntime(withoutToken, { proxy: new StubProxy() })).runtime;
  const plainPayload = parseToolResult(
    await penExtractFlows(plainRuntime, { vision: false, screens: false })
  );
  const plainFlows = JSON.parse(fs.readFileSync(plainPayload.savedTo.json, "utf-8"));
  assert.equal(plainFlows.screens[0].elementsCoverage[0].candidateNodes, 0);

  const original = process.env.AOS_VISION_CANDIDATE_TOKENS;
  process.env.AOS_VISION_CANDIDATE_TOKENS = "Promo";
  try {
    const envRuntime = (await loadTestRuntime(withoutToken, { proxy: new StubProxy() })).runtime;
    const envPayload = parseToolResult(
      await penExtractFlows(envRuntime, { vision: false, screens: false })
    );
    const envFlows = JSON.parse(fs.readFileSync(envPayload.savedTo.json, "utf-8"));
    assert.equal(
      envFlows.screens[0].elementsCoverage[0].candidateNodes,
      1,
      "进程 env 回退同样生效"
    );
  } finally {
    if (original === undefined) delete process.env.AOS_VISION_CANDIDATE_TOKENS;
    else process.env.AOS_VISION_CANDIDATE_TOKENS = original;
  }
});

test("vision: 零候选兜底按全部设计节点计数（auto-layout 无完整几何也告警）", async () => {
  const doc = {
    version: "2.20",
    children: [
      {
        id: "b1",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: [
          {
            id: "auto",
            type: "frame",
            name: "Frame 600",
            x: 0,
            y: 0,
            width: "fill_container",
            children: [
              { id: "auto-title", type: "text", content: "主頁" },
              { id: "auto-a", type: "frame", name: "Frame 1", x: 0, y: 40 },
              { id: "auto-b", type: "frame", name: "Frame 2", x: 0, y: 80 }
            ]
          }
        ]
      }
    ]
  };
  const dir = makeProjectWithDoc(doc);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      { screens: false },
      { chat: silentChat, render: sizedRender(390, 844) }
    )
  );
  assert.equal(payload.ok, true);
  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  const coverage = flows.screens[0].elementsCoverage[0];
  assert.equal(coverage.designNodes, 3, "无几何子节点也计入");
  assert.equal(coverage.candidateNodes, 0);
  assert.equal(coverage.notEvaluated, undefined);
  assert.equal(payload.vision.candidateNodes, 0);
  const warning = payload.warnings.find(
    (entry) => entry.code === "vision-candidate-vocabulary-unmatched"
  );
  assert.ok(warning, "零候选但设计节点 > 0 必须告警");
  assert.match(warning.message, /3 个设计节点/);
});

test("vision: 重复节点 id 告警码对齐 pen-duplicate-node-ids（last-wins）", async () => {
  const doc = {
    version: "2.20",
    children: [
      {
        id: "b1",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: [
          { id: "dup", type: "frame", name: "Frame 701", x: 0, y: 0, width: 390, height: 844 },
          { id: "dup", type: "frame", name: "Frame 702", x: 420, y: 0, width: 390, height: 844 }
        ]
      }
    ]
  };
  const dir = makeProjectWithDoc(doc);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      { screens: false },
      { chat: silentChat, render: sizedRender(390, 844) }
    )
  );
  const warning = payload.warnings.find((entry) => entry.code === "pen-duplicate-node-ids");
  assert.ok(warning, "重复 id 不静默");
  assert.match(warning.message, /last-wins/);
  assert.deepEqual(warning.details, ["dup"]);
});

test("vision: render channel failure and per-screen call failure degrade without aborting", async () => {
  const dir = makeProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const renderFailed = parseToolResult(
    await penExtractFlows(
      runtime,
      {},
      { chat: fakeChat(), render: async () => ({ ok: false, dir: null, files: new Map(), missing: ["home", "store"], error: "pen CLI 未登录" }) }
    )
  );
  assert.equal(renderFailed.ok, true);
  assert.equal(renderFailed.vision.active, false);
  assert.ok(renderFailed.warnings.some((warning) => warning.code === "vision-render-unavailable"));

  const flakyChat = async (messages) => {
    const text = messages[1].content[0].text;
    if (text.includes("主頁")) throw new Error("HTTP 429");
    return JSON.stringify({ elements: [] });
  };
  const callFailed = parseToolResult(
    await penExtractFlows(runtime, {}, { chat: flakyChat, render: fakeRender() })
  );
  assert.equal(callFailed.ok, true);
  assert.equal(callFailed.vision.active, true);
  assert.equal(callFailed.vision.failures, 1);
  assert.equal(callFailed.vision.screensFailed, 1);
  assert.equal(callFailed.vision.screensProcessed, 1);
  assert.equal(callFailed.vision.screensRequested, 2);
  assert.equal(callFailed.vision.accounting.ok, true);
  assert.equal(callFailed.counts.visionElements, 0);
  const failure = callFailed.warnings.find((warning) => warning.code === "vision-call-failed");
  assert.match(failure.message, /主頁.*HTTP 429/);
});

test("vision: AOS_VISION_MAX_SCREENS caps the pass with an explicit warning", async () => {
  const dir = makeProject({ dotenv: "AOS_VISION_MAX_SCREENS=1\n" });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, {}, { chat: fakeChat(), render: fakeRender() })
  );
  assert.ok(payload.warnings.some((warning) => warning.code === "vision-screen-cap"));
  assert.equal(payload.vision.screensProcessed, 1);
  assert.equal(payload.counts.visionElements, 1);
});

test("vision: AOS_VISION_MAX_SCREENS=0 lifts the cap (full pass, no truncation warning)", async () => {
  const dir = makeProject({ dotenv: "AOS_VISION_MAX_SCREENS=0\n" });
  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "design.pen"),
    JSON.stringify(manyScreensDoc(23)),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: async () => JSON.stringify({ elements: [] }), render: fakeRender() })
  );
  assert.equal(payload.vision.screensProcessed, 23, "0 means unlimited, not the default 20");
  assert.ok(!payload.warnings.some((warning) => warning.code === "vision-screen-cap"));
});

test("vision: AOS_VISION_MAX_SCREENS=all lifts the cap", async () => {
  const dir = makeProject({ dotenv: "AOS_VISION_MAX_SCREENS=all\n" });
  fs.writeFileSync(
    path.join(dir, ".artemis", "design", "design.pen"),
    JSON.stringify(manyScreensDoc(23)),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: async () => JSON.stringify({ elements: [] }), render: fakeRender() })
  );
  assert.equal(payload.vision.screensProcessed, 23);
  assert.ok(!payload.warnings.some((warning) => warning.code === "vision-screen-cap"));
});

test("vision: default cap of 50 keeps every screen of a 23-screen design (no silent drop)", async () => {
  const dir = makeProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(
    path.join(designDir, "design.pen"),
    JSON.stringify(manyScreensDoc(23)),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: async () => JSON.stringify({ elements: [] }), render: fakeRender() })
  );
  assert.equal(payload.counts.screens, 23);
  assert.equal(payload.vision.screensRequested, 23);
  assert.equal(payload.vision.screensProcessed, 23);
  assert.ok(!payload.warnings.some((warning) => warning.code === "vision-screen-cap"));
});

test("vision: default cap of 50 still truncates a 60-screen design with an explicit warning", async () => {
  const dir = makeProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(
    path.join(designDir, "design.pen"),
    JSON.stringify(manyScreensDoc(60)),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: async () => JSON.stringify({ elements: [] }), render: fakeRender() })
  );
  assert.equal(payload.vision.screensInput, 60);
  assert.equal(payload.vision.screensRequested, 50, "只有进入 pass 的主屏计入 requested");
  assert.equal(payload.vision.screensCapped, 10);
  assert.equal(payload.vision.screensProcessed, 50);
  assert.ok(payload.warnings.some((warning) => warning.code === "vision-screen-cap"));
});

test("vision: auto-layout screens (fill_container width, no height) use the rendered PNG size", async () => {
  const dir = makeProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(autoLayoutDoc()), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const seen = [];
  const chat = async (messages) => {
    seen.push(messages[1].content[0].text);
    return JSON.stringify({
      elements: [
        { class: "cart-entry", intent: "navigate", label: "购物袋", bbox: CART_BBOX, confidence: 0.9 }
      ]
    });
  };
  const payload = parseToolResult(
    await penExtractFlows(runtime, {}, { chat, render: sizedRender(390, 844) })
  );

  assert.equal(payload.vision.screensRequested, 2, "no screen is dropped for lacking numeric geometry");
  assert.equal(payload.vision.screensProcessed, 2);
  assert.equal(payload.vision.elements, 2);
  assert.match(seen[0], /390x844/, "normalized bbox is scaled by the rendered size");

  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  const element = flows.screens.find((screen) => screen.name === "主頁").elements[0];
  assert.equal(element.nodeId, "cart-fab", "grounding uses screen-local node geometry");
  assert.deepEqual(element.bbox, { x: 300, y: 760, width: 60, height: 60 });
});

test("vision: screens without numeric geometry and without a render are reported, not silently dropped", async () => {
  const dir = makeProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(autoLayoutDoc()), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      {},
      {
        chat: async () => JSON.stringify({ elements: [] }),
        render: async ({ screenIds, outDir }) => {
          fs.mkdirSync(outDir, { recursive: true });
          const files = new Map();
          const [first] = screenIds;
          const file = path.join(outDir, `${first}.png`);
          fs.writeFileSync(file, pngHeader(390, 844));
          files.set(first, file);
          return { ok: true, dir: outDir, files, missing: screenIds.slice(1) };
        }
      }
    )
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, true);
  assert.equal(payload.vision.screensRequested, 1);
  assert.equal(payload.vision.screensProcessed, 1);
  const warning = payload.warnings.find((entry) => entry.code === "vision-screen-no-geometry");
  assert.ok(warning, "screens dropped for missing geometry are reported");
  assert.match(warning.message, /門市/);
});

test("vision: when every screen lacks geometry the skip reason still carries the warning", async () => {
  const dir = makeProject();
  const designDir = path.join(dir, ".artemis", "design");
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(autoLayoutDoc()), "utf-8");
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      {},
      {
        chat: async () => JSON.stringify({ elements: [] }),
        render: async ({ outDir }) => ({ ok: true, dir: outDir, files: new Map(), missing: [] })
      }
    )
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, false);
  const warning = payload.warnings.find((entry) => entry.code === "vision-screen-no-geometry");
  assert.ok(warning, "an all-dropped pass must not lose its reason");
  assert.match(warning.message, /主頁|門市/);
});


test("vision: screens:false 仍为主屏 + 变体渲染（同一次渲染，变体不静默）", async () => {
  const dir = makeProjectWithDoc(statefulDoc());
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const calls = { count: 0, screenIds: null };
  const render = async ({ screenIds, outDir }) => {
    calls.count += 1;
    calls.screenIds = screenIds;
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map();
    for (const id of screenIds) {
      const file = path.join(outDir, `${id}.png`);
      fs.writeFileSync(file, pngHeader(390, 844));
      files.set(id, file);
    }
    return { ok: true, dir: outDir, files, missing: [] };
  };
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      { screens: false },
      { chat: async () => JSON.stringify({ elements: [] }), render }
    )
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.screenshots, undefined, "screens:false 不附截图摘要");
  assert.deepEqual(calls.screenIds, ["home", "store", "home-loading"]);
  assert.equal(payload.vision.active, true);
  assert.equal(payload.vision.screensRequested, 2, "主屏数保持独立语义");
  assert.equal(payload.vision.statesRequested, 1, "变体另计");
  assert.equal(payload.vision.targetsRequested, 3, "变体也算 target");
  assert.equal(payload.vision.screensProcessed, 2);
  assert.equal(payload.vision.statesProcessed, 1);
});


/** One main screen (home) plus two merged variants (login/error). */
function variantVisionDoc() {
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
          {
            id: "home",
            type: "frame",
            name: "Frame 101",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            children: [
              { id: "home-title", type: "text", content: "主頁" },
              { id: "main-cta", type: "frame", name: "提交 Button", x: 20, y: 700, width: 200, height: 48 }
            ]
          },
          {
            id: "home-login",
            type: "frame",
            name: "Frame 102",
            x: 420,
            y: 0,
            width: 390,
            height: 844,
            children: [
              { id: "login-title", type: "text", content: "主頁-登入" },
              { id: "login-cta", type: "frame", name: "登入 Button", x: 40, y: 600, width: 180, height: 44 }
            ]
          },
          {
            id: "home-error",
            type: "frame",
            name: "Frame 103",
            x: 840,
            y: 0,
            width: 390,
            height: 844,
            children: [
              { id: "error-title", type: "text", content: "主頁-錯誤" },
              { id: "error-cta", type: "frame", name: "重試 Button", x: 60, y: 620, width: 160, height: 44 }
            ]
          }
        ]
      }
    ]
  };
}

function bboxOf(x, y, width, height) {
  return { x: x / 390, y: y / 844, width: width / 390, height: height / 844 };
}

function variantChat() {
  return async (messages) => {
    const text = messages[1].content[0].text;
    if (text.includes("主頁-登入")) {
      return JSON.stringify({
        elements: [{ class: "cta", intent: "navigate", label: "登入", bbox: bboxOf(40, 600, 180, 44) }]
      });
    }
    if (text.includes("主頁-錯誤")) {
      return JSON.stringify({
        elements: [{ class: "cta", intent: "navigate", label: "重試", bbox: bboxOf(60, 620, 160, 44) }]
      });
    }
    return JSON.stringify({
      elements: [{ class: "cta", intent: "navigate", label: "提交", bbox: bboxOf(20, 700, 200, 48) }]
    });
  };
}

function target(overrides = {}) {
  return { id: "home", name: "主頁", width: 390, height: 844, nodes: [], ...overrides };
}

const silentChat = async () => JSON.stringify({ elements: [] });

test("runVisionPass: 主屏+变体逐 target 识别，state 元素只进 states，不进主屏 elements", async () => {
  const dir = makeProjectWithDoc(variantVisionDoc());
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: variantChat(), render: sizedRender(390, 844) })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, true);
  assert.equal(payload.vision.screensProcessed, 1);
  assert.equal(payload.vision.statesProcessed, 2);
  assert.equal(payload.counts.visionMainElements, 1);
  assert.equal(payload.counts.visionStateElements, 2);
  assert.equal(
    payload.counts.visionMainElements + payload.counts.visionStateElements,
    payload.counts.visionElements,
    "主屏/变体元素计数与总数对齐（变体仅审计，不并入生成）"
  );

  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  const home = flows.screens.find((screen) => screen.name === "主頁");
  assert.equal(home.elements.length, 1, "主屏只保留主屏元素");
  assert.equal(home.elements[0].nodeId, "main-cta");
  assert.equal(home.elements[0].state, undefined);
  const login = home.states.find((state) => state.label === "主頁-登入");
  const error = home.states.find((state) => state.label === "主頁-錯誤");
  assert.equal(login.elements.length, 1);
  assert.equal(login.elements[0].nodeId, "login-cta");
  assert.equal(login.elements[0].state, "主頁-登入");
  assert.equal(error.elements[0].nodeId, "error-cta");
  assert.equal(error.elements[0].state, "主頁-錯誤");

  assert.equal(login.edges.length, 1, "变体边挂在 state 上");
  assert.equal(login.edges[0].state, "主頁-登入");
  assert.equal(flows.edges.filter((edge) => edge.trigger === "VISION").length, 1, "result.edges 只收主屏边");
  assert.equal(flows.edges.filter((edge) => edge.state !== undefined).length, 0);
  assert.equal(flows.unresolvedDestinations.length, 1, "变体未决目的地不进入生成侧");
  assert.match(flows.unresolvedDestinations[0], /主頁 · 提交/);
});

test("runVisionPass: state target 计入 statesRequested/Processed，元素带 state", async () => {
  const pass = await runVisionPass({
    chat: variantChat(),
    screens: [
      target(),
      target({ id: "home-login", name: "主頁-登入", stateOf: "home", stateName: "主頁-登入" })
    ],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(pass.stats.screensRequested, 1);
  assert.equal(pass.stats.statesRequested, 1);
  assert.equal(pass.stats.targetsRequested, 2);
  assert.equal(pass.stats.screensProcessed, 1);
  assert.equal(pass.stats.statesProcessed, 1);
  assert.equal(pass.stats.statesSkipped, 0);
  assert.equal(pass.stats.statesFailed, 0);
  assert.equal(pass.stats.elements, 2);
  const stateElements = pass.elementsByScreen.get("home-login");
  assert.equal(stateElements.length, 1);
  assert.equal(stateElements[0].state, "主頁-登入");
  assert.equal(pass.edges.length, 1, "主屏边");
  assert.equal(pass.stateEdges.length, 1, "变体边单独审计");
  assert.equal(pass.stateEdges[0].state, "主頁-登入");
  assert.equal(pass.stateEdges[0].from.id, "home-login");
  assert.deepEqual(pass.cappedTargets, []);
});

test("runVisionPass: 2× 渲染图按 renderScale 换算（width/height 为图像像素）", async () => {
  const node = { id: "cta", name: "提交 Button", type: "frame", x: 100, y: 200, width: 60, height: 40 };
  const imageWidth = 390 * 2;
  const imageHeight = 844 * 2;
  const bbox = {
    x: (100 * 2) / imageWidth,
    y: (200 * 2) / imageHeight,
    width: (60 * 2) / imageWidth,
    height: (40 * 2) / imageHeight
  };
  const chat = async () =>
    JSON.stringify({ elements: [{ class: "cta", intent: "submit", label: "提交", bbox }] });

  const scaled = await runVisionPass({
    chat,
    screens: [
      target({
        width: imageWidth,
        height: imageHeight,
        nodes: [node],
        renderScale: 2
      })
    ],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  const scaledElement = scaled.elementsByScreen.get("home")[0];
  assert.equal(scaledElement.nodeId, "cta", "归一化 bbox 乘图像像素后除 renderScale 回到设计 px");
  assert.ok(Math.abs(scaledElement.bbox.x - 100) < 1e-9);
  assert.ok(Math.abs(scaledElement.bbox.y - 200) < 1e-9);
  assert.ok(Math.abs(scaledElement.bbox.width - 60) < 1e-9);
  assert.ok(Math.abs(scaledElement.bbox.height - 40) < 1e-9);

  const unscaled = await runVisionPass({
    chat,
    screens: [target({ width: imageWidth, height: imageHeight, nodes: [node] })],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(
    unscaled.elementsByScreen.get("home")[0].nodeId,
    undefined,
    "不换算会失准（测试锁定换算路径）"
  );
});

test("runVisionPass: >40 条 → vision-response-truncated 且 truncatedItems 计入会计", async () => {
  const elements = Array.from({ length: 41 }, (_, index) => ({
    class: "link",
    intent: "submit",
    label: `入口${index + 1}`,
    bbox: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 }
  }));
  const pass = await runVisionPass({
    chat: async () => JSON.stringify({ elements }),
    screens: [target()],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(pass.stats.truncatedItems, 1);
  assert.equal(pass.stats.elements, 40);
  assert.equal(pass.accounting.rawElements, 41);
  assert.equal(pass.accounting.ok, true);
  const warning = pass.warnings.find((entry) => entry.code === "vision-response-truncated");
  assert.ok(warning);
  assert.match(warning.message, /主頁/);
  assert.match(warning.message, /40/);
});

test("runVisionPass: 无渲染图 target 进 skipped 桶（主屏/变体分桶）", async () => {
  const dir = makeProjectWithDoc(variantVisionDoc());
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(
      runtime,
      { screens: false },
      {
        chat: variantChat(),
        render: async ({ outDir }) => ({ ok: true, dir: outDir, files: new Map(), missing: [] })
      }
    )
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, true);
  assert.equal(payload.vision.screensSkipped, 1);
  assert.equal(payload.vision.statesSkipped, 2);
  assert.equal(payload.vision.screensProcessed, 0);
  assert.equal(payload.vision.statesProcessed, 0);
  assert.equal(payload.vision.screensRequested, 1);
  assert.equal(payload.vision.statesRequested, 2);
  assert.equal(payload.vision.screensInput, 1);
  assert.equal(payload.vision.statesInput, 2);
  assert.equal(payload.vision.accounting.ok, true);
  assert.equal(
    payload.warnings.filter((warning) => warning.code === "vision-render-no-output").length,
    3,
    "每个 target 都具名"
  );
  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  assert.equal(flows.screens[0].elementsCoverage[0].notEvaluated, true);
  const login = flows.screens[0].states.find((state) => state.label === "主頁-登入");
  assert.equal(login.elementsCoverage[0].details[0].reason, "render-missing");
});

test("runVisionPass: state frame-missing 计入 statesFrameMissing", async () => {
  const pass = await runVisionPass({
    chat: silentChat,
    screens: [target()],
    excluded: [
      {
        screenId: "ghost-state",
        screenName: "主頁",
        state: "主頁-錯誤",
        reason: "frame-missing",
        candidates: [],
        designNodes: 0
      }
    ],
    maxScreens: 1,
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(pass.stats.screensInput, 1);
  assert.equal(pass.stats.statesInput, 1);
  assert.equal(pass.stats.screensFrameMissing, 0);
  assert.equal(pass.stats.statesFrameMissing, 1);
  assert.equal(pass.stats.statesNoGeometry, 0);
  assert.equal(pass.stats.statesCapped, 0, "排除项不占 cap 名额");
  assert.equal(pass.stats.screensRequested, 1);
  assert.equal(pass.stats.statesRequested, 0);
  assert.equal(pass.stats.targetsRequested, 1);
  assert.equal(pass.accounting.ok, true);
  assert.ok(!pass.warnings.some((warning) => warning.code === "vision-accounting-mismatch"));
  const coverage = pass.coverageByTarget.get("ghost-state");
  assert.equal(coverage.state, "主頁-錯誤");
  assert.equal(coverage.notEvaluated, true);
  assert.equal(coverage.notEvaluatedReason, "frame-missing");
  assert.equal(coverage.notEvaluatedCandidates, 0);
});

test("runVisionPass: state no-geometry 计入 statesNoGeometry", async () => {
  const pass = await runVisionPass({
    chat: silentChat,
    screens: [target()],
    excluded: [
      {
        screenId: "size-less-state",
        screenName: "主頁",
        state: "主頁-載入",
        reason: "no-geometry",
        candidates: [
          {
            id: "loading-cta",
            name: "取消 Button",
            type: "frame",
            textHints: ["取消"],
            state: "主頁-載入"
          }
        ],
        designNodes: 2
      }
    ],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(pass.stats.statesInput, 1);
  assert.equal(pass.stats.statesNoGeometry, 1);
  assert.equal(pass.stats.statesFrameMissing, 0);
  assert.equal(pass.stats.statesCapped, 0);
  assert.equal(pass.stats.statesRequested, 0);
  assert.equal(pass.accounting.ok, true);
  const coverage = pass.coverageByTarget.get("size-less-state");
  assert.equal(coverage.notEvaluatedReason, "no-geometry");
  assert.equal(coverage.candidateNodes, 1);
  assert.equal(coverage.notEvaluatedCandidates, 1);
  assert.equal(coverage.details[0].reason, "no-geometry");
});

test("runVisionPass: state 调用失败计入 statesFailed（不是 skipped）", async () => {
  const chat = async (messages) => {
    const text = messages[1].content[0].text;
    if (text.includes("主頁-登入")) throw new Error("HTTP 500");
    return JSON.stringify({ elements: [] });
  };
  const pass = await runVisionPass({
    chat,
    screens: [
      target(),
      target({ id: "home-login", name: "主頁-登入", stateOf: "home", stateName: "主頁-登入" })
    ],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.equal(pass.stats.screensProcessed, 1);
  assert.equal(pass.stats.screensFailed, 0);
  assert.equal(pass.stats.statesProcessed, 0);
  assert.equal(pass.stats.statesFailed, 1);
  assert.equal(pass.stats.statesSkipped, 0);
  assert.equal(pass.stats.failures, 1);
  assert.equal(pass.stats.screensRequested, 1);
  assert.equal(pass.stats.statesRequested, 1);
  assert.equal(pass.stats.targetsRequested, 2);
  assert.equal(pass.accounting.ok, true);
  assert.ok(!pass.warnings.some((warning) => warning.code === "vision-accounting-mismatch"));
  const warning = pass.warnings.find((entry) => entry.code === "vision-call-failed");
  assert.match(warning.message, /主頁-登入/);
  assert.match(warning.message, /HTTP 500/);
  const coverage = pass.coverageByTarget.get("home-login");
  assert.equal(coverage.notEvaluatedReason, "failed");
});

test("runVisionPass: 变体独有 Button 未识别 → vision-candidate-uncovered 带 state 名", async () => {
  const pass = await runVisionPass({
    chat: silentChat,
    screens: [
      target({ candidates: [], nodes: [] }),
      target({
        id: "home-login",
        name: "主頁-登入",
        stateOf: "home",
        stateName: "主頁-登入",
        candidates: [
          {
            id: "login-cta",
            name: "登入 Button",
            type: "frame",
            bbox: { x: 40, y: 600, width: 180, height: 44 },
            textHints: ["登入"],
            state: "主頁-登入"
          }
        ],
        nodes: []
      })
    ],
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  const warning = pass.warnings.find((entry) => entry.code === "vision-candidate-uncovered");
  assert.ok(warning, "变体未覆盖必须告警");
  assert.match(warning.message, /主頁-登入/);
  assert.match(warning.message, /状态/);
  assert.deepEqual(warning.details, ["登入 Button（login-cta）"]);
  const coverage = pass.coverageByTarget.get("home-login");
  assert.equal(coverage.uncoveredCandidates, 1);
  assert.equal(coverage.coveredCandidates, 0);
  assert.equal(coverage.state, "主頁-登入");
});

test("runVisionPass: cap 先裁变体，主屏全保留；capped 具名", async () => {
  const pass = await runVisionPass({
    chat: silentChat,
    screens: [
      target({ id: "main1", name: "主頁" }),
      target({ id: "main2", name: "門市" }),
      target({ id: "s1", name: "變體1", stateOf: "main1", stateName: "變體1" }),
      target({
        id: "s2",
        name: "變體2",
        stateOf: "main1",
        stateName: "變體2",
        candidates: [
          {
            id: "s2-cta",
            name: "變體 Button",
            type: "frame",
            textHints: [],
            state: "變體2"
          }
        ]
      }),
      target({ id: "s3", name: "變體3", stateOf: "main2", stateName: "變體3" })
    ],
    excluded: [
      {
        screenId: "ghost",
        screenName: "缺幾何",
        state: null,
        reason: "no-geometry",
        candidates: [],
        designNodes: 3
      }
    ],
    maxScreens: 3,
    imageFor: () => "data:image/png;base64,AA==",
    renderPath: () => null
  });
  assert.deepEqual(
    pass.cappedTargets.map((entry) => entry.id),
    ["s2", "s3"],
    "先裁变体；主屏全保留"
  );
  assert.equal(pass.stats.screensRequested, 2);
  assert.equal(pass.stats.statesRequested, 1);
  assert.equal(pass.stats.targetsRequested, 3);
  assert.equal(pass.stats.screensCapped, 0);
  assert.equal(pass.stats.statesCapped, 2);
  assert.equal(pass.stats.screensNoGeometry, 1, "缺几何先于 cap 分类，且不占 cap 名额");
  assert.equal(pass.stats.screensInput, 3);
  assert.equal(pass.stats.statesInput, 3);
  const cap = pass.warnings.find((entry) => entry.code === "vision-screen-cap");
  assert.ok(cap);
  assert.match(cap.message, /AOS_VISION_MAX_SCREENS=0/);
  assert.ok(cap.details.includes("主頁·變體2"));
  assert.ok(cap.details.includes("門市·變體3"));
  assert.equal(pass.coverageByTarget.get("s2").notEvaluated, true);
  assert.equal(pass.coverageByTarget.get("s2").details[0].reason, "capped");
});

test("applyVision: 会计公式成立；人为破坏 → vision-accounting-mismatch", async () => {
  const dir = makeProjectWithDoc(variantVisionDoc());
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: variantChat(), render: sizedRender(390, 844) })
  );
  const accounting = payload.vision.accounting;
  assert.equal(accounting.ok, true);
  assert.equal(accounting.screensInput, 1);
  assert.equal(accounting.statesInput, 2);
  assert.equal(accounting.targetsRequested, 3);
  assert.equal(accounting.elements, 3);
  assert.equal(accounting.rawElements, 3);
  assert.ok(Object.values(accounting.formulas).every(Boolean));

  const stats = payload.vision.stats;
  assert.equal(stats.screensRequested, 1);
  assert.equal(stats.statesRequested, 2);
  assert.equal(stats.targetsRequested, 3);
  assert.equal(stats.elements, stats.groundedElements + stats.ungroundedElements);

  const broken = visionAccounting({ ...stats, screensProcessed: stats.screensProcessed + 1 });
  assert.equal(broken.ok, false);
  assert.equal(broken.formulas.screensInput, false);
  const warnings = accountingWarnings(broken);
  assert.equal(warnings[0].code, "vision-accounting-mismatch");
  assert.match(warnings[0].message, /screensInput/);
});

test("pen payload/flow-map: 屏/变体显示 识别/候选/覆盖/未覆盖/不可核验/未评估", async () => {
  const dir = makeProjectWithDoc(variantVisionDoc(), { dotenv: "AOS_VISION_MAX_TARGETS=2\n" });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: silentChat, render: sizedRender(390, 844) })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.statesCapped, 1);
  const flows = JSON.parse(fs.readFileSync(payload.savedTo.json, "utf-8"));
  const home = flows.screens[0];
  assert.ok(home.elementsCoverage, "主屏覆盖");
  assert.equal(home.elementsCoverage[0].notEvaluated, undefined);
  const error = home.states.find((state) => state.label === "主頁-錯誤");
  assert.equal(error.elementsCoverage[0].notEvaluated, true);
  assert.equal(error.elementsCoverage[0].details[0].reason, "capped");

  const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(map, /覆盖：识别 \d+ · 候选 \d+ · 覆盖 \d+ · 未覆盖 \d+ · 不可核验 \d+ · 未评估 \d+/);
  assert.match(map, /状态「主頁-錯誤」/);
  assert.match(map, /未评估 1/);
});

test("applyVision: 全部帧缺失时标题原因区别于「无可用屏幕几何」", async () => {
  const idless = {
    version: "2.20",
    children: [
      {
        id: "board",
        type: "frame",
        name: "1. 主流程",
        x: 0,
        y: 0,
        children: [
          {
            type: "frame",
            name: "Frame 101",
            x: 0,
            y: 0,
            width: 390,
            height: 844,
            children: [{ type: "text", content: "主頁" }]
          }
        ]
      }
    ]
  };
  const dir = makeProjectWithDoc(idless);
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(
    await penExtractFlows(runtime, { screens: false }, { chat: silentChat, render: sizedRender(390, 844) })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vision.active, false);
  assert.match(payload.vision.reason, /设计帧|帧缺失|frame-missing/);
  assert.doesNotMatch(payload.vision.reason, /^无可用屏幕几何$/);
  assert.ok(payload.warnings.some((warning) => warning.code === "vision-screen-frame-missing"));
  assert.equal(payload.vision.screensFrameMissing, 1);
  assert.equal(payload.vision.screensInput, 1);
  assert.equal(payload.vision.accounting.ok, true);
});

test("flows.json: schemaVersion newer than supported fails loud (version gate)", async () => {
  const dir = makeProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const flowsPath = path.join(dir, ".artemis", "design", "flows.json");
  fs.writeFileSync(
    flowsPath,
    JSON.stringify({ schemaVersion: 99, screens: [], edges: [] }),
    "utf-8"
  );
  const result = await figmaGenerateTests(runtime, { save: false });
  assert.equal(result.isError, true);
  const payload = parseToolResult(result);
  assert.match(payload.error, /schemaVersion 99 .*高于本版本支持范围 3/);
});

test("parseVisionReply: >40 条返回 truncated 计数，不再静默丢弃", () => {
  const elements = Array.from({ length: 41 }, (_, index) => ({
    class: "link",
    intent: "navigate",
    label: `入口${index + 1}`,
    bbox: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 }
  }));
  const parsed = parseVisionReply(JSON.stringify({ elements }));
  assert.equal(parsed.items.length, 40, "只保留前 40 条");
  assert.equal(parsed.invalid, 0);
  assert.equal(parsed.truncated, 1, "超出上限的条数单独计数");
});

test("vision: model heuristic and reply parsing stay deterministic", () => {
  assert.equal(isVisionCapableModel("qwen2.5-vl-72b-instruct"), true);
  assert.equal(isVisionCapableModel("glm-4v-plus"), true);
  assert.equal(isVisionCapableModel("gpt-4o-mini"), true);
  assert.equal(isVisionCapableModel("claude-sonnet-4"), true);
  assert.equal(isVisionCapableModel("moonshot-v1-8k-vision-preview"), true);
  assert.equal(isVisionCapableModel("deepseek-flash"), true);
  assert.equal(isVisionCapableModel("deepseek-v4-flash"), true);
  assert.equal(isVisionCapableModel("deepseek-v4.1-flash"), true);
  assert.equal(isVisionCapableModel("deepseek-v4-pro"), false);
  assert.equal(isVisionCapableModel("deepseek-chat"), false);
  assert.equal(isVisionCapableModel(""), false);
  assert.equal(isVisionCapableModel(null), false);

  const parsed = parseVisionReply(
    '```json\n{"elements":[{"class":"cart-entry","intent":"navigate","label":"购物袋","bbox":{"x":0.7,"y":0.9,"width":0.1,"height":0.1}},{"class":"tab","intent":"navigate","bbox":{"x":0,"y":0,"width":0,"height":0}}]}\n```'
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.invalid, 1, "zero-size bbox is invalid");
  assert.equal(parsed.items[0].className, "cart-entry");
  assert.deepEqual(parseVisionReply("not json"), { items: [], invalid: 0, truncated: 0 });
});
