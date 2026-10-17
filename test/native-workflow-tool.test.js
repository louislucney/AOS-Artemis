import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServerForRuntime, inProcessToolCatalog } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

async function makeHarness() {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: false }) });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "native-workflow-tool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    dir,
    runtime,
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

async function workflowTool(client) {
  const { tools } = await client.listTools();
  const tool = tools.find((entry) => entry.name === "design_to_test");
  assert.ok(tool, `design_to_test missing from ${tools.map((entry) => entry.name).join(",")}`);
  return tool;
}

test("design_to_test: registered in the catalog and exposed with a minimal optional schema", async () => {
  assert.ok(inProcessToolCatalog().includes("design_to_test"));
  const harness = await makeHarness();
  try {
    const tool = await workflowTool(harness.client);
    assert.ok(tool.description.length > 0);
    const properties = tool.inputSchema.properties ?? {};
    for (const key of [
      "figmaUrl",
      "nodeId",
      "penPath",
      "vision",
      "reuseExistingFlows",
      "device",
      "run"
    ]) {
      assert.ok(key in properties, `inputSchema exposes ${key}`);
    }
  } finally {
    await harness.close();
  }
});

test("design_to_test: description pins the pipeline protocol (no drift)", async () => {
  const harness = await makeHarness();
  try {
    const tool = await workflowTool(harness.client);
    for (const phrase of [
      "设计稿",
      "Figma",
      ".pen",
      "CR",
      "前置自检→读设计→懂交互→出用例→校验→可选执行",
      "run 缺省 false",
      "止于校验",
      "nextAction",
      "needs-setup",
      "needs-info"
    ]) {
      assert.ok(tool.description.includes(phrase), `description must mention "${phrase}"`);
    }
  } finally {
    await harness.close();
  }
});

test("design_to_test: zod rejects illegal types, accepts documented shapes", async () => {
  const harness = await makeHarness();
  try {
    for (const args of [
      { device: 123 },
      { run: "true" },
      { reuseExistingFlows: "yes" },
      { vision: "sometimes" },
      { vision: 1 },
      { figmaUrl: 42 }
    ]) {
      const rejected = await harness.client.callTool({ name: "design_to_test", arguments: args });
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /参数校验失败/, JSON.stringify(args));
    }

    // 合法形态穿过 zod 进入编排（缺设计来源＝用法错误，而非校验失败）。
    for (const args of [
      {},
      { vision: "auto" },
      { vision: true },
      { vision: false },
      { run: true },
      { reuseExistingFlows: false },
      { device: "emulator-5554" }
    ]) {
      const accepted = await harness.client.callTool({ name: "design_to_test", arguments: args });
      assert.ok(!accepted.content[0].text.includes("参数校验失败"), JSON.stringify(args));
      assert.equal(accepted.isError, true, JSON.stringify(args));
      const payload = JSON.parse(accepted.content[0].text);
      assert.equal(payload.ok, false, JSON.stringify(args));
      assert.ok(payload.error.includes("用法错误"), JSON.stringify(args));
    }
  } finally {
    await harness.close();
  }
});
