import type {
  ParsedSelector,
  ParsedSelectorRelation,
  ParsedStep,
  ScriptGenUnresolvedCode,
  StepParseContext
} from "./step-types.js";

const NUMBER_PREFIX = /^\s*(?:\d{1,4}\s*(?:[、)）]|[.．](?!\d))|[-•*]\s+)\s*/;
const TAP_VERB =
  /(点击|點擊|点选|點選|选择|選擇|取消|切换|切換|勾选|勾選|點一下|点一下|輕觸|轻触|輕按|轻按|按下|按一下|點按|点按|選取|选取)/;
const TAP_SINGLE_VERB = /^(選|选)\s+(.+)$/;
const INPUT_VERB = /(输入|輸入|填寫|填写|鍵入|键入)/;
const VERIFY_VERB =
  /^(查看|檢查|检查|觀察|观察|確認|确认|驗證|验证|找到|是否|查看是否|檢查是否|检查是否|核對|核对|檢視|检视|瀏覽|浏览)/;
const NAV_VERB = /^(进入|進入|前往|轉到|转到)/;
const SCROLL_VERB = /(滚动|滾動|滑動|滑动)/;
const BACK_VERB = /^返回$/;
const WAIT_VERB = /^等待/;
const LAUNCH_VERB = /^(启动|啟動|打开|打開)\s*(?:App|APP|应用|應用)$/i;
const LAUNCH_NAV_VERB = /^(进入|進入)\s*(?:App|APP|应用|應用)\s*(?:首页|首頁)?$/i;

const EN_TAP = /\b(?:tap|click|press|select|choose|hit|touch)\b/i;
const EN_INPUT = /\b(?:input|enter|type|fill(?:\s+in)?|set)\b/i;
const EN_VERIFY = /^(?:verify|check|ensure|confirm|validate|see|find|observe|look\s+for)\b/i;
const EN_NAV = /^(?:go\s+to|navigate\s+to|open|visit|switch\s+to)\b/i;
const EN_SCROLL = /\b(?:scroll|swipe)\b/i;
const EN_BACK = /^(?:back|go\s+back|return)\b/i;
const EN_WAIT = /^(?:wait|pause)\b/i;
const EN_LAUNCH = /^(?:launch|start|open)\s+(?:the\s+)?app\b/i;
const EN_DEPENDS = /^(?:complete|run|do)\s+((?:TC_?)[A-Za-z0-9_-]+)\b/i;
const EN_RELATION =
  /\b(?:next\s+to|beside|to\s+the\s+right\s+of|right\s+of|to\s+the\s+left\s+of|left\s+of|below|under|beneath|above|over)\b/i;

const GENERIC_LABEL =
  /^(?:该|該|此|这个|這個|那个|那個|上述|对应|對應|其|其中|一个|一個|任意|下方|上方|这|那)$/;
const GENERIC_TARGET =
  /^(?:组件|組件|按钮|按鈕|项|項|图标|圖標|篩選項|筛选项|選項|选项)$/;
const GENERIC_TARGET_EN =
  /^(?:the|a|an|button|link|tab|field|option|item|icon|page|screen|box|area|textbox)$/i;

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
  let quoteClose: string | null = null;
  let parenDepth = 0;
  for (const char of text) {
    if (quoteClose !== null) {
      current += char;
      if (char === quoteClose) quoteClose = null;
      continue;
    }
    const pair = QUOTE_PAIRS.find(([open]) => open === char);
    if (pair !== undefined) {
      current += char;
      quoteClose = pair[1];
      continue;
    }
    if (char === "(" || char === "（") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "）") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (parenDepth === 0 && (char === "，" || char === "," || char === "；" || char === ";")) {
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

export function isConcreteLabel(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const label = value.trim();
  if (label === "" || [...label].length < 2 || [...label].length > 40) return false;
  if (label.includes("${") || /[\r\n\t]/.test(label)) return false;
  if (/[。；;，,]/.test(label)) return false;
  if (GENERIC_LABEL.test(label) || GENERIC_TARGET.test(label) || GENERIC_TARGET_EN.test(label)) {
    return false;
  }
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

function stripEnglishArticles(value: string): string {
  return value.replace(/^(?:the|a|an)\s+/i, "").trim();
}

function stripEnglishTargetNoun(value: string): string {
  return value
    .replace(/\s+(?:button|link|tab|field|option|item|icon|page|screen|box|area|textbox)$/i, "")
    .trim();
}

function isInputValue(value: string): boolean {
  return value.trim() !== "" && [...value].length <= 200 && !/[\r\n\t]/.test(value) && !value.includes("${");
}

function chineseVerbIndex(inputClause: string): number {
  return Math.max(
    inputClause.lastIndexOf("输入"),
    inputClause.lastIndexOf("輸入"),
    inputClause.lastIndexOf("填寫"),
    inputClause.lastIndexOf("填写"),
    inputClause.lastIndexOf("鍵入"),
    inputClause.lastIndexOf("键入")
  );
}

function parseChineseInput(text: string, inputClause: string): ParsedStep {
  const matches = quotedMatches(inputClause);
  const verbIndex = chineseVerbIndex(inputClause);
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
    return { kind: "input", field: { text: field }, value };
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
      return { kind: "input", field: { text: field }, value };
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
      return { kind: "input", field: { text: field }, value };
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
      return { kind: "input", field: { text: field }, value };
    }
  }
  return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
}

