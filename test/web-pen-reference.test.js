import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { PenReferenceError, storePenReference } from "../dist/web/pen-reference.js";

function penDoc(children) {
  return JSON.stringify({ version: "2.8", children });
}

async function setup(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-pen-reference-"));
  const rootPath = path.join(workspace, "app");
  await mkdir(rootPath, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const store = new MemoryStore();
  await store.upsertProject({ rootPath, name: "app" });
  return { rootPath, store };
}

test("storePenReference: .pen screens render into reference assets", async (t) => {
  const { rootPath, store } = await setup(t);
  const renderedIds = [];
  const result = await storePenReference({
    store,
    rootPath,
    filename: "login.pen",
    buffer: Buffer.from(
      penDoc([
        { id: "s1", type: "frame", name: "Login", width: 390, height: 844 },
        { id: "s2", type: "frame", name: "Home", width: 390, height: 844 }
      ])
    ),
    uploadedBy: "alice",
    deps: {
      render: async (input) => {
        renderedIds.push(...input.screenIds);
        const files = new Map();
        for (const id of input.screenIds) {
          const file = path.join(input.outDir, `${id}.png`);
          await writeFile(file, Buffer.from(`png-${id}`));
          files.set(id, file);
        }
        return { ok: true, dir: input.outDir, files, missing: [], log: "" };
      }
    }
  });
  assert.deepEqual(renderedIds, ["s1", "s2"]);
  assert.equal(result.screenCount, 2);
  assert.equal(result.assets.length, 2);
  assert.equal(result.assets[0].kind, "reference");
  assert.match(result.assets[0].filename, /login-Login-s1\.png/);
  assert.equal(result.assets[0].metadata.sourceType, "pen");
  assert.equal(result.assets[0].metadata.screenId, "s1");
  assert.equal(result.assets[1].metadata.screenName, "Home");
  assert.equal(await readFile(result.sourcePath, "utf8"), penDoc([
    { id: "s1", type: "frame", name: "Login", width: 390, height: 844 },
    { id: "s2", type: "frame", name: "Home", width: 390, height: 844 }
  ]));
  assert.equal((await store.listWebAssets(rootPath, "reference")).length, 2);
});

test("storePenReference: invalid/no-screen .pen fail closed", async (t) => {
  const { rootPath, store } = await setup(t);
  await assert.rejects(
    () =>
      storePenReference({
        store,
        rootPath,
        filename: "bad.pen",
        buffer: Buffer.from("not a pen"),
        uploadedBy: null
      }),
    (error) => error instanceof PenReferenceError && error.code === "pen-parse-failed"
  );
  await assert.rejects(
    () =>
      storePenReference({
        store,
        rootPath,
        filename: "empty.pen",
        buffer: Buffer.from(penDoc([])),
        uploadedBy: null
      }),
    (error) => error instanceof PenReferenceError && error.code === "pen-no-screens"
  );
});
