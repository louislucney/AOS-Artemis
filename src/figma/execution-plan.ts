import { resolveResetPolicy, type ResetPolicy } from "../device/reset-policy.js";
import type { SuiteCaseResult } from "./suite-runner.js";

export type ExecutionEngine = "proxy" | "ios-llm" | "native-ios" | "native-android";
export type ExecutionPlatform = "ios" | "android";

export interface ExecutionPlanBudget {
  maxWallMs: number | null;
  maxSteps: number | null;
  maxStepsEffective: number | null;
  maxActions: number | null;
}

export interface ExecutionPlanView {
  schemaVersion: 1;
  platform: ExecutionPlatform;
  engine: ExecutionEngine;
  reset: {
    /** 四态保留；当前实现产出 reuse / app-internal-reset，fresh/none 待任务策略。 */
    mode: "fresh" | "app-internal-reset" | "reuse" | "none";
    entryConfigured: boolean;
    capability: "debug-menu" | "deep-link" | "test-api" | "full-reset" | "unsupported";
    supported: boolean;
    degraded: boolean;
  };
  data: {
    policy: "per-platform";
    aliases: string[];
  };
  /** 最小预算视图：iOS LLM 记录步数；Android proxy 显式未知；legacy 证据可为 null。 */
  budget: ExecutionPlanBudget | null;
  evidence: {
    steps: boolean;
    screenshots: boolean;
  };
}

export function buildExecutionPlan(input: {
  platform: ExecutionPlatform;
  engine: ExecutionEngine;
  aliases: string[];
  env?: NodeJS.ProcessEnv;
  screenshots?: boolean;
  resetPolicy?: ResetPolicy | null;
}): ExecutionPlanView {
  const env = input.env ?? process.env;
  const entry =
    input.platform === "ios"
      ? (env.AOS_IOS_RESET_URL ?? "").trim()
      : (env.AOS_ANDROID_RESET_URL ?? "").trim();
  const policy = input.resetPolicy ?? resolveResetPolicy(env);
  const effectiveReset = policy ?? (entry === "" ? "reuse" : "app-internal-reset");
  const resetSupported =
    effectiveReset === "app-internal-reset"
      ? entry !== ""
      : effectiveReset === "fresh"
        ? input.platform === "android"
        : true;
  const rawMaxSteps = Number.parseInt(env.AOS_IOS_MAX_STEPS ?? "", 10);
  const iosMaxSteps =
    input.platform === "ios" && (input.engine === "proxy" || input.engine === "ios-llm")
      ? Number.isInteger(rawMaxSteps) && rawMaxSteps > 0
        ? Math.max(1, Math.min(200, rawMaxSteps))
        : 30
      : null;
  return {
    schemaVersion: 1,
    platform: input.platform,
    engine: input.engine,
    reset: {
      mode: effectiveReset,
      entryConfigured: entry !== "",
      capability:
        effectiveReset === "fresh"
          ? "full-reset"
          : effectiveReset === "app-internal-reset"
            ? "deep-link"
            : "unsupported",
      supported: resetSupported,
      degraded: false
    },
    data: {
      policy: "per-platform",
      aliases: [...input.aliases]
    },
    budget: {
      maxWallMs: null,
      maxSteps: iosMaxSteps,
      maxStepsEffective: iosMaxSteps,
      maxActions: null
    },
    evidence: {
      steps: true,
      screenshots: input.screenshots === true
    }
  };
}

function budgetKey(budget: ExecutionPlanBudget | null | undefined): string {
  if (budget == null) return "legacy";
  return JSON.stringify([
    budget.maxWallMs,
    budget.maxSteps,
    budget.maxStepsEffective,
    budget.maxActions
  ]);
}

export interface ExecutionParityRecord {
  caseId: string;
  platform: ExecutionPlatform;
  status: SuiteCaseResult["status"];
  plan: ExecutionPlanView | null;
  stepsAvailable: boolean;
  /** 该 case 实际复位结果；null/未提供表示旧证据或未执行复位。 */
  resetOk?: boolean | null;
  /** suite_runs 中的失败原因；用于只读的跨端 UI 差异提示。 */
  failureReason?: string | null;
}

export interface ExecutionParityResult {
  caseId: string;
  comparable: boolean;
  reasons: string[];
  /** 可比但条件信息不完整（如 Android 步数预算未知）；不阻断 --fail-on-not-comparable。 */
  limitations: string[];
  platforms: Partial<
    Record<ExecutionPlatform, { status: SuiteCaseResult["status"]; stepsAvailable: boolean }>
  >;
}

/** 只判断“条件是否可比”，不判断两端谁对谁错；不是产品门禁。 */
export function compareExecutionParity(records: readonly ExecutionParityRecord[]): ExecutionParityResult[] {
  const byCase = new Map<string, ExecutionParityRecord[]>();
  for (const record of records) {
    const bucket = byCase.get(record.caseId) ?? [];
    bucket.push(record);
    byCase.set(record.caseId, bucket);
  }
  const out: ExecutionParityResult[] = [];
  for (const [caseId, entries] of byCase) {
    const reasons: string[] = [];
    const limitations: string[] = [];
    const platforms: ExecutionParityResult["platforms"] = {};
    for (const entry of entries) {
      platforms[entry.platform] = {
        status: entry.status,
        stepsAvailable: entry.stepsAvailable
      };
    }
    if (!platforms.ios) reasons.push("missing-platform:ios");
    if (!platforms.android) reasons.push("missing-platform:android");
    if (entries.some((entry) => entry.plan === null)) reasons.push("plan-missing");
    const plans = entries.filter((entry): entry is ExecutionParityRecord & { plan: ExecutionPlanView } => entry.plan !== null);
    if (plans.length > 0) {
      const first = plans[0]!.plan;
      if (plans.some((entry) => entry.plan.reset.mode !== first.reset.mode)) {
        reasons.push("plan-reset-mismatch");
      }
      if (plans.some((entry) => entry.plan.reset.supported === false)) {
        reasons.push("reset-unsupported");
      }
      if (plans.some((entry) => entry.plan.reset.degraded === true)) {
        reasons.push("reset-degraded");
      }
      if (plans.some((entry) => entry.plan.data.policy !== first.data.policy)) {
        reasons.push("data-policy-mismatch");
      }
      if (plans.some((entry) => JSON.stringify(entry.plan.data.aliases) !== JSON.stringify(first.data.aliases))) {
        reasons.push("data-aliases-mismatch");
      }
      const budgets = plans.map((entry) => entry.plan.budget);
      const budgetUnknown = budgets.some(
        (budget) =>
          budget == null ||
          (budget.maxSteps == null &&
            budget.maxStepsEffective == null &&
            budget.maxActions == null)
      );
      if (budgetUnknown) {
        limitations.push("budget-unknown");
      } else if (budgets.some((budget) => budgetKey(budget) !== budgetKey(first.budget))) {
        reasons.push("budget-mismatch");
      }
    }
    if (entries.some((entry) => entry.resetOk === false)) reasons.push("reset-failed");
    if (entries.some((entry) => !entry.stepsAvailable)) reasons.push("steps-unavailable");
    if (
      platforms.ios !== undefined &&
      platforms.android !== undefined &&
      entries.every((entry) => entry.failureReason?.includes("case-target-missing"))
    ) {
      limitations.push("ui-divergence-inconclusive");
    }
    out.push({
      caseId,
      comparable: reasons.length === 0,
      reasons,
      limitations,
      platforms
    });
  }
  return out.sort((a, b) => a.caseId.localeCompare(b.caseId));
}
