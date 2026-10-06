import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { closeLogging, configureLogging } from "../dist/log.js";
import { createServerForRuntime } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, StubProxy } from "./helpers.js";

class ThrowingUsageStore extends MemoryStore {
  async recordUsageEvent() {
    throw new Error("pg down");
  }
}

async function makeHarness({ store, baseEnv, proxy } = {}) {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: proxy ?? new StubProxy({ running: true }),
    store,
    baseEnv: { AOS_MODEL_REFRESH_HOURS: "0", ...baseEnv }
  });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-server-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    dir,
    runtime,
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

async function makeBareClient(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-bare-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("usage server: a successful call records exactly one event", async () => {
  const harness = await makeHarness();
  try {
    const result = await harness.client.callTool({ name: "llm_list", arguments: {} });
    assert.notEqual(result.isError, true);
    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.tool, "llm_list");
    assert.equal(event.family, "native");
    assert.equal(event.ok, true);
    assert.ok(Number.isInteger(event.durationMs) && event.durationMs >= 0);
    assert.equal(event.errorClass, null);
    assert.equal(event.errorSummary, null);
    assert.deepEqual(event.argKeys, []);
    assert.ok(event.projectId);

    const status = JSON.parse(
      (await harness.client.callTool({ name: "aos_status", arguments: {} })).content[0].text
    );
    assert.deepEqual(status.usage, { enabled: true, storage: "memory" });
    assert.equal((await harness.runtime.store.listUsageEvents(harness.dir)).length, 2);
  } finally {
    await harness.close();
  }
});

test("usage server: a failing call records ok=false with its error summary", async () => {
  const harness = await makeHarness();
  try {
    const result = await harness.client.callTool({
      name: "llm_switch",
      arguments: { name: "ghost" }
    });
    assert.equal(result.isError, true);
    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, "llm_switch");
    assert.equal(events[0].ok, false);
    assert.equal(events[0].errorClass, "unknown");
    assert.match(events[0].errorSummary, /未知条目/);
    assert.deepEqual(events[0].argKeys, ["name"]);
  } finally {
    await harness.close();
  }
});

test("usage server: validation failures and unknown tools count; aos_usage is excluded", async () => {
  const harness = await makeHarness();
  try {
    const invalid = await harness.client.callTool({ name: "llm_switch", arguments: {} });
    assert.equal(invalid.isError, true);
    const unknown = await harness.client.callTool({
      name: "definitely_not_a_tool",
      arguments: { a: 1 }
    });
    assert.notEqual(unknown.isError, true);
    const self = await harness.client.callTool({ name: "aos_usage", arguments: {} });
    assert.ok(self);

    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    assert.equal(events.length, 2);
    const byTool = new Map(events.map((event) => [event.tool, event]));
    assert.equal(byTool.get("llm_switch").errorClass, "validation");
    assert.match(byTool.get("llm_switch").errorSummary, /^参数校验失败/);
    assert.equal(byTool.get("definitely_not_a_tool").family, "unknown");
    assert.equal(byTool.has("aos_usage"), false);
  } finally {
    await harness.close();
  }
});

test("usage server: a throwing store only logs a warning and never affects the result", async () => {
  const logDir = makeTempDir("aos-usage-log-");
  configureLogging({ logDir, echo: false });
  const harness = await makeHarness({ store: new ThrowingUsageStore() });
  try {
    const result = await harness.client.callTool({ name: "llm_list", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).ok, true);

    const log = fs.readFileSync(path.join(logDir, "aos-mcp.log"), "utf-8");
    assert.match(log, /使用统计记录失败: pg down/);
    assert.ok(!/tool=llm_list[^\n]*usage=/.test(log));
  } finally {
    closeLogging();
    await harness.close();
  }
});

