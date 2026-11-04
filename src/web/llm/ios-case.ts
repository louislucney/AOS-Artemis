import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkExpectedTexts } from "./verify.js";
import type { LlmWorkerCase, LlmWorkerCaseResult } from "./worker.js";

export interface IosLlmToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface IosLlmToolProxy {
  callTool(name: string, args: Record<string, unknown>): Promise<IosLlmToolCallResult>;
}

export interface ExecuteIosLlmCaseInput {
  proxy: IosLlmToolProxy;
  traceDir: (traceId: string) => string;
  testCase: LlmWorkerCase;
  deviceSerial: string;
  appPackage?: string | null;
  appPath?: string | null;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ExecuteIosLlmCaseResult extends LlmWorkerCaseResult {
  artifacts?: {
    statusJsonPath?: string;
  };
}

function parseToolJson(result: IosLlmToolCallResult): Record<string, unknown> | null {
  if (
    result.structuredContent !== null &&
    result.structuredContent !== undefined &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent as Record<string, unknown>;
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

function readRunLabels(runPath: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return [];
    const steps = (parsed as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return [];
    const labels: string[] = [];
    for (const step of steps) {
      if (step === null || typeof step !== "object") continue;
      const texts = (step as { texts?: unknown }).texts;
      if (!Array.isArray(texts)) continue;
      for (const item of texts) {
        if (item !== null && typeof item === "object") {
          const text = (item as { text?: unknown }).text;
          if (typeof text === "string" && text.trim() !== "") labels.push(text.trim());
        }
      }
    }
    return [...new Set(labels)];
  } catch {
    return [];
  }
}

/** 远程 iOS 真机：中心通过 AOS iOS 执行器（Appium/WDA）执行 taskDesc。 */
export async function executeIosLlmCase(
  input: ExecuteIosLlmCaseInput
): Promise<ExecuteIosLlmCaseResult> {
  if (input.testCase.caseId.trim() === "") {
    return {
      caseId: input.testCase.caseId,
      status: "ERROR",
      durationMs: 0,
      failureReason: "empty-case-id"
    };
  }
  const startedAt = input.now?.() ?? Date.now();
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = input.pollMs ?? 2_000;
  let traceId: string | null = null;
  let last: Record<string, unknown> | null = null;
  try {
    const started = await input.proxy.callTool("mobile_run_task", {
      task_desc: input.testCase.taskDesc,
      device_serial: input.deviceSerial,
      ...(input.appPackage === null || input.appPackage === undefined
        ? {}
        : { locked_app_package: input.appPackage }),
      ...(input.appPath === null || input.appPath === undefined
        ? {}
        : { app_path: input.appPath })
    });
    const startedJson = parseToolJson(started);
    traceId = typeof startedJson?.trace_id === "string" ? startedJson.trace_id : null;
    if (traceId === null) {
      return {
        caseId: input.testCase.caseId,
        ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
        status: "ERROR",
        durationMs: 0,
        failureReason: "ios-run-task-missing-trace"
      };
    }
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
      last = parseToolJson(
        await input.proxy.callTool("mobile_manage_task", {
          action: "status",
          trace_id: traceId
        })
      );
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
      failureReason: error instanceof Error ? error.message : String(error)
    };
  }

  const traceDir = input.traceDir(traceId);
  const statusJsonPath = path.join(traceDir, "status.json");
  const runPath = path.join(traceDir, "run.json");
  const labels = readRunLabels(runPath);
  const l1 = checkExpectedTexts(input.testCase.expected, labels);
  const summary =
    last?.test_summary !== null &&
    typeof last?.test_summary === "object" &&
    !Array.isArray(last.test_summary)
      ? (last.test_summary as Record<string, unknown>)
      : null;
  const status = typeof last?.status === "string" ? last.status : "";
  let caseStatus: "PASS" | "FAIL" | "UNVERIFIED";
  let failureReason: string | undefined;
  if (status === "failed" || status === "cancelled") {
    caseStatus = "FAIL";
    failureReason = status === "failed" ? "ios-task-failed" : "ios-task-cancelled";
  } else if (summary !== null) {
    const failed = numberField(summary, "failed");
    const passed = numberField(summary, "passed");
    if (failed > 0) {
      caseStatus = "FAIL";
      failureReason = "ios-test-summary-failed";
    } else if (passed > 0) {
      caseStatus = "PASS";
    } else if (l1.anchored && l1.failed > 0) {
      caseStatus = "FAIL";
      failureReason = "ios-l1-missing";
    } else if (l1.anchored && l1.passed > 0) {
      caseStatus = "PASS";
    } else {
      caseStatus = "UNVERIFIED";
      failureReason = "no-deterministic-evidence";
    }
  } else if (l1.anchored && l1.failed > 0) {
    caseStatus = "FAIL";
    failureReason = "ios-l1-missing";
  } else if (l1.anchored && l1.passed > 0) {
    caseStatus = "PASS";
  } else {
    caseStatus = "UNVERIFIED";
    failureReason = "ios-test-summary-missing";
  }

  return {
    caseId: input.testCase.caseId,
    ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
    status: caseStatus,
    durationMs: (input.now?.() ?? Date.now()) - startedAt,
    ...(failureReason === undefined ? {} : { failureReason }),
    traceId,
    evidenceSteps: labels,
    artifacts: {
      ...(existsSync(statusJsonPath) ? { statusJsonPath } : {})
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
