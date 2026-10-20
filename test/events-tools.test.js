import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServerForRuntime } from "../dist/server.js";
import { baseConfig, loadTestRuntime, makeTempProject, parseToolResult, StubProxy } from "./helpers.js";

async function connect() {
  const dir = makeTempProject({
    config: baseConfig(),
    dotenv: "DEEPSEEK_API_KEY=sk-abcdef123456\n"
  });
  const { runtime } = await loadTestRuntime(dir, { proxy: new StubProxy({ running: true }) });
  const server = createServerForRuntime(runtime, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "events-tool-test", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, runtime, dir };
}

test("aos_event_report / aos_events: 注册、ack、幂等与查询", async () => {
  const { client, server } = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("aos_event_report"), names.join(","));
    assert.ok(names.includes("aos_events"), names.join(","));

    const input = {
      eventId: "e-tool-1",
      type: "case.result",
      caseId: "TC_1",
      status: "passed",
      payload: { note: "x" }
    };
    const first = parseToolResult(await client.callTool({ name: "aos_event_report", arguments: input }));
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.storage, "memory");
    assert.ok("degraded" in first);

    const dup = parseToolResult(await client.callTool({ name: "aos_event_report", arguments: input }));
    assert.equal(dup.accepted, false);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.serverId, first.serverId);

    const listed = parseToolResult(
      await client.callTool({ name: "aos_events", arguments: { includePayload: false } })
    );
    assert.equal(listed.returned, 1);
    assert.equal(listed.events[0].payload, undefined);

    const invalid = await client.callTool({
      name: "aos_event_report",
      arguments: { eventId: "bad", type: "nope" }
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
