import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { aosConfigure } from "../dist/tools/configure.js";
import { llmList, llmModels } from "../dist/tools/llm.js";
import {
  baseConfig,
  loadTestRuntime,
  makeTempProject,
  modelFetcher,
  parseToolResult,
  StubProxy
} from "./helpers.js";

const RETIRED_DOTENV = [
  "AOS_LLM_NAME=deepseek",
  "AOS_LLM_MODEL=deepseek-v4-flash",
  "AOS_LLM_BASE_URL=https://api.deepseek.com/v1",
  "AOS_LLM_API_KEY=sk-test-key-123456",
  ""
].join("\n");

const LIVE_MODELS = ["deepseek-flash", "deepseek-v4-pro"];

function readDotenv(dir) {
  return fs.readFileSync(path.join(dir, ".env"), "utf-8");
}

function readArtemisConfig(dir) {
  return JSON.parse(
    fs.readFileSync(path.join(dir, ".artemis", "artemis.jsonc"), "utf-8")
  );
}

test("refreshModels: retired model is auto-repaired to the vendor alias", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: RETIRED_DOTENV });
  const fetchImpl = modelFetcher(LIVE_MODELS);
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    baseEnv: { AOS_LLM_AUTO_REPAIR: "1" },
    modelFetcher: fetchImpl
  });

  const reports = await runtime.refreshModels({ force: true });
  const report = reports.find((item) => item.entry === "deepseek");
  assert.ok(report);
  assert.equal(report.deprecated, true);
  assert.equal(report.suggestedModel, "deepseek-flash");
  assert.deepEqual(report.repaired, {
    from: "deepseek-v4-flash",
    to: "deepseek-flash",
    reason: "alias",
    sources: ["内存存储", "项目 .env", ".artemis/artemis.jsonc"]
  });

  const entries = await runtime.entries();
  assert.equal(entries.find((entry) => entry.name === "deepseek").model, "deepseek-flash");
  assert.match(readDotenv(dir), /AOS_LLM_MODEL=deepseek-flash/);
  assert.equal(readArtemisConfig(dir).default.model, "deepseek-flash");
  assert.equal(runtime.activeEntryCached().model, "deepseek-flash");
});

test("refreshModels: AOS_LLM_AUTO_REPAIR=0 keeps config, preflight blocks with guidance", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: RETIRED_DOTENV });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    baseEnv: { AOS_LLM_AUTO_REPAIR: "0" },
    modelFetcher: modelFetcher(LIVE_MODELS)
  });

  const reports = await runtime.refreshModels({ force: true });
  assert.equal(reports[0].repaired, null);
  assert.equal(reports[0].deprecated, true);

  const preflight = await runtime.ensureActiveModelUsable();
  assert.equal(preflight.ok, false);
  assert.equal(preflight.payload.model_deprecated, true);
  assert.equal(preflight.payload.model, "deepseek-v4-flash");
  assert.equal(preflight.payload.suggestedModel, "deepseek-flash");
  assert.ok(preflight.payload.availableModels.includes("deepseek-flash"));

  const entries = await runtime.entries();
  assert.equal(entries.find((entry) => entry.name === "deepseek").model, "deepseek-v4-flash");
});

test("preflight: capability model without equivalent is blocked, not silently downgraded", async () => {
  const dotenv = RETIRED_DOTENV.replace("deepseek-v4-flash", "deepseek-v4-pro");
  const dir = makeTempProject({ config: baseConfig(), dotenv });
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    baseEnv: { AOS_LLM_AUTO_REPAIR: "1" },
    modelFetcher: modelFetcher(["deepseek-flash"])
  });

  const reports = await runtime.refreshModels({ force: true });
  assert.equal(reports[0].deprecated, true);
  assert.equal(reports[0].repaired, null);
  assert.equal(reports[0].suggestedModel, null);

  const preflight = await runtime.ensureActiveModelUsable();
  assert.equal(preflight.ok, false);
  assert.equal(preflight.payload.suggestedModel, null);
});

test("llm_models: list reads cache, refresh fetches once, providers included", async () => {
  const dir = makeTempProject({ config: baseConfig(), dotenv: RETIRED_DOTENV });
  const fetchImpl = modelFetcher(LIVE_MODELS);
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    baseEnv: { AOS_LLM_AUTO_REPAIR: "1" },
    modelFetcher: fetchImpl
  });

  const before = parseToolResult(await llmModels(runtime, { action: "list" }));
  assert.equal(before.ttlHours, 12);
  assert.equal(before.autoRepair, true);
  assert.equal(before.providers.length, 8);
  assert.equal(before.entries[0].known, false);
  assert.equal(fetchImpl.calls.length, 0);

  const refreshed = parseToolResult(await llmModels(runtime, { action: "refresh" }));
  assert.equal(refreshed.entries[0].refreshed, true);
  assert.equal(refreshed.entries[0].deprecated, true);
  assert.equal(refreshed.entries[0].repaired.to, "deepseek-flash");
  assert.deepEqual(refreshed.entries[0].models, LIVE_MODELS);
  assert.equal(fetchImpl.calls.length, 1);

  const after = parseToolResult(await llmModels(runtime, { action: "list" }));
  assert.equal(after.entries[0].known, true);
  assert.equal(after.entries[0].deprecated, false);
  assert.equal(after.entries[0].activeModelAvailable, true);
  assert.equal(fetchImpl.calls.length, 1);

  const listed = parseToolResult(await llmList(runtime));
  assert.equal(listed.modelRefresh.ttlHours, 12);
  const entry = listed.llms.find((item) => item.name === "deepseek");
  assert.equal(entry.models.known, true);
  assert.equal(entry.models.activeModelAvailable, true);
  assert.equal(entry.models.deprecated, false);
});

test("aos_configure: vendor preset picks the vendor alias from the live list", async () => {
  const dir = makeTempProject({});
  const fetchImpl = modelFetcher(LIVE_MODELS);
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    modelFetcher: fetchImpl
  });

  const bad = await aosConfigure(runtime, { vendor: "ghost", apiKey: "sk-1" });
  assert.equal(bad.isError, true);

  const payload = parseToolResult(
    await aosConfigure(runtime, { vendor: "deepseek", apiKey: "sk-vendor-123456" })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.vendor, "deepseek");
  assert.equal(payload.model, "deepseek-flash");
  assert.equal(payload.activated, true);
  assert.ok(payload.warnings.some((line) => line.includes("别名")));
  assert.equal(fetchImpl.calls[0].url, "https://api.deepseek.com/v1/models");

  const stored = await runtime.store.listLlms(dir);
  assert.equal(stored.find((item) => item.name === "deepseek-flash").isActive, true);
  assert.match(readDotenv(dir), /AOS_LLM_MODEL=deepseek-flash/);
});

test("aos_configure: explicit triple does not call the vendor API", async () => {
  const dir = makeTempProject({});
  const fetchImpl = modelFetcher(LIVE_MODELS);
  const { runtime } = await loadTestRuntime(dir, {
    proxy: new StubProxy(),
    modelFetcher: fetchImpl
  });

  const payload = parseToolResult(
    await aosConfigure(runtime, {
      model: "deepseek-flash",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-explicit-123456"
    })
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.model, "deepseek-flash");
  assert.equal(payload.modelsFetched, 0);
  assert.equal(fetchImpl.calls.length, 0);
});
