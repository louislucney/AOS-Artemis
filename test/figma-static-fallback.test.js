import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { figmaExtractFlows } from "../dist/figma/flows.js";
import { mergeStaticEdges } from "../dist/figma/static-flows.js";

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

const PARTIAL_FILE = {
  name: "Partial App",
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
          {
            ...frame("1:1", "登录页", 0, "登录"),
            interactions: [
              {
                trigger: { type: "ON_CLICK" },
                actions: [{ type: "NODE", destinationId: "1:2" }]
              }
            ]
          },
          frame("1:2", "首页", 500, "首页"),
          {
            ...frame("1:3", "C", 1000, "C"),
            interactions: [
              {
                trigger: { type: "ON_CLICK" },
                actions: [{ type: "NODE", destinationId: "1:4" }]
              }
            ]
          },
          {
            ...frame("1:4", "D", 1500, "D"),
            interactions: [
              {
                trigger: { type: "ON_CLICK" },
                actions: [{ type: "NODE", destinationId: "1:3" }]
              }
            ]
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

async function extract(root, key, args, file = FILE) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(file), {
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

test("figma extract: hybrid static edges connect screens without prototype interactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-static-partial-"));
  try {
    const body = await extract(root, `FB${process.pid}${Date.now()}mix`, {}, PARTIAL_FILE);
    assert.equal(body.ok, true);
    assert.equal(body.counts.screens, 4);
    assert.equal(body.counts.edges, 4);
    const explicit = body.edges.find(
      (edge) => edge.from.name === "登录页" && edge.to?.name === "首页"
    );
    assert.equal(explicit.provenance, "explicit");
    const inferred = body.edges.filter((edge) => edge.provenance === "inferred");
    assert.equal(inferred.length, 1);
    assert.ok(inferred.some((edge) => edge.from.name === "首页" && edge.to?.name === "C"));
    assert.ok(
      body.warnings.some(
        (warning) => warning.code === "static-flow-inferred" && /部分屏/.test(warning.message)
      )
    );
    assert.ok(!body.warnings.some((warning) => warning.code === "unreachable-screens"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function graphScreen(id, name) {
  return {
    id,
    name,
    suggestedRoute: `/${name}`,
    childNames: [],
    textHints: [],
    provenance: "explicit",
    confidence: "high"
  };
}

function graphEdge(id, from, to, provenance = "explicit") {
  return {
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    element: { id, name: `To ${to.name}`, type: "BUTTON" },
    textHints: [],
    trigger: provenance === "inferred" ? "INFERRED" : "ON_CLICK",
    actionType: provenance === "inferred" ? "INFERRED" : "NODE",
    provenance,
    confidence: provenance === "inferred" ? "low" : "high"
  };
}

test("mergeStaticEdges: static clue edges + layout chain connect unreachable screens", () => {
  const a = graphScreen("s1", "A");
  const b = graphScreen("s2", "B");
  const c = graphScreen("s3", "C");
  const d = graphScreen("s4", "D");
  const explicit = {
    screens: [a, b, c, d],
    edges: [graphEdge("e1", a, b)],
    entryScreens: ["A"],
    unresolvedDestinations: []
  };
  const synthesized = {
    screens: [a, b, c, d],
    edges: [graphEdge("s1", c, d, "inferred")],
    entryScreens: ["A"],
    unresolvedDestinations: []
  };
  const result = mergeStaticEdges(explicit, synthesized);
  assert.equal(result.added, 2);
  assert.equal(result.graph.edges.length, 3);
  assert.ok(
    result.graph.edges.some(
      (edge) => edge.from.name === "C" && edge.to?.name === "D" && edge.provenance === "inferred"
    )
  );
  assert.ok(
    result.graph.edges.some(
      (edge) => edge.from.name === "B" && edge.to?.name === "C" && edge.trigger === "INFERRED"
    )
  );
});
