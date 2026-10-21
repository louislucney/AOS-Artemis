import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { resolveEventProject } from "../dist/events/project-resolver.js";
import { createAosHttpServer } from "../dist/http-server.js";
import { makeTempDir } from "./helpers.js";

const REMOTE_PATH = "/Users/louis/app";

/** 本机 host＝h-a；h-a 与 h-b 各有一条同名项目行（同一远端路径，本机磁盘不存在）。 */
async function makeStore() {
  const store = new MemoryStore();
  store.bindHost("h-a");
  const hA = store.scopeHost("h-a");
  const hB = store.scopeHost("h-b");
  const rowA = await hA.upsertProject({ rootPath: REMOTE_PATH, name: "app" });
  const rowB = await hB.upsertProject({ rootPath: REMOTE_PATH, name: "app" });
  return { store, hA, hB, rowA, rowB };
}

test("MemoryStore: 事件记录携带 hostId，同 eventId 两主机不判重", async () => {
  const { hA, hB } = await makeStore();
  const a = await hA.recordProjectEvent(REMOTE_PATH, { eventId: "evt-shared", type: "log.entry" });
  const b = await hB.recordProjectEvent(REMOTE_PATH, { eventId: "evt-shared", type: "log.entry" });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, false);
  assert.equal(a.record.hostId, "h-a");
  assert.equal(b.record.hostId, "h-b");
  assert.notEqual(a.record.projectId, b.record.projectId);
});

test("resolveEventProject: 显式非本机 host 按名解析远端（无需本机磁盘）", async () => {
  const { store, rowB } = await makeStore();
  const workspace = makeTempDir("aos-events-hosts-ws-");
  const resolved = await resolveEventProject({
    workspaceRoot: workspace,
    hostId: "h-b",
    name: "app",
    store,
    write: false
  });
  assert.ok(resolved);
  assert.equal(resolved.hostId, "h-b");
  assert.equal(resolved.rootPath, REMOTE_PATH);
  assert.equal(resolved.projectId, rowB.id);

  const missing = await resolveEventProject({
    workspaceRoot: workspace,
    hostId: "h-zzz",
    name: "app",
    store,
    write: true
  });
  assert.equal(missing, null);
});

test("resolveEventProject: 无显式 host 且同路径跨主机 → 返回 null（不取其一）", async () => {
  const store = new MemoryStore();
  const workspace = makeTempDir("aos-events-amb-");
  const dir = path.join(workspace, "app");
  fs.mkdirSync(dir);
  const rootPath = fs.realpathSync(dir);
  await store.scopeHost("h-a").upsertProject({ rootPath, name: "app" });
  await store.scopeHost("h-b").upsertProject({ rootPath, name: "app" });
  const resolved = await resolveEventProject({
    workspaceRoot: workspace,
    hostId: null,
    name: "app",
    store,
    write: false
  });
  assert.equal(resolved, null);
});

test("事件路由按 host 归属：/events/h-b/app 落到 h-b，旧 /events/app 不串 h-b", async () => {
  const { store, rowB } = await makeStore();
  const workspace = makeTempDir("aos-events-hosts-http-");
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  try {
    const base = `http://127.0.0.1:${handle.port}`;

    const post = await fetch(`${base}/events/h-b/app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "evt-hb-1", type: "log.entry", payload: { who: "b" } })
    });
    assert.equal(post.status, 202);
    const ack = await post.json();
    assert.equal(ack.accepted, true);

    const list = await (await fetch(`${base}/events/h-b/app?includePayload=false`)).json();
    assert.equal(list.returned, 1);
    assert.equal(list.events[0].hostId, "h-b");
    assert.equal(list.events[0].projectId, rowB.id);

    const polled = await (
      await fetch(`${base}/events/h-b/app/poll?waitMs=0&consume=false`)
    ).json();
    assert.equal(polled.returned, 1);
    assert.equal(polled.events[0].hostId, "h-b");

    // 旧路由仅本机；本机无同名磁盘目录 → 404，绝不落到 h-b。
    const legacy = await fetch(`${base}/events/app`);
    assert.equal(legacy.status, 404);

    // h-a 侧看不到 h-b 的事件。
    const hA = store.scopeHost("h-a");
    const hB = store.scopeHost("h-b");
    assert.equal((await hA.listProjectEvents(REMOTE_PATH)).length, 0);
    assert.equal((await hB.listProjectEvents(REMOTE_PATH)).length, 1);
  } finally {
    await handle.close();
  }
});
