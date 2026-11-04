export type ScriptPlatform = "android" | "ios";
export type PreconditionMode = "strict" | "assume-prepared";

export type ScriptGenUnresolvedCode =
  | "empty-case-id"
  | "invalid-case-id"
  | "empty-steps"
  | "app-id-missing"
  | "app-id-invalid"
  | "precondition-unparsed"
  | "step-unparsed"
  | "input-field-missing"
  | "input-value-invalid"
  | "navigation-unparsed"
  | "ambiguous-text"
  | "symbol-label"
  | "scan-unsupported"
  | "conditional-unsupported"
  | "scroll-shape"
  | "assertion-step-out-of-range"
  | "assertion-text-invalid";

export type ParsedSelectorRelation = "rightOf" | "leftOf" | "below" | "above";

export interface ParsedSelector {
  text: string;
  relation?: ParsedSelectorRelation;
}

export type ParsedStep =
  | { kind: "launch" }
  | { kind: "tap"; selector: ParsedSelector }
  | { kind: "input"; field: ParsedSelector; value: string }
  | { kind: "scroll"; direction?: "UP" | "DOWN" }
  | { kind: "scrollTo"; selector: ParsedSelector; direction: "DOWN" | "UP" }
  | { kind: "back" }
  | { kind: "wait" }
  | { kind: "verify"; target?: ParsedSelector }
  | { kind: "unsupported"; code: ScriptGenUnresolvedCode; detail: string };

export interface StepParseContext {
  inferNavigationTap?: boolean;
  getLastLabel: () => string | null;
  setLastLabel: (value: string) => void;
  pushWarning: (warning: string) => void;
}
