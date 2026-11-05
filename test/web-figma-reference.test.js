import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { FigmaReferenceError, storeFigmaReference } from "../dist/web/figma-reference.js";

async function setup(t, token = "figma-token") {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-figma-reference-"));
  const rootPath = path.join(workspace, "app");
  await mkdir(rootPath, { recursive: true });
  if (token !== null) {
    await writeFile(path.join(rootPath, ".env"), `FIGMA_ACCESS_TOKEN=${token}\n`);
  }
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "app" });
  return { rootPath, store };
}

const URL = "https://www.figma.com/design/ABC123/Login?node-id=1-2";

test("storeFigmaReference: URL node renders into a reference asset", async (t) => {
  const { rootPath, store } = await setup(t);
  const seen = [];
  const result = await storeFigmaReference({
    store,
    rootPath,
    figmaUrl: URL,
    uploadedBy: "alice",
    deps: {
      capture: async (fileKey, nodeIds, deps) => {
        seen.push({ fileKey, nodeIds, token: deps?.figmaToken });
        return {
          pngById: new Map([[nodeIds[0], Buffer.from("fake-png")]]),
          skipped: [],
          channelError: null
        };
      }
    }
  });
  assert.deepEqual(seen, [{ fileKey: "ABC123", nodeIds: ["1:2"], token: "figma-token" }]);
  assert.equal(result.asset.kind, "reference");
  assert.equal(result.asset.metadata.sourceType, "figma");
  assert.equal(result.asset.metadata.nodeId, "1:2");
  assert.equal(result.asset.metadata.fileKey, "ABC123");
  assert.match(result.asset.filename, /figma-ABC123-1-2\.png/);
});

test("storeFigmaReference: missing token / render failure fail closed", async (t) => {
  const noToken = await setup(t, null);
  await assert.rejects(
    () =>
      storeFigmaReference({
        store: noToken.store,
        rootPath: noToken.rootPath,
        figmaUrl: URL,
        uploadedBy: null
      }),
    (error) => error instanceof FigmaReferenceError && error.code === "figma-token-missing"
  );

  const { rootPath, store } = await setup(t);
  await assert.rejects(
    () =>
      storeFigmaReference({
        store,
        rootPath,
        figmaUrl: URL,
        uploadedBy: null,
        deps: {
          capture: async () => ({
            pngById: new Map(),
            skipped: ["1:2"],
            channelError: "render unavailable"
          })
        }
      }),
    (error) => error instanceof FigmaReferenceError && error.code === "figma-render-failed"
  );
});
