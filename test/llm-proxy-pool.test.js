import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { createAosHttpServer } from "../dist/http-server.js";

const HOST = "llm-pool-host";
const TOKEN = "llm-pool-runner-token-0123456789";

async function makeWorkspace() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "aos-llm-proxy-"));
}

async function startProvider(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const record = { url: req.url, headers: req.headers, body };
      try {
        record.json = body === "" ? null : JSON.parse(body);
      } catch {
        record.json = null;
      }
      requests.push(record);
      handler(req, res, record);
    });
    req.on("error", () => undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: server.address().port,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function defaultJsonHandler(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-pool",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 }
    })
  );
}

async function withProxy(options, fn) {
  const workspace = await makeWorkspace();
  const store = new MemoryStore();
  await store.upsertProject({
    rootPath: workspace,
    name: path.basename(workspace),
    hostId: HOST
  });
  const provider = await startProvider(options.providerHandler ?? defaultJsonHandler);
  const token = await store.upsertLlmPoolToken({
    name: "pool-a",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    apiKey: "sk-pool-key",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1_000_000,
    budgetLimitTokens: null,
    maxConcurrency: 10,
    supportsStreamUsage: false,
    priority: 10,
    ...(options.token ?? {})
  });
  await store.upsertLlm(workspace, {
    name: "entry",
    provider: "custom",
    baseUrl: "https://project.example.com",
    model: "m",
    apiKey: "sk-own",
    makeActive: true
  });
  await store.setLlmPoolBinding({
    rootPath: workspace,
    name: "entry",
    poolTokenId: options.boundTokenId ?? token.id,
    poolMode: options.mode ?? "pinned",
    poolModel: "m"
  });
  await store.upsertLlmPrice({
    provider: "custom",
    model: "m",
    currency: "CNY",
    fxRateToBase: 1,
    inputMicrosPerMtok: 10_000_000,
    outputMicrosPerMtok: 10_000_000,
    effectiveFrom: "2020-01-01T00:00:00.000Z"
  });

  const previous = process.env.AOS_RUNNER_JOB_TOKEN;
  process.env.AOS_RUNNER_JOB_TOKEN = TOKEN;
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  const proxyUrl = `http://127.0.0.1:${handle.port}/panel/api/runners/suite/llm/proxy/${Buffer.from(
    workspace,
    "utf8"
  ).toString("base64url")}/chat/completions`;
  try {
    await fn({ store, token, workspace, provider, proxyUrl });
  } finally {
    await handle.close();
    await provider.close();
    if (previous === undefined) delete process.env.AOS_RUNNER_JOB_TOKEN;
    else process.env.AOS_RUNNER_JOB_TOKEN = previous;
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

function post(proxyUrl, body, init = {}) {
  return fetch(proxyUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-aos-host-id": HOST,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    ...init
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("JSON response settles provider usage", async () => {
  await withProxy({}, async ({ store, token, proxyUrl }) => {
    const response = await post(proxyUrl, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "chatcmpl-pool");

    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.equal(events[0].totalTokens, 1100);
    assert.equal(events[0].usageSource, "provider");
    assert.ok(events[0].costMicrosBase > 0);
    assert.equal(events[0].poolTokenId, token.id);

    const snapshot = await store.getLlmBudgetSnapshot(token.id);
    assert.equal(snapshot.usedTokens, 1100);
    assert.ok(snapshot.usedMicros > 0);
    assert.equal(snapshot.reservedMicros, 0);
    assert.equal(snapshot.activeReservations, 0);
  });
});

test("JSON response without usage settles an estimate", async () => {
  await withProxy(
    {
      providerHandler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "no-usage", choices: [] }));
      }
    },
    async ({ store, token, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100
      });
      assert.equal(response.status, 200);
      const events = await store.listLlmUsageEvents({});
      assert.equal(events.length, 1);
      assert.equal(events[0].usageSource, "estimated");
      assert.equal(events[0].status, "settled_estimated");
      assert.ok(events[0].totalTokens > 0);
      const snapshot = await store.getLlmBudgetSnapshot(token.id);
      assert.equal(snapshot.reservedMicros, 0);
    }
  );
});

test("stream endpoint without capability does not receive stream_options", async () => {
  await withProxy(
    {
      providerHandler: (_req, res, record) => {
        assert.equal(record.json.stream_options, undefined);
        sse(res, [{ choices: [{ delta: { content: "ok" } }] }]);
      }
    },
    async ({ store, token, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /"ok"/);

      const events = await store.listLlmUsageEvents({});
      assert.equal(events.length, 1);
      assert.equal(events[0].usageSource, "estimated");
      assert.ok(events[0].totalTokens > 0);
      const snapshot = await store.getLlmBudgetSnapshot(token.id);
      assert.equal(snapshot.reservedMicros, 0);
      assert.equal(snapshot.activeReservations, 0);
    }
  );
});

test("stream endpoint with capability receives include_usage and usage is parsed", async () => {
  await withProxy(
    {
      token: { supportsStreamUsage: true },
      providerHandler: (_req, res, record) => {
        assert.equal(record.json.stream_options.include_usage, true);
        sse(res, [
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }
        ]);
      }
    },
    async ({ store, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true
      });
      assert.equal(response.status, 200);
      await response.text();

      const events = await store.listLlmUsageEvents({});
      assert.equal(events.length, 1);
      assert.equal(events[0].usageSource, "provider");
      assert.equal(events[0].totalTokens, 12);
      assert.equal(events[0].outputTokens, 2);
    }
  );
});

