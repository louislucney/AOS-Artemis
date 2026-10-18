import assert from "node:assert/strict";
import test from "node:test";

import { makeResolver } from "../dist/config/validate.js";
import { entryFromStore, withEnvKeyFallback } from "../dist/llm/registry.js";

function record(overrides = {}) {
  return {
    id: "r1",
    projectId: "p1",
    name: "deepseek",
    provider: "custom",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: null,
    isActive: true,
    createdAt: "",
    updatedAt: "",
    ...overrides
  };
}

test("withEnvKeyFallback: stripped store key resolves from env by convention", () => {
  const resolver = makeResolver({}, { DEEPSEEK_API_KEY: "k-env" });
  const entry = withEnvKeyFallback(entryFromStore(record()), resolver);
  assert.equal(entry.apiKey, "k-env");
  assert.equal(entry.keyEnvName, "DEEPSEEK_API_KEY");

  const openai = withEnvKeyFallback(
    entryFromStore(record({ name: "o", provider: "openai" })),
    makeResolver({}, { OPENAI_API_KEY: "k-o" })
  );
  assert.equal(openai.apiKey, "k-o");
  assert.equal(openai.keyEnvName, "OPENAI_API_KEY");
});

test("withEnvKeyFallback: 条目专属变量优先（多条目不再塌缩为同一把 key）", () => {
  const resolver = makeResolver(
    {},
    {
      AOS_LLM_KEY_DEEPSEEK: "k-deepseek",
      AOS_LLM_KEY_KIMI: "k-kimi",
      AOS_LLM_API_KEY: "k-kimi"
    }
  );
  const deepseek = withEnvKeyFallback(entryFromStore(record()), resolver);
  assert.equal(deepseek.apiKey, "k-deepseek");
  assert.equal(deepseek.keyEnvName, "AOS_LLM_KEY_DEEPSEEK");

  const kimi = withEnvKeyFallback(entryFromStore(record({ name: "kimi" })), resolver);
  assert.equal(kimi.apiKey, "k-kimi");
  assert.equal(kimi.keyEnvName, "AOS_LLM_KEY_KIMI");
});

test("withEnvKeyFallback: present key untouched; missing env leaves entry unchanged", () => {
  const kept = withEnvKeyFallback(entryFromStore(record({ apiKey: "direct" })), makeResolver({}, {}));
  assert.equal(kept.apiKey, "direct");

  const untouched = withEnvKeyFallback(entryFromStore(record()), makeResolver({}, {}));
  assert.equal(untouched.apiKey, null);
});
