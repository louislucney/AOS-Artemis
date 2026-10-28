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

test("createWebProject: 显式 projectId（含 null）被采纳，缺省才回退 lookup", async () => {
  const mem = new MemoryStore();
  await mem.upsertProject({ rootPath: "/w/reg", name: "reg" });
  const regId = (await mem.getProjectByPath("/w/reg")).id;

  const explicit = await mem.createWebProject({
    rootPath: "/w/unreg", name: "a", normalizedName: "a", platforms: [], projectId: regId
  });
  assert.equal(explicit.projectId, regId);

  const forcedNull = await mem.createWebProject({
    rootPath: "/w/reg", name: "b", normalizedName: "b", platforms: [], projectId: null
  });
  assert.equal(forcedNull.projectId, null);

  const omitted = await mem.createWebProject({
    rootPath: "/w/reg", name: "c", normalizedName: "c", platforms: []
  });
  assert.equal(omitted.projectId, regId);

  const pg = await makePgStore();
  await pg.upsertProject({ rootPath: "/w/reg", name: "reg" });
  const pgRegId = (await pg.getProjectByPath("/w/reg")).id;
  const pgExplicit = await pg.createWebProject({
    rootPath: "/w/unreg", name: "d", normalizedName: "d", platforms: [], projectId: pgRegId
  });
  assert.equal(pgExplicit.projectId, pgRegId);
  const pgNull = await pg.createWebProject({
    rootPath: "/w/unreg2", name: "e", normalizedName: "e", platforms: [], projectId: null
  });
  assert.equal(pgNull.projectId, null);
});

test("FileStore: 跨项目桶同名 normalizedName 全局拒绝", async () => {
  const home = await tempHome();
  const rootA = join(home, "a");
  const rootB = join(home, "b");
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });

  const store = await FileStore.create({ homeDir: home });
  await store.createWebProject({ rootPath: rootA, name: "星巴克", normalizedName: "星巴克", platforms: [] });
  await assert.rejects(
    store.createWebProject({ rootPath: rootB, name: "星巴克", normalizedName: "星巴克", platforms: [] }),
    /UNIQUE|已存在|duplicate/i
  );
});

test("FileStore: 未注册项目的 web project 重启后仍可 list", async () => {
  const home = await tempHome();
  const root = join(home, "unreg");
  await mkdir(root, { recursive: true });

  let store = await FileStore.create({ homeDir: home });
  await store.createWebProject({ rootPath: root, name: "u", normalizedName: "u", platforms: ["android"] });
  await store.close();

  store = await FileStore.create({ homeDir: home });
  const listed = await store.listWebProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rootPath, root);
  assert.deepEqual(listed[0].platforms, ["android"]);
});

test("MemoryStore: deleteWebProject 硬删除并可重建", async () => {
  const store = new MemoryStore();
  await store.createWebProject({ rootPath: "/w/a", name: "a", normalizedName: "a", platforms: ["android"] });
  assert.equal(await store.deleteWebProject("/w/a"), true);
  assert.equal(await store.getWebProject("/w/a"), null);
  assert.equal(await store.deleteWebProject("/w/a"), false);
  await store.createWebProject({ rootPath: "/w/a", name: "a", normalizedName: "a", platforms: ["android"] });
  assert.equal((await store.listWebProjects()).length, 1);
});

test("PostgresStore (pg-mem): deleteWebProject 硬删除并可重建", async () => {
  const store = await makePgStore();
  await store.createWebProject({ rootPath: "/w/a", name: "a", normalizedName: "a", platforms: ["android"] });
  assert.equal(await store.deleteWebProject("/w/a"), true);
  assert.equal(await store.getWebProject("/w/a"), null);
  assert.equal(await store.deleteWebProject("/w/a"), false);
  await store.createWebProject({ rootPath: "/w/a", name: "a", normalizedName: "a", platforms: ["android"] });
  assert.equal((await store.listWebProjects()).length, 1);
});

test("FileStore: deleteWebProject 从索引与桶状态移除，重启后不残留", async () => {
  const home = await tempHome();
  const rootA = join(home, "a");
  const rootB = join(home, "b");
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });

  let store = await FileStore.create({ homeDir: home });
  await store.upsertProject({ rootPath: rootA, name: "a" });
  await store.upsertProject({ rootPath: rootB, name: "b" });
  await store.createWebProject({ rootPath: rootA, name: "a", normalizedName: "a", platforms: ["android"] });
  await store.createWebProject({ rootPath: rootB, name: "b", normalizedName: "b", platforms: ["ios"] });
  assert.equal(await store.deleteWebProject(rootA), true);
  assert.equal(await store.getWebProject(rootA), null);
  assert.equal((await store.listWebProjects()).length, 1);
  await store.close();

  store = await FileStore.create({ homeDir: home });
  const listed = await store.listWebProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].rootPath, rootB);
  assert.equal(await store.getWebProject(rootA), null);
  await store.createWebProject({ rootPath: rootA, name: "a", normalizedName: "a", platforms: ["android"] });
  assert.equal((await store.listWebProjects()).length, 2);
});
