import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";

import { FileStore } from "../dist/db/file.js";
import { MemoryStore } from "../dist/db/memory.js";
import { PostgresStore } from "../dist/db/postgres.js";

async function makeStores(env = {}) {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pg = new PostgresStore(new Pool(), null, env);
  await pg.init();
  return [new MemoryStore(null, env), pg];
}

async function tempHome() {
  return mkdtemp(join(tmpdir(), "aos-llm-pool-"));
}

async function runAgainstEachStore(fn, env = {}) {
  for (const store of await makeStores(env)) {
    await fn(store);
  }
  const home = await tempHome();
  try {
    const file = await FileStore.create({ homeDir: home, env });
    await fn(file);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function tokenInput(overrides = {}) {
  return {
    name: "t1",
    provider: "custom",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-fake-key-123",
    status: "active",
    priority: 1,
    budgetPeriod: "total",
    budgetLimitMicros: null,
    budgetLimitTokens: null,
    currency: "CNY",
    maxConcurrency: 10,
    supportsStreamUsage: false,
    modelAllowlist: ["m"],
    ...overrides
  };
}

function usageInput(overrides = {}) {
  return {
    projectRoot: "/w/p",
    projectId: null,
    poolTokenId: null,
    provider: "custom",
    model: "m",
    usage: {
      baseInputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 5,
      totalTokens: 15
    },
    usageSource: "provider",
    costMicros: null,
    currency: null,
    costMicrosBase: null,
    baseCurrency: "CNY",
    fxRateToBase: null,
    priceBookId: null,
    priceVersion: null,
    source: "center_proxy",
    status: "ok",
    ...overrides
  };
}

function reserveInput(overrides = {}) {
  return {
    poolTokenId: "",
    projectRoot: "/w/p",
    provider: "custom",
    model: "m",
    source: "center_proxy",
    estimatedPromptTokens: 5,
    estimatedOutputTokens: 5,
    estimatedMicros: 10,
    ...overrides
  };
}

test("pool token, price, and usage roundtrip", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(tokenInput({ name: "t-roundtrip" }));
    assert.ok(token.id);
    assert.equal(token.apiKey, "sk-fake-key-123");
    assert.equal(token.status, "active");

    const listed = await store.listLlmPoolTokens();
    assert.equal(listed.length, 1);
    assert.equal((await store.getLlmPoolToken(token.id)).name, "t-roundtrip");

    const price = await store.upsertLlmPrice({
      provider: "custom",
      model: "m",
      currency: "CNY",
      fxRateToBase: 1,
      inputMicrosPerMtok: 1000000,
      outputMicrosPerMtok: 2000000,
      effectiveFrom: "2026-01-01T00:00:00.000Z"
    });
    assert.ok(price.id);
    assert.equal(price.version, 1);

    const usage = await store.recordLlmUsage(
      usageInput({ poolTokenId: token.id, model: "m" })
    );
    assert.ok(usage.id);
    assert.equal(usage.totalTokens, 15);

    const prices = await store.listLlmPrices({ provider: "custom" });
    assert.equal(prices.length, 1);

    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.equal(events[0].poolTokenId, token.id);
  });
});

test("project llm pool binding fields roundtrip", async () => {
  await runAgainstEachStore(async (store) => {
    await store.upsertProject({ rootPath: "/w/p", name: "p" });
    await store.upsertLlm("/w/p", { name: "entry", model: "m", apiKey: null });

    const ok = await store.setLlmPoolBinding({
      rootPath: "/w/p",
      name: "entry",
      poolTokenId: "tok-1",
      poolMode: "auto",
      poolModel: "gpt-x"
    });
    assert.equal(ok, true);

    let entry = (await store.listLlms("/w/p"))[0];
    assert.equal(entry.poolTokenId, "tok-1");
    assert.equal(entry.poolMode, "auto");
    assert.equal(entry.poolModel, "gpt-x");

    // an unrelated config save must not erase the binding
    await store.upsertLlm("/w/p", { name: "entry", model: "m2", apiKey: null });
    entry = (await store.listLlms("/w/p"))[0];
    assert.equal(entry.poolTokenId, "tok-1");
    assert.equal(entry.poolMode, "auto");
    assert.equal(entry.poolModel, "gpt-x");

    assert.equal(
      await store.setLlmPoolBinding({ rootPath: "/w/p", name: "missing", poolTokenId: "x" }),
      false
    );
  });
});

