import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const activeCount = Number(process.env.FAKE_ACTIVE_TASKS || "0");
if (process.env.FAKE_STDERR === "1") {
  console.error("fake-artemis ready");
}

const TOOLS = [
  {
    name: "mobile_run_task",
    description: "fake run",
    inputSchema: {
      type: "object",
      properties: { task_desc: { type: "string" } },
      required: ["task_desc"],
      additionalProperties: true
    }
  },
  {
    name: "mobile_manage_task",
    description: "fake manage",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" }, trace_id: { type: "string" } },
      required: ["action", "trace_id"],
      additionalProperties: true
    }
  },
  {
    name: "mobile_get_device_state",
    description: "fake device state",
    inputSchema: {
      type: "object",
      properties: { view_type: { type: "string" } },
      required: ["view_type"],
      additionalProperties: true
    }
  },
  {
    name: "mobile_inspect_trace",
    description: "fake inspect",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" }, trace_id: { type: "string" } },
      required: ["action", "trace_id"],
      additionalProperties: true
    }
  },
  {
    name: "mobile_diagnose",
    description: "fake diagnose",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

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
