import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { figmaExtractFlows } from "../dist/figma/flows.js";

function frame(id, name, x, text) {
  return {
    id,
    name,
    type: "FRAME",
    absoluteBoundingBox: { x, y: 0, width: 375, height: 812 },
    children: [
      {
        id: `${id}-t`,
        name: text,
        type: "TEXT",
        characters: text,
        absoluteBoundingBox: { x: x + 20, y: 40, width: 200, height: 24 }
      }
    ]
  };
}

const FILE = {
  name: "Static App",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          frame("1:1", "登录页", 0, "登录"),
          frame("1:2", "首页", 500, "首页"),
          {
            id: "9:1",
            name: "点击登录进入首页",
            type: "TEXT",
            characters: "点击登录进入首页",
            absoluteBoundingBox: { x: 20, y: 830, width: 220, height: 24 }
          }
        ]
      }
    ]
  }
};

function runtimeFor(root) {
  return {
    configDirAbs: join(root, ".artemis"),
    project: { rootDir: root, dotenvValues: {} },
    store: {}
  };
}

async function extract(root, key, args) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(FILE), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  const oldTtl = process.env.AOS_FIGMA_CACHE_TTL_MS;
  process.env.AOS_FIGMA_CACHE_TTL_MS = "0";
  try {
    const result = await figmaExtractFlows(
      runtimeFor(root),
      {
        url: `https://www.figma.com/design/${key}/demo`,
        screens: false,
        ...args
      },
      { figmaToken: "tok-static" }
    );
    const text = result.content.find((entry) => entry.type === "text").text;
    return JSON.parse(text);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldTtl === undefined) delete process.env.AOS_FIGMA_CACHE_TTL_MS;
    else process.env.AOS_FIGMA_CACHE_TTL_MS = oldTtl;
  }
}

test("figma extract: static fallback synthesizes inferred edges by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-static-fallback-"));
  try {
    const body = await extract(root, `FB${process.pid}${Date.now()}`, {});
    assert.equal(body.ok, true);
    assert.equal(body.counts.edges, 1);
    assert.equal(body.edges[0].provenance, "inferred");
    assert.ok(body.warnings.some((warning) => warning.code === "static-flow-inferred"));
    assert.ok(!body.warnings.some((warning) => warning.code === "no-interactions"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("figma extract: staticFallback:false keeps the legacy no-interactions behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-static-fallback-"));
  try {
    const body = await extract(root, `FB${process.pid}${Date.now()}off`, { staticFallback: false });
    assert.equal(body.counts.edges, 0);
    assert.ok(body.warnings.some((warning) => warning.code === "no-interactions"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
