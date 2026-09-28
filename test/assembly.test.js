import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChildEnv,
  buildChildEnvForEntry,
  renderProjectArtemisConfig
} from "../dist/artemis/assembly.js";
import { makeResolver } from "../dist/config/validate.js";

const config = {
  llm: { profiles: {} },
  artemis: { repo: "/tmp/artemis", configDir: ".artemis" }
};

test("renderProjectArtemisConfig: merges base config and applies entry LLM", () => {
  const baseConfigText = JSON.stringify({
    agent: {
      flash: {
        max_turns: 7,
        step_summarizer: { enabled: true, model: "gemini-3.5-flash-lite" }
      }
    },
    default: {
      provider: "google",
      model: "gemini-3.8-flash",
      thinking_level: "medium",
      fallback: { provider: "google", model: "gemini-3.7-flash" }
    },
    nodes: { planner: { thinking_level: "high" } }
  });

  const rendered = JSON.parse(
    renderProjectArtemisConfig({
      baseConfigText,
      entry: { provider: "custom", model: "deepseek-flash", baseUrl: "https://x", apiKey: "k" }
    })
  );
  assert.equal(rendered.default.provider, "custom");
  assert.equal(rendered.default.model, "deepseek-flash");
  assert.deepEqual(rendered.default.fallback, { provider: "custom", model: "deepseek-flash" });
  assert.equal(rendered.default.thinking_level, "medium", "non-LLM default fields preserved");
  assert.deepEqual(rendered.nodes.planner, { thinking_level: "high" }, "base nodes preserved");
  assert.deepEqual(rendered.nodes.object_detector, { provider: "custom", model: "deepseek-flash" });
  assert.deepEqual(rendered.nodes.hopper, { provider: "custom", model: "deepseek-flash" });
  assert.equal(rendered.agent.flash.max_turns, 7, "non-LLM sections preserved");
  assert.equal(
    rendered.agent.flash.step_summarizer.enabled,
    false,
    "Google-bound flash summarizer disabled for custom entries"
  );
  assert.equal(
    rendered.agent.flash.step_summarizer.model,
    "gemini-3.5-flash-lite",
    "summarizer config otherwise preserved"
  );

  const googleRendered = JSON.parse(
    renderProjectArtemisConfig({
      baseConfigText,
      entry: { provider: "google", model: "gemini-2.5-flash", baseUrl: null, apiKey: "k" }
    })
  );
  assert.equal(
    googleRendered.agent.flash.step_summarizer.enabled,
    true,
    "summarizer untouched for google entries"
  );
});

test("renderProjectArtemisConfig: explicit nodeOverrides win; works without base config", () => {
  const explicit = JSON.parse(
    renderProjectArtemisConfig({
      baseConfigText: null,
      entry: {
        provider: "custom",
        model: "m",
        baseUrl: null,
        apiKey: "k",
        nodeOverrides: { hopper: null }
      }
    })
  );
  assert.deepEqual(explicit.nodes, { hopper: null });
  assert.equal(explicit.default.model, "m");

  const googleEntry = JSON.parse(
    renderProjectArtemisConfig({
      baseConfigText: null,
      entry: { provider: "google", model: "gemini-2.5-flash", baseUrl: null, apiKey: "k" }
    })
  );
  assert.deepEqual(googleEntry.nodes, {}, "google entries keep no auto-pins");
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
  assert.equal(a.env.ARTEMIS_ARTEMIS_JSONC, "/tmp/proj/.artemis/artemis.jsonc");
  assert.equal(a.fingerprint, b.fingerprint);

  const c = buildChildEnvForEntry({
    ...base,
    entry: { provider: "custom", model: "m1", baseUrl: "https://x/v1", apiKey: "k2" }
  });
  assert.notEqual(a.fingerprint, c.fingerprint);
});
