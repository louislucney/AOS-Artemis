import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makeStores() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool());
  await pg.init();
  return [new MemoryStore(), pg];
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-project-hosts-"));
}

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "aos-project-host-proj-"));
  return root;
}

test("同一 rootPath 两台主机是两行；作用域解析不串台", async () => {
  for (const store of await makeStores()) {
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    await a.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    await b.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    assert.notEqual(
      (await a.getProjectByPath("/Users/louis/app")).id,
      (await b.getProjectByPath("/Users/louis/app")).id
    );
  }
});

test("未绑定 host 且多行 → AmbiguousProjectError，不取 rows[0]", async () => {
  for (const store of await makeStores()) {
    await store.scopeHost("h-a").upsertProject({ rootPath: "/x/app", name: "app" });
    await store.scopeHost("h-b").upsertProject({ rootPath: "/x/app", name: "app" });
    await assert.rejects(store.getProjectByPath("/x/app"), (e) => e.name === "AmbiguousProjectError");
  }
});

test("绑定 host 后 upsertProject 使用该 host；旧 NULL 行不被隐式接管", async () => {
  for (const store of await makeStores()) {
    const legacy = await store.upsertProject({ rootPath: "/x/app", name: "app" });
    const scoped = store.scopeHost("h-a");
    const local = await scoped.upsertProject({ rootPath: "/x/app", name: "app" });
    assert.equal(legacy.hostId, null);
    assert.equal(local.hostId, "h-a");
    assert.notEqual(local.id, legacy.id);
  }
});

test("FileStore: scopeHost 两行往返且重启保留", async () => {
  const home = await tempHome();
  const root = await tempProject();
  try {
    const store = await FileStore.create({ homeDir: home });
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    const ra = await a.upsertProject({ rootPath: root, name: "app" });
    const rb = await b.upsertProject({ rootPath: root, name: "app" });
    assert.notEqual(ra.id, rb.id);

    const reopened = await FileStore.create({ homeDir: home });
    const a2 = reopened.scopeHost("h-a");
    const b2 = reopened.scopeHost("h-b");
    assert.equal((await a2.getProjectByPath(root)).id, ra.id);
    assert.equal((await b2.getProjectByPath(root)).id, rb.id);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("FileStore: 历史 NULL 行与单个已绑定行共存 → 加载时自动收敛为已绑定行", async () => {
  const home = await tempHome();
  const root = await tempProject();
  try {
    const store = await FileStore.create({ homeDir: home });
    await store.upsertProject({ rootPath: root, name: "app" });
    await store.scopeHost("h-a").upsertProject({ rootPath: root, name: "app" });
    const statePath = join(root, ".artemis", "ledger", "state.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8"));
    for (const row of legacy.state.projects) {
      if (row.hostId === null) delete row.hostId;
    }
    await writeFile(statePath, JSON.stringify(legacy));

    const reopened = await FileStore.create({ homeDir: home });
    const project = await reopened.getProjectByPath(root);
    assert.equal(project.hostId, "h-a");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.state.projects.length, 1, "重复的无主机行已从快照移除");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("FileStore: 同 rootPath 两主机各自解析项目数据（无 AmbiguousProjectError、不串数据）", async () => {
  const home = await tempHome();
  const root = await tempProject();
  try {
    const store = await FileStore.create({ homeDir: home });
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    await a.upsertProject({ rootPath: root, name: "app" });
    await b.upsertProject({ rootPath: root, name: "app" });

    await a.setFigmaToken(root, "token-a");
    assert.equal((await a.getProjectByPath(root)).figmaToken, "token-a");
    assert.equal((await b.getProjectByPath(root)).figmaToken, null);

    await a.recordTask({ rootPath: root, traceId: "t-a", status: "submitted" });
    assert.equal((await a.listTasks(root)).length, 1);
    assert.equal((await b.listTasks(root)).length, 0);

    await a.recordCaseSet({
      rootPath: root,
      source: "test",
      basename: "feature-a",
      features: [
        {
          key: "f1",
          name: "F1",
          caseCount: 1,
          screens: [],
          jsonPath: join(root, "f1.json"),
          mdPath: join(root, "f1.md"),
          xlsxPath: join(root, "f1.xlsx")
        }
      ]
    });
    assert.equal((await a.listCaseSets(root)).length, 1);
    assert.equal((await b.listCaseSets(root)).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
