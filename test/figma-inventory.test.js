import assert from "node:assert/strict";
import test from "node:test";

import { listFigmaFrames } from "../dist/figma/inventory.js";

function frame(id, name) {
  return { id, name, type: "FRAME", children: [] };
}

const FILE = {
  name: "Inventory App",
  document: {
    id: "0:0",
    name: "Document",
    type: "DOCUMENT",
    children: [
      {
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [frame("1:1", "登录页"), frame("1:2", "首页")]
      },
      {
        id: "0:2",
        name: "Flow Board",
        type: "CANVAS",
        children: [{ id: "2:1", name: "主流程", type: "SECTION", children: [] }]
      }
    ]
  }
};

test("figma inventory: depth=2 拉页面/画板清单，不拉整树", async () => {
  const requested = [];
  const originalFetch = globalThis.fetch;
  const oldTtl = process.env.AOS_FIGMA_CACHE_TTL_MS;
  process.env.AOS_FIGMA_CACHE_TTL_MS = "0";
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(JSON.stringify(FILE), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const inventory = await listFigmaFrames({
      url: "https://www.figma.com/design/InventoryKey/demo",
      token: "tok-inv"
    });
    assert.equal(inventory.ok, true, JSON.stringify(inventory));
    assert.ok(
      requested.some((url) => url.includes("/files/InventoryKey?depth=2")),
      "使用 depth=2"
    );
    assert.equal(inventory.pages.length, 2);
    assert.deepEqual(
      inventory.pages[0].frames.map((entry) => entry.name),
      ["登录页", "首页"]
    );
    assert.equal(inventory.pages[1].frames[0].type, "SECTION");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldTtl === undefined) delete process.env.AOS_FIGMA_CACHE_TTL_MS;
    else process.env.AOS_FIGMA_CACHE_TTL_MS = oldTtl;
  }
});