test("atomic reservation never overshoots", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-atomic", budgetLimitMicros: 100, maxConcurrency: 1000 })
    );
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        store.reserveLlmBudget(
          reserveInput({ poolTokenId: token.id, estimatedMicros: 10 })
        )
      )
    );
    const allowed = results.filter((r) => r.ok).length;
    assert.equal(allowed, 10);
    const snap = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(snap.usedMicros + snap.reservedMicros, 100);
    assert.equal(snap.activeReservations, 10);
  });
});

test("settle converts reserved to used and is idempotent", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-settle", budgetLimitMicros: 1000, maxConcurrency: 10 })
    );
    const res = await store.reserveLlmBudget(
      reserveInput({ poolTokenId: token.id, estimatedMicros: 50 })
    );
    assert.equal(res.ok, true);

    const before = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(before.reservedMicros, 50);
    assert.equal(before.usedMicros, 0);

    const settleInput = {
      reservationId: res.reservation.id,
      usage: { baseInputTokens: 6, cacheCreationTokens: 0, cacheReadTokens: 2, outputTokens: 5, totalTokens: 13 },
      usageSource: "provider",
      costMicros: 60,
      currency: "CNY",
      costMicrosBase: 60,
      baseCurrency: "CNY",
      fxRateToBase: 1,
      priceBookId: null,
      priceVersion: null,
      status: "ok"
    };
    const usage = await store.settleLlmReservation(settleInput);
    assert.ok(usage);
    assert.equal(usage.totalTokens, 13);
    assert.equal(usage.reservationId, res.reservation.id);

    const after = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(after.reservedMicros, 0);
    assert.equal(after.usedMicros, 60);
    assert.equal(after.usedTokens, 13);
    assert.equal(after.activeReservations, 0);

    assert.equal(await store.settleLlmReservation(settleInput), null);
    assert.equal((await store.listLlmUsageEvents({})).length, 1);
  });
});

test("release frees reserved without usage", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-release", budgetLimitMicros: 1000 })
    );
    const res = await store.reserveLlmBudget(
      reserveInput({ poolTokenId: token.id, estimatedMicros: 40 })
    );
    assert.equal(res.ok, true);

    const before = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(before.reservedMicros, 40);

    assert.equal(await store.releaseLlmReservation({ reservationId: res.reservation.id }), true);

    const after = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(after.reservedMicros, 0);
    assert.equal(after.usedMicros, 0);
    assert.equal(after.activeReservations, 0);
    assert.equal((await store.listLlmUsageEvents({})).length, 0);

    assert.equal(await store.releaseLlmReservation({ reservationId: res.reservation.id }), false);
  });
});

test("ttl reconcile settles at estimate", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-ttl", budgetLimitMicros: 1000 })
    );
    const res = await store.reserveLlmBudget(
      reserveInput({
        poolTokenId: token.id,
        estimatedPromptTokens: 7,
        estimatedOutputTokens: 3,
        estimatedMicros: 55,
        at: "2026-01-01T00:00:00.000Z",
        ttlMs: 1000
      })
    );
    assert.equal(res.ok, true);

    const result = await store.reconcileLlmReservations({
      at: "2026-01-01T00:10:00.000Z"
    });
    assert.equal(result.settled, 1);
    assert.equal(result.released, 0);

    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.equal(events[0].usageSource, "estimated");
    assert.equal(events[0].status, "settled_estimated");
    assert.equal(events[0].errorClass, "reservation-ttl");
    assert.equal(events[0].baseInputTokens, 7);
    assert.equal(events[0].outputTokens, 3);
    assert.equal(events[0].totalTokens, 10);

    const snap = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(snap.reservedMicros, 0);
    assert.equal(snap.usedMicros, 55);
  });
});

