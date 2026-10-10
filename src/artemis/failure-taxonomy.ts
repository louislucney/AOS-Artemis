import type { AppResetOutcome } from "../device/reset.js";
import type { TaskStatus } from "./task-result.js";

export type FailureDomain =
  | "app-defect"
  | "environment"
  | "api-error"
  | "data-environment"
  | "behavior-or-design"
  | "design-inference"
  | "case-defect"
  | "unclassified";

export type FailureConfidence = "high" | "medium" | "low";

export interface FailureClassification {
  domain: FailureDomain;
  confidence: FailureConfidence;
  reason: string;
  evidence: string[];
}

export interface CrashSignal {
  id: string;
  kind: string;
  package: string;
  exceptionClass: string;
}

export interface ApiErrorSignal {
  code: string;
  handled: boolean | null;
}

export interface ScriptProvenanceSignal {
  /** assert-kind steps in the case script (from tests.json expectations). */
  asserts: number;
  /** explore-kind (inferred evidence) steps in the case script. */
  explores: number;
  /** assert steps never observed during the run (iOS adherence), when available. */
  unresolvedAsserts?: number;
  /** explore steps whose target screen was observed (iOS adherence), when available. */
  exploresReached?: number;
}

/** Compose the classification signal from the case's script counts and the
 * run's adherence summary when the executor reported one (iOS). Missing
 * adherence keeps the signal unverified — mixed scripts then never claim
 * design-inference. */
export function scriptProvenanceSignal(
  base: { asserts: number; explores: number } | null,
  adherence?: { unresolved: number; deferredReached: number } | null
): ScriptProvenanceSignal | null {
  if (!base) return null;
  if (!adherence) return base;
  return {
    ...base,
    unresolvedAsserts: adherence.unresolved,
    exploresReached: adherence.deferredReached
  };
}

export interface FailureInput {
  status?: TaskStatus | null;
  crashes?: CrashSignal[];
  reset?: AppResetOutcome | null;
  submitError?: string | null;
  preconditions?: string[];
  timedOut?: boolean;
  apiErrors?: ApiErrorSignal[];
  scriptProvenance?: ScriptProvenanceSignal | null;
}

const ENVIRONMENT_RESET_REASONS = new Set([
  "adb-not-found",
  "device-offline",
  "timeout",
  "ios-unsupported",
  "launch-failed"
]);
const ENVIRONMENT_PATTERN =
  /(adb|device\s+(offline|unauthorized|not\s+found)|no\s+devices?|emulator|设备(离线|未授权|未连接|不可用|不存在)|无可用设备|没有可用设备|找不到设备)/i;
const LOGIN_PATTERN = /(登录|登陆|log\s?in|sign\s?in|账号|account|credentials?)/i;
const DATA_PATTERN =
  /(数据|列表|list|feed|为空|空列表|无数据|没有数据|no\s+data|empty|网络|network|连接(失败|超时)|connection|加载失败|load(ing)?\s+failed)/i;
const CASE_PATTERN = /(参数|invalid|格式|task_desc|任务描述|用例)/i;

function failureTexts(input: FailureInput): string[] {
  const texts: string[] = [];
  if (input.submitError) texts.push(input.submitError);
  if (input.status?.error) texts.push(input.status.error);
  if (input.status?.message) texts.push(input.status.message);
  for (const item of input.status?.testSummary?.failedItems ?? []) {
    if (item.itemText) texts.push(item.itemText);
    if (item.evidence) texts.push(item.evidence);
  }
  return texts;
}

function matchedPrecondition(text: string, preconditions: string[] | undefined): string | null {
  if (!preconditions || preconditions.length === 0) return null;
  const tokens: RegExp[] = [];
  if (LOGIN_PATTERN.test(text)) tokens.push(LOGIN_PATTERN);
  if (DATA_PATTERN.test(text)) tokens.push(DATA_PATTERN);
  if (tokens.length === 0) return null;
  for (const precondition of preconditions) {
    if (tokens.some((pattern) => pattern.test(precondition))) return precondition;
  }
  return null;
}

/** Deterministic failure-domain classification over run evidence. The taxonomy
 * is an explanation layer only: it never feeds design/device diff judgment
 * (ADR-0001) and returns `unclassified` with a reason when signals are weak. */
