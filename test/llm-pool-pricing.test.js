import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  baseCurrencyFrom,
  computeCost,
  estimateCostMicros,
  findPrice,
  penaltyRate
} from "../dist/llm/pool/pricing.js";
import { estimatedUsage, normalizeUsage } from "../dist/llm/pool/usage.js";

function priceRecord(overrides = {}) {
  return {
    id: "price-1",
    version: 1,
    provider: "anthropic",
    model: "claude",
    currency: "USD",
    fxRateToBase: 1,
    inputMicrosPerMtok: 3_000_000,
    outputMicrosPerMtok: 15_000_000,
    cacheReadMicrosPerMtok: 300_000,
    cacheWriteMicrosPerMtok: 3_750_000,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    createdBy: null,
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("OpenAI prompt_tokens includes cached tokens", () => {
  const u = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 600 }
  });
  assert.deepEqual(u, {
    baseInputTokens: 400,
    cacheCreationTokens: 0,
    cacheReadTokens: 600,
    outputTokens: 100,
    totalTokens: 1100
  });
});

test("DeepSeek hit/miss are separate fields", () => {
  const u = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400
  });
  assert.equal(u.baseInputTokens, 400);
  assert.equal(u.cacheReadTokens, 600);
  assert.equal(u.totalTokens, 1100);
});

test("Anthropic input_tokens excludes cache", () => {
  const u = normalizeUsage({
    input_tokens: 1000,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 3000,
    output_tokens: 500
  });
  assert.deepEqual(u, {
    baseInputTokens: 1000,
    cacheCreationTokens: 200,
    cacheReadTokens: 3000,
    outputTokens: 500,
    totalTokens: 4700
  });
});

test("generic prompt shape does not subtract cache without an explicit adapter", () => {
  const u = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 10,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 100
  });
  assert.deepEqual(u, {
    baseInputTokens: 1000,
    cacheCreationTokens: 100,
    cacheReadTokens: 300,
    outputTokens: 10,
    totalTokens: 1410
  });
});

test("missing usage returns null", () => {
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ prompt_tokens: "1000" }), null);
});

test("normalization clamps negative and fractional counts", () => {
  const u = normalizeUsage({
    input_tokens: -5,
    cache_creation_input_tokens: 1.9,
    cache_read_input_tokens: 2.2,
    output_tokens: -1
  });
  assert.deepEqual(u, {
    baseInputTokens: 0,
    cacheCreationTokens: 1,
    cacheReadTokens: 2,
    outputTokens: 0,
    totalTokens: 3
  });
});

test("estimatedUsage splits prompt and output", () => {
  assert.deepEqual(estimatedUsage(100, 20), {
    baseInputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 20,
    totalTokens: 120
  });
});

test("Anthropic cache cost matches manual billing", () => {
  const usage = {
    baseInputTokens: 1000,
    cacheCreationTokens: 200,
    cacheReadTokens: 3000,
    outputTokens: 500,
    totalTokens: 4700
  };
  const cost = computeCost(usage, priceRecord(), "USD");
  assert.equal(cost.costMicros, 12150);
  assert.equal(cost.costMicrosBase, 12150);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.priceBookId, "price-1");
  assert.equal(cost.priceVersion, 1);
});

test("USD price converts to CNY base", () => {
  const usage = {
    baseInputTokens: 1000,
    cacheCreationTokens: 200,
    cacheReadTokens: 3000,
    outputTokens: 500,
    totalTokens: 4700
  };
  const cost = computeCost(usage, priceRecord({ fxRateToBase: 7.2 }), "CNY");
  assert.equal(cost.costMicros, 12150);
  assert.equal(cost.costMicrosBase, 87480);
  assert.equal(cost.fxRateToBase, 7.2);
});

test("missing FX is not silently 1:1", () => {
  const usage = {
    baseInputTokens: 1000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 1000
  };
  const cost = computeCost(
    usage,
    priceRecord({ currency: "USD", fxRateToBase: 0 }),
    "CNY"
  );
  assert.equal(cost.costMicros, 3000);
  assert.equal(cost.costMicrosBase, null);
});

test("unpriced model uses penalty rate", () => {
  const rate = penaltyRate([], "CNY", { AOS_LLM_UNPRICED_MICROS_PER_MTOK: "20000000" });
  assert.equal(rate.inputMicrosPerMtok, 20000000);
  assert.equal(rate.model, "*");
  assert.equal(rate.provider, "*");
  assert.equal(rate.currency, "CNY");
  assert.equal(rate.fxRateToBase, 1);
});

test("penalty rate uses the highest known base-currency input price", () => {
  const prices = [
    priceRecord({ id: "a", currency: "CNY", fxRateToBase: 1, inputMicrosPerMtok: 1_000_000 }),
    priceRecord({ id: "b", currency: "CNY", fxRateToBase: 1, inputMicrosPerMtok: 5_000_000 }),
    priceRecord({ id: "c", currency: "USD", fxRateToBase: 7.2, inputMicrosPerMtok: 9_000_000 })
  ];
  const rate = penaltyRate(prices, "CNY", {});
  assert.equal(rate.inputMicrosPerMtok, 5_000_000);
  assert.equal(rate.outputMicrosPerMtok, 5_000_000);
});

