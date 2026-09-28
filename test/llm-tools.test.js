import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { aosConfigure } from "../dist/tools/configure.js";
import { aosStatus, aosTasks, llmList, llmSwitch } from "../dist/tools/llm.js";
import {
  baseConfig,
  deepseekWithOverrides,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy
} from "./helpers.js";

function readOverride(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".artemis", "artemis.jsonc"), "utf-8"));
}

test("llm_list: config entries, masked keys, active marker, no setup required", async () => {
  const dir = makeTempProject({
    config: deepseekWithOverrides(),
    dotenv: "DEEPSEEK_API_KEY=abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await llmList(runtime));

  assert.equal(payload.ok, true);
  assert.equal(payload.activeProfile, "gemini");
  assert.equal(payload.setupRequired, false);
  assert.equal(payload.store.kind, "memory");

  const deepseek = payload.llms.find((entry) => entry.name === "deepseek");
  assert.equal(deepseek.key.present, true);
  assert.equal(deepseek.key.preview, "****3456");
  assert.equal(deepseek.key.envVar, "DEEPSEEK_API_KEY");
  assert.equal(deepseek.source, "config");
  assert.deepEqual(deepseek.issues, []);
});

test("llm_list: setup_required when nothing is configured", async () => {
  const dir = makeTempProject({});
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await llmList(runtime));

  assert.equal(payload.setupRequired, true);
  assert.equal(payload.llms.length, 0);
  assert.ok(payload.setup.missing.length >= 1);
  assert.ok(payload.setup.howToFix.some((line) => line.includes("aos_configure")));
});

test("llm_switch: incomplete entry is blocked", async () => {
  const dir = makeTempProject({ config: deepseekWithOverrides() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const result = await llmSwitch(runtime, { name: "deepseek" });
  const payload = parseToolResult(result);

  assert.equal(result.isError, true);
  assert.equal(payload.blockedBy, "incomplete");
  assert.ok(payload.missing.some((issue) => issue.includes("api_key")));
});

test("llm_switch: unknown entry lists available names", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await llmSwitch(runtime, { name: "ghost" }));
  assert.deepEqual(payload.available.sort(), ["deepseek", "gemini"]);
});

test("llm_switch: auto-pins non-Google nodes, imports to store, restarts on env change", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-test-key-123456\n"
  });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(await llmSwitch(runtime, { name: "deepseek" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.active, "deepseek");
  assert.equal(payload.previous, "gemini");
  assert.equal(payload.effects.childRestarted, true);
  assert.equal(proxy.restartCalls, 1);
  assert.ok(payload.warnings.some((warning) => warning.includes("自动重指")));
  assert.ok(payload.warnings.some((warning) => warning.includes("步骤摘要器已禁用")));

  const override = readOverride(dir);
  assert.equal(override.default.provider, "custom");
  assert.deepEqual(override.default.fallback, { provider: "custom", model: "deepseek-chat" });
  assert.deepEqual(override.nodes.object_detector, { provider: "custom", model: "deepseek-chat" });
  assert.deepEqual(override.nodes.hopper, { provider: "custom", model: "deepseek-chat" });

  // The config-sourced entry was imported into the store and marked active.
  const entries = await runtime.entries();
  const stored = entries.find((entry) => entry.name === "deepseek" && entry.source === "store");
  assert.ok(stored, "expected deepseek to be imported into the store");
  assert.equal(stored.isActive, true);
});

