import { classifyExpectedResult, type Assertion, type AssertionDoc } from "./assertions.js";
import { isConcreteLabel, parseStep } from "./step-parse.js";
import type { NormalizedStep } from "./step-normalizer.js";
import type {
  ParsedSelector,
  ParsedStep,
  PreconditionMode,
  ScriptGenUnresolvedCode,
  ScriptPlatform
} from "./step-types.js";

export type { PreconditionMode, ScriptGenUnresolvedCode, ScriptPlatform } from "./step-types.js";
export type { ParsedSelector, ParsedSelectorRelation, ParsedStep } from "./step-types.js";

export interface ScriptGenUnresolved {
  code: ScriptGenUnresolvedCode;
  step: number | null;
  detail: string;
}

export interface ScriptAssertionRef {
  step: number;
  type: "visible" | "notVisible";
  originalText: string;
}

export interface ScriptGenCaseInput {
  caseId: string;
  steps: string[];
  expected?: string | null;
  preconditions?: string[];
  /** Precomputed assertion document (same classifier); omit to classify here. */
  assertionDoc?: AssertionDoc;
  /** Optional LLM-normalized actions; per-step fallback to raw parsing when absent. */
  normalizedSteps?: NormalizedStep[];
}

export interface ScriptGenOptions {
  appId: string;
  platform: ScriptPlatform;
  preconditionMode?: PreconditionMode;
  /** Reserved for the next phase; default false keeps soft text report-only. */
  includeSoftText?: boolean;
  /** Default false: `进入“X”` stays unresolved unless explicitly enabled. */
  inferNavigationTap?: boolean;
  /** Manual-document mode: unmapped steps become screenshots/manual markers instead of blocking the case. */
  bestEffort?: boolean;
}

export interface ScriptGenManualStep {
  step: number;
  code: ScriptGenUnresolvedCode;
  detail: string;
}

export interface ScriptGenResult {
  caseId: string;
  status: "ready" | "unresolved";
  yaml: string | null;
  assertions: number;
  assertionTexts: ScriptAssertionRef[];
  confidence: AssertionDoc["confidence"];
  unresolved: ScriptGenUnresolved[];
  warnings: string[];
  manualSteps: ScriptGenManualStep[];
  partial: boolean;
}

export interface GenerateScriptSetInput {
  appId: string;
  platform: ScriptPlatform;
  cases: ScriptGenCaseInput[];
  options?: Omit<ScriptGenOptions, "appId" | "platform">;
}

export interface GenerateScriptSetResult {
  cases: ScriptGenResult[];
  ready: number;
  partial: number;
  unresolved: number;
  runnable: number;
}

const ANDROID_APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_APP_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TRIVIAL_PRECONDITION = /^(?:无|無|none|n\/a|-|—|nil)$/i;

function truncate(text: string, max = 80): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function selectorLines(selector: ParsedSelector): string[] {
  const text = yamlScalar(escapeRegExp(selector.text));
  if (selector.relation === undefined) return [`- tapOn: ${text}`];
  return ["- tapOn:", `    ${selector.relation}: ${text}`];
}

function selectorMapLines(selector: ParsedSelector, indent: string): string[] {
  const text = yamlScalar(escapeRegExp(selector.text));
  if (selector.relation === undefined) return [`${indent}text: ${text}`];
  return [`${indent}${selector.relation}: ${text}`];
}

function manualScreenshotName(caseId: string, step: number): string {
  const safe = caseId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  return `aos-${safe === "" ? "case" : safe}-step-${step}`;
}

function manualCommentText(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
}

function compileNormalizedStep(step: NormalizedStep): ParsedStep[] {
  const out: ParsedStep[] = [];
  for (const action of step.actions) {
    switch (action.type) {
      case "launch":
        out.push({ kind: "launch" });
        break;
      case "tap":
        out.push({ kind: "tap", selector: action.target });
        break;
      case "input":
        out.push({ kind: "input", field: action.target, value: action.value });
        break;
      case "verify":
        out.push({
          kind: "verify",
          ...(action.target === undefined ? {} : { target: action.target })
        });
        break;
      case "scroll":
        out.push({
          kind: "scroll",
          ...(action.direction === undefined ? {} : { direction: action.direction })
        });
        break;
      case "back":
        out.push({ kind: "back" });
        break;
      case "wait":
        out.push({ kind: "wait" });
        break;
      case "manual":
        out.push({ kind: "unsupported", code: "step-unparsed", detail: action.reason });
        break;
    }
  }
  return out.length === 0
    ? [{ kind: "unsupported", code: "step-unparsed", detail: "llm-empty-actions" }]
    : out;
}

export function isValidAppId(appId: string, platform: ScriptPlatform): boolean {
  return validateAppId(appId.trim(), platform);
}