test("concurrency limit blocks the 9th active reservation", async () => {
  await runAgainstEachStore(async (store) => {
    const token = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-conc", maxConcurrency: 8, budgetLimitMicros: null })
    );
    for (let i = 0; i < 8; i += 1) {
      const r = await store.reserveLlmBudget(
        reserveInput({ poolTokenId: token.id, estimatedMicros: 1 })
      );
      assert.equal(r.ok, true);
    }
    const ninth = await store.reserveLlmBudget(
      reserveInput({ poolTokenId: token.id, estimatedMicros: 1 })
    );
    assert.equal(ninth.ok, false);
    assert.equal(ninth.reason, "concurrency-limit");
    assert.equal(ninth.snapshot.activeReservations, 8);
  });
});

test("daily/monthly period counters roll over", async () => {
  await runAgainstEachStore(async (store) => {
    const daily = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-daily", budgetPeriod: "daily", budgetLimitMicros: 1000 })
    );
    assert.equal(
      (await store.reserveLlmBudget(
        reserveInput({ poolTokenId: daily.id, at: "2026-01-01T10:00:00.000Z", estimatedMicros: 10 })
      )).ok,
      true
    );
    assert.equal(
      (await store.reserveLlmBudget(
        reserveInput({ poolTokenId: daily.id, at: "2026-01-02T10:00:00.000Z", estimatedMicros: 20 })
      )).ok,
      true
    );
    const d1 = await store.getLlmBudgetSnapshot(daily.id, "2026-01-01T23:00:00.000Z");
    const d2 = await store.getLlmBudgetSnapshot(daily.id, "2026-01-02T23:00:00.000Z");
    assert.equal(d1.reservedMicros, 10);
    assert.equal(d2.reservedMicros, 20);

    const monthly = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-monthly", budgetPeriod: "monthly", budgetLimitMicros: 1000 })
    );
    await store.reserveLlmBudget(
      reserveInput({ poolTokenId: monthly.id, at: "2026-01-15T00:00:00.000Z", estimatedMicros: 5 })
    );
    await store.reserveLlmBudget(
      reserveInput({ poolTokenId: monthly.id, at: "2026-02-15T00:00:00.000Z", estimatedMicros: 6 })
    );
    const m1 = await store.getLlmBudgetSnapshot(monthly.id, "2026-01-20T00:00:00.000Z");
    const m2 = await store.getLlmBudgetSnapshot(monthly.id, "2026-02-20T00:00:00.000Z");
    assert.equal(m1.reservedMicros, 5);
    assert.equal(m2.reservedMicros, 6);
  });
});

test("usage retention prunes rows older than AOS_LLM_USAGE_RETENTION_DAYS", async () => {
  await runAgainstEachStore(async (store) => {
    await store.recordLlmUsage(usageInput({ model: "old", at: "2020-01-01T00:00:00.000Z" }));
    await store.recordLlmUsage(usageInput({ model: "new" }));
    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.equal(events[0].model, "new");
  });
});

test("usage retention 0 disables pruning", async () => {
  await runAgainstEachStore(
    async (store) => {
      await store.recordLlmUsage(usageInput({ model: "old", at: "2020-01-01T00:00:00.000Z" }));
      await store.recordLlmUsage(usageInput({ model: "new" }));
      const events = await store.listLlmUsageEvents({});
      assert.equal(events.length, 2);
    },
    { AOS_LLM_USAGE_RETENTION_DAYS: "0" }
  );
});

test("pool token upsert preserves key when apiKey omitted", async () => {
  await runAgainstEachStore(async (store) => {
    const created = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-key", apiKey: "sk-secret" })
    );
    const updated = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-key", apiKey: undefined, modelAllowlist: ["a", "b"] })
    );
    assert.equal(updated.id, created.id);
    assert.equal(updated.apiKey, "sk-secret");
    const cleared = await store.upsertLlmPoolToken(
      tokenInput({ name: "t-key", apiKey: null, modelAllowlist: undefined })
    );
    assert.equal(cleared.apiKey, null);
    assert.deepEqual(cleared.modelAllowlist, ["a", "b"]);
  });
});
