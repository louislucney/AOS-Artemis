import { classifyExpectedResult, type Assertion, type AssertionDoc } from "./assertions.js";

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
}

export interface ScriptGenOptions {
  appId: string;
  platform: ScriptPlatform;
  preconditionMode?: PreconditionMode;
  /** Reserved for the next phase; default false keeps soft text report-only. */
  includeSoftText?: boolean;
  /** Default false: `进入“X”` stays unresolved unless explicitly enabled. */
  inferNavigationTap?: boolean;
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
  unresolved: number;
}

type ParsedStep =
  | { kind: "launch" }
  | { kind: "tap"; label: string }
  | { kind: "input"; field: string; value: string }
  | { kind: "scroll" }
  | { kind: "scrollTo"; label: string; direction: "DOWN" | "UP" }
  | { kind: "back" }
  | { kind: "wait" }
  | { kind: "verify" }
  | { kind: "unsupported"; code: ScriptGenUnresolvedCode; detail: string };

const ANDROID_APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_APP_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TRIVIAL_PRECONDITION = /^(?:无|無|none|n\/a|-|—|nil)$/i;
const NUMBER_PREFIX = /^\s*\d{1,4}\s*(?:[、)）]|[.．](?!\d))\s*/;
const TAP_VERB = /(点击|點擊|点选|點選|选择|選擇|取消|切换|切換|勾选|勾選)/;
const TAP_SINGLE_VERB = /^(選|选)\s+(.+)$/;
const INPUT_VERB = /(输入|輸入)/;
const VERIFY_VERB = /^(查看|檢查|检查|觀察|观察|確認|确认|驗證|验证|找到|是否|查看是否|檢查是否|检查是否)/;
const GENERIC_LABEL = /^(?:该|該|此|这个|這個|那个|那個|上述|对应|對應|其|其中|一个|一個|任意|下方|上方|这|那)$/;
const GENERIC_TARGET = /^(?:组件|組件|按钮|按鈕|项|項|图标|圖標|篩選項|筛选项|選項|选项)$/;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["【", "】"],
  ['"', '"'],
  ["'", "'"]
];

function truncate(text: string, max = 80): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function stripStepNumber(raw: string): string {
  return raw
    .replace(NUMBER_PREFIX, "")
    .replace(/[；;。]\s*$/, "")
    .trim();
}

