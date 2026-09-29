import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createAosHttpServer } from "../dist/http-server.js";

process.env.AOS_MODEL_REFRESH_HOURS = "0";

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aos-ws-"));
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
