import assert from "node:assert/strict";
import test from "node:test";

import { makeChatFn } from "../dist/llm/chat.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("makeChatFn: POST chat/completions 并解析 content", async () => {
  const requests = [];
  const chat = makeChatFn(
    { baseUrl: "https://api.example.com/v1/", apiKey: "sk-test", model: "m1" },
    {
      fetchFn: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ choices: [{ message: { content: '{"action":"done"}' } }] });
      }
    }
  );
  const content = await chat([{ role: "user", content: "hi" }]);
  assert.equal(content, '{"action":"done"}');
  assert.equal(requests[0].url, "https://api.example.com/v1/chat/completions");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, "m1");
  assert.equal(body.temperature, 0);
  assert.equal(requests[0].init.headers.authorization, "Bearer sk-test");
});

test("makeChatFn: HTTP 错误与缺 content 抛出 ChatError", async () => {
  const httpError = makeChatFn(
    { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
    { fetchFn: async () => new Response("nope", { status: 401 }) }
  );
  await assert.rejects(() => httpError([{ role: "user", content: "x" }]), /HTTP 401/);

  const empty = makeChatFn(
    { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
    { fetchFn: async () => jsonResponse({ choices: [] }) }
  );
  await assert.rejects(() => empty([{ role: "user", content: "x" }]), /缺少 choices/);

  const apiError = makeChatFn(
    { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
    { fetchFn: async () => jsonResponse({ error: { message: "bad key" } }) }
  );
  await assert.rejects(() => apiError([{ role: "user", content: "x" }]), /bad key/);
});

test("makeChatFn: 网络异常包装为 LLM 请求失败", async () => {
  const chat = makeChatFn(
    { baseUrl: "https://api.example.com", apiKey: "k", model: "m" },
    {
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      }
    }
  );
  await assert.rejects(() => chat([{ role: "user", content: "x" }]), /LLM 请求失败.*ECONNREFUSED/);
});
