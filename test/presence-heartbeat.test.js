import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { createServerForRuntime } from "../dist/server.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempProject,
  StubProxy,
  TEST_HOST_IDENTITY
} from "./helpers.js";

function hostIdentity(id) {
  return { ...TEST_HOST_IDENTITY, id, username: "tester" };
}

class CountingStore extends MemoryStore {
  constructor() {
    super();
    this.touchCount = 0;
    this.endCount = 0;
  }

  async touchHostSession(input) {
    this.touchCount += 1;
    return super.touchHostSession(input);
  }

  async endHostSession(id, at) {
    this.endCount += 1;
    return super.endHostSession(id, at);
  }
}

test("Runtime.startClientSession/note/end 写 host_sessions 并节流", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new CountingStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    store,
    hostIdentity: hostIdentity("h1")
  });

  assert.equal(runtime.hostIdentity.id, "h1");
  assert.ok(runtime.clientSessionId);

  await runtime.startClientSession({ name: "cursor", version: "1.0" });
  assert.equal(store.touchCount, 1);
  let rows = await store.listHostSessions("h1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, runtime.clientSessionId);
  assert.equal(rows[0].hostId, "h1");
  assert.equal(rows[0].client, "cursor");
  assert.equal(rows[0].clientVersion, "1.0");
  assert.equal(rows[0].username, "tester");
  assert.equal(rows[0].pid, process.pid);

  await runtime.noteClientPresence();
  assert.equal(store.touchCount, 2);
  await runtime.noteClientPresence();
  assert.equal(store.touchCount, 2, "30s 内节流：第二次心跳不应落盘");

  await runtime.endClientSession();
  assert.equal(store.endCount, 1);
  const ended = store.exportState().hostSessions.find((s) => s.id === runtime.clientSessionId);
  assert.ok(ended);
  assert.notEqual(ended.endedAt, null);
  assert.equal((await store.listHostSessions("h1")).length, 0);
});

test("usage 事件带 hostId/sessionId（经 InMemoryTransport 工具调用）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    store,
    hostIdentity: hostIdentity("h1")
  });

  const server = createServerForRuntime(runtime, null, { presence: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cursor", version: "1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "aos_status", arguments: {} });
    assert.notEqual(result.isError, true);

    const events = await store.listUsageEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].hostId, "h1");
    assert.equal(events[0].sessionId, runtime.clientSessionId);

    // 接入会话已由 oninitialized 登记（clientInfo 取自 getClientVersion）。
    const sessions = await store.listHostSessions("h1");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].client, "cursor");
    assert.equal(sessions[0].clientVersion, "1.0");
  } finally {
    await client.close();
    await server.close();
  }
});
