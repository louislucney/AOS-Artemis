import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CrashKind, CrashRecord, CrashSummary } from "../crash/types.js";
import type { Runtime } from "../runtime.js";

export interface AosCrashesArgs {
  action: "list" | "get" | "scan";
  signature?: string;
  traceId?: string;
  package?: string;
  kind?: CrashKind;
  since?: string;
  limit?: number;
}

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError
  };
}

function summaryView(record: CrashSummary): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    package: record.package,
    attribution: record.attribution,
    exceptionClass: record.exceptionClass,
    message: record.message,
    rootCauseClass: record.rootCauseClass,
    topFrame: record.topFrame,
    signatureBasis: record.signatureBasis,
    source: record.source,
    deviceSerial: record.deviceSerial,
    occurredAt: record.occurredAt,
    capturedAt: record.capturedAt,
    occurrences: record.occurrences,
    outcomeCounts: record.outcomeCounts,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    traceIds: record.traceIds
  };
}

function recordView(record: CrashRecord): Record<string, unknown> {
  return {
    ...summaryView(record),
    frames: record.frames,
    causedBy: record.causedBy,
    excerpt: record.excerpt
  };
}

export async function aosCrashes(runtime: Runtime, args: AosCrashesArgs): Promise<CallToolResult> {
  if (args.action === "list") {
    let sinceMs: number | undefined;
    if (args.since) {
      const parsed = Date.parse(args.since);
      if (!Number.isFinite(parsed)) {
        return jsonResult(
          { ok: false, error: `无法解析 since 时间 "${args.since}"，请使用 ISO 8601 格式` },
          true
        );
      }
      sinceMs = parsed;
    }
    const { total, records } = runtime.crashStore.list({
      kind: args.kind,
      package: args.package,
      sinceMs,
      limit: args.limit
    });
    return jsonResult({
      ok: true,
      enabled: runtime.crashCaptureEnabled(),
      store: {
        dir: runtime.crashStore.dirPath,
        ...runtime.crashStore.counts()
      },
      total,
      count: records.length,
      records: records.map(summaryView)
    });
  }

  if (args.action === "get") {
    if (!args.signature) {
      return jsonResult({ ok: false, error: "action=get 需要提供 signature（见 action=list）" }, true);
    }
    const record = runtime.crashStore.get(args.signature);
    if (!record) {
      return jsonResult({ ok: false, error: `未找到崩溃签名 "${args.signature}"` }, true);
    }
    return jsonResult({ ok: true, record: recordView(record) });
  }

  const report = await runtime.scanTraceForCrashes({
    traceId: args.traceId,
    force: args.traceId ? true : undefined
  });
  const found = report.results.reduce((sum, result) => sum + result.found, 0);
  const newIds = report.results.flatMap((result) => result.newIds ?? []);
  const updatedIds = report.results.flatMap((result) => result.updatedIds ?? []);
  return jsonResult({
    ok: true,
    enabled: report.enabled,
    scanned: report.results.length,
    found,
    newSignatures: newIds,
    updatedSignatures: updatedIds,
    results: report.results
  });
}