test("llm_switch: explicit nodeOverrides win over auto-pins", async () => {
  const dir = makeTempProject({
    config: deepseekWithOverrides(),
    dotenv: "DEEPSEEK_API_KEY=sk-test-key-123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  await llmSwitch(runtime, { name: "deepseek" });
  const override = readOverride(dir);
  assert.deepEqual(override.nodes.object_detector, { provider: "custom", model: "deepseek-chat" });
});

test("llm_switch: refuses while tasks are active unless forced", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-test-key-123456\n"
  });
  const proxy = new StubProxy({
    running: true,
    tasks: { active: [{ session_id: "t1" }], queued: [] }
  });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  // initialize() materializes the active entry (gemini) — capture it so the
  // refusal can be asserted as "no rewrite" instead of "no file".
  const overridePath = path.join(dir, ".artemis", "artemis.jsonc");
  const before = fs.readFileSync(overridePath, "utf-8");

  const refused = await llmSwitch(runtime, { name: "deepseek" });
  const refusedPayload = parseToolResult(refused);
  assert.equal(refused.isError, true);
  assert.equal(refusedPayload.blockedBy, "active_tasks");
  assert.equal(proxy.restartCalls, 0);
  assert.equal(
    fs.readFileSync(overridePath, "utf-8"),
    before,
    "refused switch must not rewrite the override"
  );

  const forced = await llmSwitch(runtime, { name: "deepseek", force: true });
  assert.equal(parseToolResult(forced).ok, true);
  assert.equal(proxy.restartCalls, 1);
});

test("llm_switch: model-only change does not restart the child", async () => {
  const config = baseConfig({
    llm: { profiles: { "gemini-mini": { provider: "google", model: "gemini-2.0-flash" } } }
  });
  const dir = makeTempProject({ config, dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(await llmSwitch(runtime, { name: "gemini-mini" }));
  assert.equal(payload.ok, true);
  assert.equal(payload.effects.childRestarted, false);
  assert.match(payload.effects.restartReason, /无需重启/);
  assert.equal(proxy.restartCalls, 0);
});

test("llm_switch: proceeds with a warning when the task check is unavailable", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-test-key-123456\n"
  });
  const proxy = new StubProxy({ running: true, diagnoseThrows: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(await llmSwitch(runtime, { name: "deepseek" }));
  assert.equal(payload.ok, true);
  assert.ok(payload.warnings.some((warning) => warning.includes("未能通过 mobile_diagnose")));
});

test("first-enable import: .env LLM is imported into the store and activated", async () => {
  const dir = makeTempProject({
    dotenv:
      "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_API_KEY=sk-env-123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await llmList(runtime));

  assert.equal(payload.setupRequired, false);
  const entry = payload.llms.find((item) => item.name === "deepseek-flash");
  assert.ok(entry);
  assert.equal(entry.source, "store");
  assert.equal(entry.isActive, true);
  assert.equal(entry.provider, "custom");
});

test("first-enable import also materializes the project artemis config for task_runner", async () => {
  const dir = makeTempProject({
    dotenv:
      "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com\nAOS_LLM_API_KEY=sk-env-123456\n"
  });
  await loadTestRuntime(dir, { proxy: new StubProxy() });

  const config = JSON.parse(
    fs.readFileSync(path.join(dir, ".artemis", "artemis.jsonc"), "utf-8")
  );
  assert.equal(config.default.provider, "custom");
  assert.equal(config.default.model, "deepseek-flash");
  assert.deepEqual(config.default.fallback, {
    provider: "custom",
    model: "deepseek-flash"
  });
  assert.equal(config.nodes.hopper.provider, "custom");
});

test("legacy llm-config.override.jsonc is removed (its format is ignored by artemis)", async () => {
  const dir = makeTempProject({
    dotenv:
      "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com\nAOS_LLM_API_KEY=sk-env-123456\n"
  });
  fs.mkdirSync(path.join(dir, ".artemis"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".artemis", "llm-config.override.jsonc"), "{}\n");

  await loadTestRuntime(dir, { proxy: new StubProxy() });
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "llm-config.override.jsonc")));
});

test("setup_required project does not write a project artemis config", async () => {
  const dir = makeTempProject({});
  await loadTestRuntime(dir, { proxy: new StubProxy() });
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "artemis.jsonc")));
});

