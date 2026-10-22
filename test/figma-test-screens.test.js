import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildFlowGraph } from "../dist/figma/flows.js";
import { figmaExtractFlows } from "../dist/figma/flows.js";
import { figmaGenerateTests, renderMarkdown } from "../dist/figma/test-gen.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";
import { syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

process.env.FIGMA_ACCESS_TOKEN = "figma-test-token";
process.env.AOS_FIGMA_CACHE_TTL_MS = "0";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function stubFigmaImages(calls = { imageQueries: [], downloads: 0 }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.figma.com") {
      if (url.pathname.includes("/files/") && !url.pathname.includes("/nodes")) {
        return jsonResponse({
          name: "App",
          version: "1",
          lastModified: "2026-10-13T00:00:00.000Z",
          document: syntheticFlowDocument()
        });
      }
      if (url.pathname.includes("/images/")) {
        calls.imageQueries.push(url.search);
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        const images = {};
        for (const id of ids) images[id] = `https://img.example.com/${encodeURIComponent(id)}.png`;
        return jsonResponse({ images });
      }
    }
    if (url.hostname === "img.example.com") {
      calls.downloads += 1;
      return new Response(Buffer.concat([PNG, Buffer.from(url.pathname)]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

function fakePenRender(calls = { count: 0 }) {
  return async ({ screenIds, outDir }) => {
    calls.count += 1;
    calls.screenIds = screenIds;
    fs.mkdirSync(outDir, { recursive: true });
    const files = new Map();
    for (const id of screenIds) {
      const file = path.join(outDir, `${id}.png`);
      fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from(id)]));
      files.set(id, file);
    }
    return { ok: true, dir: outDir, files, missing: [] };
  };
}

const PEN_FLOWS = {
  schemaVersion: 3,
  source: "pen:design.pen",
  screens: [
    {
      id: "s1",
      name: "主页",
      suggestedRoute: "/",
      childNames: [],
      textHints: [{ text: "主页", textClass: "runtime-text", nodeId: "s1-t" }]
    },
    { id: "s2", name: "门店", suggestedRoute: "/store", childNames: [], textHints: [] }
  ],
  edges: [
    {
      from: { id: "s1", name: "主页" },
      to: { id: "s2", name: "门店" },
      element: { id: "e1", name: "门店按钮", type: "frame" },
      textHints: [],
      trigger: "INFERRED",
      actionType: "INFERRED"
    }
  ],
  entryScreens: ["主页"],
  unresolvedDestinations: []
};

function makePenFlowsProject(dotenv = "") {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "flows.json"), JSON.stringify(PEN_FLOWS), "utf-8");
  fs.writeFileSync(path.join(designDir, "design.pen"), "// fixture", "utf-8");
  return dir;
}

test("figma_generate_tests: pen 来源按用例嵌图（≤3 张、一次渲染）", async () => {
  const dir = makePenFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const calls = { count: 0 };
  const payload = parseToolResult(
    await figmaGenerateTests(runtime, {}, { render: fakePenRender(calls) })
  );
  assert.equal(payload.ok, true);
  assert.equal(calls.count, 1);
  assert.equal(payload.screenshots.channel, "pen");
  assert.equal(payload.screenshots.dir, "screens/pen-design");
  assert.equal(payload.screenshots.rendered, 2);
  assert.equal(payload.screenshots.skipped, 0);

  const md = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.match(md, /<img src="screens\/pen-design\/s1\.png" height="160">/);
  assert.equal((md.match(/<img /g) ?? []).length >= 1, true);
  const file = path.join(dir, ".artemis", "design", "screens", "pen-design", "s1.png");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString("hex"), "89504e47");

  const second = parseToolResult(
    await figmaGenerateTests(runtime, {}, { render: fakePenRender(calls) })
  );
  assert.equal(second.ok, true);
  assert.equal(calls.count, 1, "第二次生成复用已落盘截图，不再调用 pen 渲染");
  assert.equal(second.screenshots.reused, 2);
  assert.equal(second.screenshots.skipped, 0);
});

