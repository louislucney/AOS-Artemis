import assert from "node:assert/strict";
import test from "node:test";

import {
  apiKeyEnvFor,
  hasGoogleKey,
  makeResolver,
  pinnedNodesCovered,
  validateConfig
} from "../dist/config/validate.js";

function bareConfig(profiles) {
  return { llm: { profiles }, artemis: { repo: "/tmp/artemis" } };
}

test("apiKeyEnvFor defaults per provider and honors override", () => {
  assert.equal(apiKeyEnvFor({ provider: "google", model: "m" }), "GEMINI_API_KEY");
  assert.equal(apiKeyEnvFor({ provider: "openai", model: "m" }), "OPENAI_API_KEY");
  assert.equal(apiKeyEnvFor({ provider: "custom", model: "m" }), "OPENAI_API_KEY");
  assert.equal(apiKeyEnvFor({ provider: "anthropic", model: "m" }), "ANTHROPIC_API_KEY");
  assert.equal(
    apiKeyEnvFor({ provider: "openai", model: "m", apiKeyEnv: "DEEPSEEK_API_KEY" }),
    "DEEPSEEK_API_KEY"
  );
});

test("pinnedNodesCovered requires every pinned node handled", () => {
  assert.equal(pinnedNodesCovered({ provider: "openai", model: "m" }), false);
  assert.equal(
    pinnedNodesCovered({
      provider: "openai",
      model: "m",
      nodeOverrides: { object_detector: { provider: "openai", model: "m" } }
    }),
    false
  );
  assert.equal(
    pinnedNodesCovered({
      provider: "openai",
      model: "m",
      nodeOverrides: {
        object_detector: { provider: "openai", model: "m" },
        hopper: { provider: "openai", model: "m" }
      }
    }),
    true
  );
  assert.equal(
    pinnedNodesCovered({
      provider: "openai",
      model: "m",
      nodeOverrides: { object_detector: null, hopper: { provider: "openai", model: "m" } }
    }),
    true
  );
  assert.equal(
    pinnedNodesCovered({
      provider: "openai",
      model: "m",
      nodeOverrides: { object_detector: { provider: "google", model: "x" }, hopper: null }
    }),
    false
  );
});

test("hasGoogleKey checks both candidate env names", () => {
  const none = makeResolver({}, {});
  assert.equal(hasGoogleKey(none), false);
  const viaGemini = makeResolver({ GEMINI_API_KEY: "k" }, {});
  assert.equal(hasGoogleKey(viaGemini), true);
  const viaGoogle = makeResolver({}, { GOOGLE_API_KEY: "k" });
  assert.equal(hasGoogleKey(viaGoogle), true);
});

test("validateConfig: empty profiles is an error", () => {
  const result = validateConfig(bareConfig({}), makeResolver({}, {}));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "llm.profiles.empty");
});

test("validateConfig: unknown defaultProfile is an error", () => {
  const config = bareConfig({ a: { provider: "google", model: "m" } });
  config.llm.defaultProfile = "ghost";
  const result = validateConfig(config, makeResolver({}, {}));
  assert.ok(result.errors.some((issue) => issue.code === "llm.defaultProfile.unknown"));
});

test("validateConfig: invalid provider and empty model are errors", () => {
  const result = validateConfig(
    bareConfig({ a: { provider: "banana", model: "" } }),
    makeResolver({}, {})
  );
  assert.ok(result.errors.some((issue) => issue.code === "llm.provider.invalid"));
  assert.ok(result.errors.some((issue) => issue.code === "llm.model.empty"));
});

test("validateConfig: missing active key warns, pinned nodes warn for non-google", () => {
  const config = bareConfig({
    a: { provider: "openai", model: "m" }
  });
  config.llm.defaultProfile = "a";
  const result = validateConfig(config, makeResolver({}, {}));
  assert.ok(result.warnings.some((issue) => issue.code === "llm.key.missing"));
  assert.ok(result.warnings.some((issue) => issue.code === "llm.pinnedNodes"));
});

test("validateConfig: google key present silences pinned warning", () => {
  const config = bareConfig({ a: { provider: "openai", model: "m" } });
  config.llm.defaultProfile = "a";
  const result = validateConfig(config, makeResolver({ GEMINI_API_KEY: "k" }, {}));
  assert.ok(!result.warnings.some((issue) => issue.code === "llm.pinnedNodes"));
});

test("validateConfig: covered pinned nodes silence pinned warning", () => {
  const config = bareConfig({
    a: {
      provider: "openai",
      model: "m",
      nodeOverrides: {
        object_detector: { provider: "openai", model: "m" },
        hopper: { provider: "openai", model: "m" }
      }
    }
  });
  config.llm.defaultProfile = "a";
  const result = validateConfig(config, makeResolver({}, {}));
  assert.ok(!result.warnings.some((issue) => issue.code === "llm.pinnedNodes"));
});

test("validateConfig: invalid fallback is an error", () => {
  const config = bareConfig({
    a: { provider: "google", model: "m", fallback: { provider: "nope", model: "" } }
  });
  const result = validateConfig(config, makeResolver({}, {}));
  assert.ok(result.errors.some((issue) => issue.code === "llm.fallback.invalid"));
});
