import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";

async function withPanel(fn) {
  const root = "/w/panel-llm";
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: root, name: "panel", hostId: null });
  const token = await store.upsertLlmPoolToken({
    name: "pool-a",
    provider: "custom",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-pool-secret-123456",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1_000_000,
    maxConcurrency: 5,
    priority: 2
  });
  await store.upsertLlm(root, { name: "entry", model: "m", apiKey: null, makeActive: true });
  await store.setLlmPoolBinding({
    rootPath: root,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  });
  await store.recordLlmUsage({
    projectRoot: root,
    poolTokenId: token.id,
    provider: "custom",
    model: "m",
    usage: {
      baseInputTokens: 100,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 20,
      totalTokens: 120
    },
    usageSource: "provider",
    costMicros: 70,
    currency: "CNY",
    costMicrosBase: 70,
    baseCurrency: "CNY",
    fxRateToBase: 1,
    priceBookId: "p",
    priceVersion: 1,
    source: "center_proxy",
    status: "ok",
    at: new Date().toISOString()
  });
  const deps = { store, env: {} };
  try {
    await fn({ deps, root, token });
  } finally {
    await store.close?.();
  }
}

test("GET /panel/api/llm/pool returns bound tokens with masked keys only", async () => {
  await withPanel(async ({ deps, root, token }) => {
    const response = await handlePanelRequest(
      new URL(`http://panel.local/panel/api/llm/pool?project=${encodeURIComponent(root)}`),
      deps
    );
    assert.equal(response.status, 200);
    const body = String(response.body);
    assert.equal(body.includes("sk-pool-secret-123456"), false);
    const payload = JSON.parse(body);
    assert.equal(payload.ok, true);
    assert.equal(payload.tokens.length, 1);
    assert.equal(payload.tokens[0].id, token.id);
    assert.match(payload.tokens[0].maskedKey, /^\*+/);
    assert.equal(payload.tokens[0].budget.period, "total");
    assert.equal(payload.tokens[0].budget.maxConcurrency, 5);
    assert.equal(payload.tokens[0].snapshot.usedTokens, 0);
  });
});

test("GET /panel/api/llm/usage returns an aggregated report", async () => {
  await withPanel(async ({ deps, root }) => {
    const response = await handlePanelRequest(
      new URL(
        `http://panel.local/panel/api/llm/usage?project=${encodeURIComponent(root)}&days=7&bucket=day&groupBy=model`
      ),
      deps
    );
    assert.equal(response.status, 200);
    const payload = JSON.parse(String(response.body));
    assert.equal(payload.ok, true);
    assert.equal(payload.report.totals.requests, 1);
    assert.equal(payload.report.totals.totalTokens, 120);
    assert.equal(payload.report.totals.costMicrosBase, 70);
    assert.equal(payload.report.groupBy, "model");
  });
});

test("unknown project returns 404 JSON", async () => {
  const store = new MemoryStore();
  const response = await handlePanelRequest(
    new URL("http://panel.local/panel/api/llm/usage?project=%2Fw%2Fmissing"),
    { store, env: {} }
  );
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(String(response.body)).ok, false);
});
