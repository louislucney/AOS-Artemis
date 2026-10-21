import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  try {
    const store = await FileStore.create({ homeDir: home });
    const a = store.scopeHost("h-a");
    const b = store.scopeHost("h-b");
    const ra = await a.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    const rb = await b.upsertProject({ rootPath: "/Users/louis/app", name: "app" });
    assert.notEqual(ra.id, rb.id);

    const reopened = await FileStore.create({ homeDir: home });
    const a2 = reopened.scopeHost("h-a");
    const b2 = reopened.scopeHost("h-b");
    assert.equal((await a2.getProjectByPath("/Users/louis/app")).id, ra.id);
    assert.equal((await b2.getProjectByPath("/Users/louis/app")).id, rb.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
