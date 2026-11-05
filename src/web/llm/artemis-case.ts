import { existsSync } from "node:fs";
import path from "node:path";

import { readAndroidTokenUsage, readAndroidTraceObservations } from "../../artemis/android-trace.js";
import { redactText, type SecretEntry } from "./secrets.js";
import { checkExpectedTexts, summaryStatus, type ExpectedTextCheck } from "./verify.js";
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
  /** 中心本地 APK 路径；ARTEMIS 在任务开始前安装到目标设备。 */
  appPath?: string | null;
  /** 已加载的项目 secret；taskDesc 进模型前先脱敏。 */
  secrets?: SecretEntry[];
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
  if (
    process.env.AOS_LLM_HOOKS_REQUIRED === "1" &&
    process.env.AOS_LLM_HOOKS_ACTIVE !== "1"
  ) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: 0,
      failureReason: "llm-secret-hook-unavailable"
    };
  }
  const secrets = input.secrets ?? [];
  const redacted = redactText(input.testCase.taskDesc, secrets);
  if (redacted.unbound.length > 0) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: 0,
      failureReason: `llm-secret-unbound:${redacted.unbound.length}`
    };
  }
  // P0 安全闸：ARTEMIS 进程内 hooks 尚未接通时，带 secret 的用例 fail-closed。
  if (secrets.length > 0 && process.env.AOS_LLM_HOOKS_ACTIVE !== "1") {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: 0,
      failureReason: "llm-secret-hook-unavailable"
    };
  }
  const started = await input.proxy.callTool("mobile_run_task", {
    task_desc: redacted.text,
    device_serial: input.deviceSerial,
    model,
    ...(model === "Pro" ? { verification_level: "final" } : {}),
    ...(input.appPackage === null || input.appPackage === undefined
      ? {}
      : { locked_app_package: input.appPackage }),
    ...(input.appPath === null || input.appPath === undefined
      ? {}
      : { app_path: input.appPath })
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
  const statusJsonPath = path.join(traceDir, "status.json");
  // ARTEMIS 默认把 data_engine.db 放在 traces 根目录（跨 trace 共享，按 session_id 区分），
  // 不是每个 trace 子目录；兼容旧的 per-trace 布局。
  const localDb = path.join(traceDir, "data_engine.db");
  const dataEngineDbPath = existsSync(localDb)
    ? localDb
    : path.join(path.dirname(traceDir), "data_engine.db");
  const observations = await readAndroidTraceObservations(dataEngineDbPath, traceId);
  const l1: ExpectedTextCheck =
    observations === null
      ? { anchored: false, passed: 0, failed: 0, texts: [], missing: [] }
      : checkExpectedTexts(
          redactText(input.testCase.expected ?? "", secrets).text,
          observations.labels
        );
  let caseStatus: "PASS" | "FAIL" | "UNVERIFIED" = "UNVERIFIED";
  let failureReason: string | undefined;
  if (status === "failed" || status === "cancelled") {
    caseStatus = "FAIL";
    failureReason = status === "failed" ? "artemis-task-failed" : "artemis-task-cancelled";
  } else if (status === "completed") {
    const summaryVerdict = summaryStatus(summary);
    if (summaryVerdict === "FAIL") {
      caseStatus = "FAIL";
      failureReason = "artemis-test-summary-failed";
    } else if (summaryVerdict === "PASS") {
      caseStatus = "PASS";
    } else if (l1.anchored && l1.failed > 0) {
      caseStatus = "FAIL";
      failureReason = `l1-missing:${l1.missing.slice(0, 3).join("|")}`;
    } else if (l1.anchored && l1.passed > 0) {
      caseStatus = "PASS";
    } else {
      caseStatus = "UNVERIFIED";
      failureReason =
        summary === null
          ? observations === null
            ? "artemis-evidence-missing"
            : "artemis-test-summary-missing"
          : "no-deterministic-evidence";
    }
  } else {
    caseStatus = "FAIL";
    failureReason = "artemis-task-not-completed";
  }
  const tokenRows = await readAndroidTokenUsage(dataEngineDbPath, traceId);
  const tokenUsage =
    tokenRows === null
      ? undefined
      : tokenRows.map((row) => ({
          caseId: input.testCase.caseId,
          traceId,
          model,
          attempt: 1,
          phase: "execute",
          requestId: `${traceId}:step-${row.stepNumber}`,
          promptTokens: row.inputTokens,
          completionTokens: row.outputTokens,
          cacheCreateTokens: row.cacheCreateTokens,
          cacheReadTokens: row.cacheReadTokens
        }));
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
      deterministic:
        summary === null
          ? { passed: l1.passed, failed: l1.failed, skipped: 0 }
          : {
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
