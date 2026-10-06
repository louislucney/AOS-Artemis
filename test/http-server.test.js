import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAosHttpServer } from "../dist/http-server.js";

process.env.AOS_MODEL_REFRESH_HOURS = "0";
process.env.AOS_USAGE = "1";

function makeWorkspace() {
  const workspace = makeTempDir("aos-ws-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir);
  fs.writeFileSync(
    path.join(projectDir, ".env"),
    "AOS_LLM_MODEL=deepseek-flash\nAOS_LLM_BASE_URL=https://api.deepseek.com/v1\nAOS_LLM_API_KEY=sk-http-123456\n"
  );
  return workspace;
}

test("http server: per-project routing and MCP over streamable HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const client = new Client({ name: "http-smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp/demo`))
    );

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("llm_list"), names.join(","));
    assert.ok(names.includes("get_current_selection"));
    assert.ok(names.includes("aos_tasks"));

    const payload = JSON.parse(
      (await client.callTool({ name: "llm_list", arguments: {} })).content[0].text
    );
    assert.equal(payload.activeProfile, "deepseek-flash");
    assert.equal(payload.setupRequired, false);
    await client.close();

    // HTTP transport records usage: the audit line carries usage=<id>.
    const httpLog = fs.readFileSync(
      path.join(workspace, ".aos-mcp", "logs", "aos-mcp.log"),
      "utf-8"
    );
    assert.match(httpLog, /tool=llm_list ok=true ms=\d+ usage=[0-9a-f-]{36}/);

    // healthz reports registered projects
    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.ok(healthPayload.projects.includes("demo"));

    // unknown project → 404
    const unknown = await fetch(`http://127.0.0.1:${handle.port}/mcp/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(unknown.status, 404);

    // GET on /mcp/<project> is not supported in stateless mode
    const notAllowed = await fetch(`http://127.0.0.1:${handle.port}/mcp/demo`);
    assert.equal(notAllowed.status, 405);
  } finally {
    await handle.close();
  }
});

test("http server: invalid project names are rejected", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const bad = await fetch(`http://127.0.0.1:${handle.port}/mcp/..%2Fescape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    assert.equal(bad.status, 400);
  } finally {
    await handle.close();
  }
});

test("http server: usage dashboard over real HTTP", async () => {
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    const client = new Client({ name: "usage-web-smoke", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp/demo`))
    );
    await client.callTool({ name: "llm_list", arguments: {} });
    await client.close();

    const html = await fetch(`http://127.0.0.1:${handle.port}/usage`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type"), /text\/html/);
    const htmlBody = await html.text();
    assert.match(htmlBody, /概览/);
    assert.match(htmlBody, /工具表/);
    assert.match(htmlBody, /信号面板/);
    assert.match(htmlBody, /事件流水/);
    assert.match(htmlBody, /llm_list/);
    assert.match(htmlBody, /内存降级/);

    const json = await fetch(`http://127.0.0.1:${handle.port}/usage.json`);
    assert.equal(json.status, 200);
    const payload = await json.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.project.name, "demo");
    assert.ok(payload.summary.total >= 1);
    assert.ok(payload.tools.some((row) => row.tool === "llm_list" && row.count >= 1));
    assert.ok(payload.events.items.some((event) => event.tool === "llm_list"));

    const health = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    assert.equal(health.status, 200);
    const unknown = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    assert.equal(unknown.status, 404);
  } finally {
    await handle.close();
  }
});

test("http server: AOS_USAGE_WEB=0 disables /usage routes only", async () => {
  const previous = process.env.AOS_USAGE_WEB;
  process.env.AOS_USAGE_WEB = "0";
  const workspace = makeWorkspace();
  const handle = await createAosHttpServer({ port: 0, host: "127.0.0.1", workspaceRoot: workspace });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/usage.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${handle.port}/healthz`)).status, 200);
  } finally {
    await handle.close();
    if (previous === undefined) delete process.env.AOS_USAGE_WEB;
    else process.env.AOS_USAGE_WEB = previous;
  }
});
