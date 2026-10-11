import type { IosTaskStep } from "./types.js";

export interface StepRecordInput {
  step: number;
  thought: string;
  action: string;
  params: Record<string, unknown>;
  outcome: string;
  shot?: string;
  postShot?: string;
  screen?: string;
  scale?: number | null;
  noop?: boolean;
  scriptHits?: number[];
  perception: IosTaskStep["perception"];
}

/** 步骤记录组装（三个 push 点共用同一条件展开规则）。 */
export function toStepRecord(input: StepRecordInput): IosTaskStep {
  return {
    step: input.step,
    thought: input.thought,
    action: input.action,
    params: input.params,
    outcome: input.outcome,
    ...(input.shot ? { shot: input.shot } : {}),
    ...(input.postShot ? { postShot: input.postShot } : {}),
    ...(input.screen ? { screen: input.screen } : {}),
    ...(input.scale !== null && input.scale !== undefined ? { scale: input.scale } : {}),
    ...(input.noop ? { noop: true } : {}),
    ...(input.scriptHits && input.scriptHits.length > 0 ? { scriptHits: input.scriptHits } : {}),
    perception: input.perception
  };
}