function englishInputField(clause: string, parenthetical: string): string {
  let raw = clause.replace(parenthetical, " ").replace(EN_INPUT, " ").trim();
  const inMatch = /\b(?:in|into|on|at)\b\s*(.+)$/i.exec(raw);
  if (inMatch) raw = inMatch[1]!.trim();
  raw = raw
    .replace(/\b(?:invalid|incorrect|valid|wrong|correct)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripEnglishTargetNoun(stripEnglishArticles(raw));
}

function englishInputValue(parenthetical: string, context: StepParseContext): string | null {
  if (parenthetical === "") return null;
  if (/-->|->|→/.test(parenthetical)) {
    const value = parenthetical.split(/-->|->|→/).pop()?.trim() ?? "";
    if (value !== "") {
      context.pushWarning("input-value-example");
      return value;
    }
  }
  if (/\b(?:random|any)\b/i.test(parenthetical)) {
    context.pushWarning("input-value-generated");
    return "AOSINVALID0001";
  }
  const example = /\b(?:e\.g\.|eg\.|example)\s*[:：]?\s*(.+)$/i.exec(parenthetical);
  if (example) {
    context.pushWarning("input-value-example");
    return example[1]!.trim();
  }
  return parenthetical;
}

function parseEnglishInput(text: string, clause: string, context: StepParseContext): ParsedStep {
  const quotes = quotedMatches(clause);
  const parenthetical = /\(([^)]*)\)/.exec(clause);
  const parentheticalText = parenthetical?.[0] ?? "";
  let field: string | null = null;
  let value: string | null = null;

  if (quotes.length >= 2) {
    const first = quotes[0]!;
    const second = quotes[1]!;
    const before = clause.slice(0, first.start);
    const between = clause.slice(first.end, second.start);
    if (/\b(?:in|into|on|at)\b/i.test(before)) {
      field = first.value;
      value = second.value;
    } else if (/\b(?:with|as|:)\b/i.test(between)) {
      field = first.value;
      value = second.value;
    } else if (/\b(?:to|into|in|on|at)\b/i.test(between)) {
      field = second.value;
      value = first.value;
    } else {
      field = first.value;
      value = second.value;
    }
  } else if (quotes.length === 1) {
    const only = quotes[0]!;
    const before = clause.slice(0, only.start);
    const after = clause.slice(only.end);
    const afterPreposition = /\b(?:in|into|on|at)\b\s*(.+)$/i.exec(after);
    const afterConnector = /\b(?:with|as|:)\s*(.+)$/i.exec(after);
    if (afterPreposition) {
      field = afterPreposition[1]!.trim();
      value = only.value;
    } else if (afterConnector) {
      field = only.value;
      value = afterConnector[1]!.trim();
    } else if (/\b(?:in|into|on|at)\b\s*$/i.test(before)) {
      field = only.value;
      value = context.getLastLabel();
    } else {
      field = context.getLastLabel() ?? only.value;
      value = only.value;
    }
  } else if (parenthetical !== null) {
    field = englishInputField(clause, parentheticalText);
    value = englishInputValue(parentheticalText.slice(1, -1).trim(), context);
  } else {
    const inMatch = /\b(?:in|into|on|at)\b\s*(.+)$/i.exec(clause);
    const withMatch = /\b(?:with|as|:)\s*(.+)$/i.exec(clause);
    if (inMatch) {
      field = inMatch[1]!.trim();
      value = clause.slice(0, inMatch.index).replace(EN_INPUT, "").trim();
    } else if (withMatch) {
      field = clause.slice(0, withMatch.index).replace(EN_INPUT, "").trim();
      value = withMatch[1]!.trim();
    }
  }

  const normalizedField = field === null ? "" : stripEnglishTargetNoun(stripEnglishArticles(field));
  if (!isConcreteLabel(normalizedField)) {
    return { kind: "unsupported", code: "input-field-missing", detail: truncate(text) };
  }
  if (value === null || !isInputValue(value)) {
    return { kind: "unsupported", code: "input-value-invalid", detail: truncate(text) };
  }
  context.setLastLabel(normalizedField);
  return { kind: "input", field: { text: normalizedField }, value };
}

