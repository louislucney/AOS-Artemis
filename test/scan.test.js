import assert from "node:assert/strict";
import test from "node:test";

import { makeResolver } from "../dist/config/validate.js";
import { scanProjectEnv } from "../dist/projects/scan.js";

test("scan: new AOS_LLM_* names win over legacy", () => {
  const resolver = makeResolver(
    {
      AOS_LLM_MODEL: "m1",
      AOS_LLM_BASE_URL: "https://new.example/v1",
      AOS_LLM_API_KEY: "k-new",
      OPENAI_BASE_URL: "https://old.example/v1",
      DEEPSEEK_API_KEY: "k-old"
    },
    {}
  );
  const scan = scanProjectEnv(resolver);
  assert.equal(scan.llm.model, "m1");
  assert.equal(scan.llm.baseUrl, "https://new.example/v1");
  assert.equal(scan.llm.apiKey, "k-new");
  assert.equal(scan.llm.complete, true);
  assert.equal(scan.llm.modelVar, "AOS_LLM_MODEL");
  assert.equal(scan.llm.baseUrlVar, "AOS_LLM_BASE_URL");
  assert.equal(scan.llm.apiKeyVar, "AOS_LLM_API_KEY");
});

test("scan: legacy names fall back; missing model detected", () => {
  const resolver = makeResolver(
    { DEEPSEEK_API_KEY: "k", OPENAI_BASE_URL: "https://legacy.example/v1" },
    {}
  );
  const scan = scanProjectEnv(resolver);
  assert.equal(scan.llm.model, null);
  assert.equal(scan.llm.complete, false);
  assert.ok(scan.llm.missing.some((entry) => entry.includes("AOS_LLM_MODEL")));
  assert.equal(scan.llm.apiKeyVar, "DEEPSEEK_API_KEY");
  assert.equal(scan.llm.baseUrlVar, "OPENAI_BASE_URL");
});

test("scan: figma token optional, no LLM", () => {
  const scan = scanProjectEnv(makeResolver({ FIGMA_ACCESS_TOKEN: "figd_x" }, {}));
  assert.equal(scan.llm, null);
  assert.equal(scan.figmaToken, "figd_x");
  assert.equal(scan.figmaTokenVar, "FIGMA_ACCESS_TOKEN");
});

test("scan: entry name defaults to the model", () => {
  const scan = scanProjectEnv(
    makeResolver(
      { AOS_LLM_MODEL: "deepseek-flash", AOS_LLM_BASE_URL: "https://x/v1", AOS_LLM_API_KEY: "k" },
      {}
    )
  );
  assert.equal(scan.llm.name, "deepseek-flash");
});

test("scan: AOS_LLM_NAME overrides the derived name", () => {
  const scan = scanProjectEnv(
    makeResolver(
      {
        AOS_LLM_NAME: "team-deepseek",
        AOS_LLM_MODEL: "deepseek-flash",
        AOS_LLM_BASE_URL: "https://x/v1",
        AOS_LLM_API_KEY: "k"
      },
      {}
    )
  );
  assert.equal(scan.llm.name, "team-deepseek");
});