test("usage server: audit log carries usage=<id> matching the recorded event id", async () => {
  const logDir = makeTempDir("aos-usage-log-");
  configureLogging({ logDir, echo: false });
  const harness = await makeHarness();
  try {
    await harness.client.callTool({ name: "llm_list", arguments: {} });
    const log = fs.readFileSync(path.join(logDir, "aos-mcp.log"), "utf-8");
    const match = /tool=llm_list ok=true ms=(\d+) usage=([0-9a-f-]{36})/.exec(log);
    assert.ok(match, log);
    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, match[2]);
  } finally {
    closeLogging();
    await harness.close();
  }
});

test("usage server: AOS_USAGE=0 records nothing and omits the log field", async () => {
  const logDir = makeTempDir("aos-usage-log-");
  configureLogging({ logDir, echo: false });
  const harness = await makeHarness({ baseEnv: { AOS_USAGE: "0" } });
  try {
    await harness.client.callTool({ name: "llm_list", arguments: {} });
    assert.equal((await harness.runtime.store.listUsageEvents(harness.dir)).length, 0);

    const status = JSON.parse(
      (await harness.client.callTool({ name: "aos_status", arguments: {} })).content[0].text
    );
    assert.deepEqual(status.usage, { enabled: false, storage: "memory" });

    const log = fs.readFileSync(path.join(logDir, "aos-mcp.log"), "utf-8");
    assert.ok(!/tool=llm_list[^\n]*usage=/.test(log));
    assert.ok(!/tool=aos_status[^\n]*usage=/.test(log));
  } finally {
    closeLogging();
    await harness.close();
  }
});

test("usage server: a thrown handler error is caught and recorded as internal", async () => {
  const events = [];
  const runtime = {
    proxy: {
      isRunning: () => false,
      ensureStarted: async () => {},
      listTools: async () => [],
      callTool: async () => ({ content: [{ type: "text", text: "{}" }] }),
      status: () => ({}),
      markForRestart: async () => {},
      dispose: async () => {},
      disposeSync: () => {}
    },
    setupInfo: async () => ({ required: false, missing: [], message: "", howToFix: [] }),
    ensureActiveModelUsable: async () => ({ ok: true, warnings: [] }),
    recordTaskResult: async () => {},
    recordUsage: async (input) => {
      events.push(input);
      return { id: "fake-usage-id", ...input };
    }
  };
  const server = createServerForRuntime(runtime, null);
  const client = await makeBareClient(server);
  try {
    const result = await client.callTool({ name: "llm_list", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /工具 "llm_list" 执行失败/);
    assert.equal(events.length, 1);
    assert.equal(events[0].family, "native");
    assert.equal(events[0].ok, false);
    assert.equal(events[0].errorClass, "internal");
  } finally {
    await client.close();
    await server.close();
  }
});

test("usage server: policy env caps events per project", async () => {
  const harness = await makeHarness({ baseEnv: { AOS_USAGE_MAX_EVENTS: "1" } });
  try {
    await harness.client.callTool({ name: "llm_list", arguments: {} });
    await harness.client.callTool({ name: "aos_status", arguments: {} });
    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].tool, "aos_status");
  } finally {
    await harness.close();
  }
});

test("usage server: consecutive calls get strictly increasing timestamps", async () => {
  const harness = await makeHarness();
  try {
    await harness.client.callTool({ name: "llm_list", arguments: {} });
    await harness.client.callTool({ name: "llm_list", arguments: {} });
    await harness.client.callTool({ name: "aos_status", arguments: {} });
    const events = await harness.runtime.store.listUsageEvents(harness.dir);
    const times = events.map((event) => event.at);
    assert.equal(times.length, 3);
    assert.equal(new Set(times).size, times.length);
    assert.deepEqual(times, [...times].sort().reverse());
  } finally {
    await harness.close();
  }
});

test("usage server: init-failed runtime still answers with an error and records nothing", async () => {
  const server = createServerForRuntime(null, "boom");
  const client = await makeBareClient(server);
  try {
    const result = await client.callTool({ name: "llm_list", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /AOS 项目初始化失败/);
  } finally {
    await client.close();
    await server.close();
  }
});
