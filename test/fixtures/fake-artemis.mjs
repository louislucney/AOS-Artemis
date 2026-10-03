import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOLS } from "./fake-artemis-tools.mjs";

const activeCount = Number(process.env.FAKE_ACTIVE_TASKS || "0");
if (process.env.FAKE_STDERR === "1") {
  console.error("fake-artemis ready");
}

const server = new Server(
  { name: "fake-artemis", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "mobile_diagnose") {
    const tasks = {
      active: Array.from({ length: activeCount }, (_, index) => ({ session_id: `fake-${index}` })),
      queued: []
    };
    const payload = { verdict: "ready", tasks };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  }
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, args }) }] };
});

await server.connect(new StdioServerTransport());
