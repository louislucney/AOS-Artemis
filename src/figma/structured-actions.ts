import type { StepKind } from "../provenance.js";

export type ActionEngine = "native" | "artemis" | "auto";

export type StructuredActionKind = "tap" | "type" | "back" | "swipe" | "wait";

export type StructuredTargetKind =
  | "resource-id"
  | "view-tag"
  | "content-desc"
  | "semantics-label"
  | "text"
  | "point";

export interface StructuredTarget {
  kind: StructuredTargetKind;
  value: string;
}

export interface StructuredActionInput {
  kind: "text" | "secretRef";
  text?: string;
  ref?: string;
}

export interface StructuredActionExpect {
  screen?: string;
  hints?: string[];
  absent?: string[];
  timeoutMs?: number;
}

export interface StructuredAction {
  stepIndex: number;
  action: StructuredActionKind;
  target?: StructuredTarget;
  fallbackTargets?: StructuredTarget[];
  input?: StructuredActionInput;
  expect?: StructuredActionExpect;
  timeoutMs?: number;
  optional?: boolean;
  /** secretRef 填写后回读校验（默认 true；密码类自动跳过）。 */
  verify?: boolean;
  /** 输入前清空已有文本；secretRef 默认 true，其他默认 false。 */
  clear?: boolean;
  /** 输入后收起键盘；默认 true（设备不支持时跳过）。 */
  hideKeyboard?: boolean;
}

export interface StructuredActionValidation {
  actions: StructuredAction[];
  errors: string[];
}

const ACTION_KINDS = new Set<StructuredActionKind>(["tap", "type", "back", "swipe", "wait"]);
const TARGET_KINDS = new Set<StructuredTargetKind>([
  "resource-id",
  "view-tag",
  "content-desc",
  "semantics-label",
  "text",
  "point"
]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function targetOf(value: unknown): StructuredTarget | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { kind?: unknown; value?: unknown };
  if (typeof record.kind !== "string" || !TARGET_KINDS.has(record.kind as StructuredTargetKind)) {
    return null;
  }
  if (typeof record.value !== "string" || record.value.trim() === "") return null;
  return {
    kind: record.kind as StructuredTargetKind,
    value: record.value.trim()
  };
}

function expectOf(value: unknown): StructuredActionExpect | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const out: StructuredActionExpect = {
    ...(typeof record.screen === "string" && record.screen.trim() !== ""
      ? { screen: record.screen.trim() }
      : {}),
    ...(Array.isArray(record.hints) ? { hints: stringArray(record.hints) } : {}),
    ...(Array.isArray(record.absent) ? { absent: stringArray(record.absent) } : {}),
    ...(typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs) &&
    record.timeoutMs > 0
      ? { timeoutMs: record.timeoutMs }
      : {})
  };
  return Object.keys(out).length > 0 ? out : null;
}

function inputOf(value: unknown): StructuredActionInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { kind?: unknown; text?: unknown; ref?: unknown };
  if (record.kind === "text" && typeof record.text === "string" && record.text !== "") {
    return { kind: "text", text: record.text };
  }
  if (record.kind === "secretRef" && typeof record.ref === "string" && record.ref.trim() !== "") {
    return { kind: "secretRef", ref: record.ref.trim() };
  }
  return null;
}

/** Parse + validate `actions[]` against the flow's step count. Invalid entries
 * are dropped and reported; never silently promoted to executable actions. */
export function validateStructuredActions(
  raw: unknown,
  stepCount: number
): StructuredActionValidation {
  const errors: string[] = [];
  if (!Array.isArray(raw)) {
    return { actions: [], errors: ["actions 不是数组"] };
  }
  const actions: StructuredAction[] = [];
  const seenSteps = new Set<number>();
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`actions[${index}] 不是对象`);
      return;
    }
    const record = entry as Record<string, unknown>;
    const stepIndex = record.stepIndex;
    if (
      typeof stepIndex !== "number" ||
      !Number.isInteger(stepIndex) ||
      stepIndex < 0 ||
      stepIndex >= stepCount
    ) {
      errors.push(`actions[${index}].stepIndex 越界或非法：${String(stepIndex)}`);
      return;
    }
    if (seenSteps.has(stepIndex)) {
      errors.push(`actions[${index}].stepIndex 重复：${stepIndex}`);
      return;
    }
    const action = record.action;
    if (typeof action !== "string" || !ACTION_KINDS.has(action as StructuredActionKind)) {
      errors.push(`actions[${index}].action 非法：${String(action)}`);
      return;
    }
    const target = targetOf(record.target);
    const fallbackTargets = Array.isArray(record.fallbackTargets)
      ? record.fallbackTargets.map(targetOf).filter((value): value is StructuredTarget => value !== null)
      : [];
    const input = inputOf(record.input);
    const expect = expectOf(record.expect);
    if (action === "tap" && target === null) {
      errors.push(`actions[${index}] tap 缺少有效 target`);
      return;
    }
    if (action === "type" && input === null) {
      errors.push(`actions[${index}] type 缺少有效 input（text/secretRef）`);
      return;
    }
    // secretRef 允许省略 target：执行期从 secret 资料的字段映射解析。
    if (action === "type" && target === null && input?.kind !== "secretRef") {
      errors.push(`actions[${index}] type(text) 缺少有效 target`);
      return;
    }
    const timeoutMs =
      typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs > 0
        ? record.timeoutMs
        : undefined;
    actions.push({
      stepIndex,
      action: action as StructuredActionKind,
      ...(target === null ? {} : { target }),
      ...(fallbackTargets.length === 0 ? {} : { fallbackTargets }),
      ...(input === null ? {} : { input }),
      ...(expect === null ? {} : { expect }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(record.optional === true ? { optional: true } : {}),
      ...(record.verify === false ? { verify: false } : {}),
      ...(record.clear === true ? { clear: true } : {}),
      ...(record.hideKeyboard === false ? { hideKeyboard: false } : {})
    });
    seenSteps.add(stepIndex);
  });
  return { actions, errors };
}

/** Missing actions for assert steps → not native-ready. Explore steps are not
 * required; callers should also reject native when explore steps exist. */
export function hasCompleteActions(
  actions: StructuredAction[],
  expectations: Array<{ kind?: StepKind }>
): boolean {
  const byStep = new Map(actions.map((action) => [action.stepIndex, action]));
  return expectations.every((expectation, index) => {
    if (expectation.kind === "explore") return true;
    const action = byStep.get(index);
    if (action === undefined) return false;
    return (
      action.expect !== undefined &&
      (action.expect.screen !== undefined ||
        (action.expect.hints?.length ?? 0) > 0 ||
        (action.expect.absent?.length ?? 0) > 0)
    );
  });
}

export function engineForActions(
  actions: StructuredAction[],
  expectations: Array<{ kind?: StepKind }>,
  options: { prelude?: boolean; continuation?: boolean } = {}
): { engine: ActionEngine; reason?: string } {
  if (options.prelude === true || options.continuation === true) {
    return { engine: "artemis", reason: "prelude-unsupported" };
  }
  if (expectations.some((expectation) => expectation.kind === "explore")) {
    return { engine: "artemis", reason: "explore-step" };
  }
  if (expectations.length === 0) {
    return { engine: "artemis", reason: "no-expectations" };
  }
  if (!hasCompleteActions(actions, expectations)) {
    return { engine: "artemis", reason: "actions-incomplete" };
  }
  return { engine: "native" };
}
