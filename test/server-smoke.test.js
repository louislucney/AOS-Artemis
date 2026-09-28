import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { baseConfig, makeTempProject } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function makeClient(projectDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "index.js")],
    cwd: repoRoot,
    env: { ...process.env, AOS_PROJECT_DIR: projectDir }
  });
  const client = new Client({ name: "aos-mcp-smoke", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

test("server smoke: handshake, tools, llm_list / llm_switch / aos_status", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const client = await makeClient(dir);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "llm_list",
      "llm_switch",
      "aos_configure",
      "aos_status",
      "get_current_selection",
      "extract_design_system"
    ]) {
      assert.ok(names.includes(expected), `expected ${expected} in ${names.join(",")}`);
    }

    const selectionSchema = tools.find((tool) => tool.name === "get_frame_by_name").inputSchema;
    assert.deepEqual(selectionSchema.required, ["name"]);

    const listed = await client.callTool({ name: "llm_list", arguments: {} });
    const payload = JSON.parse(listed.content[0].text);
    assert.equal(payload.activeProfile, "gemini");
    assert.equal(payload.llms.length, 2);
    assert.equal(payload.setupRequired, false);

    const badSwitch = await client.callTool({ name: "llm_switch", arguments: { name: "ghost" } });
    assert.equal(badSwitch.isError, true);

    const invalidArgs = await client.callTool({ name: "llm_switch", arguments: {} });
    assert.equal(invalidArgs.isError, true);

    const status = await client.callTool({ name: "aos_status", arguments: {} });
    const statusPayload = JSON.parse(status.content[0].text);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.figma.token.present, false);
    assert.equal(statusPayload.store.kind, "memory");
    assert.ok(
      ["listening", "skipped_occupied"].includes(statusPayload.figma.bridge.status),
      `unexpected bridge status: ${statusPayload.figma.bridge.status}`
    );
  } finally {
    await client.close();
  }
});

test("server smoke: mobile_run_task is gated by setup_required without an LLM", async () => {
  const dir = makeTempProject({});
  const client = await makeClient(dir);
  try {
    const gated = await client.callTool({
      name: "mobile_run_task",
      arguments: { task_desc: "open settings" }
    });
    assert.equal(gated.isError, true);
    const payload = JSON.parse(gated.content[0].text);
    assert.equal(payload.setup_required, true);
    assert.ok(Array.isArray(payload.howToFix));
  } finally {
    await client.close();
  }
});