test("upstream 400 releases the reservation without usage", async () => {
  await withProxy(
    {
      providerHandler: (_req, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad request" } }));
      }
    },
    async ({ store, token, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.message, "bad request");

      const snapshot = await store.getLlmBudgetSnapshot(token.id);
      assert.equal(snapshot.reservedMicros, 0);
      assert.equal(snapshot.usedMicros, 0);
      assert.equal(snapshot.activeReservations, 0);
      assert.equal((await store.listLlmUsageEvents({})).length, 0);
      const updated = await store.getLlmPoolToken(token.id);
      assert.match(updated.lastError ?? "", /upstream-http-400/);
    }
  );
});

test("client disconnect settles partial and no reserved remains", async () => {
  let timer = null;
  await withProxy(
    {
      providerHandler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`);
        timer = setInterval(() => {
          try {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`
            );
          } catch {
            clearInterval(timer);
          }
        }, 50);
        res.on("close", () => clearInterval(timer));
      }
    },
    async ({ store, token, proxyUrl }) => {
      const controller = new AbortController();
      const response = await post(
        proxyUrl,
        {
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 100,
          stream: true
        },
        { signal: controller.signal }
      );
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      await reader.cancel().catch(() => undefined);
      if (timer !== null) clearInterval(timer);

      await waitFor(async () => {
        const snapshot = await store.getLlmBudgetSnapshot(token.id);
        return snapshot !== null && snapshot.activeReservations === 0 && snapshot.reservedMicros === 0;
      });
      const snapshot = await store.getLlmBudgetSnapshot(token.id);
      assert.ok(snapshot.usedMicros > 0);
      const events = await store.listLlmUsageEvents({});
      assert.equal(events.length, 1);
      assert.equal(events[0].usageSource, "partial");
    }
  );
});

test("budget exhausted returns 402 llm-budget-exhausted", async () => {
  await withProxy(
    {
      token: { budgetLimitMicros: 1 }
    },
    async ({ store, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100
      });
      assert.equal(response.status, 402);
      const payload = await response.json();
      assert.equal(payload.code, "llm-budget-exhausted");
      assert.equal((await store.listLlmUsageEvents({})).length, 0);
    }
  );
});

test("request model mismatch returns 400 llm-model-mismatch", async () => {
  await withProxy(
    {
      providerHandler: (_req, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider must not be called" }));
      }
    },
    async ({ provider, proxyUrl }) => {
      const response = await post(proxyUrl, {
        model: "other-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "llm-model-mismatch");
      assert.equal(provider.requests.length, 0);
    }
  );
});

test("auto mode falls back to the next token before forwarding", async () => {
  const workspace = await makeWorkspace();
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: workspace, name: "p", hostId: HOST });
  const providerA = await startProvider((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "token A provider must not be called" }));
  });
  const providerB = await startProvider(defaultJsonHandler);
  const a = await store.upsertLlmPoolToken({
    name: "a",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${providerA.port}/v1`,
    apiKey: "sk-a",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1,
    maxConcurrency: 10,
    priority: 10
  });
  await store.upsertLlmPoolToken({
    name: "b",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${providerB.port}/v1`,
    apiKey: "sk-b",
    status: "active",
    modelAllowlist: ["m"],
    budgetPeriod: "total",
    budgetLimitMicros: 1_000_000,
    maxConcurrency: 10,
    priority: 20
  });
  await store.upsertLlm(workspace, {
    name: "entry",
    provider: "custom",
    baseUrl: "https://project.example.com",
    model: "m",
    apiKey: "sk-own",
    makeActive: true
  });
  await store.setLlmPoolBinding({
    rootPath: workspace,
    name: "entry",
    poolTokenId: a.id,
    poolMode: "auto",
    poolModel: "m"
  });
  await store.upsertLlmPrice({
    provider: "custom",
    model: "m",
    currency: "CNY",
    fxRateToBase: 1,
    inputMicrosPerMtok: 10_000_000,
    outputMicrosPerMtok: 10_000_000,
    effectiveFrom: "2020-01-01T00:00:00.000Z"
  });

  const previous = process.env.AOS_RUNNER_JOB_TOKEN;
  process.env.AOS_RUNNER_JOB_TOKEN = TOKEN;
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot: workspace,
    store
  });
  const proxyUrl = `http://127.0.0.1:${handle.port}/panel/api/runners/suite/llm/proxy/${Buffer.from(
    workspace,
    "utf8"
  ).toString("base64url")}/chat/completions`;
  try {
    const response = await post(proxyUrl, {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(providerA.requests.length, 0);
    assert.equal(providerB.requests.length, 1);
    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.notEqual(events[0].poolTokenId, a.id);
  } finally {
    await handle.close();
    await providerA.close();
    await providerB.close();
    if (previous === undefined) delete process.env.AOS_RUNNER_JOB_TOKEN;
    else process.env.AOS_RUNNER_JOB_TOKEN = previous;
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
});

test("valid JSON with a non-JSON content type is still metered", async () => {
  await withProxy({}, async ({ store, proxyUrl }) => {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-aos-host-id": HOST,
        "content-type": "text/plain"
      },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    const events = await store.listLlmUsageEvents({});
    assert.equal(events.length, 1);
    assert.equal(events[0].totalTokens, 1100);
  });
});

test("invalid JSON on the chat path is rejected instead of bypassing the budget", async () => {
  await withProxy({}, async ({ store, proxyUrl }) => {
    const response = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-aos-host-id": HOST,
        "content-type": "text/plain"
      },
      body: "{not-json"
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid-body");
    assert.equal((await store.listLlmUsageEvents({})).length, 0);
  });
});