test("first-enable import: legacy names are recognized", async () => {
  const dir = makeTempProject({
    dotenv:
      "AOS_LLM_MODEL=deepseek-flash\nDEEPSEEK_API_KEY=ds-legacy-123456\nOPENAI_BASE_URL=https://api.deepseek.com/v1\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const payload = parseToolResult(await llmList(runtime));
  const entry = payload.llms.find((item) => item.name === "deepseek-flash");
  assert.ok(entry);
  assert.equal(entry.source, "store");
  assert.equal(entry.key.envVar, null); // store entries keep no source var
  assert.equal(entry.baseUrl, "https://api.deepseek.com/v1");
});

test("aos_configure: stores, writes .env, activates, records figma token", async () => {
  const dir = makeTempProject({});
  const proxy = new StubProxy({ running: false });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(
    await aosConfigure(runtime, {
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-configured-123456",
      figmaToken: "figd_token_123"
    })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.stored, true);
  assert.equal(payload.activated, true);

  const envContent = fs.readFileSync(path.join(dir, ".env"), "utf-8");
  assert.match(envContent, /^AOS_LLM_MODEL=deepseek-flash$/m);
  assert.match(envContent, /^AOS_LLM_BASE_URL=https:\/\/api\.deepseek\.com\/v1$/m);
  assert.match(envContent, /^AOS_LLM_API_KEY=sk-configured-123456$/m);
  assert.match(envContent, /^FIGMA_ACCESS_TOKEN=figd_token_123$/m);

  const list = parseToolResult(await llmList(runtime));
  assert.equal(list.activeProfile, "deepseek-flash");
  assert.equal(list.setupRequired, false);

  const status = parseToolResult(await aosStatus(runtime));
  assert.equal(status.figma.token.present, true);
  assert.equal(status.figma.token.source, "store");
});

test("aos_configure: rejects invalid input", async () => {
  const dir = makeTempProject({});
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const bad = await aosConfigure(runtime, {
    model: "m",
    baseUrl: "not-a-url",
    apiKey: "k"
  });
  assert.equal(parseToolResult(bad).ok, false);
  assert.equal(bad.isError, true);
});

test("runtime: bare child spec works without an LLM (read-only tools stay usable)", async () => {
  const dir = makeTempProject({});
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy() });
  const spec = runtime.prepareChildSpec();
  assert.ok(spec.command);
  assert.equal(spec.env.ARTEMIS_STANDALONE, "1");
  assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.OPENAI_BASE_URL, undefined);
});

test("aos_configure: activating over a running bare child restarts it", async () => {
  const dir = makeTempProject({});
  const proxy = new StubProxy({ running: true, childFingerprint: "bare-child-fingerprint" });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(
    await aosConfigure(runtime, {
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-bare-123456"
    })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.activation.effects.childRestarted, true);
  assert.equal(proxy.restartCalls, 1);
});

test("aos_status: reports project, store, child and setup state", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  const payload = parseToolResult(await aosStatus(runtime));
  assert.equal(payload.activeProfile, "gemini");
  assert.equal(payload.project.name, path.basename(dir));
  assert.equal(payload.store.kind, "memory");
  assert.equal(payload.store.degraded, true);
  assert.equal(payload.artemis.child.running, true);
  assert.equal(payload.artemis.python.found, false);
  assert.match(payload.artemis.python.hint, /uv sync/);
});

test("aos_tasks: syncs pending tasks against artemis and lists stats", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const proxy = new StubProxy({ running: true, taskStatus: "completed" });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  await runtime.recordTaskSubmission({
    traceId: "trace-1",
    model: "Flash",
    taskDesc: "open settings"
  });

  const payload = parseToolResult(await aosTasks(runtime, { limit: 10 }));
  assert.equal(payload.ok, true);
  assert.equal(payload.sync.checked, 1);
  assert.equal(payload.sync.updated, 1);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].trace_id, "trace-1");
  assert.equal(payload.tasks[0].status, "completed");
  assert.ok(payload.tasks[0].finished_at);
});

test("aos_tasks: sync=false skips polling and leaves the row pending", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: "GEMINI_API_KEY=gm-abcdef123456\n" });
  const proxy = new StubProxy({ running: true, taskStatus: "completed" });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  await runtime.recordTaskSubmission({ traceId: "trace-2", model: "Pro", taskDesc: "x" });
  const payload = parseToolResult(await aosTasks(runtime, { sync: false }));
  assert.equal(payload.sync, null);
  assert.equal(payload.tasks[0].status, "submitted");
  assert.equal(payload.tasks[0].finished_at, null);
});