test("figma_generate_tests: figma 来源批量渲染并嵌图", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const stub = stubFigmaImages();
  try {
    const flows = parseToolResult(
      await figmaExtractFlows(runtime, { url: "https://www.figma.com/file/TestKey123/App", screens: false }, { sleep: async () => {} })
    );
    assert.equal(flows.ok, true);

    const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
    assert.equal(payload.ok, true);
    assert.equal(payload.screenshots.channel, "figma");
    assert.equal(payload.screenshots.dir, "screens/figma-TestKey123");
    assert.equal(stub.calls.imageQueries.length, 1, "generate 阶段一次批量 /images");
    const md = fs.readFileSync(payload.savedTo.markdown, "utf-8");
    assert.match(md, /<img src="screens\/figma-TestKey123\/10-1\.png" height="160">/);

    const downloadsAfterFirst = stub.calls.downloads;
    const reused = parseToolResult(await figmaGenerateTests(runtime, {}));
    assert.equal(reused.ok, true);
    assert.equal(stub.calls.imageQueries.length, 1, "复用已落盘截图，不再请求 /images");
    assert.equal(stub.calls.downloads, downloadsAfterFirst, "复用已落盘截图，不再下载 PNG");
    assert.equal(reused.screenshots.reused, payload.screenshots.rendered);
  } finally {
    stub.restore();
  }
});

test("figma_generate_tests: 映射缺失全部降级（无图 + screenshot-mapping-missing）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const designDir = path.join(dir, ".artemis", "design");
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(
    path.join(designDir, "flows.json"),
    JSON.stringify(buildFlowGraph(syntheticFlowDocument())),
    "utf-8"
  );
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });

  const payload = parseToolResult(await figmaGenerateTests(runtime, {}));
  assert.equal(payload.ok, true);
  assert.equal(payload.screenshots, undefined);
  assert.ok(payload.warnings.some((warning) => warning.code === "screenshot-mapping-missing"));
  const md = fs.readFileSync(payload.savedTo.markdown, "utf-8");
  assert.doesNotMatch(md, /<img/);
});

test("figma_generate_tests: screens:false / AOS_SCREENS=0 关闭；显式 true 覆盖", async () => {
  const dir = makePenFlowsProject();
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const calls = { count: 0 };
  const off = parseToolResult(
    await figmaGenerateTests(runtime, { screens: false }, { render: fakePenRender(calls) })
  );
  assert.equal(calls.count, 0);
  assert.equal(off.screenshots, undefined);
  assert.doesNotMatch(fs.readFileSync(off.savedTo.markdown, "utf-8"), /<img/);

  const { runtime: envRuntime } = await (async () => {
    const envDir = makePenFlowsProject("AOS_SCREENS=0\n");
    return await loadTestRuntime(envDir, { proxy: new StubProxy() });
  })();
  const envOff = parseToolResult(
    await figmaGenerateTests(envRuntime, {}, { render: fakePenRender(calls) })
  );
  assert.equal(calls.count, 0);
  assert.equal(envOff.screenshots, undefined);

  const forced = parseToolResult(
    await figmaGenerateTests(envRuntime, { screens: true }, { render: fakePenRender(calls) })
  );
  assert.equal(calls.count, 1);
  assert.equal(forced.screenshots.channel, "pen");
});

test("renderMarkdown: ≤3 张截断并提示总数", () => {
  const cases = [
    {
      id: "c1",
      name: "Case",
      screens: ["A"],
      preconditions: [],
      prelude: [],
      steps: ["步骤"],
      taskDesc: "desc"
    }
  ];
  const refs = new Map([
    [
      "c1",
      ["screens/x/1.png", "screens/x/2.png", "screens/x/3.png", "screens/x/4.png", "screens/x/5.png"]
    ]
  ]);
  const md = renderMarkdown(cases, { source: "t", generatedAt: "now" }, { images: refs });
  assert.equal((md.match(/<img /g) ?? []).length, 3);
  assert.match(md, /…（共 5 屏）/);
  assert.doesNotMatch(md, /screens\/x\/4\.png/);

  const without = renderMarkdown(cases, { source: "t", generatedAt: "now" });
  assert.doesNotMatch(without, /<img/);
});
