import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServerForRuntime } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

test("server instructions: initialize 返回服务定位与常用入口", async () => {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "instructions-test", version: "0.0.1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const instructions = client.getInstructions();
    assert.equal(typeof instructions, "string");
    for (const expected of [
      "Android",
      "iOS",
      "design_to_test",
      "run_regression",
      "verify_jira_issue",
      "mobile_run_task",
      ".artemis/"
    ]) {
      assert.ok(instructions.includes(expected), `instructions 缺少 ${expected}`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
