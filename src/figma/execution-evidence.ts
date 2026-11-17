import fs from "node:fs";

import type { ExecutionPlanView } from "./execution-plan.js";

export interface ExecutionEvidenceSummary {
  plan: ExecutionPlanView | null;
  stepsAvailable: boolean;
  resetOk: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 解析 `execution-evidence.json` 的安全视图；schema 不匹配时保留 reset/steps 可用性。 */
export function parseExecutionEvidence(payload: unknown): ExecutionEvidenceSummary {
  const record = asRecord(payload);
  if (record === null) {
    return { plan: null, stepsAvailable: false, resetOk: null };
  }
  const reset = asRecord(record.reset);
  const resetOk =
    reset === null ? null : reset.ok === true ? true : reset.ok === false ? false : null;
  const stepsAvailable = record.stepsAvailable === true;
  const plan = asRecord(record.plan);
  if (plan === null) return { plan: null, stepsAvailable, resetOk };
  const planReset = asRecord(plan.reset);
  const data = asRecord(plan.data);
  if (
    plan.schemaVersion === 1 &&
    (plan.platform === "ios" || plan.platform === "android") &&
    (plan.engine === "proxy" ||
      plan.engine === "ios-llm" ||
      plan.engine === "native-ios" ||
      plan.engine === "native-android") &&
    planReset !== null &&
    data !== null &&
    Array.isArray(data.aliases)
  ) {
    return {
      plan: plan as unknown as ExecutionPlanView,
      stepsAvailable,
      resetOk
    };
  }
  return { plan: null, stepsAvailable, resetOk };
}

/** 读取文件；不存在/不可解析返回 null，便于调用方继续尝试下一个候选路径。 */
export function readExecutionEvidence(file: string): ExecutionEvidenceSummary | null {
  try {
    return parseExecutionEvidence(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
