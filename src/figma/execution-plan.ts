import type { SuiteCaseResult } from "./suite-runner.js";

export type ExecutionEngine = "proxy" | "native-ios" | "native-android";
export type ExecutionPlatform = "ios" | "android";

export interface ExecutionPlanView {
  schemaVersion: 1;
  platform: ExecutionPlatform;
  engine: ExecutionEngine;
  reset: {
    /** 当前实现可确定的模式；完整 fresh 计划仍待接入。 */
    mode: "app-internal-reset" | "reuse";
    entryConfigured: boolean;
  };
  data: {
    policy: "per-platform";
    aliases: string[];
  };
  /** 当前显式不设 token 预算（用户决定）；字段保留供后续计划接入。 */
  budget: null;
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
}): ExecutionPlanView {
  const env = input.env ?? process.env;
  const entry =
    input.platform === "ios"
      ? (env.AOS_IOS_RESET_URL ?? "").trim()
      : (env.AOS_ANDROID_RESET_URL ?? "").trim();
  return {
    schemaVersion: 1,
    platform: input.platform,
    engine: input.engine,
    reset: {
      mode: entry === "" ? "reuse" : "app-internal-reset",
      entryConfigured: entry !== ""
    },
    data: {
      policy: "per-platform",
      aliases: [...input.aliases]
    },
    budget: null,
    evidence: {
      steps: true,
      screenshots: false
    }
  };
}

export interface ExecutionParityRecord {
  caseId: string;
  platform: ExecutionPlatform;
  status: SuiteCaseResult["status"];
  plan: ExecutionPlanView | null;
  stepsAvailable: boolean;
}

export interface ExecutionParityResult {
  caseId: string;
  comparable: boolean;
  reasons: string[];
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
      if (plans.some((entry) => entry.plan.data.policy !== first.data.policy)) {
        reasons.push("data-policy-mismatch");
      }
      if (plans.some((entry) => JSON.stringify(entry.plan.data.aliases) !== JSON.stringify(first.data.aliases))) {
        reasons.push("data-aliases-mismatch");
      }
      if (plans.some((entry) => entry.plan.budget !== first.budget)) reasons.push("budget-mismatch");
    }
    if (entries.some((entry) => !entry.stepsAvailable)) reasons.push("steps-unavailable");
    out.push({
      caseId,
      comparable: reasons.length === 0,
      reasons,
      platforms
    });
  }
  return out.sort((a, b) => a.caseId.localeCompare(b.caseId));
}