function splitClauses(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let close: string | null = null;
  for (const char of text) {
    if (close !== null) {
      current += char;
      if (char === close) close = null;
      continue;
    }
    const pair = QUOTE_PAIRS.find(([open]) => open === char);
    if (pair !== undefined) {
      current += char;
      close = pair[1];
      continue;
    }
    if (char === "，" || char === "," || char === "；" || char === ";") {
      if (current.trim() !== "") out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

interface QuotedMatch {
  value: string;
  start: number;
  end: number;
}

function quotedMatches(text: string): QuotedMatch[] {
  const out: QuotedMatch[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const pair = QUOTE_PAIRS.find(([open]) => open === char);
    if (pair === undefined) continue;
    const close = text.indexOf(pair[1], index + 1);
    if (close <= index + 1) continue;
    const value = text.slice(index + 1, close).trim();
    if (value !== "") out.push({ value, start: index, end: close + 1 });
    index = close;
  }
  return out;
}

function extractQuoted(text: string): string[] {
  return quotedMatches(text).map((entry) => entry.value);
}

function isConcreteLabel(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const label = value.trim();
  if (label === "" || [...label].length < 2 || [...label].length > 30) return false;
  if (label.includes("${") || /[\r\n\t]/.test(label)) return false;
  if (/[。；;，,]/.test(label)) return false;
  if (GENERIC_LABEL.test(label) || GENERIC_TARGET.test(label)) return false;
  return true;
}

function isSymbolLabel(value: string): boolean {
  const label = value.trim();
  if (label === "") return false;
  return !/[\p{L}\p{N}]/u.test(label);
}

function normalizeTapLabel(raw: string): string {
  return raw
    .replace(/^(该|該|此|这个|這個|那个|那個|其中一個|其中一个|一个|一個|任意|下方|上方)/, "")
    .trim();
}

function isInputValue(value: string): boolean {
  return value.trim() !== "" && [...value].length <= 200 && !/[\r\n\t]/.test(value) && !value.includes("${");
}

function parseInput(text: string, inputClause: string): ParsedStep {
  const matches = quotedMatches(inputClause);
  const verbIndex = Math.max(inputClause.lastIndexOf("输入"), inputClause.lastIndexOf("輸入"));
  const startsWithAt = /^在/.test(inputClause);
  if (matches.length >= 2) {
    const first = matches[0]!;
    const second = matches[1]!;
    const field = startsWithAt ? first.value : second.value;
    const value = startsWithAt ? second.value : first.value;
    if (!isConcreteLabel(field)) {
      return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
    }
    if (!isInputValue(value)) {
      return { kind: "unsupported", code: "input-value-invalid", detail: truncate(text) };
    }
    return { kind: "input", field, value };
  }
  if (matches.length === 1 && verbIndex >= 0) {
    const match = matches[0]!;
    if (startsWithAt && match.end <= verbIndex) {
      const field = match.value;
      const value = inputClause.slice(verbIndex + 2).trim();
      if (!isConcreteLabel(field)) {
        return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
      }
      if (!isInputValue(value)) {
        return { kind: "unsupported", code: "input-value-invalid", detail: truncate(text) };
      }
      return { kind: "input", field, value };
    }
    if (startsWithAt && match.start >= verbIndex) {
      const field = inputClause.slice(1, verbIndex).trim();
      const value = match.value;
      if (!isConcreteLabel(field)) {
        return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
      }
      if (!isInputValue(value)) {
        return { kind: "unsupported", code: "input-value-invalid", detail: truncate(text) };
      }
      return { kind: "input", field, value };
    }
    if (!startsWithAt && /[到至]/.test(inputClause)) {
      const field = inputClause.slice(match.end).replace(/^[到至]\s*/, "").trim();
      const value = match.value;
      if (!isConcreteLabel(field)) {
        return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
      }
      if (!isInputValue(value)) {
        return { kind: "unsupported", code: "input-value-invalid", detail: truncate(text) };
      }
      return { kind: "input", field, value };
    }
  }
  return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
}

function parseStep(raw: string, options: ScriptGenOptions, getLastLabel: () => string | null, setLastLabel: (value: string) => void): ParsedStep {
  const text = stripStepNumber(raw);
  if (text === "") return { kind: "unsupported", code: "step-unparsed", detail: "空步骤" };
  if (/^(启动|啟動|打开|打開)\s*(?:App|APP|应用|應用)$/i.test(text)) return { kind: "launch" };
  if (/^(进入|進入)\s*(?:App|APP|应用|應用)\s*(?:首页|首頁)?$/i.test(text)) return { kind: "launch" };
  if (/^(扫描|掃描)/.test(text)) {
    return { kind: "unsupported", code: "scan-unsupported", detail: truncate(text) };
  }
  if (/^(如果|若|当|當|when\b|if\b)/i.test(text)) {
    return { kind: "unsupported", code: "conditional-unsupported", detail: truncate(text) };
  }
  if (/(筛选|篩選)/.test(text) && !TAP_VERB.test(text) && !INPUT_VERB.test(text)) {
    return { kind: "unsupported", code: "conditional-unsupported", detail: truncate(text) };
  }
  if (VERIFY_VERB.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (quoted !== undefined && isConcreteLabel(quoted)) setLastLabel(quoted);
    return { kind: "verify" };
  }
  if (/^(进入|進入)/.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (options.inferNavigationTap === true && quoted !== undefined && isConcreteLabel(quoted)) {
      setLastLabel(quoted);
      return { kind: "tap", label: quoted };
    }
    return { kind: "unsupported", code: "navigation-unparsed", detail: truncate(text) };
  }

  const single = TAP_SINGLE_VERB.exec(text);
  if (single) {
    const label = single[2]!.trim();
    if (isSymbolLabel(label)) {
      return { kind: "unsupported", code: "symbol-label", detail: truncate(label) };
    }
    if (!isConcreteLabel(label)) {
      return { kind: "unsupported", code: "ambiguous-text", detail: truncate(label) };
    }
    setLastLabel(label);
    return { kind: "tap", label };
  }

  const clauses = splitClauses(text);
  const tapClause = clauses.find((clause) => TAP_VERB.test(clause));
  if (tapClause !== undefined) {
    const quoted = extractQuoted(tapClause)[0];
    let label = quoted ?? normalizeTapLabel(tapClause.replace(/^.*?(?:点击|點擊|点选|點選|选择|選擇|選|取消|切换|切換|勾选|勾選)/, "").trim());
    if (GENERIC_TARGET.test(label)) {
      const previous = getLastLabel();
      if (previous !== null) label = previous;
    }
    if (isSymbolLabel(label)) {
      return { kind: "unsupported", code: "symbol-label", detail: truncate(label) };
    }
    if (!isConcreteLabel(label)) {
      return { kind: "unsupported", code: "ambiguous-text", detail: truncate(label || tapClause) };
    }
    setLastLabel(label);
    return { kind: "tap", label };
  }

  if (INPUT_VERB.test(text)) {
    const inputClause = clauses.find((clause) => INPUT_VERB.test(clause)) ?? text;
    const parsed = parseInput(text, inputClause);
    if (parsed.kind === "input") setLastLabel(parsed.field);
    return parsed;
  }

  if (/(滚动|滾動|滑動|滑动)/.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (quoted !== undefined && isConcreteLabel(quoted)) {
      setLastLabel(quoted);
      return { kind: "scrollTo", label: quoted, direction: /向上/.test(text) ? "UP" : "DOWN" };
    }
    if (/向下|下滑/.test(text)) return { kind: "scroll" };
    return { kind: "unsupported", code: "scroll-shape", detail: truncate(text) };
  }

  if (/^返回$/.test(text)) return { kind: "back" };
  if (/^等待/.test(text)) return { kind: "wait" };
  return { kind: "unsupported", code: "step-unparsed", detail: truncate(text) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateAppId(appId: string, platform: ScriptPlatform): boolean {
  return (platform === "android" ? ANDROID_APP_ID : IOS_APP_ID).test(appId);
}

function meaningfulPreconditions(preconditions: string[] | undefined): string[] {
  return (preconditions ?? []).map((entry) => entry.trim()).filter((entry) => entry !== "" && !TRIVIAL_PRECONDITION.test(entry));
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
  const unresolved: ScriptGenUnresolved[] = [];
  const warnings: string[] = [];
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
    unresolved.push({ code: "app-id-invalid", step: null, detail: `appId 不符合 ${options.platform} 格式：${truncate(appId)}` });
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
      unresolved.push({
        code: "assertion-step-out-of-range",
        step: step.step,
        detail: `断言步骤 ${step.step} 超出 ${input.steps.length} 个动作`
      });
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
    const parsed = parseStep(rawStep, options, () => lastLabel, (value) => {
      lastLabel = value;
    });
    if (parsed.kind === "unsupported") {
      unresolved.push({ code: parsed.code, step: stepNumber, detail: parsed.detail });
      continue;
    }
    switch (parsed.kind) {
      case "launch":
        break;
      case "tap":
        commands.push(`- tapOn: ${yamlScalar(escapeRegExp(parsed.label))}`);
        break;
      case "input":
        commands.push(`- tapOn: ${yamlScalar(escapeRegExp(parsed.field))}`);
        commands.push(`- inputText: ${yamlScalar(parsed.value)}`);
        break;
      case "scroll":
        commands.push("- scroll");
        break;
      case "scrollTo":
        commands.push("- scrollUntilVisible:");
        commands.push("    element:");
        commands.push(`      text: ${yamlScalar(escapeRegExp(parsed.label))}`);
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

    for (const entry of grouped.get(stepNumber) ?? []) {
      const mapped = assertionCommand(entry.assertion);
      if (mapped === null) {
        if (entry.assertion.type === "text") {
          if (options.includeSoftText === true && isConcreteLabel(entry.assertion.text) && isSafeAssertionText(entry.assertion.text)) {
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
        unresolved.push({ code: "assertion-text-invalid", step: stepNumber, detail: truncate(original) });
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
  if (status === "unresolved") {
    return {
      caseId,
      status,
      yaml: null,
      assertions,
      assertionTexts,
      confidence: doc.confidence,
      unresolved,
      warnings
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
    warnings
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
  return {
    cases,
    ready: cases.filter((entry) => entry.status === "ready").length,
    unresolved: cases.filter((entry) => entry.status === "unresolved").length
  };
}