test("penalty rate falls back to the default when env is invalid", () => {
  const rate = penaltyRate([], "CNY", { AOS_LLM_UNPRICED_MICROS_PER_MTOK: "-3" });
  assert.equal(rate.inputMicrosPerMtok, 20000000);
});

test("baseCurrencyFrom validates three-letter codes", () => {
  assert.equal(baseCurrencyFrom({}), "CNY");
  assert.equal(baseCurrencyFrom({ AOS_LLM_COST_CURRENCY: "usd" }), "USD");
  assert.equal(baseCurrencyFrom({ AOS_LLM_COST_CURRENCY: "US" }), "CNY");
  assert.equal(baseCurrencyFrom({ AOS_LLM_COST_CURRENCY: "US1" }), "CNY");
});

test("findPrice honours effective intervals", () => {
  const prices = [
    priceRecord({
      id: "jan",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-02-01T00:00:00.000Z"
    }),
    priceRecord({ id: "feb", effectiveFrom: "2026-02-01T00:00:00.000Z" })
  ];
  assert.equal(findPrice(prices, "anthropic", "claude", "2026-01-15T00:00:00.000Z").id, "jan");
  assert.equal(findPrice(prices, "anthropic", "claude", "2026-02-01T00:00:00.000Z").id, "feb");
  assert.equal(findPrice(prices, "anthropic", "claude", "2025-12-31T23:59:59.999Z"), null);
});

test("findPrice prefers exact matches over wildcards", () => {
  const prices = [
    priceRecord({ id: "wild", provider: "*", model: "*", inputMicrosPerMtok: 1 }),
    priceRecord({ id: "model-wild", provider: "anthropic", model: "*", inputMicrosPerMtok: 2 }),
    priceRecord({ id: "provider-wild", provider: "*", model: "claude", inputMicrosPerMtok: 3 }),
    priceRecord({ id: "exact", provider: "anthropic", model: "claude", inputMicrosPerMtok: 4 })
  ];
  assert.equal(findPrice(prices, "anthropic", "claude", "2026-03-01T00:00:00.000Z").id, "exact");
  assert.equal(findPrice(prices, "anthropic", "other", "2026-03-01T00:00:00.000Z").id, "model-wild");
  assert.equal(findPrice(prices, "other", "claude", "2026-03-01T00:00:00.000Z").id, "provider-wild");
  assert.equal(findPrice(prices, "other", "other", "2026-03-01T00:00:00.000Z").id, "wild");
});

test("findPrice takes the newest interval when specificity ties", () => {
  const prices = [
    priceRecord({ id: "old", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
    priceRecord({ id: "new", effectiveFrom: "2026-02-01T00:00:00.000Z" })
  ];
  assert.equal(findPrice(prices, "anthropic", "claude", "2026-03-01T00:00:00.000Z").id, "new");
});

test("estimateCostMicros includes cache rates", () => {
  const usage = {
    baseInputTokens: 1000,
    cacheCreationTokens: 200,
    cacheReadTokens: 3000,
    outputTokens: 500,
    totalTokens: 4700
  };
  assert.equal(estimateCostMicros(usage, priceRecord()), 12150);
});

test("unpriced model with only a money budget is blocked", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  const token = await store.upsertLlmPoolToken({
    name: "t",
    provider: "custom",
    baseUrl: "https://x",
    modelAllowlist: ["m"],
    budgetPeriod: "monthly",
    budgetLimitMicros: 100
  });
  const rate = penaltyRate([], "CNY", { AOS_LLM_UNPRICED_MICROS_PER_MTOK: "20000000" });
  const usage = estimatedUsage(100, 100);
  const estimatedMicros = estimateCostMicros(usage, rate);
  const result = await store.reserveLlmBudget({
    poolTokenId: token.id,
    projectRoot: "/w/p",
    provider: "custom",
    model: "m",
    source: "center_proxy",
    estimatedPromptTokens: 100,
    estimatedOutputTokens: 100,
    estimatedMicros
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "budget-exhausted");
});

test("cache rates fall back to the input rate when unset", () => {
  const usage = {
    baseInputTokens: 0,
    cacheCreationTokens: 1_000,
    cacheReadTokens: 1_000,
    outputTokens: 0,
    totalTokens: 2_000
  };
  const cost = computeCost(
    usage,
    priceRecord({ currency: "CNY", fxRateToBase: 1, cacheReadMicrosPerMtok: null, cacheWriteMicrosPerMtok: null }),
    "CNY"
  );
  // 2000 tokens * 3 CNY/Mtok = 6000 micros
  assert.equal(cost.costMicros, 6_000);
});
