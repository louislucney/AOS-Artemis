import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  autoRepairEnabled,
  fetchModelIds,
  isModelStale,
  ModelCatalog,
  modelCacheKey,
  pickReplacement,
  resolveModelRefreshHours
} from "../dist/llm/catalog.js";
import { providerPresetById, providerPresetForBaseUrl } from "../dist/llm/providers.js";
import { modelFetcher } from "./helpers.js";

test("fetchModelIds: OpenAI-style list, trailing slash, bearer auth", async () => {
  const fetchImpl = modelFetcher(["deepseek-flash", "deepseek-v4-pro"]);
  const result = await fetchModelIds({
    baseUrl: "https://api.deepseek.com/v1/",
    apiKey: "sk-x",
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(fetchImpl.calls[0].url, "https://api.deepseek.com/v1/models");
  assert.equal(fetchImpl.calls[0].auth, "Bearer sk-x");
});

test("fetchModelIds: dedupes ids and accepts plain strings", async () => {
  const fetchImpl = modelFetcher([], {
    payload: { data: [{ id: "a" }, "b", { id: "a" }] }
  });
  const result = await fetchModelIds({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ["a", "b"]);
});

test("fetchModelIds: auth / unsupported endpoint / bad payload / network errors", async () => {
  const auth = await fetchModelIds({
    baseUrl: "https://x/v1",
    apiKey: "k",
    fetchImpl: modelFetcher([], { status: 401 })
  });
  assert.equal(auth.ok, false);
  assert.match(auth.error, /鉴权失败/);

  const missing = await fetchModelIds({
    baseUrl: "https://x/v1",
    apiKey: "k",
    fetchImpl: modelFetcher([], { status: 404 })
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /\/models/);

  const bad = await fetchModelIds({
    baseUrl: "https://x/v1",
    apiKey: "k",
    fetchImpl: modelFetcher([], { payload: { models: [] } })
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /data\[\]/);

  const thrown = await fetchModelIds({
    baseUrl: "https://x/v1",
    apiKey: "k",
    fetchImpl: modelFetcher([], { throwError: "connect ECONNREFUSED" })
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /ECONNREFUSED/);
});

test("modelCacheKey: stable, key/baseUrl sensitive, trailing slash insensitive", () => {
  const a = modelCacheKey("https://x/v1", "k1");
  assert.equal(a, modelCacheKey("https://x/v1/", "k1"));
  assert.notEqual(a, modelCacheKey("https://x/v1", "k2"));
  assert.notEqual(a, modelCacheKey("https://y/v1", "k1"));
});

test("resolveModelRefreshHours + autoRepairEnabled + isModelStale", () => {
  assert.equal(resolveModelRefreshHours({}), 12);
  assert.equal(resolveModelRefreshHours({ AOS_MODEL_REFRESH_HOURS: "6" }), 6);
  assert.equal(resolveModelRefreshHours({ AOS_MODEL_REFRESH_HOURS: "0" }), 0);
  assert.equal(resolveModelRefreshHours({ AOS_MODEL_REFRESH_HOURS: "bogus" }), 12);
  assert.equal(resolveModelRefreshHours({ AOS_MODEL_REFRESH_HOURS: "9999" }), 720);

  assert.equal(autoRepairEnabled({}), true);
  assert.equal(autoRepairEnabled({ AOS_LLM_AUTO_REPAIR: "0" }), false);

  const now = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(isModelStale(null, 12, now), true);
  assert.equal(isModelStale("2026-09-29T01:00:00Z", 12, now), false);
  assert.equal(isModelStale("2026-09-28T01:00:00Z", 12, now), true);
  assert.equal(isModelStale("2026-01-01T00:00:00Z", 0, now), false);
});

test("pickReplacement: vendor alias, capability guard, equivalent core, ambiguity", () => {
  const deepseek = providerPresetById("deepseek");
  assert.deepEqual(
    pickReplacement("deepseek-v4-flash", ["deepseek-flash", "deepseek-v4-pro"], deepseek),
    { model: "deepseek-flash", reason: "alias" }
  );
  assert.equal(
    pickReplacement("deepseek-reasoner", ["deepseek-flash", "deepseek-v4-pro"], deepseek),
    null
  );
  assert.equal(
    pickReplacement("deepseek-v4-pro", ["deepseek-flash"], deepseek),
    null
  );
  assert.deepEqual(
    pickReplacement("deepseek-v4-flash", ["deepseek-flash"], null),
    { model: "deepseek-flash", reason: "equivalent" }
  );
  assert.equal(pickReplacement("qwen2.5-7b-instruct", ["qwen2.5-72b-instruct"], null), null);
  assert.deepEqual(
    pickReplacement("foo-2025-01-01", ["foo", "foo-2026-01-01"], null),
    { model: "foo", reason: "equivalent" }
  );
  assert.equal(pickReplacement("ghost", [], null), null);
});

test("provider presets: 8 domestic vendors, lookup by id and baseUrl", () => {
  assert.equal(providerPresetById("deepseek").label, "DeepSeek");
  assert.equal(providerPresetById("nope"), null);
  assert.equal(
    providerPresetForBaseUrl("https://api.deepseek.com/v1/").id,
    "deepseek"
  );
  assert.equal(providerPresetForBaseUrl("https://example.com/v1"), null);
});

test("ModelCatalog: refresh writes cache, skips fresh, preserves list on failure", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  const entry = {
    name: "ds",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    provider: "custom"
  };

  const fetchImpl = modelFetcher(["deepseek-flash", "deepseek-v4-pro"]);
  const catalog = new ModelCatalog({ env: {}, fetchImpl });

  const first = await catalog.refresh(store, "/w/p", entry, { force: true });
  assert.equal(first.refreshed, true);
  assert.equal(first.known, true);
  assert.equal(first.count, 2);
  assert.equal(first.available, false);
  assert.equal(first.deprecated, true);
  assert.equal(first.suggestedModel, "deepseek-flash");
  assert.equal(first.replacementReason, "alias");

  const second = await catalog.refresh(store, "/w/p", entry);
  assert.equal(second.refreshed, false);
  assert.equal(fetchImpl.calls.length, 1);

  const report = await catalog.report(store, "/w/p", entry);
  assert.equal(report.available, false);
  assert.equal(report.suggestedModel, "deepseek-flash");

  const failing = new ModelCatalog({
    env: {},
    fetchImpl: modelFetcher([], { throwError: "boom" })
  });
  const third = await failing.refresh(store, "/w/p", entry, { force: true });
  assert.equal(third.refreshed, false);
  assert.equal(third.error, "boom");
  assert.equal(third.count, 2);
  assert.equal(third.suggestedModel, "deepseek-flash");

  const availableEntry = { ...entry, model: "deepseek-flash" };
  const ok = await catalog.report(store, "/w/p", availableEntry);
  assert.equal(ok.available, true);
  assert.equal(ok.deprecated, false);
  assert.equal(ok.suggestedModel, null);
});

test("ModelCatalog: stale cache is reported but never deprecated", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: "/w/p", name: "p" });
  const entry = {
    name: "ds",
    model: "old-model",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    provider: "custom"
  };
  const past = new Date(Date.now() - 13 * 3_600_000).toISOString();
  await store.putModelCache("/w/p", {
    cacheKey: modelCacheKey(entry.baseUrl, entry.apiKey),
    baseUrl: entry.baseUrl,
    models: ["new-model"],
    fetchedAt: past,
    lastError: null
  });
  const catalog = new ModelCatalog({ env: {}, fetchImpl: modelFetcher([]) });
  const report = await catalog.report(store, "/w/p", entry);
  assert.equal(report.known, true);
  assert.equal(report.stale, true);
  assert.equal(report.available, false);
  assert.equal(report.deprecated, false);
  assert.equal(report.suggestedModel, null);
});
