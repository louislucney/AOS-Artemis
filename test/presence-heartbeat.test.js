import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { buildPanelOverview } from "../dist/panel/overview.js";
import { createServerForRuntime } from "../dist/server.js";
import { aosStatus } from "../dist/tools/llm.js";
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

/** Runtime 使用自己的主机作用域视图，计数需包在 `runtime.store` 上。 */
function instrumentPresence(runtime) {
  const counters = { touchCount: 0, endCount: 0 };
  const scoped = runtime.store;
  const originalTouch = scoped.touchHostSession.bind(scoped);
  scoped.touchHostSession = async (input) => {
    counters.touchCount += 1;
    return originalTouch(input);
  };
  const originalEnd = scoped.endHostSession.bind(scoped);
  scoped.endHostSession = async (id, at) => {
    counters.endCount += 1;
    return originalEnd(id, at);
  };
  return counters;
}

test("Runtime.startClientSession/note/end 写 host_sessions 并节流", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    store,
    hostIdentity: hostIdentity("h1")
  });
  const counters = instrumentPresence(runtime);

  assert.equal(runtime.hostIdentity.id, "h1");
  assert.ok(runtime.clientSessionId);

  await runtime.startClientSession({ name: "cursor", version: "1.0" });
  assert.equal(counters.touchCount, 1);
  let rows = await store.listHostSessions("h1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, runtime.clientSessionId);
  assert.equal(rows[0].hostId, "h1");
  assert.equal(rows[0].client, "cursor");
  assert.equal(rows[0].clientVersion, "1.0");
  assert.equal(rows[0].username, "tester");
  assert.equal(rows[0].pid, process.pid);

  await runtime.noteClientPresence();
  assert.equal(counters.touchCount, 1, "startClientSession 已播种时间戳：30s 内首次心跳被节流");
  await runtime.noteClientPresence();
  assert.equal(counters.touchCount, 1, "30s 内节流：心跳不应落盘");

  await runtime.endClientSession();
  assert.equal(counters.endCount, 1);
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

test("presence 同时写 hosts.clientSeenAt：不预置 host 也显示 IDE 在线", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    store,
    hostIdentity: hostIdentity("h1")
  });
  assert.equal(await store.getHost("h1"), null, "启动前未预置 host 行");

  await runtime.startClientSession({ name: "cursor", version: "1.0" });
  const host = await store.getHost("h1");
  assert.ok(host, "单独的 stdio MCP 也创建 host 行");
  assert.ok(host.clientSeenAt, "clientSeenAt 已写入");
  assert.equal(host.username, "tester");

  const overview = await buildPanelOverview({ store });
  const machine = overview.machines.find((entry) => entry.id === "h1");
  assert.ok(machine);
  assert.equal(machine.clientOnline, true, "面板 IDE 在线");

  const status = JSON.parse((await aosStatus(runtime)).content[0].text);
  assert.equal(status.host.clientOnline, true, "aos_status IDE 在线");

  await runtime.endClientSession();
});

test("空闲心跳：会话 lastSeen 前进且 end 后停止", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    store,
    baseEnv: { AOS_CLIENT_PRESENCE_MS: "15" },
    hostIdentity: hostIdentity("h1")
  });
  const counters = instrumentPresence(runtime);

  await runtime.startClientSession({ name: "cursor" });
  const first = (await store.listHostSessions("h1"))[0].lastSeenAt;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const second = (await store.listHostSessions("h1"))[0].lastSeenAt;
  assert.ok(
    Date.parse(second) > Date.parse(first),
    `空闲 80ms 后 lastSeen 应前进（${first} → ${second}）`
  );

  await runtime.endClientSession();
  const afterEnd = counters.touchCount;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(counters.touchCount, afterEnd, "end 后定时器停止，不再写会话");
  assert.equal((await store.listHostSessions("h1")).length, 0, "会话已结束");
});

test("AOS_CLIENT_PRESENCE_MS=0 关闭 presence：不写会话、sessionId 为 null", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: true }),
    store,
    baseEnv: { AOS_CLIENT_PRESENCE_MS: "0" },
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

    assert.equal((await store.listHostSessions("h1")).length, 0);

    const events = await store.listUsageEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].hostId, "h1");
    assert.equal(events[0].sessionId, null);
  } finally {
    await client.close();
    await server.close();
  }
});
