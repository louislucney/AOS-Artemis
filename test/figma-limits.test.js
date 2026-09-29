import assert from "node:assert/strict";
import test from "node:test";

import {
  FigmaRateLimitError,
  fetchFile
} from "../dist/vendor/design-context-bridge/figma-rest/client.js";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

test("figma limits: 长冷却 fail-fast 且按 token 记忆", async (t) => {
  process.env.FIGMA_ACCESS_TOKEN = "figd_test_limit_long";
  process.env.AOS_FIGMA_RETRY_MAX_WAIT_MS = "0";
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return new Response('{"status":429,"err":"Rate limit exceeded"}', {
      status: 429,
      headers: { "retry-after": "3600", "x-figma-rate-limit-type": "low" }
    });
  });
  t.after(() => {
    restore();
    delete process.env.FIGMA_ACCESS_TOKEN;
    delete process.env.AOS_FIGMA_RETRY_MAX_WAIT_MS;
  });

  await assert.rejects(fetchFile("limit-long-a"), (error) => {
    assert.ok(error instanceof FigmaRateLimitError);
    assert.equal(error.retryAfterSeconds, 3600);
    assert.equal(error.tier, "low");
    assert.match(error.message, /retry-after=3600s/);
    return true;
  });
  assert.equal(calls, 1);

  await assert.rejects(fetchFile("limit-long-b"), (error) => error instanceof FigmaRateLimitError);
  assert.equal(calls, 1, "冷却生效时应直接失败，不再打 API");
});

test("figma limits: 短 Retry-After 等待一次并重试", async (t) => {
  process.env.FIGMA_ACCESS_TOKEN = "figd_test_limit_short";
  process.env.AOS_FIGMA_RETRY_MAX_WAIT_MS = "2000";
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    if (calls === 1) {
      return new Response('{"status":429,"err":"Rate limit exceeded"}', {
        status: 429,
        headers: { "retry-after": "1", "x-figma-rate-limit-type": "medium" }
      });
    }
    return new Response(JSON.stringify({ name: "ok" }), { status: 200 });
  });
  t.after(() => {
    restore();
    delete process.env.FIGMA_ACCESS_TOKEN;
    delete process.env.AOS_FIGMA_RETRY_MAX_WAIT_MS;
  });

  const started = Date.now();
  const result = await fetchFile("limit-short-a");
  assert.equal(result.name, "ok");
  assert.equal(calls, 2);
  assert.ok(Date.now() - started >= 900, "应等待 Retry-After 时长后再试");
});

test("figma cache: TTL 内复用响应，AOS_FIGMA_CACHE_TTL_MS=0 关闭", async (t) => {
  process.env.FIGMA_ACCESS_TOKEN = "figd_test_cache";
  delete process.env.AOS_FIGMA_CACHE_TTL_MS;
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ name: "cached" }), { status: 200 });
  });
  t.after(() => {
    restore();
    delete process.env.FIGMA_ACCESS_TOKEN;
    delete process.env.AOS_FIGMA_CACHE_TTL_MS;
  });

  const first = await fetchFile("cache-a");
  const second = await fetchFile("cache-a");
  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  process.env.AOS_FIGMA_CACHE_TTL_MS = "0";
  const third = await fetchFile("cache-b");
  const fourth = await fetchFile("cache-b");
  assert.equal(calls, 3);
  assert.deepEqual(third, fourth);
});
