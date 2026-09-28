import assert from "node:assert/strict";
import test from "node:test";

import { upsertEnvContent } from "../dist/env-file.js";

test("upsertEnvContent replaces existing keys and appends new ones", () => {
  const out = upsertEnvContent(
    "FOO=1\n# keep me\nAOS_LLM_MODEL=old-model\n",
    { AOS_LLM_MODEL: "new-model", AOS_LLM_API_KEY: "sk-new" }
  );
  assert.match(out, /^FOO=1$/m);
  assert.match(out, /^# keep me$/m);
  assert.match(out, /^AOS_LLM_MODEL=new-model$/m);
  assert.match(out, /^AOS_LLM_API_KEY=sk-new$/m);
  assert.ok(!out.includes("old-model"));
  assert.ok(out.endsWith("\n"));
});

test("upsertEnvContent handles empty files and preserves unrelated entries", () => {
  const out = upsertEnvContent("", { A: "1", B: "2" });
  assert.equal(out, "A=1\nB=2\n");

  const out2 = upsertEnvContent("EXISTING=x\n", { B: "2" });
  assert.match(out2, /^EXISTING=x$/m);
  assert.match(out2, /^B=2$/m);
});
