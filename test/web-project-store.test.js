import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makePgStore() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = new PostgresStore(new Pool());
  await store.init();
  return store;
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-web-project-"));
}

test("MemoryStore: createWebProject/getWebProject/archiveWebProject + normalizedName 唯一", async () => {
  const store = new MemoryStore();
  const created = await store.createWebProject({
    rootPath: "/w/acme", name: "星巴克", normalizedName: "星巴克",
    platforms: ["android"], appPackage: "com.starbucks.tw", owner: "admin"
  });
  assert.equal(created.name, "星巴克");
  assert.equal((await store.getWebProject("/w/acme")).appPackage, "com.starbucks.tw");
  await assert.rejects(
    store.createWebProject({ rootPath: "/w/other", name: "星巴克", normalizedName: "星巴克", platforms: [] }),
    /UNIQUE|已存在|duplicate/i
  );
  assert.equal(await store.archiveWebProject("/w/acme", "2026-10-28T00:00:00.000Z"), true);
  assert.equal((await store.getWebProject("/w/acme")).status, "archived");
});

test("MemoryStore: listWebProjects + 未知 rootPath 返回 null", async () => {
  const store = new MemoryStore();
  await store.createWebProject({ rootPath: "/w/a", name: "a", normalizedName: "a", platforms: ["android"] });
  await store.createWebProject({ rootPath: "/w/b", name: "b", normalizedName: "b", platforms: ["ios"] });
  const listed = await store.listWebProjects();
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((record) => record.rootPath).sort(), ["/w/a", "/w/b"]);
  assert.equal(await store.getWebProject("/w/nope"), null);
});

test("PostgresStore (pg-mem): web_projects 往返 + 唯一 + 归档", async () => {
  const store = await makePgStore();
  const created = await store.createWebProject({
    rootPath: "/w/acme", name: "星巴克", normalizedName: "星巴克",
    platforms: ["android"], appPackage: "com.starbucks.tw", owner: "admin"
  });
  assert.equal(created.name, "星巴克");
  assert.equal((await store.getWebProject("/w/acme")).appPackage, "com.starbucks.tw");
  await assert.rejects(
    store.createWebProject({ rootPath: "/w/other", name: "星巴克", normalizedName: "星巴克", platforms: [] }),
    /UNIQUE|已存在|duplicate/i
  );
  assert.equal(await store.archiveWebProject("/w/acme", "2026-10-28T00:00:00.000Z"), true);
  assert.equal((await store.getWebProject("/w/acme")).status, "archived");
  assert.equal((await store.listWebProjects()).length, 1);
});

test("FileStore: 重启后仍可读 + 归档持久 + listWebProjects", async () => {
  const home = await tempHome();
  const root = join(home, "acme");
  await mkdir(root, { recursive: true });

  let store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: root, name: "acme" });
  await store.createWebProject({
    rootPath: root, name: "星巴克", normalizedName: "星巴克",
    platforms: ["android"], appPackage: "com.starbucks.tw", owner: "admin"
  });
  await store.close();

  store = await FileStore.create({ homeDir: home });
  const found = await store.getWebProject(root);
  assert.equal(found.name, "星巴克");
  assert.equal(found.appPackage, "com.starbucks.tw");
  assert.equal(found.status, "active");
  assert.equal(await store.archiveWebProject(root, "2026-10-28T00:00:00.000Z"), true);
  await store.close();

  store = await FileStore.create({ homeDir: home });
  assert.equal((await store.getWebProject(root)).status, "archived");
  const listed = await store.listWebProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "archived");
});
