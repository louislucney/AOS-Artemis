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

test("withEnvKeyFallback: present key untouched; missing env leaves entry unchanged", () => {
  const kept = withEnvKeyFallback(entryFromStore(record({ apiKey: "direct" })), makeResolver({}, {}));
  assert.equal(kept.apiKey, "direct");

  const untouched = withEnvKeyFallback(entryFromStore(record()), makeResolver({}, {}));
  assert.equal(untouched.apiKey, null);
});