export function classifyFailure(input: FailureInput): FailureClassification {
  const texts = failureTexts(input);
  const crashes = input.crashes ?? [];

  if (crashes.length > 0) {
    const details = crashes.map(
      (crash) => `${crash.kind}:${crash.exceptionClass}@${crash.package}`
    );
    return {
      domain: "app-defect",
      confidence: "high",
      reason: `检测到与 trace 关联的崩溃签名（${details.join("；")}）`,
      evidence: crashes.map((crash) => crash.id)
    };
  }

  if (input.reset && !input.reset.ok && input.reset.reason) {
    if (ENVIRONMENT_RESET_REASONS.has(input.reset.reason)) {
      return {
        domain: "environment",
        confidence: "high",
        reason: `用例复位失败（${input.reset.reason}）${input.reset.message ? `：${input.reset.message}` : ""}`,
        evidence: [`reset:${input.reset.reason}`]
      };
    }
  }

  const environmentText = texts.find((text) => ENVIRONMENT_PATTERN.test(text));
  if (environmentText) {
    return {
      domain: "environment",
      confidence: "high",
      reason: `失败信息包含设备/ADB 环境信号：${environmentText}`,
      evidence: [environmentText]
    };
  }

  const unhandledApiErrors = (input.apiErrors ?? []).filter((error) => error.handled === false);
  if (unhandledApiErrors.length > 0) {
    const codes = unhandledApiErrors.map((error) => error.code);
    return {
      domain: "api-error",
      confidence: "high",
      reason: `检测到未按通用处理响应的 API 错误：${codes.join("、")}`,
      evidence: codes
    };
  }

  const dataText = texts.find((text) => LOGIN_PATTERN.test(text) || DATA_PATTERN.test(text));
  if (dataText) {
    const precondition = matchedPrecondition(dataText, input.preconditions);
    return {
      domain: "data-environment",
      confidence: precondition ? "high" : "medium",
      reason: precondition
        ? `失败信息与前置数据假设「${precondition}」相关：${dataText}`
        : `失败信息包含登录/数据/网络信号，疑似数据环境不符：${dataText}`,
      evidence: precondition ? [dataText, `precondition:${precondition}`] : [dataText]
    };
  }

  if ((input.status?.testSummary?.failedItems.length ?? 0) > 0) {
    const provenance = input.scriptProvenance;
    if (provenance && provenance.explores > 0) {
      const pureExploration = provenance.asserts === 0;
      if (pureExploration) {
        return {
          domain: "design-inference",
          confidence: "high",
          reason: `用例失败但脚本全部为推断来源（探索 ${provenance.explores} 步、断言 0 步）：更可能是设计推断/配对问题而非应用缺陷`,
          evidence: [`script:asserts=0`, `script:explores=${provenance.explores}`]
        };
      }
      const assertsVerifiedSettled = provenance.unresolvedAsserts === 0;
      const explorationIncomplete =
        provenance.exploresReached !== undefined &&
        provenance.exploresReached < provenance.explores;
      if (assertsVerifiedSettled && explorationIncomplete) {
        return {
          domain: "design-inference",
          confidence: "medium",
          reason: `断言均已命中（未出现 0）而探索步骤未全部达成（${provenance.exploresReached}/${provenance.explores}）：失败指向设计推断`,
          evidence: [
            `script:asserts=${provenance.asserts}`,
            `script:explores=${provenance.explores}`,
            `script:exploresReached=${provenance.exploresReached}`,
            `script:unresolvedAsserts=0`
          ]
        };
      }
    }
    return {
      domain: "behavior-or-design",
      confidence: "high",
      reason: "断言未通过且无崩溃/环境/数据证据，归为行为或设计差异",
      evidence: input.status!.testSummary!.failedItems.map((item) =>
        [item.itemText, item.evidence].filter(Boolean).join(" / ")
      )
    };
  }

  if (input.timedOut) {
    return {
      domain: "case-defect",
      confidence: "medium",
      reason: "轮询超时未获得终态：用例可能无法推进或设备长时间无响应",
      evidence: []
    };
  }

  const caseText = input.submitError && CASE_PATTERN.test(input.submitError) ? input.submitError : null;
  if (caseText) {
    return {
      domain: "case-defect",
      confidence: "medium",
      reason: `任务未被上游接受，疑似用例描述/参数问题：${caseText}`,
      evidence: [caseText]
    };
  }

  if (input.status?.status === "failed") {
    return {
      domain: "unclassified",
      confidence: "low",
      reason: "任务失败但无 failed_items、崩溃或环境证据",
      evidence: []
    };
  }
  if (input.submitError) {
    return {
      domain: "unclassified",
      confidence: "low",
      reason: `任务提交失败但无明确域信号：${input.submitError}`,
      evidence: [input.submitError]
    };
  }
  return {
    domain: "unclassified",
    confidence: "low",
    reason: input.status?.status
      ? `任务状态为 ${input.status.status}，无可用失败证据`
      : "缺少任务状态，无可用失败证据",
    evidence: []
  };
}
