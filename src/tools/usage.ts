import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { USAGE_EVENT_DEFAULT_LIMIT } from "../db/usage-event.js";
import type { UsageEventQuery, UsageEventRecord } from "../db/types.js";
import { figmaTools } from "../figma/registry.js";
import type { Runtime } from "../runtime.js";
import {
  USAGE_EVENT_LIST_MAX,
  usageEvents,
  usageSignals,
  usageSummary
} from "../usage/aggregate.js";
import { USAGE_DISABLED_NOTE } from "../usage/capture.js";

export interface AosUsageArgs {
  action?: "summary" | "signals" | "events";
  tool?: string;
  status?: "ok" | "error";
  days?: number;
  limit?: number;
}

interface UsageView {
  enabled: boolean;
  storage: "postgres" | "memory";
  note?: string;
}

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

async function inProcessCatalog(): Promise<string[]> {
  try {
    const { inProcessToolCatalog } = await import("../server.js");
    return inProcessToolCatalog();
  } catch {
    return figmaTools().map((tool) => tool.name);
  }
}

async function usageCatalog(runtime: Runtime): Promise<string[]> {
  const names = new Set(await inProcessCatalog());
  if (runtime.proxy.isRunning()) {
    for (const tool of await runtime.proxy.listTools().catch(() => [])) {
      names.add(tool.name);
    }
  }
  names.delete("aos_usage");
  return [...names].sort();
}

function usageView(runtime: Runtime): UsageView {
  const enabled = runtime.usageEnabled();
  const storage = runtime.storeKind();
  return enabled ? { enabled, storage } : { enabled, storage, note: USAGE_DISABLED_NOTE };
}

function filtersView(
  args: AosUsageArgs,
  since: string | undefined,
  appliedLimit: number | null
): Record<string, unknown> {
  return {
    tool: args.tool ?? null,
    status: args.status ?? null,
    days: args.days ?? null,
    since: since ?? null,
    limit: appliedLimit
  };
}

function eventView(event: UsageEventRecord): Record<string, unknown> {
  return {
    id: event.id,
    at: event.at,
    tool: event.tool,
    family: event.family,
    ok: event.ok,
    durationMs: event.durationMs,
    errorClass: event.errorClass,
    errorSummary: event.errorSummary,
    signals: event.signals,
    argKeys: event.argKeys,
    traceId: event.traceId
  };
}

export async function aosUsage(runtime: Runtime, args: AosUsageArgs): Promise<CallToolResult> {
  const action = args.action ?? "summary";
  const since =
    args.days === undefined
      ? undefined
      : new Date(Date.now() - args.days * 86_400_000).toISOString();
  const query: UsageEventQuery = { tool: args.tool, status: args.status, since };
  const common = {
    ok: true,
    action,
    usage: usageView(runtime),
    store: { kind: runtime.storeKind(), degraded: runtime.storeKind() === "memory" }
  };

  if (action === "events") {
    const appliedLimit = Math.min(args.limit ?? USAGE_EVENT_DEFAULT_LIMIT, USAGE_EVENT_LIST_MAX);
    const stored = await runtime.listUsageEvents({ ...query, limit: appliedLimit });
    const list = usageEvents(stored, { ...query, limit: appliedLimit });
    return jsonResult({
      ...common,
      filters: filtersView(args, since, appliedLimit),
      count: list.length,
      events: list.map(eventView)
    });
  }

  const stored = await runtime.listUsageEvents({ ...query, limit: runtime.usageSampleLimit() });

  if (action === "signals") {
    return jsonResult({
      ...common,
      filters: filtersView(args, since, null),
      signals: usageSignals(stored)
    });
  }

  return jsonResult({
    ...common,
    filters: filtersView(args, since, null),
    summary: usageSummary(stored, await usageCatalog(runtime))
  });
}
