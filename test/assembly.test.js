import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChildEnv,
  buildChildEnvForEntry,
  buildOverrideDocument,
  buildOverrideDocumentForEntry,
  renderOverride
} from "../dist/artemis/assembly.js";
import { makeResolver } from "../dist/config/validate.js";

const config = {
  llm: { profiles: {} },
  artemis: { repo: "/tmp/artemis", configDir: ".artemis" }
};

test("override: self fallback when missing, optional fields pass through", () => {
  const doc = buildOverrideDocument({ provider: "openai", model: "deepseek-chat" });
  assert.deepEqual(doc.default, {
    provider: "openai",
    model: "deepseek-chat",
    fallback: { provider: "openai", model: "deepseek-chat" }
  });
  assert.deepEqual(doc.nodes, {});

  const doc2 = buildOverrideDocument({
    provider: "google",
    model: "gemini-2.5-flash",
    thinking_level: "high",
    include_thoughts: true,
    enable_grounding: true,
    thinking_budget: 2048,
    reasoning_effort: "low",
    fallback: { provider: "google", model: "gemini-2.0-flash" },
    nodeOverrides: { object_detector: { provider: "google", model: "gemini-robotics-er-2-preview" } }
  });
  assert.equal(doc2.default.thinking_level, "high");
  assert.equal(doc2.default.include_thoughts, true);
  assert.equal(doc2.default.enable_grounding, true);
  assert.equal(doc2.default.thinking_budget, 2048);
  assert.equal(doc2.default.reasoning_effort, "low");
  assert.deepEqual(doc2.default.fallback, { provider: "google", model: "gemini-2.0-flash" });
  assert.deepEqual(doc2.nodes, {
    object_detector: { provider: "google", model: "gemini-robotics-er-2-preview" }
  });
});

test("renderOverride emits parseable JSON with newline", () => {
  const text = renderOverride({ provider: "google", model: "m" });
  assert.ok(text.endsWith("\n"));
  assert.equal(JSON.parse(text).default.provider, "google");
});

test("buildChildEnv injects standalone/config dir/key and strips daemon port", () => {
  const resolver = makeResolver({ GEMINI_API_KEY: "gm-123" }, {});
  const { env, keyEnvName, fingerprint } = buildChildEnv({
    config,
    rootDir: "/tmp/proj",
    profile: { provider: "google", model: "gemini-2.5-flash" },
    resolver,
    baseEnv: { PATH: "/usr/bin", ARTEMIS_DAEMON_PORT: "8000" }
  });
  assert.equal(env.ARTEMIS_STANDALONE, "1");
  assert.equal(env.ARTEMIS_CONFIG_DIR, "/tmp/proj/.artemis");
  assert.equal(env.PYTHONUNBUFFERED, "1");
  assert.equal(env.GEMINI_API_KEY, "gm-123");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ARTEMIS_DAEMON_PORT, undefined);
  assert.equal(keyEnvName, "GEMINI_API_KEY");
  assert.equal(fingerprint.length, 16);
});

test("buildChildEnv: GOOGLE_API_KEY fallback and openai baseUrl", () => {
  const googleResolver = makeResolver({}, { GOOGLE_API_KEY: "g-1" });
  const google = buildChildEnv({
    config,
    rootDir: "/tmp/proj",
    profile: { provider: "google", model: "m" },
    resolver: googleResolver,
    baseEnv: {}
  });
  assert.equal(google.keyEnvName, "GOOGLE_API_KEY");
  // Injected under the name artemis actually reads.
  assert.equal(google.env.GEMINI_API_KEY, "g-1");

  const openaiResolver = makeResolver({ OPENAI_API_KEY: "o-1" }, {});
  const openai = buildChildEnv({
    config,
    rootDir: "/tmp/proj",
    profile: { provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" },
    resolver: openaiResolver,
    baseEnv: {}
  });
  assert.equal(openai.env.OPENAI_BASE_URL, "https://api.deepseek.com/v1");
});

test("buildChildEnv: deviceSerial maps to ADB_DEVICE_SERIAL", () => {
  const withSerial = {
    ...config,
    artemis: { ...config.artemis, deviceSerial: "emulator-5554" }
  };
  const { env } = buildChildEnv({
    config: withSerial,
    rootDir: "/tmp/proj",
    profile: { provider: "google", model: "m" },
    resolver: makeResolver({ GEMINI_API_KEY: "k" }, {}),
    baseEnv: {}
  });
  assert.equal(env.ADB_DEVICE_SERIAL, "emulator-5554");
});

test("buildChildEnv: custom provider injects the source key as OPENAI_API_KEY", () => {
  const resolver = makeResolver({ DEEPSEEK_API_KEY: "ds-1" }, {});
  const { env, keyEnvName } = buildChildEnv({
    config,
    rootDir: "/tmp/proj",
    profile: {
      provider: "custom",
      model: "deepseek-flash",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com/v1"
    },
    resolver,
    baseEnv: {}
  });
  assert.equal(env.OPENAI_API_KEY, "ds-1");
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, "https://api.deepseek.com/v1");
  assert.equal(keyEnvName, "DEEPSEEK_API_KEY");
});