function detectEnglishRelation(text: string): { relation: ParsedSelectorRelation; inferred: boolean } | null {
  const lower = text.toLowerCase();
  if (/\b(?:next\s+to|beside)\b/.test(lower)) return { relation: "rightOf", inferred: true };
  if (/\b(?:to\s+the\s+right\s+of|right\s+of)\b/.test(lower)) return { relation: "rightOf", inferred: false };
  if (/\b(?:to\s+the\s+left\s+of|left\s+of)\b/.test(lower)) return { relation: "leftOf", inferred: false };
  if (/\b(?:below|under|beneath)\b/.test(lower)) return { relation: "below", inferred: false };
  if (/\b(?:above|over)\b/.test(lower)) return { relation: "above", inferred: false };
  return null;
}

function parseEnglishTap(text: string, clause: string, context: StepParseContext): ParsedStep {
  const relation = detectEnglishRelation(clause);
  const quoted = quotedMatches(clause)[0]?.value;
  let target = quoted ?? "";
  if (target === "") {
    const verb = EN_TAP.exec(clause);
    let rest = verb === null ? clause : clause.slice(verb.index + verb[0].length);
    const relationMatch = EN_RELATION.exec(rest);
    if (relationMatch !== null) {
      rest = rest.slice(relationMatch.index + relationMatch[0].length);
    }
    target = stripEnglishTargetNoun(stripEnglishArticles(rest.replace(/\s+/g, " ").trim()));
  }
  if (target === "" || /^(?:it|this|that)$/i.test(target)) target = context.getLastLabel() ?? "";
  if (target === "") {
    return { kind: "unsupported", code: "ambiguous-text", detail: truncate(text) };
  }
  if (isSymbolLabel(target)) {
    return { kind: "unsupported", code: "symbol-label", detail: truncate(target) };
  }
  if (!isConcreteLabel(target)) {
    return { kind: "unsupported", code: "ambiguous-text", detail: truncate(target) };
  }
  if (relation?.inferred === true) context.pushWarning(`relation-inferred:${relation.relation}`);
  context.setLastLabel(target);
  const selector: ParsedSelector = {
    text: target,
    ...(relation === null ? {} : { relation: relation.relation })
  };
  return { kind: "tap", selector };
}

function parseEnglishNavigation(text: string, context: StepParseContext): ParsedStep {
  const quoted = extractQuoted(text)[0];
  let target = quoted ?? text.replace(EN_NAV, "").trim();
  target = stripEnglishTargetNoun(stripEnglishArticles(target.replace(/\s+/g, " ").trim()));
  if (target !== "" && context.inferNavigationTap === true && isConcreteLabel(target)) {
    context.setLastLabel(target);
    return { kind: "tap", selector: { text: target } };
  }
  return { kind: "unsupported", code: "navigation-unparsed", detail: truncate(text) };
}

function unsupported(code: ScriptGenUnresolvedCode, detail: string): ParsedStep {
  return { kind: "unsupported", code, detail: truncate(detail) };
}

