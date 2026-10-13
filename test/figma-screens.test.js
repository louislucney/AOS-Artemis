import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { figmaExtractFlows, renderFigmaFlowMap } from "../dist/figma/flows.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";
import { syntheticFlowDocument } from "./fixtures/figma-flow-doc.mjs";

process.env.FIGMA_ACCESS_TOKEN = "figma-test-token";
process.env.AOS_FIGMA_CACHE_TTL_MS = "0";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const FIGMA_URL = "https://www.figma.com/file/TestKey123/App";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function stubFigma({ imagesMode = "ok" } = {}) {
  const original = globalThis.fetch;
  const calls = { files: 0, imageQueries: [], downloads: 0 };
  let imageRound = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.figma.com") {
      if (url.pathname.includes("/files/") && !url.pathname.includes("/nodes")) {
        calls.files += 1;
        return jsonResponse({
          name: "App",
          version: "1",
          lastModified: "2026-10-13T00:00:00.000Z",
          document: syntheticFlowDocument()
        });
      }
      if (url.pathname.includes("/images/")) {
        imageRound += 1;
        calls.imageQueries.push(url.search);
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        if (imagesMode === "error") return new Response("boom", { status: 500 });
        const images = {};
        for (const id of ids) {
          const nullAlways =
            imagesMode === "null" || (imagesMode === "partial" && id !== "10:1");
          if (nullAlways || (imagesMode === "null-once" && imageRound === 1)) {
            images[id] = null;
          } else {
            images[id] = `https://img.example.com/${encodeURIComponent(id)}.png`;
          }
        }
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

async function makeProject(dotenv = "") {
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  return { dir, runtime };
}

const noSleep = async () => {};

test("figma_extract_flows: 批量渲染截图并嵌入 flow-map.md", async () => {
  const { dir, runtime } = await makeProject();
  const stub = stubFigma();
  try {
    const payload = parseToolResult(await figmaExtractFlows(runtime, { url: FIGMA_URL }, { sleep: noSleep }));
    assert.equal(payload.ok, true);
    assert.equal(stub.calls.files, 1);
    assert.equal(stub.calls.imageQueries.length, 1, "批量一次 /images 调用");
    assert.match(stub.calls.imageQueries[0], /format=png/);
    assert.match(stub.calls.imageQueries[0], /scale=1/);
    assert.equal(payload.screenshots.rendered, 3);
    assert.equal(payload.screenshots.skipped, 0);
    assert.equal(payload.screenshots.dir, "screens/figma-TestKey123");
    assert.equal(stub.calls.downloads, 3);

    assert.equal(payload.savedTo.json, path.join(dir, ".artemis", "design", "flows.json"));
    const mapPath = payload.savedTo.markdown;
    const map = fs.readFileSync(mapPath, "utf-8");
    assert.match(map, /# Figma 交互地图/);
    assert.match(map, /## 屏幕（含缩略图）/);
    assert.equal((map.match(/<img /g) ?? []).length, 3);
    assert.match(map, /<img src="screens\/figma-TestKey123\/10-1\.png"/);

    const file = path.join(dir, ".artemis", "design", "screens", "figma-TestKey123", "10-1.png");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file).subarray(0, 4).toString("hex"), "89504e47");

    // 幂等：同内容重跑 → 仍 3 张、文件 mtime 稳定
    const mtime = fs.statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = parseToolResult(
      await figmaExtractFlows(runtime, { url: FIGMA_URL }, { sleep: noSleep })
    );
    assert.equal(again.screenshots.rendered, 3);
    assert.equal(fs.statSync(file).mtimeMs, mtime);
  } finally {
    stub.restore();
  }
});

test("figma_extract_flows: 单屏 null 有界重试一次（仅未决屏、绕缓存）", async () => {
  const { runtime } = await makeProject();
  const onceStub = stubFigma({ imagesMode: "null-once" });
  try {
    const payload = parseToolResult(
      await figmaExtractFlows(runtime, { url: FIGMA_URL }, { sleep: noSleep })
    );
    assert.equal(payload.screenshots.rendered, 3);
    assert.equal(onceStub.calls.imageQueries.length, 2, "null → 有界重试一次");
  } finally {
    onceStub.restore();
  }

  const partialStub = stubFigma({ imagesMode: "partial" });
  try {
    const payload = parseToolResult(
      await figmaExtractFlows(runtime, { url: FIGMA_URL }, { sleep: noSleep })
    );
    assert.equal(partialStub.calls.imageQueries.length, 2);
    assert.equal(partialStub.calls.imageQueries[0].split(",").length, 3);
    assert.equal(partialStub.calls.imageQueries[1].split(",").length, 2, "重试只查询未决屏");
    assert.equal(payload.screenshots.rendered, 1);
    assert.equal(payload.screenshots.skipped, 2);
    assert.ok(payload.warnings.some((warning) => warning.code === "screenshot-skipped"));
  } finally {
    partialStub.restore();
  }
});

test("figma_extract_flows: 通道失败降级不阻断（无图 + warning，md 照常）", async () => {
  const { runtime } = await makeProject();
  const stub = stubFigma({ imagesMode: "error" });
  try {
    const payload = parseToolResult(
      await figmaExtractFlows(runtime, { url: FIGMA_URL }, { sleep: noSleep })
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.screenshots.rendered, 0);
    assert.equal(payload.screenshots.skipped, 3);
    const warning = payload.warnings.find((entry) => entry.code === "screenshot-render-unavailable");
    assert.ok(warning);
    assert.match(warning.message, /Figma API 500/);

    const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
    assert.doesNotMatch(map, /<img/);
    assert.match(map, /\[screenshot-render-unavailable\]/);
    assert.match(map, /## 跳转/);
  } finally {
    stub.restore();
  }
});

test("figma_extract_flows: screens:false / AOS_SCREENS=0 关闭截图（md 仍生成）；显式 true 覆盖", async () => {
  const { runtime } = await makeProject();
  const stub = stubFigma();
  try {
    const payload = parseToolResult(
      await figmaExtractFlows(runtime, { url: FIGMA_URL, screens: false }, { sleep: noSleep })
    );
    assert.equal(stub.calls.imageQueries.length, 0);
    assert.equal(payload.screenshots, undefined);
    const map = fs.readFileSync(payload.savedTo.markdown, "utf-8");
    assert.doesNotMatch(map, /<img/);
    assert.match(map, /# Figma 交互地图/);
  } finally {
    stub.restore();
  }

  const { runtime: envRuntime } = await makeProject("AOS_SCREENS=0\n");
  const envStub = stubFigma();
  try {
    const off = parseToolResult(
      await figmaExtractFlows(envRuntime, { url: FIGMA_URL }, { sleep: noSleep })
    );
    assert.equal(envStub.calls.imageQueries.length, 0);
    assert.equal(off.screenshots, undefined);

    const forced = parseToolResult(
      await figmaExtractFlows(envRuntime, { url: FIGMA_URL, screens: true }, { sleep: noSleep })
    );
    assert.equal(envStub.calls.imageQueries.length, 1);
    assert.equal(forced.screenshots.rendered, 3);
  } finally {
    envStub.restore();
  }
});

test("renderFigmaFlowMap: 无图与未决目的地照常渲染", () => {
  const markdown = renderFigmaFlowMap({
    fileKey: "Key1",
    fileName: "App",
    generatedAt: "2026-10-13T00:00:00.000Z",
    graph: {
      screens: [
        { id: "1:2", name: "Home", suggestedRoute: "/", childNames: [], textHints: [] }
      ],
      edges: [
        {
          from: { id: "1:2", name: "Home" },
          to: null,
          element: { id: "1:3", name: "CTA", type: "INSTANCE" },
          textHints: [],
          trigger: "ON_CLICK",
          actionType: "NODE"
        }
      ],
      entryScreens: ["Home"],
      unresolvedDestinations: ["9:9"],
      interactionNodes: 1
    },
    warnings: []
  });
  assert.match(markdown, /Home → （未决） \[ON_CLICK\] · CTA/);
  assert.match(markdown, /## 未决目的地/);
  assert.match(markdown, /- 9:9/);
  assert.doesNotMatch(markdown, /<img/);
  assert.match(markdown, /屏幕 1 · 跳转 1 · 入口 1 · 交互节点 1/);
});
