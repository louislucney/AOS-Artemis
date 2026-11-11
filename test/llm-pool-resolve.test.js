import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  resolveCenterLlmCandidates,
  resolvePoolTokenKey
} from "../dist/llm/pool/resolve.js";

const ROOT = "/w/p";

async function setup(overrides = {}) {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: ROOT, name: "p" });
  await store.upsertLlm(ROOT, {
    name: "entry",
    provider: "custom",
    baseUrl: "https://project.example.com",
    model: "m",
    apiKey: "sk-project",
    makeActive: true,
    ...(overrides.llm ?? {})
  });
  return store;
}

function tokenInput(overrides = {}) {
  return {
    name: "pool-a",
    provider: "custom",
    baseUrl: "https://pool.example.com",
    apiKey: "sk-pool-aaaaaaaa",
    status: "active",
    priority: 10,
    modelAllowlist: ["m"],
    maxConcurrency: 4,
    supportsStreamUsage: true,
    ...overrides
  };
}

test("pinned binding resolves exactly one token", async () => {
  const store = await setup();
  const token = await store.upsertLlmPoolToken(tokenInput({ modelAllowlist: ["m-pro"] }));
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m-pro"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.mode, "pinned");
  assert.equal(resolution.model, "m-pro");
  assert.equal(resolution.error, null);
  assert.equal(resolution.candidates.length, 1);
  const [candidate] = resolution.candidates;
  assert.equal(candidate.provider, "custom");
  assert.equal(candidate.model, "m-pro");
  assert.equal(candidate.baseUrl, "https://pool.example.com");
  assert.equal(candidate.apiKey, "sk-pool-aaaaaaaa");
  assert.equal(candidate.poolTokenId, token.id);
  assert.equal(candidate.poolTokenName, token.name);
  assert.equal(candidate.poolMode, "pinned");
  assert.equal(candidate.supportsStreamUsage, true);
  assert.equal(candidate.maxConcurrency, 4);
});

test("auto binding orders same-model tokens by priority", async () => {
  const store = await setup();
  const a = await store.upsertLlmPoolToken(tokenInput({ name: "a", priority: 10 }));
  const b = await store.upsertLlmPoolToken(tokenInput({ name: "b", priority: 20 }));
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: a.id,
    poolMode: "auto",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.mode, "auto");
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.poolTokenName),
    ["a", "b"]
  );
});

test("auto binding uses lastValidatedAt as the tie-breaker", async () => {
  const store = await setup();
  const a = await store.upsertLlmPoolToken(
    tokenInput({ name: "a", priority: 10, lastValidatedAt: "2026-01-01T00:00:00.000Z" })
  );
  await store.upsertLlmPoolToken(
    tokenInput({ name: "b", priority: 10, lastValidatedAt: "2026-02-01T00:00:00.000Z" })
  );
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: a.id,
    poolMode: "auto",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.poolTokenName),
    ["b", "a"]
  );
});

test("auto skips disabled and model-not-allowed tokens", async () => {
  const store = await setup();
  const a = await store.upsertLlmPoolToken(tokenInput({ name: "a", priority: 10 }));
  await store.upsertLlmPoolToken(
    tokenInput({ name: "disabled", priority: 1, status: "disabled" })
  );
  await store.upsertLlmPoolToken(
    tokenInput({ name: "other-model", priority: 2, modelAllowlist: ["other"] })
  );
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: a.id,
    poolMode: "auto",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.poolTokenName),
    ["a"]
  );
});

test("pinned token missing returns token-disabled", async () => {
  const store = await setup();
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: "missing-token",
    poolMode: "pinned",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.error, "token-disabled");
  assert.equal(resolution.candidates.length, 0);
});

test("pending_token is not selectable", async () => {
  const store = await setup();
  const token = await store.upsertLlmPoolToken(
    tokenInput({ name: "pending", status: "pending_token", apiKey: null })
  );
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.error, "token-disabled");
  assert.equal(resolution.candidates.length, 0);
});

test("keyEnv resolves from env and missing keys disable the token", async () => {
  const store = await setup();
  const token = await store.upsertLlmPoolToken(
    tokenInput({ name: "env-key", apiKey: null, keyEnv: "POOL_KEY" })
  );
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  });

  const withKey = await resolveCenterLlmCandidates(store, { POOL_KEY: "sk-from-env" }, ROOT);
  assert.equal(withKey.candidates[0].apiKey, "sk-from-env");

  const withoutKey = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(withoutKey.error, "token-disabled");
  assert.equal(withoutKey.candidates.length, 0);
});

test("model not in the allowlist is rejected", async () => {
  const store = await setup();
  const token = await store.upsertLlmPoolToken(tokenInput({ modelAllowlist: ["only-this"] }));
  await store.setLlmPoolBinding({
    rootPath: ROOT,
    name: "entry",
    poolTokenId: token.id,
    poolMode: "pinned",
    poolModel: "m"
  });

  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.error, "model-not-allowed");
  assert.equal(resolution.candidates.length, 0);
});

test("project-owned entry keeps its own key and no poolTokenId", async () => {
  const store = await setup();
  const resolution = await resolveCenterLlmCandidates(store, {}, ROOT);
  assert.equal(resolution.mode, "project");
  assert.equal(resolution.error, null);
  assert.equal(resolution.candidates.length, 1);
  const [candidate] = resolution.candidates;
  assert.equal(candidate.apiKey, "sk-project");
  assert.equal(candidate.baseUrl, "https://project.example.com");
  assert.equal(candidate.poolTokenId, null);
  assert.equal(candidate.poolTokenName, null);
});

test("resolvePoolTokenKey prefers the stored key over env", () => {
  assert.equal(resolvePoolTokenKey({ apiKey: "sk-direct", keyEnv: "K" }, { K: "sk-env" }), "sk-direct");
  assert.equal(resolvePoolTokenKey({ apiKey: null, keyEnv: "K" }, { K: "sk-env" }), "sk-env");
  assert.equal(resolvePoolTokenKey({ apiKey: null, keyEnv: "K" }, {}), null);
  assert.equal(resolvePoolTokenKey({ apiKey: "", keyEnv: null }, {}), null);
});
