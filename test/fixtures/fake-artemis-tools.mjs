export const TOOLS = [
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
