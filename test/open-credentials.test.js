import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { figmaExtractFlows } from "../dist/figma/flows.js";

const FILE = {
  name: "Demo",
  document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] }
};

function runtimeFor(rootDir) {
  return {
    configDirAbs: join(rootDir, ".artemis"),
    project: { rootDir, dotenvValues: {} },
    store: {}
  };
}

test("figma token: per-call token per request, cache not shared across tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-open-cred-"));
  const fileKey = `OPEN${process.pid}${Date.now()}`;
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const seen = [];
  delete process.env.FIGMA_ACCESS_TOKEN;
  globalThis.fetch = async (_url, init) => {
    seen.push(init?.headers?.["X-Figma-Token"] ?? null);
    return new Response(JSON.stringify(FILE), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const url = `https://www.figma.com/design/${fileKey}/demo`;
    await figmaExtractFlows(runtimeFor(root), { url, screens: false }, { figmaToken: "tok-a" });
    await figmaExtractFlows(runtimeFor(root), { url, screens: false }, { figmaToken: "tok-b" });
    assert.deepEqual(seen, ["tok-a", "tok-b"], "每次请求使用自己的 token，且缓存不跨 token 复用");
    assert.equal(process.env.FIGMA_ACCESS_TOKEN, undefined, "不得写回进程 env");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  }
});
