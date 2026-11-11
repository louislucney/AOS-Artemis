import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MemoryStore } from "../dist/db/memory.js";
import { runLlmCommand } from "../dist/llm/command.js";
import { createServerForRuntime } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

function jsonOf(result) {
  return JSON.parse(result.content[0].text);
}

async function setupStore() {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  await store.upsertLlm("/w/p", {
    name: "entry",
    provider: "custom",
    baseUrl: "https://project.example.com",
    model: "m",
    apiKey: "sk-own",
    makeActive: true
  });
  return store;
}

function makeIo() {
  const logs = [];
  const errors = [];
  return { logs, errors, log: (line) => logs.push(line), errorLog: (line) => errors.push(line) };
}

test("llm pool add/list masks the key and persists", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const code = await runLlmCommand(
    [
      "pool",
      "add",
      "--name",
      "p1",
      "--provider",
      "custom",
      "--base-url",
      "https://api.example.com",
      "--model",
      "m1",
      "--api-key",
      "sk-secret-123456"
    ],
    { store, env: {}, ...io }
  );
  assert.equal(code, 0);
  const out = io.logs.join("\n");
  assert.ok(out.includes("****"));
  assert.ok(!out.includes("sk-secret-123456"));

  const tokens = await store.listLlmPoolTokens();
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].apiKey, "sk-secret-123456");
  assert.equal(tokens[0].status, "active");
  assert.deepEqual(tokens[0].modelAllowlist, ["m1"]);
});

test("llm pool add without a token is pending_token", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const code = await runLlmCommand(
    [
      "pool",
      "add",
      "--name",
      "p2",
      "--provider",
      "custom",
      "--base-url",
      "https://api.example.com",
      "--model",
      "m1"
    ],
    { store, env: {}, ...io }
  );
  assert.equal(code, 0);
  const [token] = await store.listLlmPoolTokens();
  assert.equal(token.status, "pending_token");
});

test("llm pool bind links a project_llm entry", async () => {
  const store = await setupStore();
  const io = makeIo();
  const token = await store.upsertLlmPoolToken({
    name: "bound",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: "sk-pool",
    modelAllowlist: ["m"]
  });
  const code = await runLlmCommand(
    [
      "pool",
      "bind",
      "--project",
      "/w/p",
      "--entry",
      "entry",
      "--token",
      token.name,
      "--model",
      "m",
      "--mode",
      "auto"
    ],
    { store, env: {}, ...io }
  );
  assert.equal(code, 0);
  const [entry] = await store.listLlms("/w/p");
  assert.equal(entry.poolTokenId, token.id);
  assert.equal(entry.poolMode, "auto");
  assert.equal(entry.poolModel, "m");
  assert.equal(entry.apiKey, "sk-own");
});

test("llm pool bind rejects a missing entry", async () => {
  const store = await setupStore();
  const io = makeIo();
  const token = await store.upsertLlmPoolToken({
    name: "bound",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: "sk-pool"
  });
  const code = await runLlmCommand(
    [
      "pool",
      "bind",
      "--project",
      "/w/p",
      "--entry",
      "missing",
      "--token",
      token.id,
      "--model",
      "m"
    ],
    { store, env: {}, ...io }
  );
  assert.equal(code, 1);
  assert.ok(io.errors.join("\n").includes("missing"));
});

test("llm pool disable stops selection", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  await runLlmCommand(
    [
      "pool",
      "add",
      "--name",
      "p3",
      "--provider",
      "custom",
      "--base-url",
      "https://api.example.com",
      "--model",
      "m1",
      "--api-key",
      "sk-x"
    ],
    { store, env: {}, ...io }
  );
  const [token] = await store.listLlmPoolTokens();
  const code = await runLlmCommand(["pool", "disable", "--id", token.id], {
    store,
    env: {},
    ...io
  });
  assert.equal(code, 0);
  assert.equal((await store.getLlmPoolToken(token.id)).status, "disabled");
});

test("llm price set converts mtok and rejects overlapping ranges", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const base = [
    "price",
    "set",
    "--provider",
    "custom",
    "--model",
    "m",
    "--currency",
    "CNY",
    "--input-mtok",
    "3",
    "--output-mtok",
    "15",
    "--cache-read-mtok",
    "0.3",
    "--cache-write-mtok",
    "3.75"
  ];
  assert.equal(
    await runLlmCommand(
      [...base, "--effective-from", "2026-01-01T00:00:00.000Z"],
      { store, env: {}, ...io }
    ),
    0
  );
  const [price] = await store.listLlmPrices({ provider: "custom" });
  assert.equal(price.inputMicrosPerMtok, 3_000_000);
  assert.equal(price.outputMicrosPerMtok, 15_000_000);
  assert.equal(price.cacheReadMicrosPerMtok, 300_000);

  const overlap = await runLlmCommand(
    [...base, "--effective-from", "2026-02-01T00:00:00.000Z"],
    { store, env: {}, ...io }
  );
  assert.equal(overlap, 1);
  assert.ok(io.errors.join("\n").includes("重叠"));
});

