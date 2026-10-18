import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handleArtifactRequest } from "../dist/panel/artifact-route.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aos-artifact-route-"));
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: root, name: "p" });
  const deps = { store, env: {} };
  const dir = join(root, ".artemis", "design", "diffs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, "aos.config.jsonc"), "{}", "utf8");
  return { root, deps };
}

function url(root, relPath) {
  return new URL(
    `http://x/panel/artifact?project=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`
  );
}

test("artifact route: .artemis 内白名单文件可读（正确 content-type）", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(url(root, ".artemis/design/diffs/shot.png"), deps);
    assert.equal(response.status, 200);
    assert.equal(response.contentType, "image/png");
    assert.ok(Buffer.isBuffer(response.body));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 索引 CSV 导出（含筛选）", async () => {
  const { root, deps } = await setup();
  try {
    const csv = await handleArtifactRequest(
      new URL(`http://x/panel/artifact?project=${encodeURIComponent(root)}&format=csv&q=shot`),
      deps
    );
    assert.equal(csv.status, 200);
    assert.match(csv.contentType, /text\/csv/);
    assert.match(String(csv.body), /kind,path,title,at,size/);
    assert.match(String(csv.body), /shot\.png/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 越权与穿越全部拒绝", async () => {
  const { root, deps } = await setup();
  try {
    const outside = await handleArtifactRequest(url(root, "aos.config.jsonc"), deps);
    assert.equal(outside.status, 403, "仅 .artemis 范围");

    const traversal = await handleArtifactRequest(
      new URL(
        `http://x/panel/artifact?project=${encodeURIComponent(root)}&path=${encodeURIComponent(".artemis/../../etc/hosts")}`
      ),
      deps
    );
    assert.equal(traversal.status, 400, "目录穿越拒绝");

    const unknownExt = await handleArtifactRequest(url(root, ".artemis/design/diffs/raw.bin"), deps);
    assert.equal(unknownExt.status, 400, "非白名单类型拒绝");

    const missing = await handleArtifactRequest(url(root, ".artemis/design/diffs/none.png"), deps);
    assert.equal(missing.status, 404);

    const noParams = await handleArtifactRequest(new URL("http://x/panel/artifact"), deps);
    assert.equal(noParams.status, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
