import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateMessagesTokens,
  estimateRequest,
  estimateTextTokens
} from "../dist/llm/pool/estimate.js";
import { rewriteProviderRequest } from "../dist/llm/pool/provider-adapter.js";
import { createStreamTap } from "../dist/llm/pool/stream.js";

test("estimateRequest counts text and reserves the completion ceiling", () => {
  const e = estimateRequest({
    messages: [{ role: "user", content: "hello world" }],
    max_tokens: 100
  });
  assert.ok(e.promptTokens >= 2 && e.promptTokens <= 10);
  assert.equal(e.completionTokens, 100);
  assert.equal(e.totalTokens, e.promptTokens + 100);
});

test("image parts reserve a fixed allowance", () => {
  const e = estimateRequest({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:..." } }
        ]
      }
    ]
  });
  assert.ok(e.promptTokens >= 1600);
});

test("CJK text is not underestimated", () => {
  assert.ok(estimateTextTokens("登录页输入用户名和密码") >= 8);
});

test("estimateMessagesTokens includes per-message and request overhead", () => {
  const tokens = estimateMessagesTokens([{ role: "user", content: "hello" }]);
  assert.ok(tokens >= 6);
});

test("completion ceiling honours max_completion_tokens and env default", () => {
  assert.equal(
    estimateRequest({ messages: [], max_completion_tokens: 32 }).completionTokens,
    32
  );
  assert.equal(
    estimateRequest({ messages: [] }, { AOS_LLM_DEFAULT_MAX_OUTPUT_TOKENS: "512" })
      .completionTokens,
    512
  );
});

test("invalid body uses the default completion ceiling", () => {
  const e = estimateRequest(null);
  assert.deepEqual(e, { promptTokens: 0, completionTokens: 4096, totalTokens: 4096 });
});

test("SSE tap keeps the final usage chunk", () => {
  const tap = createStreamTap();
  tap.push(Buffer.from('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
  tap.push(
    Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n')
  );
  tap.push(Buffer.from("data: [DONE]\n\n"));
  tap.end();
  assert.deepEqual(tap.usage(), {
    baseInputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 2,
    totalTokens: 12
  });
  assert.equal(tap.outputChars(), 1);
});

test("tap handles split chunks and no usage", () => {
  const tap = createStreamTap();
  tap.push(Buffer.from('data: {"choices":[{"delta":{"con'));
  tap.push(Buffer.from('tent":"abc"}}]}\n\n'));
  tap.end();
  assert.equal(tap.usage(), null);
  assert.equal(tap.outputChars(), 3);
  assert.equal(tap.estimatedOutputTokens(), 1);
});

test("tap counts Anthropic text deltas", () => {
  const tap = createStreamTap();
  tap.push(
    Buffer.from(
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n'
    )
  );
  tap.end();
  assert.equal(tap.outputChars(), 2);
});

test("provider adapter rewrites DeepSeek json_schema", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: { name: "x", schema: { type: "object", properties: { a: { type: "string" } } } }
    }
  };
  const result = rewriteProviderRequest(body, {
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com"
  });
  assert.equal(result.rewritten, true);
  assert.deepEqual((result.body).response_format, { type: "json_object" });
  assert.ok((result.body).messages[0].content.includes("JSON schema"));
});

test("provider adapter leaves non-DeepSeek targets untouched", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } }
  };
  const result = rewriteProviderRequest(body, {
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1"
  });
  assert.equal(result.rewritten, false);
  assert.equal(result.body, body);
});

test("stream tap merges Anthropic message_start and message_delta usage", () => {
  const tap = createStreamTap();
  tap.push(
    Buffer.from(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":1}}}\n\n'
    )
  );
  tap.push(Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":15}}\n\n'));
  tap.end();
  const usage = tap.usage();
  assert.ok(usage);
  assert.equal(usage.baseInputTokens, 100);
  assert.equal(usage.cacheCreationTokens, 20);
  assert.equal(usage.cacheReadTokens, 30);
  assert.equal(usage.outputTokens, 15);
  assert.equal(usage.totalTokens, 165);
});