test("buildChildEnv: custom baseUrl falls back to .env OPENAI_BASE_URL", () => {
  const resolver = makeResolver(
    { DEEPSEEK_API_KEY: "ds-1", OPENAI_BASE_URL: "https://gateway.example/v1" },
    {}
  );
  const { env } = buildChildEnv({
    config,
    rootDir: "/tmp/proj",
    profile: { provider: "custom", model: "deepseek-flash" },
    resolver,
    baseEnv: {}
  });
  assert.equal(env.OPENAI_BASE_URL, "https://gateway.example/v1");
});

test("fingerprint ignores model changes but reacts to key changes", () => {
  const args = (profile, dotenv) => ({
    config,
    rootDir: "/tmp/proj",
    profile,
    resolver: makeResolver(dotenv, {}),
    baseEnv: {}
  });
  const a = buildChildEnv(args({ provider: "google", model: "gemini-2.5-flash" }, { GEMINI_API_KEY: "k1" }));
  const b = buildChildEnv(args({ provider: "google", model: "gemini-2.0-flash" }, { GEMINI_API_KEY: "k1" }));
  const c = buildChildEnv(args({ provider: "google", model: "gemini-2.5-flash" }, { GEMINI_API_KEY: "k2" }));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test("entry override: auto-pins non-google nodes; explicit nodeOverrides win", () => {
  const auto = buildOverrideDocumentForEntry({
    provider: "custom",
    model: "deepseek-flash",
    baseUrl: "https://x/v1",
    apiKey: "k"
  });
  assert.equal(auto.default.provider, "custom");
  assert.deepEqual(auto.default.fallback, { provider: "custom", model: "deepseek-flash" });
  assert.deepEqual(auto.nodes.object_detector, { provider: "custom", model: "deepseek-flash" });
  assert.deepEqual(auto.nodes.hopper, { provider: "custom", model: "deepseek-flash" });

  const explicit = buildOverrideDocumentForEntry({
    provider: "custom",
    model: "m",
    baseUrl: null,
    apiKey: "k",
    nodeOverrides: { hopper: null }
  });
  assert.deepEqual(explicit.nodes, { hopper: null });

  const google = buildOverrideDocumentForEntry({
    provider: "google",
    model: "gemini-2.5-flash",
    baseUrl: null,
    apiKey: "k"
  });
  assert.deepEqual(google.nodes, {});
});

test("entry env: injects OPENAI_API_KEY + OPENAI_BASE_URL; fingerprint ignores model", () => {
  const base = { config, rootDir: "/tmp/proj", baseEnv: {} };
  const a = buildChildEnvForEntry({
    ...base,
    entry: { provider: "custom", model: "m1", baseUrl: "https://x/v1", apiKey: "k1" }
  });
  const b = buildChildEnvForEntry({
    ...base,
    entry: { provider: "custom", model: "m2", baseUrl: "https://x/v1", apiKey: "k1" }
  });
  assert.equal(a.env.OPENAI_API_KEY, "k1");
  assert.equal(a.env.OPENAI_BASE_URL, "https://x/v1");
  assert.equal(a.env.ARTEMIS_STANDALONE, "1");
  assert.equal(a.fingerprint, b.fingerprint);

  const c = buildChildEnvForEntry({
    ...base,
    entry: { provider: "custom", model: "m1", baseUrl: "https://x/v1", apiKey: "k2" }
  });
  assert.notEqual(a.fingerprint, c.fingerprint);
});
