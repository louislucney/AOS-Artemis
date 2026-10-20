import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Runtime } from "../runtime.js";
import type { NativeToolDefinition } from "../tools/native-tools/types.js";
import {
  degradedReason,
  listProjectEvents,
  reportProjectEvent,
  type EventIngressContext
} from "../events/ingress.js";
import { errorMessage, log } from "../util.js";

export const ASYNC_TOOL_NAMES = new Set(["run_regression", "verify_jira_issue", "design_to_test"]);

function jsonResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function eventContext(runtime: Runtime): EventIngressContext {
  return {
    store: runtime.store,
    rootPath: runtime.project.rootDir,
    storage: runtime.store.kind,
    degraded: degradedReason(runtime.store, runtime.storeNote)
  };
}

function resultText(result: CallToolResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") parts.push(item.text);
  }
  return parts.join("\n");
}

function outcomeOf(result: CallToolResult): { status: "passed" | "failed" | "error"; detail: unknown } {
  if (result.isError === true) return { status: "error", detail: null };
  const text = resultText(result);
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; failedStep?: unknown };
    if (parsed && typeof parsed === "object" && (parsed.ok === false || typeof parsed.failedStep === "string")) {
      return { status: "failed", detail: parsed };
    }
  } catch {
    /* non-JSON text is still a completed job */
  }
  return { status: "passed", detail: null };
}

function writeJobResult(
  rootDir: string,
  jobId: string,
  payload: unknown
): { path: string; bytes: number } | null {
  try {
    const dir = path.join(rootDir, ".artemis", "jobs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${jobId}.json`);
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    return { path: file, bytes: Buffer.byteLength(body) };
  } catch (error) {
    log(`异步任务结果落盘失败（${jobId}）：${errorMessage(error)}`);
    return null;
  }
}

export async function startAsyncJob(
  runtime: Runtime,
  tool: NativeToolDefinition,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const context = eventContext(runtime);
  try {
    await reportProjectEvent(context, {
      eventId: `${jobId}:started`,
      type: "run.started",
      source: "agent",
      runId: jobId,
      status: "started",
      at: startedAt,
      payload: { tool: tool.name, async: true, argsKeys: Object.keys(args).sort() }
    });
  } catch (error) {
    return jsonResult(
      { ok: false, error: `异步任务登记失败：${errorMessage(error)}`, tool: tool.name },
      true
    );
  }

  const execute = async () => {
    const began = Date.now();
    let result: CallToolResult;
    try {
      result = await tool.handler(runtime, args);
    } catch (error) {
      result = jsonResult({ ok: false, error: errorMessage(error), tool: tool.name }, true);
    }
    const finishedAt = new Date().toISOString();
    const outcome = outcomeOf(result);
    const text = resultText(result);
    const stored = writeJobResult(runtime.project.rootDir, jobId, {
      jobId,
      tool: tool.name,
      startedAt,
      finishedAt,
      durationMs: Date.now() - began,
      status: outcome.status,
      result
    });
    try {
      await reportProjectEvent(context, {
        eventId: `${jobId}:finished`,
        type: "run.finished",
        source: "agent",
        runId: jobId,
        status: outcome.status,
        at: finishedAt,
        payload: {
          tool: tool.name,
          durationMs: Date.now() - began,
          isError: result.isError === true,
          resultPath: stored?.path ?? null,
          resultBytes: stored?.bytes ?? 0,
          resultPreview: text.slice(0, 2000),
          ...(outcome.detail === null ? {} : { detail: outcome.detail })
        }
      });
    } catch (error) {
      log(`异步任务完成事件写入失败（${jobId}）：${errorMessage(error)}`);
    }
  };

  setImmediate(() => {
    void execute();
  });

  return jsonResult({
    ok: true,
    async: true,
    jobId,
    tool: tool.name,
    status: "running",
    startedAt,
    pollWith: "aos_job_status"
  });
}

export async function jobStatus(runtime: Runtime, jobId: string): Promise<CallToolResult> {
  const context = eventContext(runtime);
  const events = await listProjectEvents(context, {
    runId: jobId,
    order: "asc",
    includePayload: true,
    limit: 200
  });
  if (events.returned === 0) {
    return jsonResult({ ok: false, error: "job-not-found", jobId });
  }

  const started = events.events.find((event) => event.type === "run.started");
  const finished = [...events.events].reverse().find((event) => event.type === "run.finished");
  const startedAt = started?.receivedAt ?? events.events[0]!.receivedAt;
  const finishedAt = finished?.receivedAt ?? null;
  const finishedPayload =
    finished?.payload !== null && typeof finished?.payload === "object"
      ? (finished.payload as Record<string, unknown>)
      : null;
  const status = finished
    ? typeof finished.status === "string"
      ? finished.status
      : "passed"
    : "running";
  let result: unknown = null;
  const resultPath =
    typeof finishedPayload?.resultPath === "string" ? finishedPayload.resultPath : null;
  if (resultPath !== null) {
    try {
      result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as unknown;
    } catch {
      result = null;
    }
  }

  return jsonResult({
    ok: true,
    jobId,
    tool: finishedPayload?.tool ?? (typeof started?.payload === "object" && started.payload !== null
      ? (started.payload as Record<string, unknown>).tool
      : null),
    status,
    startedAt,
    finishedAt,
    durationMs: finishedAt === null ? null : Date.parse(finishedAt) - Date.parse(startedAt),
    resultPath,
    result,
    events: events.events.map((event) => ({
      type: event.type,
      status: event.status,
      step: event.step,
      receivedAt: event.receivedAt
    }))
  });
}
