import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { makeChatForRuntime } from "../dist/llm/pool/chat-factory.js";

const ROOT = "/w/chat-budget";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function setupToken(store, overrides = {}) {
  await store.upsertProject({ rootPath: ROOT, name: "p", hostId: null });
  const token = await store.upsertLlmPoolToken({
    name: "pool-chat",
    provider: "custom",
    baseUrl: "https://pool.example.com/v1",
    apiKey: "sk-pool",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1_000_000,
    budgetLimitTokens: null,
    maxConcurrency: 10,
    supportsStreamUsage: false,
    priority: 1,
    ...overrides
  });
  await store.upsertLlmPrice({
    provider: "custom",
    model: "m",
    currency: "CNY",
    fxRateToBase: 1,
    inputMicrosPerMtok: 10_000_000,
    outputMicrosPerMtok: 10_000_000,
    effectiveFrom: "2020-01-01T00:00:00.000Z"
  });
  return token;
}

function poolEntry(token) {
  return {
    name: "entry",
    provider: "custom",
    model: "m",
    baseUrl: "https://project.example.com",
    apiKey: "sk-own",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  };
}

test("chat with a pool token reserves before fetch and settles usage", async () => {
  const store = new MemoryStore();
  const token = await setupToken(store);
  let reservedDuringFetch = 0;

  const chat = await makeChatForRuntime({
    store,
    projectRoot: ROOT,
    env: {},
    entry: poolEntry(token),
    options: {
      fetchFn: async (_url, init) => {
        const snapshot = await store.getLlmBudgetSnapshot(token.id);
        reservedDuringFetch = snapshot?.reservedMicros ?? 0;
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, "m");
        return jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        });
      }
    }
  });

  assert.equal(await chat([{ role: "user", content: "hi" }]), "ok");
  assert.ok(reservedDuringFetch > 0);

  const events = await store.listLlmUsageEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].totalTokens, 120);
  assert.equal(events[0].usageSource, "provider");
  assert.equal(events[0].poolTokenId, token.id);
  assert.ok(events[0].costMicrosBase > 0);

  const snapshot = await store.getLlmBudgetSnapshot(token.id);
  assert.equal(snapshot.reservedMicros, 0);
  assert.equal(snapshot.activeReservations, 0);
  assert.ok(snapshot.usedTokens >= 120);
});

test("chat without usage settles an estimate instead of free", async () => {
  const store = new MemoryStore();
  const token = await setupToken(store);

  const chat = await makeChatForRuntime({
    store,
    projectRoot: ROOT,
    env: {},
    entry: poolEntry(token),
    options: {
      fetchFn: async () =>
        jsonResponse({ choices: [{ message: { content: "fallback answer" } }] })
    }
  });

  assert.equal(await chat([{ role: "user", content: "hi" }]), "fallback answer");
  const events = await store.listLlmUsageEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].usageSource, "estimated");
  assert.equal(events[0].status, "settled_estimated");
  assert.ok(events[0].totalTokens > 0);

  const snapshot = await store.getLlmBudgetSnapshot(token.id);
  assert.equal(snapshot.reservedMicros, 0);
  assert.equal(snapshot.activeReservations, 0);
});

test("chat 400 releases the reservation", async () => {
  const store = new MemoryStore();
  const token = await setupToken(store);

  const chat = await makeChatForRuntime({
    store,
    projectRoot: ROOT,
    env: {},
    entry: poolEntry(token),
    options: {
      fetchFn: async () => jsonResponse({ error: { message: "bad request" } }, 400)
    }
  });

  await assert.rejects(
    () => chat([{ role: "user", content: "hi" }]),
    /HTTP 400/
  );
  const snapshot = await store.getLlmBudgetSnapshot(token.id);
  assert.equal(snapshot.reservedMicros, 0);
  assert.equal(snapshot.usedMicros, 0);
  assert.equal(snapshot.activeReservations, 0);
  assert.equal((await store.listLlmUsageEvents({})).length, 0);
});

test("chat without a pool token records local usage with poolTokenId=null", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: ROOT, name: "p", hostId: null });
  await store.upsertLlmPrice({
    provider: "custom",
    model: "m",
    currency: "CNY",
    fxRateToBase: 1,
    inputMicrosPerMtok: 10_000_000,
    outputMicrosPerMtok: 10_000_000,
    effectiveFrom: "2020-01-01T00:00:00.000Z"
  });

  const chat = await makeChatForRuntime({
    store,
    projectRoot: ROOT,
    env: {},
    entry: {
      name: "own",
      provider: "custom",
      model: "m",
      baseUrl: "https://own.example.com/v1",
      apiKey: "sk-own"
    },
    options: {
      fetchFn: async () =>
        jsonResponse({
          choices: [{ message: { content: "local" } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 }
        })
    }
  });

  assert.equal(await chat([{ role: "user", content: "hi" }]), "local");
  const events = await store.listLlmUsageEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].poolTokenId, null);
  assert.equal(events[0].source, "local_chat");
  assert.equal(events[0].totalTokens, 60);
  assert.equal(events[0].usageSource, "provider");
});

test("chat body read failure settles the reservation instead of leaking it", async () => {
  const store = new MemoryStore();
  const token = await setupToken(store);
  const chat = await makeChatForRuntime({
    store,
    projectRoot: ROOT,
    env: {},
    entry: poolEntry(token),
    options: {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("body reset");
        }
      })
    }
  });
  await assert.rejects(() => chat([{ role: "user", content: "hi" }]), /body reset/);
  const snapshot = await store.getLlmBudgetSnapshot(token.id);
  assert.equal(snapshot.activeReservations, 0);
  assert.equal(snapshot.reservedMicros, 0);
  const events = await store.listLlmUsageEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "settled_estimated");
});

test("unpriced pool usage is recorded with null cost and charges the estimate", async () => {
  const bareStore = new MemoryStore();
  await bareStore.upsertProject({ rootPath: ROOT, name: "p", hostId: null });
  const bareToken = await bareStore.upsertLlmPoolToken({
    name: "bare",
    provider: "custom",
    baseUrl: "https://pool.example.com/v1",
    apiKey: "sk-pool",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1_000_000,
    maxConcurrency: 10
  });
  await bareStore.upsertLlm(ROOT, { name: "entry", model: "m", apiKey: null, makeActive: true });
  await bareStore.setLlmPoolBinding({ rootPath: ROOT, name: "entry", poolTokenId: bareToken.id, poolModel: "m" });
  const bareChat = await makeChatForRuntime({
    store: bareStore,
    projectRoot: ROOT,
    env: {},
    entry: poolEntry(bareToken),
    options: {
      fetchFn: async () =>
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        })
    }
  });
  assert.equal(await bareChat([{ role: "user", content: "hi" }]), "ok");
  const events = await bareStore.listLlmUsageEvents({});
  assert.equal(events.length, 1);
  assert.equal(events[0].costMicros, null);
  assert.equal(events[0].costMicrosBase, null);
  const snapshot = await bareStore.getLlmBudgetSnapshot(bareToken.id);
  assert.ok(snapshot.usedMicros > 0);
  assert.equal(snapshot.reservedMicros, 0);
});