function validateAppId(appId: string, platform: ScriptPlatform): boolean {
  return (platform === "android" ? ANDROID_APP_ID : IOS_APP_ID).test(appId);
}

function meaningfulPreconditions(preconditions: string[] | undefined): string[] {
  return (preconditions ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !TRIVIAL_PRECONDITION.test(entry));
}

function isSafeAssertionText(value: string): boolean {
  return value.trim() !== "" && [...value].length <= 200 && !/[\r\n\t]/.test(value) && !value.includes("${");
}

function assertionText(assertion: Assertion): string | null {
  switch (assertion.type) {
    case "visible":
    case "notVisible":
    case "text":
      return assertion.text;
    default:
      return null;
  }
}

function assertionCommand(assertion: Assertion): { type: "visible" | "notVisible"; command: string } | null {
  if (assertion.type === "visible") return { type: "visible", command: "assertVisible" };
  if (assertion.type === "notVisible") return { type: "notVisible", command: "assertNotVisible" };
  return null;
}

function caseWarnings(doc: AssertionDoc): string[] {
  const warnings: string[] = [];
  for (const note of doc.manual) warnings.push(`assertion-manual:${note.step ?? "?"}`);
  for (const note of doc.ambiguous) warnings.push(`assertion-ambiguous:${note.step ?? "?"}`);
  return warnings;
}