export function parseStep(raw: string, context: StepParseContext): ParsedStep {
  const text = stripStepNumber(raw);
  if (text === "") return { kind: "unsupported", code: "step-unparsed", detail: "空步骤" };

  if (LAUNCH_VERB.test(text) || LAUNCH_NAV_VERB.test(text) || EN_LAUNCH.test(text)) {
    return { kind: "launch" };
  }
  if (/^(扫描|掃描)/.test(text)) {
    return { kind: "unsupported", code: "scan-unsupported", detail: truncate(text) };
  }
  if (/^(如果|若|当|當|when\b|if\b)/i.test(text)) {
    return { kind: "unsupported", code: "conditional-unsupported", detail: truncate(text) };
  }
  if (/(筛选|篩選)/.test(text) && !TAP_VERB.test(text) && !INPUT_VERB.test(text)) {
    return { kind: "unsupported", code: "conditional-unsupported", detail: truncate(text) };
  }

  const dependency = EN_DEPENDS.exec(text);
  if (dependency !== null) {
    return { kind: "unsupported", code: "step-unparsed", detail: `depends-on:${dependency[1]}` };
  }

  if (VERIFY_VERB.test(text) || EN_VERIFY.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (quoted !== undefined && isConcreteLabel(quoted)) context.setLastLabel(quoted);
    return { kind: "verify" };
  }

  if (NAV_VERB.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (context.inferNavigationTap === true && quoted !== undefined && isConcreteLabel(quoted)) {
      context.setLastLabel(quoted);
      return { kind: "tap", selector: { text: quoted } };
    }
    return { kind: "unsupported", code: "navigation-unparsed", detail: truncate(text) };
  }
  if (EN_NAV.test(text)) {
    return parseEnglishNavigation(text, context);
  }

  const single = TAP_SINGLE_VERB.exec(text);
  if (single !== null) {
    const label = single[2]!.trim();
    if (isSymbolLabel(label)) return unsupported("symbol-label", label);
    if (!isConcreteLabel(label)) return unsupported("ambiguous-text", label);
    context.setLastLabel(label);
    return { kind: "tap", selector: { text: label } };
  }

  const clauses = splitClauses(text);
  const tapClause = clauses.find((clause) => TAP_VERB.test(clause) || EN_TAP.test(clause));
  if (tapClause !== undefined) {
    if (EN_TAP.test(tapClause) && !TAP_VERB.test(tapClause)) {
      return parseEnglishTap(text, tapClause, context);
    }
    const quoted = extractQuoted(tapClause)[0];
    let label =
      quoted ??
      normalizeTapLabel(
        tapClause
          .replace(
            /^.*?(?:点击|點擊|点选|點選|选择|選擇|選|取消|切换|切換|勾选|勾選|點一下|点一下|輕觸|轻触|輕按|轻按|按下|按一下|點按|点按|選取|选取)/,
            ""
          )
          .trim()
      );
    if (GENERIC_TARGET.test(label)) {
      const previous = context.getLastLabel();
      if (previous !== null) label = previous;
    }
    if (isSymbolLabel(label)) return unsupported("symbol-label", label);
    if (!isConcreteLabel(label)) return unsupported("ambiguous-text", label || tapClause);
    context.setLastLabel(label);
    return { kind: "tap", selector: { text: label } };
  }

  if (INPUT_VERB.test(text) || EN_INPUT.test(text)) {
    const inputClause = clauses.find((clause) => INPUT_VERB.test(clause) || EN_INPUT.test(clause)) ?? text;
    const parsed =
      EN_INPUT.test(inputClause) && !INPUT_VERB.test(inputClause)
        ? parseEnglishInput(text, inputClause, context)
        : parseChineseInput(text, inputClause);
    return parsed;
  }

  if (SCROLL_VERB.test(text) || EN_SCROLL.test(text)) {
    const quoted = extractQuoted(text)[0];
    if (quoted !== undefined && isConcreteLabel(quoted)) {
      context.setLastLabel(quoted);
      const direction = /向上|\bup\b/i.test(text) ? "UP" : "DOWN";
      return { kind: "scrollTo", selector: { text: quoted }, direction };
    }
    const direction = /向上|\bup\b/i.test(text) ? "UP" : "DOWN";
    return { kind: "scroll", direction };
  }

  if (BACK_VERB.test(text) || EN_BACK.test(text)) return { kind: "back" };
  if (WAIT_VERB.test(text) || EN_WAIT.test(text)) return { kind: "wait" };
  return { kind: "unsupported", code: "step-unparsed", detail: truncate(text) };
}
