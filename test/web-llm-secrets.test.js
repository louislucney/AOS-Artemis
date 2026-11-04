import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import {
  loadWebSecrets,
  redactText,
  resolvePlaceholders
} from "../dist/web/llm/secrets.js";

test("secrets: materials secret + env 加载，脱敏与占位符注入", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aos-llm-secrets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secretPath = path.join(dir, "accounts.json");
  await writeFile(
    secretPath,
    JSON.stringify({ account: "user@example.com", password: "p@ssw0rd" })
  );
  const store = new MemoryStore();
  await store.createWebAsset({
    rootPath: "/w/p",
    kind: "materials",
    filename: "accounts.json",
    sha256: "a".repeat(64),
    size: 1,
    storagePath: secretPath,
    metadata: { secret: true }
  });
  const secrets = await loadWebSecrets({
    store,
    rootPath: "/w/p",
    env: { AOS_WEB_SECRET_API_TOKEN: "token-123456" }
  });
  assert.ok(secrets.some((entry) => entry.value === "user@example.com"));
  assert.ok(secrets.some((entry) => entry.alias === "api_token"));

  const result = redactText(
    "账号 user@example.com，密码 p@ssw0rd，token-123456",
    secrets
  );
  assert.doesNotMatch(result.text, /user@example\.com|p@ssw0rd|token-123456/);
  assert.match(result.text, /<secret:account>/);
  assert.deepEqual(result.unbound, []);
  assert.equal(
    resolvePlaceholders("<secret:account>", secrets),
    "user@example.com"
  );
});

test("secrets: 未绑定邮箱/手机号 → unbound", () => {
  const result = redactText("联系 user@example.com 或 13800138000", []);
  assert.equal(result.unbound.length, 2);
  assert.match(result.text, /<redacted:email>/);
});