export function generateFlow(input: ScriptGenCaseInput, options: ScriptGenOptions): ScriptGenResult {
  const caseId = input.caseId.trim();
  const bestEffort = options.bestEffort === true;
  const unresolved: ScriptGenUnresolved[] = [];
  const warnings: string[] = [];
  const manualSteps: ScriptGenManualStep[] = [];
  const doc =
    input.assertionDoc ??
    classifyExpectedResult({
      expected: input.expected ?? null,
      steps: input.steps,
      caseId
    });

  if (caseId === "") unresolved.push({ code: "empty-case-id", step: null, detail: "用例编号为空" });
  else if (/[\r\n\t]/.test(caseId) || [...caseId].length > 100) {
    unresolved.push({ code: "invalid-case-id", step: null, detail: truncate(caseId) });
  }
  const appId = options.appId.trim();
  if (appId === "") {
    unresolved.push({ code: "app-id-missing", step: null, detail: "缺少 appId（Android package / iOS bundle id）" });
  } else if (!validateAppId(appId, options.platform)) {
    unresolved.push({
      code: "app-id-invalid",
      step: null,
      detail: `appId 不符合 ${options.platform} 格式：${truncate(appId)}`
    });
  }

  const preconditions = meaningfulPreconditions(input.preconditions);
  const preconditionMode = options.preconditionMode ?? "strict";
  if (preconditions.length > 0) {
    if (preconditionMode === "strict") {
      unresolved.push({
        code: "precondition-unparsed",
        step: null,
        detail: truncate(preconditions.join("；"), 140)
      });
    } else {
      warnings.push(`precondition-assumed:${preconditions.length}`);
    }
  }

  if (input.steps.length === 0) {
    unresolved.push({ code: "empty-steps", step: null, detail: "没有测试步骤" });
  }

  const grouped = new Map<number, Array<{ assertion: Assertion; step: number }>>();
  for (const step of doc.steps) {
    if (step.step < 1 || step.step > input.steps.length) {
      if (bestEffort) {
        warnings.push(`assertion-step-out-of-range:${step.step}`);
      } else {
        unresolved.push({
          code: "assertion-step-out-of-range",
          step: step.step,
          detail: `断言步骤 ${step.step} 超出 ${input.steps.length} 个动作`
        });
      }
      continue;
    }
    for (const assertion of step.assert) {
      const list = grouped.get(step.step) ?? [];
      list.push({ assertion, step: step.step });
      grouped.set(step.step, list);
    }
  }

  warnings.push(...caseWarnings(doc));

  let lastLabel: string | null = null;
  const commands: string[] = [];
  const assertionTexts: ScriptAssertionRef[] = [];
  let assertions = 0;

  for (const [index, rawStep] of input.steps.entries()) {
    const stepNumber = index + 1;
    const normalized = input.normalizedSteps?.find((entry) => entry.step === stepNumber);
    const parsedSteps: ParsedStep[] =
      normalized === undefined
        ? [
            parseStep(rawStep, {
              ...(options.inferNavigationTap === undefined
                ? {}
                : { inferNavigationTap: options.inferNavigationTap }),
              getLastLabel: () => lastLabel,
              setLastLabel: (value) => {
                lastLabel = value;
              },
              pushWarning: (warning) => warnings.push(warning)
            })
          ]
        : compileNormalizedStep(normalized);
    for (const parsed of parsedSteps) {
      if (parsed.kind === "unsupported") {
        if (bestEffort) {
          manualSteps.push({ step: stepNumber, code: parsed.code, detail: parsed.detail });
          warnings.push(`step-manual:${stepNumber}:${parsed.code}`);
          commands.push(`# aos:manual step=${stepNumber} reason=${parsed.code}`);
          commands.push(`# aos:manual-text ${manualCommentText(rawStep)}`);
          commands.push(`- takeScreenshot: ${yamlScalar(manualScreenshotName(caseId, stepNumber))}`);
          continue;
        }
        unresolved.push({ code: parsed.code, step: stepNumber, detail: parsed.detail });
        continue;
      }
      switch (parsed.kind) {
        case "launch":
          break;
        case "tap":
          commands.push(...selectorLines(parsed.selector));
          lastLabel = parsed.selector.text;
          break;
        case "input":
          commands.push(...selectorLines(parsed.field));
          commands.push(`- inputText: ${yamlScalar(parsed.value)}`);
          lastLabel = parsed.field.text;
          break;
        case "scroll":
          commands.push(parsed.direction === "UP" ? "- swipe:\n    direction: UP" : "- scroll");
          break;
        case "scrollTo":
          commands.push("- scrollUntilVisible:");
          commands.push("    element:");
          commands.push(...selectorMapLines(parsed.selector, "      "));
          commands.push(`    direction: ${parsed.direction}`);
          break;
        case "back":
          commands.push("- back");
          break;
        case "wait":
          commands.push("- waitForAnimationToEnd");
          break;
        case "verify":
          break;
      }
    }

    for (const entry of grouped.get(stepNumber) ?? []) {
      const mapped = assertionCommand(entry.assertion);
      if (mapped === null) {
        if (entry.assertion.type === "text") {
          if (
            options.includeSoftText === true &&
            isConcreteLabel(entry.assertion.text) &&
            isSafeAssertionText(entry.assertion.text)
          ) {
            commands.push(`# aos:assertion step=${stepNumber} source=excel.expected type=text`);
            commands.push(`# aos:text ${entry.assertion.text}`);
            commands.push(`- assertVisible: ${yamlScalar(escapeRegExp(entry.assertion.text))}`);
            assertions += 1;
            assertionTexts.push({ step: stepNumber, type: "visible", originalText: entry.assertion.text });
          } else {
            warnings.push(`assertion-soft-text-skipped:${stepNumber}`);
          }
        } else if (entry.assertion.type === "manual") {
          warnings.push(`assertion-manual:${stepNumber}`);
        } else if (entry.assertion.type === "count" || entry.assertion.type === "calc") {
          warnings.push(`assertion-unsupported:${entry.assertion.type}:${stepNumber}`);
        }
        continue;
      }
      const original = assertionText(entry.assertion) ?? "";
      if (!isSafeAssertionText(original)) {
        if (bestEffort) {
          warnings.push(`assertion-text-invalid:${stepNumber}`);
        } else {
          unresolved.push({ code: "assertion-text-invalid", step: stepNumber, detail: truncate(original) });
        }
        continue;
      }
      commands.push(`# aos:assertion step=${stepNumber} source=excel.expected type=${mapped.type}`);
      commands.push(`# aos:text ${original}`);
      commands.push(`- ${mapped.command}: ${yamlScalar(escapeRegExp(original))}`);
      assertions += 1;
      assertionTexts.push({
        step: stepNumber,
        type: mapped.type,
        originalText: original
      });
    }
  }

  if (assertions === 0) warnings.push("unverified-expected");

  const status = unresolved.length === 0 ? "ready" : "unresolved";
  const partial = manualSteps.length > 0;
  if (status === "unresolved") {
    return {
      caseId,
      status,
      yaml: null,
      assertions,
      assertionTexts,
      confidence: doc.confidence,
      unresolved,
      warnings,
      manualSteps,
      partial
    };
  }

  const clearState = preconditions.length === 0;
  const lines = [
    `appId: ${yamlScalar(appId)}`,
    "tags:",
    `  - ${yamlScalar(caseId)}`,
    "---",
    "- launchApp:",
    `    clearState: ${clearState}`,
    ...(clearState ? [] : ["    stopApp: false"]),
    ...commands
  ];
  return {
    caseId,
    status,
    yaml: `${lines.join("\n")}\n`,
    assertions,
    assertionTexts,
    confidence: doc.confidence,
    unresolved,
    warnings,
    manualSteps,
    partial
  };
}

export function generateScriptSet(input: GenerateScriptSetInput): GenerateScriptSetResult {
  const cases = input.cases.map((entry) =>
    generateFlow(entry, {
      ...input.options,
      appId: input.appId,
      platform: input.platform
    })
  );
  const ready = cases.filter((entry) => entry.status === "ready" && !entry.partial).length;
  const partial = cases.filter((entry) => entry.status === "ready" && entry.partial).length;
  return {
    cases,
    ready,
    partial,
    unresolved: cases.filter((entry) => entry.status === "unresolved").length,
    runnable: ready + partial
  };
}
