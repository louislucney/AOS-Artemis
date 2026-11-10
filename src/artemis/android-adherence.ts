import {
  buildScriptAdherence,
  matchScriptExpectations,
  normalizeMatchText,
  parseScriptPlan,
  type IosScriptAdherence
} from "../ios/script-plan.js";
import { readAndroidTraceObservations } from "./android-trace.js";

export interface AndroidScriptAdherenceResult {
  adherence: IosScriptAdherence;
  start: {
    screen: string;
    hints: string[];
    status: "matched" | "unmatched" | "unchecked";
  } | null;
  steps: number;
  /** null = checked; otherwise why the observation layer could not check. */
  degraded: string | null;
}

function labelsText(labels: string[]): string {
  return labels.join(" | ");
}

function mergedLabels(primary: string[], fallback: string[]): string[] {
  const out = new Set<string>();
  for (const value of [...primary, ...fallback]) {
    if (value.trim() !== "") out.add(value.trim());
  }
  return [...out];
}

/** Android runs are delegated to Artemis (no native step loop), so the
 * `【AOS-EXPECT】` hints are checked after the fact against per-step OCR labels
 * from `data_engine.db`. The matching semantics mirror iOS adherence: an
 * expectation is satisfied when all its hints appear together on one observed
 * screen; empty hints are counted as unchecked, never as passed. */
export async function computeAndroidScriptAdherence(input: {
  dbPath: string;
  traceId: string;
  taskDesc: string;
}): Promise<AndroidScriptAdherenceResult | null> {
  const plan = parseScriptPlan(input.taskDesc);
  if (plan === null) return null;
  const observations = await readAndroidTraceObservations(input.dbPath, input.traceId);
  if (observations === null) {
    return {
      adherence: buildScriptAdherence(plan.steps, new Set()),
      start:
        plan.start === null
          ? null
          : { ...plan.start, status: "unchecked" },
      steps: 0,
      degraded: "observations-unavailable"
    };
  }
  const satisfied = new Set<number>();
  const screens: string[][] = observations.steps.map((step, index) => {
    const post = mergedLabels(step.postLabels, step.postTreeLabels);
    if (post.length > 0) return post;
    const next = observations.steps[index + 1];
    return next === undefined
      ? []
      : mergedLabels(next.preLabels, next.preTreeLabels);
  });
  for (const labels of screens) {
    if (labels.length === 0) continue;
    matchScriptExpectations(plan.steps, satisfied, labelsText(labels));
  }
  let start: AndroidScriptAdherenceResult["start"] = null;
  if (plan.start !== null) {
    const firstLabels =
      observations.steps[0] === undefined
        ? []
        : mergedLabels(
            observations.steps[0].preLabels,
            observations.steps[0].preTreeLabels
          );
    const text = normalizeMatchText(labelsText(firstLabels));
    const status =
      plan.start.hints.length === 0
        ? "unchecked"
        : plan.start.hints.every((hint) =>
            text.includes(normalizeMatchText(hint))
          )
          ? "matched"
          : "unmatched";
    start = { ...plan.start, status };
  }
  return {
    adherence: buildScriptAdherence(plan.steps, satisfied),
    start,
    steps: observations.steps.length,
    degraded: screens.every((labels) => labels.length === 0) ? "no-ocr-labels" : null
  };
}
