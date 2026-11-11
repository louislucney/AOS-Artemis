import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { aggregateLlmUsage } from "../dist/llm/pool/aggregate.js";
import { runLlmCommand } from "../dist/llm/command.js";

function usage(overrides = {}) {
  return {
    baseInputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
    totalTokens: 15,
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    id: `e-${Math.random().toString(36).slice(2)}`,
    at: "2026-01-01T10:00:00.000Z",
    projectId: null,
    projectRoot: "/w/p",
    hostId: null,
    sessionId: null,
    taskId: null,
    traceId: null,
    poolTokenId: null,
    provider: "custom",
    model: "m",
    baseInputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5,
    totalTokens: 15,
    usageSource: "provider",
    estimatedTokens: null,
    reservedMicros: null,
    reservationId: null,
    settledAt: null,
    costMicros: 100,
    currency: "CNY",
    costMicrosBase: 100,
    baseCurrency: "CNY",
    fxRateToBase: 1,
    priceBookId: "p",
    priceVersion: 1,
    source: "center_proxy",
    requestId: null,
    status: "ok",
    errorClass: null,
    ...overrides
  };
}

test("aggregates by model and day in UTC", () => {
  const report = aggregateLlmUsage(
    [
      event({ at: "2026-01-01T23:59:59.000Z", model: "a" }),
      event({ at: "2026-01-02T00:00:00.000Z", model: "a" }),
      event({ at: "2026-01-01T01:00:00.000Z", model: "b" })
    ],
    { groupBy: "model", bucket: "day" }
  );
  assert.equal(report.bucket, "day");
  assert.equal(report.totals.requests, 3);
  assert.equal(report.totals.totalTokens, 45);
  assert.deepEqual(
    report.rows.map((row) => row.key),
    ["a@2026-01-01", "a@2026-01-02", "b@2026-01-01"]
  );
  assert.equal(report.rows[0].requests, 1);
});

test("mixed currency uses cost_micros_base only", () => {
  const report = aggregateLlmUsage(
    [
      event({ currency: "CNY", costMicros: 100, costMicrosBase: 100, fxRateToBase: 1 }),
      event({
        currency: "USD",
        costMicros: 100,
        costMicrosBase: 720,
        baseCurrency: "CNY",
        fxRateToBase: 7.2
      })
    ],
    {}
  );
  assert.equal(report.totals.costMicrosBase, 820);
  assert.equal(report.totals.unpricedRequests, 0);
  assert.equal(report.totals.fxMissingRequests, 0);
});

test("unpriced and fx-missing counts are explicit", () => {
  const report = aggregateLlmUsage(
    [
      event({ costMicros: null, costMicrosBase: null, currency: null }),
      event({ costMicros: 50, costMicrosBase: null, currency: "USD" })
    ],
    {}
  );
  assert.equal(report.totals.unpricedRequests, 1);
  assert.equal(report.totals.fxMissingRequests, 1);
  assert.equal(report.totals.costMicrosBase, 0);
});

test("month bucket uses YYYY-MM", () => {
  const report = aggregateLlmUsage(
    [
      event({ at: "2026-01-31T23:59:59.000Z" }),
      event({ at: "2026-02-01T00:00:00.000Z" })
    ],
    { bucket: "month" }
  );
  assert.deepEqual(
    report.rows.map((row) => row.key),
    ["all@2026-01", "all@2026-02"]
  );
});

test("filters by project and model", () => {
  const report = aggregateLlmUsage(
    [
      event({ projectRoot: "/w/p", model: "m" }),
      event({ projectRoot: "/w/other", model: "m" }),
      event({ projectRoot: "/w/p", model: "x" })
    ],
    { projectRoot: "/w/p", model: "m" }
  );
  assert.equal(report.totals.requests, 1);
});

async function withStore(fn) {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p", hostId: null });
  await store.recordLlmUsage({
    projectRoot: "/w/p",
    poolTokenId: null,
    provider: "custom",
    model: "m",
    usage: usage({ totalTokens: 15 }),
    usageSource: "provider",
    costMicros: 100,
    currency: "CNY",
    costMicrosBase: 100,
    baseCurrency: "CNY",
    fxRateToBase: 1,
    priceBookId: "p",
    priceVersion: 1,
    source: "center_proxy",
    status: "ok",
    at: "2026-01-01T10:00:00.000Z"
  });
  await store.recordLlmUsage({
    projectRoot: "/w/other",
    poolTokenId: null,
    provider: "custom",
    model: "m",
    usage: usage({ totalTokens: 30 }),
    usageSource: "provider",
    costMicros: 200,
    currency: "CNY",
    costMicrosBase: 200,
    baseCurrency: "CNY",
    fxRateToBase: 1,
    priceBookId: "p",
    priceVersion: 1,
    source: "center_proxy",
    status: "ok",
    at: "2026-01-02T10:00:00.000Z"
  });
  const lines = [];
  const errors = [];
  const code = await runLlmCommand(["usage", "--project", "/w/p", "--json"], {
    store,
    env: {},
    cwd: "/w/p",
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line)
  });
  await fn({ code, lines, errors, store });
}

test("CLI llm usage JSON scopes to the current project", async () => {
  await withStore(({ code, lines, errors }) => {
    assert.equal(code, 0, errors.join("\n"));
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, true);
    assert.equal(payload.report.totals.requests, 1);
    assert.equal(payload.report.totals.totalTokens, 15);
    assert.equal(payload.report.totals.costMicrosBase, 100);
  });
});

test("CLI llm usage text prints rows and totals", async () => {
  const store = new MemoryStore();
  const lines = [];
  const errors = [];
  const code = await runLlmCommand(["usage", "--project", "/w/p"], {
    store,
    env: {},
    cwd: "/w/p",
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 0, errors.join("\n"));
  assert.match(lines.join("\n"), /合计/);
});

test("CLI llm usage rejects an invalid bucket", async () => {
  const store = new MemoryStore();
  const errors = [];
  const code = await runLlmCommand(["usage", "--bucket", "week"], {
    store,
    env: {},
    cwd: "/w/p",
    log: () => undefined,
    errorLog: (line) => errors.push(line)
  });
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /bucket/);
});
