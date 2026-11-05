import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { checkExpectedTexts, summaryStatus } from "./verify.js";
import { redactText, type SecretEntry } from "./secrets.js";
import { compareReference, lastIosScreenshot } from "./reference.js";
import type { LlmWorkerCase, LlmWorkerCaseResult } from "./worker.js";

export interface IosLlmToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface IosLlmToolProxy {
  callTool(name: string, args: Record<string, unknown>): Promise<IosLlmToolCallResult>;
}

/** 远程 Appium 只能接收 HTTP(S) URL；中心本地路径一律拒绝。 */
export function iosAppUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

export interface ExecuteIosLlmCaseInput {
  proxy: IosLlmToolProxy;
  traceDir: (traceId: string) => string;
  testCase: LlmWorkerCase;
  deviceSerial: string;
  appPackage?: string | null;
  appPath?: string | null;
  /** 项目 secret；taskDesc 进模型前脱敏，未绑定账号直接拒绝。 */
  secrets?: SecretEntry[];
  /** runtime 已启用 Node 侧观察/截图脱敏；有 secret 但未启用时 fail-closed。 */
  redactionActive?: boolean;
  referencePath?: string | null;
  referenceAssetId?: string | null;
  referenceGate?: "off" | "report" | "unverified";
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

function readTokenUsage(
  value: unknown,
  caseId: string,
  traceId: string,
  model: string | null
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const usage = entry as Record<string, unknown>;
    const number = (key: string): number =>
      typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : 0;
    const attempt = number("attempt") || index + 1;
    const phase = typeof usage.phase === "string" ? usage.phase : "execute";
    return [
      {
        caseId,
        traceId,
        ...(model === null ? {} : { model }),
        attempt,
        phase,
        requestId: `${traceId}:${phase}:${attempt}`,
        promptTokens: number("promptTokens"),
        completionTokens: number("completionTokens"),
        cacheCreateTokens: number("cacheCreateTokens"),
        cacheReadTokens: number("cacheReadTokens")
      }
    ];
  });
}

interface IosEvidenceStep {
  stepNumber: number;
  action: string | null;
  preLabels: string[];
  postLabels: string[];
}

function readRunEvidence(runPath: string): {
  available: boolean;
  labels: string[];
  steps: IosEvidenceStep[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(runPath, "utf8"));
  } catch {
    return { available: false, labels: [], steps: [] };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { available: false, labels: [], steps: [] };
  }
  const steps = (parsed as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return { available: false, labels: [], steps: [] };
  const labels: string[] = [];
  const evidence: IosEvidenceStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (step === null || typeof step !== "object") continue;
    const record = step as Record<string, unknown>;
    const texts = record.texts;
    if (!Array.isArray(texts)) continue;
    const preLabels: string[] = [];
    for (const item of texts) {
      if (item !== null && typeof item === "object") {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string" && text.trim() !== "") preLabels.push(text.trim());
      }
    }
    for (const text of preLabels) if (!labels.includes(text)) labels.push(text);
    evidence.push({
      stepNumber:
        typeof record.step === "number" && Number.isFinite(record.step) ? record.step : index + 1,
      action: typeof record.action === "string" ? record.action : null,
      preLabels,
      postLabels: []
    });
  }
  return { available: true, labels, steps: evidence };
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
  if (input.appPath !== null && input.appPath !== undefined && iosAppUrl(input.appPath) === null) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: 0,
      failureReason: "ios-app-path-not-remote"
    };
  }
  if (secrets.length > 0 && input.redactionActive !== true) {
    return {
      caseId: input.testCase.caseId,
      ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
      status: "ERROR",
      durationMs: 0,
      failureReason: "ios-redaction-unavailable"
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
      task_desc: redacted.text,
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
  const reference = compareReference({
    referencePath: input.referencePath,
    referenceAssetId: input.referenceAssetId,
    screenshotPath: lastIosScreenshot(traceDir)
  });
  const evidence = readRunEvidence(runPath);
  const labels = evidence.labels;
  const l1 = evidence.available
    ? checkExpectedTexts(redactText(input.testCase.expected ?? "", secrets).text, labels)
    : { anchored: false, passed: 0, failed: 0, texts: [], missing: [] };
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
    const summaryVerdict = summaryStatus(summary);
    if (summaryVerdict === "FAIL") {
      caseStatus = "FAIL";
      failureReason = "ios-test-summary-failed";
    } else if (summaryVerdict === "PASS") {
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
    failureReason = evidence.available ? "ios-test-summary-missing" : "ios-evidence-missing";
  }
  if (
    input.referenceGate === "unverified" &&
    reference.status === "failed" &&
    caseStatus === "PASS"
  ) {
    caseStatus = "UNVERIFIED";
    failureReason = `reference-mismatch:${reference.regions ?? 0}`;
  }

  return {
    caseId: input.testCase.caseId,
    ...(input.testCase.name === undefined ? {} : { name: input.testCase.name }),
    status: caseStatus,
    durationMs: (input.now?.() ?? Date.now()) - startedAt,
    ...(failureReason === undefined ? {} : { failureReason }),
    traceId,
    reference,
    tokenUsage: readTokenUsage(
      last?.token_usage,
      input.testCase.caseId,
      traceId,
      typeof last?.model === "string" ? last.model : null
    ),
    evidenceSteps: evidence.steps,
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
