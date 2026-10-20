import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ProjectStore } from "../../db/types.js";
import {
  degradedReason,
  EventValidationError,
  listProjectEvents,
  reportProjectEvent
} from "../../events/ingress.js";
import {
  EVENT_SOURCES,
  EVENT_STATUSES,
  EVENT_TYPES
} from "../../events/protocol.js";
import type { NativeToolDefinition } from "./types.js";

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function context(runtime: Parameters<NativeToolDefinition["handler"]>[0]) {
  return {
    store: runtime.store,
    rootPath: runtime.project.rootDir,
    storage: runtime.store.kind as ProjectStore["kind"],
    degraded: degradedReason(runtime.store, runtime.storeNote)
  };
}

const reportSchema = z.object({
  eventId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "eventId 只能包含字母、数字、. _ : -"),
  type: z.enum(EVENT_TYPES),
  source: z.enum(EVENT_SOURCES).optional(),
  at: z.string().optional(),
  runId: z.string().min(1).max(128).optional(),
  caseId: z.string().min(1).max(128).optional(),
  step: z.number().int().min(0).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  payload: z.unknown().optional()
});

const querySchema = z.object({
  runId: z.string().optional(),
  caseId: z.string().optional(),
  type: z.enum(EVENT_TYPES).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  since: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  includePayload: z.boolean().optional()
});

export const EVENTS_NATIVE_TOOLS: NativeToolDefinition[] = [
  {
    name: "aos_event_report",
    description:
      "项目执行事件上报（项目 → MCP）：幂等 eventId；写入 project_events 后立即返回 accepted/serverId/receivedAt/storage/degraded。事件类型含 run.*/case.*/artifact.created/log.entry/feedback.request；不执行 payload，也不写入 usage_events。",
    schema: reportSchema,
    handler: async (runtime, args) => {
      try {
        return jsonResult(await reportProjectEvent(context(runtime), args));
      } catch (error) {
        if (error instanceof EventValidationError) {
          return jsonResult(
            { ok: false, error: error.message, ...(error.field ? { field: error.field } : {}) },
            true
          );
        }
        return jsonResult({ ok: false, error: "event store unavailable" }, true);
      }
    }
  },
  {
    name: "aos_events",
    description:
      "查询当前项目的执行事件（project_events）：按 runId/caseId/type/status/since 过滤，默认新→旧、默认不返回 payload（includePayload:true 时 limit ≤ 50）。",
    schema: querySchema,
    handler: async (runtime, args) => {
      try {
        return jsonResult(await listProjectEvents(context(runtime), args));
      } catch (error) {
        if (error instanceof EventValidationError) {
          return jsonResult({ ok: false, error: error.message, field: error.field }, true);
        }
        return jsonResult({ ok: false, error: "event store unavailable" }, true);
      }
    }
  }
];