test("llm price set requires fx for non-base currency", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const code = await runLlmCommand(
    [
      "price",
      "set",
      "--provider",
      "custom",
      "--model",
      "m",
      "--currency",
      "USD",
      "--input-mtok",
      "1",
      "--output-mtok",
      "2"
    ],
    { store, env: { AOS_LLM_COST_CURRENCY: "CNY" }, ...io }
  );
  assert.equal(code, 2);
  assert.ok(io.errors.join("\n").includes("--fx"));
});

test("llm pool add --dry-run validates with /models and does not persist", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return { ok: true, status: 200 };
  };
  const code = await runLlmCommand(
    [
      "pool",
      "add",
      "--name",
      "p4",
      "--provider",
      "custom",
      "--base-url",
      "https://api.example.com",
      "--model",
      "m1",
      "--api-key",
      "sk-validate",
      "--dry-run"
    ],
    { store, env: {}, fetch: fakeFetch, ...io }
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/models");
  assert.equal(calls[0].headers.authorization, "Bearer sk-validate");
  assert.equal((await store.listLlmPoolTokens()).length, 0);
});

test("llm pool add --dry-run marks 401 invalid", async () => {
  const store = new MemoryStore();
  const io = makeIo();
  const fakeFetch = async () => ({ ok: false, status: 401 });
  const code = await runLlmCommand(
    [
      "pool",
      "add",
      "--name",
      "p5",
      "--provider",
      "custom",
      "--base-url",
      "https://api.example.com",
      "--model",
      "m1",
      "--api-key",
      "sk-bad",
      "--dry-run"
    ],
    { store, env: {}, fetch: fakeFetch, ...io }
  );
  assert.equal(code, 1);
  assert.ok(io.logs.join("\n").includes("invalid"));
});

test("llm_pool_list returns only bound tokens with masked keys", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const store = new MemoryStore();
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy({ running: false }),
    store,
    baseEnv: { AOS_MODEL_REFRESH_HOURS: "0" }
  });
  const token = await store.upsertLlmPoolToken({
    name: "bound",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: "sk-bound-secret-9876",
    modelAllowlist: ["m"],
    budgetPeriod: "monthly",
    budgetLimitMicros: 1_000_000
  });
  await store.upsertLlmPoolToken({
    name: "unbound",
    provider: "custom",
    baseUrl: "https://other.example.com",
    apiKey: "sk-unbound-secret-1111"
  });
  await store.upsertLlm(dir, {
    name: "entry",
    provider: "custom",
    baseUrl: "https://project.example.com",
    model: "m",
    apiKey: "sk-own",
    makeActive: true
  });
  await store.setLlmPoolBinding({
    rootPath: dir,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  });

  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "llm-pool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "llm_pool_list", arguments: {} });
    assert.notEqual(result.isError, true);
    const payload = jsonOf(result);
    assert.equal(payload.ok, true);
    assert.equal(payload.tokens.length, 1);
    assert.equal(payload.tokens[0].name, "bound");
    assert.ok(payload.tokens[0].key.preview.startsWith("****"));
    assert.equal(payload.tokens[0].snapshot.limitMicros, 1_000_000);
    const text = JSON.stringify(result);
    assert.ok(!text.includes("sk-bound-secret-9876"));
    assert.ok(!text.includes("sk-unbound-secret-1111"));
    assert.ok(!text.includes("sk-own"));
  } finally {
    await client.close();
  }
});

test("llm pool bind rejects a non-active token", async () => {
  const store = await setupStore();
  const io = makeIo();
  const token = await store.upsertLlmPoolToken({
    name: "pending",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: null,
    status: "pending_token",
    modelAllowlist: ["m"]
  });
  const code = await runLlmCommand(
    ["pool", "bind", "--project", "/w/p", "--entry", "entry", "--token", token.id, "--model", "m"],
    { store, env: {}, ...io }
  );
  assert.equal(code, 1);
  assert.match(io.errors.join("\n"), /pending_token|状态/);
});

test("llm pool unbind clears the binding", async () => {
  const store = await setupStore();
  const io = makeIo();
  const token = await store.upsertLlmPoolToken({
    name: "bound",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: "sk-pool",
    modelAllowlist: ["m"]
  });
  await store.setLlmPoolBinding({ rootPath: "/w/p", name: "entry", poolTokenId: token.id, poolModel: "m" });
  const code = await runLlmCommand(
    ["pool", "unbind", "--project", "/w/p", "--entry", "entry"],
    { store, env: {}, ...io }
  );
  assert.equal(code, 0, io.errors.join("\n"));
  const [entry] = await store.listLlms("/w/p");
  assert.equal(entry.poolTokenId, null);
});
