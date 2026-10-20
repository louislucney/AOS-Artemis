import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { resolveEventProject, resolveProjectRoot } from "../dist/events/project-resolver.js";
import { makeTempDir } from "./helpers.js";

test("resolveProjectRoot: 拒绝 . 与 ..，缺失目录返回 null", () => {
  const workspace = makeTempDir("aos-events-ws-");
  assert.equal(resolveProjectRoot(workspace, ".."), null);
  assert.equal(resolveProjectRoot(workspace, "."), null);
  assert.equal(resolveProjectRoot(workspace, "missing"), null);
  const dir = path.join(workspace, "demo");
  fs.mkdirSync(dir);
  assert.equal(resolveProjectRoot(workspace, "demo"), fs.realpathSync(dir));
});

test("resolveEventProject: POST upsert 与 GET 不写", async () => {
  const workspace = makeTempDir("aos-events-ws-");
  const dir = path.join(workspace, "demo");
  fs.mkdirSync(dir);
  const projectRoot = fs.realpathSync(dir);
  const store = new MemoryStore();
  const get = await resolveEventProject({
    workspaceRoot: workspace,
    name: "demo",
    store,
    write: false
  });
  assert.equal(get.projectId, null);
  assert.equal(await store.getProjectByPath(projectRoot), null);
  const post = await resolveEventProject({
    workspaceRoot: workspace,
    name: "demo",
    store,
    write: true
  });
  assert.ok(post.projectId);
  assert.equal((await store.getProjectByPath(projectRoot)).id, post.projectId);
  await assert.rejects(
    () => resolveEventProject({ workspaceRoot: workspace, name: "..", store, write: true }),
    /项目名/
  );
});
