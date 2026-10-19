import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { penExtractFlows } from "../dist/pen/flows.js";
import { figmaGenerateTests } from "../dist/figma/test-gen.js";
import { isVisionCapableModel, parseVisionReply } from "../dist/design/vision.js";
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

function makeProject({ dotenv = "" } = {}) {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "design.pen"), JSON.stringify(visionDoc()), "utf-8");
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
  assert.deepEqual(parseVisionReply("not json"), { items: [], invalid: 0 });
});
