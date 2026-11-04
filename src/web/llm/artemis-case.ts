import { existsSync } from "node:fs";
import path from "node:path";

import { readAndroidTokenUsage, readAndroidTraceObservations } from "../../artemis/android-trace.js";
import type { LlmWorkerCase, LlmWorkerCaseResult } from "./worker.js";

export interface LlmToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface LlmToolProxy {
  callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult>;
}

export interface ExecuteAndroidLlmCaseInput {
  proxy: LlmToolProxy;
  traceDir: (traceId: string) => string;
  testCase: LlmWorkerCase;
  deviceSerial: string;
  /** 缺省 Pro：需要 test_summary/checker 作为证据。 */
  model?: "Flash" | "Pro";
  appPackage?: string | null;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ExecuteAndroidLlmCaseResult extends LlmWorkerCaseResult {
  artifacts?: {
    statusJsonPath?: string;
    dataEngineDbPath?: string;
  };
}

function parseToolJson(result: LlmToolCallResult): Record<string, unknown> | null {
  if (result.structuredContent !== undefined) {
    if (
      result.structuredContent !== null &&
      typeof result.structuredContent === "object" &&
      !Array.isArray(result.structuredContent)
    ) {
      return result.structuredContent as Record<string, unknown>;
    }
  }
  const text = result.content?.find((entry) => typeof entry.text === "string")?.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberField(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function summaryStatus(
  summary: Record<string, unknown> | null
): "PASS" | "FAIL" | "UNVERIFIED" {
  if (summary === null) return "UNVERIFIED";
  const passed = numberField(summary, "passed");
  const failed = numberField(summary, "failed");
  const inconclusive = numberField(summary, "inconclusive");
  const unchecked = numberField(summary, "unchecked");
  if (failed > 0) return "FAIL";
  if (passed > 0 && inconclusive === 0 && unchecked === 0) return "PASS";
  return "UNVERIFIED";
}

/**
 * P0 远程 Android：中心 ARTEMIS 通过设备网关（runner adb server）执行 taskDesc。
 * 每用例一个 trace；返回状态/证据路径/token（token 读取失败留空，由 ingest 标 token-unavailable）。
 */
export async function executeAndroidLlmCase(
  input: ExecuteAndroidLlmCaseInput
): Promise<ExecuteAndroidLlmCaseResult> {
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 2_000;
  const startedAt = input.now?.() ?? Date.now();
  const model = input.model ?? "Pro";
  const started = await input.proxy.callTool("mobile_run_task", {
    task_desc: input.testCase.taskDesc,
    device_serial: input.deviceSerial,
    model,
    ...(model === "Pro" ? { verification_level: "final" } : {}),
    ...(input.appPackage === null || input.appPackage === undefined
      ? {}
      : { locked_app_package: input.appPackage })
  });
  const startedJson = parseToolJson(started);
  const traceId =
    typeof startedJson?.trace_id === "string" ? startedJson.trace_id : null;
  if (traceId === null) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: (input.now?.() ?? Date.now()) - startedAt,
      failureReason: "artemis-run-task-missing-trace"
    };
  }
  const traceDir = input.traceDir(traceId);
  let last: Record<string, unknown> | null = null;
  try {
    for (;;) {
      if (input.signal?.aborted === true) {
        await input.proxy
          .callTool("mobile_manage_task", { action: "stop", trace_id: traceId })
          .catch(() => undefined);
        return {
          caseId: input.testCase.caseId,
          ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
          status: "SKIP",
          durationMs: (input.now?.() ?? Date.now()) - startedAt,
          failureReason: "cancelled",
          traceId
        };
      }
      const statusResult = await input.proxy.callTool("mobile_manage_task", {
        action: "status",
        trace_id: traceId
      });
      last = parseToolJson(statusResult);
      const status = typeof last?.status === "string" ? last.status : "";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await sleep(pollMs);
    }
  } catch (error) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: (input.now?.() ?? Date.now()) - startedAt,
      failureReason: error instanceof Error ? error.message : String(error),
      traceId
    };
  }

  const status = typeof last?.status === "string" ? last.status : "";
  const summary =
    last?.test_summary !== null &&
    typeof last?.test_summary === "object" &&
    !Array.isArray(last.test_summary)
      ? (last.test_summary as Record<string, unknown>)
      : null;
  let caseStatus: "PASS" | "FAIL" | "UNVERIFIED" = "UNVERIFIED";
  let failureReason: string | undefined;
  if (status === "completed") {
    caseStatus = summaryStatus(summary);
    if (caseStatus === "FAIL") failureReason = "artemis-test-summary-failed";
    if (caseStatus === "UNVERIFIED") failureReason = "artemis-test-summary-incomplete";
  } else if (status === "failed") {
    caseStatus = "FAIL";
    failureReason = "artemis-task-failed";
  } else {
    caseStatus = "FAIL";
    failureReason = "artemis-task-cancelled";
  }

  const statusJsonPath = path.join(traceDir, "status.json");
  const dataEngineDbPath = path.join(traceDir, "data_engine.db");
  const tokenRows = await readAndroidTokenUsage(dataEngineDbPath, traceId);
  const tokenUsage =
    tokenRows === null
      ? undefined
      : [
          {
            caseId: input.testCase.caseId,
            traceId,
            model,
            attempt: 1,
            phase: "execute",
            requestId: traceId,
            inputTokens: tokenRows.reduce((sum, row) => sum + row.inputTokens, 0),
            outputTokens: tokenRows.reduce((sum, row) => sum + row.outputTokens, 0),
            cacheCreateTokens: tokenRows.reduce((sum, row) => sum + row.cacheCreateTokens, 0),
            cacheReadTokens: tokenRows.reduce((sum, row) => sum + row.cacheReadTokens, 0)
          }
        ];
  const observations = await readAndroidTraceObservations(dataEngineDbPath, traceId);
  return {
    caseId: input.testCase.caseId,
    ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
    status: caseStatus,
    durationMs: (input.now?.() ?? Date.now()) - startedAt,
    ...(failureReason === undefined ? {} : { failureReason }),
    traceId,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    evidenceSteps: observations?.steps ?? [],
    artifacts: {
      ...(existsSync(statusJsonPath) ? { statusJsonPath } : {}),
      ...(existsSync(dataEngineDbPath) ? { dataEngineDbPath } : {})
    },
    verification: {
      deterministic: {
        passed: numberField(summary, "passed"),
        failed: numberField(summary, "failed"),
        skipped:
          numberField(summary, "inconclusive") + numberField(summary, "unchecked")
      },
      reference: "missing",
      verifier: "not-run"
    }
  };
}
