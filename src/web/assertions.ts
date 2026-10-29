export type Assertion =
  | { type: "visible"; text: string }
  | { type: "notVisible"; text: string }
  | { type: "count"; max: number }
  | { type: "calc"; expression: string; expected: number }
  | { type: "text"; text: string }
  | { type: "manual"; reason: string };

export interface AssertionStep {
  step: number;
  assert: Assertion[];
}

export interface AssertionNote {
  step: number | null;
  reason: string;
  sourceText: string;
}

export interface AssertionDoc {
  version: 1;
  source: "excel.expected";
  confidence: "high" | "medium" | "low";
  steps: AssertionStep[];
  manual: AssertionNote[];
  ambiguous: AssertionNote[];
}

export interface ClassifyInput {
  expected: string | null;
  steps: string[];
  caseId: string;
}

interface QuoteHit {
  text: string;
  start: number;
  end: number;
}

const NUMBER_PREFIX = /^(\d{1,4})\s*[.、)）．]\s*/;
const ROMAN_PREFIX = /^(?:i{1,3}|iv|vi{0,3}|v|ix|x)[.、)）]\s*/i;
const LETTER_PREFIX = /^[a-z][.、)）]\s*/i;
const BULLET_PREFIX = /^(?:[•·▪◦*]|[-–—]\s+)\s*/;
const CONTEXT_PREFIX = /^(?:--|——|备注\s*[:：]?|【备注】|注\s*[:：]|note\b\s*[:：]?)\s*/i;

const NEGATIVE =
  /不(?!同|仅|但|过|断|少|久|符|变|停|只)|没(?:有)?|沒(?:有)?|未(?:显示|展示|出现|见|加载|返回|生效|完成|成功|存在|找到|弹出|支持)|消失|隐藏|不可见|不能|\b(?:not|no|never|hidden|absent)\b|\b\w+n't\b|\bdisappear(?:s|ed|ing)?\b/i;

const MANUAL =
  /后台|後台|排序|最近|上次|GPS|刷新|配置|积分余额|至少|存在|資料|数据|\bbackend\b|\bserver(?:-side)?\b|\bsort(?:ed|s|ing)?\b|\border(?:s|ed)?\b|\blast\b|\blatest\b|\brefresh(?:ed|es|ing)?\b|\bconfig(?:uration|ure)?\b|\bbalance\b|\bat least\b|\bexists?\b|\bdata\b/i;

const COUNT_RE =
  /(最多可|最多为|最多|至多|上限为|上限|不超过)\s*(?:为|是|有|可)?\s*(\d{1,6}|[一二两三四五六七八九十百]{1,4})/;

const CALC_HINT = /÷|向下取整|除以|乘以|×|=/;
const DISPLAY_VERB = /显示|展示|出现|跳转至|提示|呈现/;
const CLAUSE_SPLIT = /[，,。；;\n]/;

const SHORT_MAX = 30;
const QUOTE_GATE_MAX = 60;

function extractQuotes(text: string): QuoteHit[] {
  const hits: QuoteHit[] = [];
  const pattern = /“([^”]{1,200})”|"([^"\n]{1,200})"|「([^」]{1,200})」|『([^』]{1,200})』/g;
  for (const match of text.matchAll(pattern)) {
    const captured = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const value = captured.trim();
    if (value === "" || match.index === undefined) continue;
    hits.push({ text: value, start: match.index, end: match.index + match[0].length });
  }
  return hits;
}

function maskQuotes(text: string, hits: QuoteHit[]): string {
  let masked = "";
  let cursor = 0;
  for (const [index, hit] of hits.entries()) {
    masked += text.slice(cursor, hit.start) + `\u0000${index}\u0000`;
    cursor = hit.end;
  }
  return masked + text.slice(cursor);
}

function quoteClauses(text: string, hits: QuoteHit[]): string[] {
  const masked = maskQuotes(text, hits);
  const clauses = masked.split(CLAUSE_SPLIT);
  return hits.map((_, index) => {
    const token = `\u0000${index}\u0000`;
    return clauses.find((candidate) => candidate.includes(token)) ?? masked;
  });
}

function chineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    兩: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  if (raw === "十") return 10;
  if (raw === "百") return 100;
  const hundred = raw.match(/^([一二两三四五六七八九])百(.*)$/);
  if (hundred) {
    const rest = chineseNumber(hundred[2]!) ?? 0;
    return digits[hundred[1]!]! * 100 + rest;
  }
  const ten = raw.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (ten) {
    const high = ten[1] === undefined ? 1 : digits[ten[1]]!;
    const low = ten[2] === undefined ? 0 : digits[ten[2]]!;
    return high * 10 + low;
  }
  if (raw.length === 1 && digits[raw] !== undefined) return digits[raw];
  return null;
}

function tryCount(text: string): Assertion | null {
  const match = text.normalize("NFKC").match(COUNT_RE);
  if (!match) return null;
  const max = chineseNumber(match[2]!);
  if (max === null || max < 0) return null;
  return { type: "count", max };
}

function normalizeExpression(raw: string): string | null {
  let expression = raw
    .normalize("NFKC")
    .replace(/除以/g, "/")
    .replace(/乘以/g, "*")
    .replace(/÷/g, "/")
    .replace(/×/g, "*")
    .replace(/[−–—]/g, "-")
    .replace(/(\d),(?=\d{3})/g, "$1");
  expression = expression
    .replace(/\s*([+\-*/])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (expression === "" || !/\d/.test(expression) || !/[+\-*/]/.test(expression)) return null;
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) return null;
  let depth = 0;
  for (const char of expression) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return null;
  }
  if (depth !== 0) return null;
  return expression;
}

function lastNumber(raw: string): number | null {
  const normalized = raw.normalize("NFKC");
  const matches = [...normalized.matchAll(/(?:[$¥€£]\s*)?-?\d[\d,]*(?:\.\d+)?/g)];
  const last = matches.at(-1)?.[0];
  if (last === undefined) return null;
  const value = Number(last.replace(/[$¥€£,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function evaluateExpression(expression: string): number | null {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (tokens === null) return null;
  let index = 0;
  const parseFactor = (): number | null => {
    const token = tokens[index];
    if (token === undefined) return null;
    if (token === "(") {
      index += 1;
      const value = parseSum();
      if (value === null || tokens[index] !== ")") return null;
      index += 1;
      return value;
    }
    if (token === "-" || token === "+") {
      index += 1;
      const value = parseFactor();
      if (value === null) return null;
      return token === "-" ? -value : value;
    }
    const value = Number(token);
    if (!Number.isFinite(value)) return null;
    index += 1;
    return value;
  };
  const parseProduct = (): number | null => {
    let value = parseFactor();
    if (value === null) return null;
    while (tokens[index] === "*" || tokens[index] === "/") {
      const operator = tokens[index];
      index += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (operator === "/") {
        if (right === 0) return null;
        value /= right;
      } else {
        value *= right;
      }
    }
    return value;
  };
  const parseSum = (): number | null => {
    let value = parseProduct();
    if (value === null) return null;
    while (tokens[index] === "+" || tokens[index] === "-") {
      const operator = tokens[index];
      index += 1;
      const right = parseProduct();
      if (right === null) return null;
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = parseSum();
  if (result === null || index !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

function tryCalc(text: string): { expression: string; expected: number } | null {
  const normalized = text.normalize("NFKC");
  if (!CALC_HINT.test(normalized) || !/\d/.test(normalized)) return null;

  let expressionRaw = "";
  let expectedRaw = "";
  const equals = normalized.indexOf("=");
  if (equals > 0) {
    expressionRaw = normalized.slice(0, equals);
    expectedRaw = normalized.slice(equals + 1);
  } else {
    const groups = [...normalized.matchAll(/\(([^()]*)\)/g)];
    const parenthesized = groups.find((match) => /[÷/*×+-]/.test(match[1]!));
    if (parenthesized && parenthesized.index !== undefined) {
      expressionRaw = parenthesized[1]!;
      expectedRaw = normalized.slice(0, parenthesized.index);
    } else {
      const inline = normalized.match(/(\d[\d,.\s]*[÷/]\s*\d[\d,.\s]*)/);
      if (inline) {
        expressionRaw = inline[1]!;
        expectedRaw = normalized.replace(inline[1]!, " ");
      }
    }
  }

  const expression = normalizeExpression(expressionRaw);
  if (expression === null) return null;
  let expected = lastNumber(expectedRaw);
  if (expected === null) {
    const computed = evaluateExpression(expression);
    if (computed === null) return null;
    expected = /向下取整/.test(normalized) ? Math.floor(computed) : computed;
  }
  return { expression, expected };
}

function shortSegment(text: string): string | null {
  const trimmed = text.trim().replace(/[。.!！\s]+$/g, "");
  const stripped = trimmed.replace(
    /^(?:页面|界面|弹窗|应用|app)?(?:上)?(?:显示|展示|出现|呈现|提示|弹出|可见)(?:了|：|:)?\s*/i,
    ""
  );
  if (stripped === "") return null;
  if ([...stripped].length > 20) return null;
  if (/[?？]/.test(stripped)) return null;
  if (/[，,、；;]/.test(stripped) && [...stripped].length > 12) return null;
  return stripped;
}

function manualReason(text: string): string {
  if (MANUAL.test(text)) return "依赖后台/数据状态，无法自动断言";
  if (/向下取整|÷|计算|金额/.test(text)) return "计算式无法解析";
  return "长句无法确定可验证文本";
}

function pushAssertion(list: Assertion[], assertion: Assertion): void {
  if (list.some((existing) => JSON.stringify(existing) === JSON.stringify(assertion))) return;
  list.push(assertion);
}

export function classifyExpectedResult(input: ClassifyInput): AssertionDoc {
  const doc: AssertionDoc = {
    version: 1,
    source: "excel.expected",
    confidence: "low",
    steps: [],
    manual: [],
    ambiguous: []
  };

  const raw = input.expected ?? "";
  const lines = raw.split(/\r?\n/);
  if (lines.every((line) => line.trim() === "")) {
    doc.manual.push({ step: null, reason: "无预期", sourceText: "" });
    return doc;
  }

  const byStep = new Map<number, Assertion[]>();
  let currentStep: number | null = null;
  let hardCount = 0;
  let softCount = 0;

  const resolve = (step: number | null, reason: string, sourceText: string): void => {
    if (step === null) {
      doc.ambiguous.push({ step: null, reason, sourceText });
      return;
    }
    doc.manual.push({ step, reason, sourceText });
    const list = byStep.get(step) ?? [];
    pushAssertion(list, { type: "manual", reason });
    byStep.set(step, list);
  };

  for (const source of lines) {
    const sourceText = source.trim();
    if (sourceText === "") continue;

    const numbered = sourceText.match(NUMBER_PREFIX);
    if (numbered) {
      const step = Number(numbered[1]);
      if (Number.isInteger(step) && step >= 1) {
        if (step > input.steps.length) {
          currentStep = null;
          doc.ambiguous.push({
            step: null,
            reason: `步骤编号超出范围：${step}（共 ${input.steps.length} 步）`,
            sourceText
          });
          continue;
        }
        currentStep = step;
      }
    }

    if (CONTEXT_PREFIX.test(sourceText)) continue;

    const step = currentStep;
    const withoutNumber = numbered ? sourceText.replace(NUMBER_PREFIX, "") : sourceText;
    const withoutPrefix = numbered
      ? withoutNumber
      : withoutNumber.replace(ROMAN_PREFIX, "").replace(LETTER_PREFIX, "").replace(BULLET_PREFIX, "");
    const text = withoutPrefix.trim();
    if (text === "") continue;
    if (/[:：]$/.test(text)) continue;

    const quotes = extractQuotes(text);
    const masked = maskQuotes(text, quotes);
    const numeric: Assertion[] = [];

    const manual = MANUAL.test(masked);
    if (manual) {
      resolve(step, manualReason(masked), sourceText);
      continue;
    }

    if (CALC_HINT.test(masked)) {
      const calc = tryCalc(masked);
      if (calc !== null) {
        numeric.push({ type: "calc", ...calc });
      } else if (/÷|向下取整|除以|乘以|×/.test(masked)) {
        resolve(step, "计算式无法解析", sourceText);
        continue;
      }
    }

    const count = tryCount(masked);
    if (count !== null) numeric.push(count);

    if (numeric.length === 0 && quotes.length === 0) {
      if ([...text].length > SHORT_MAX) {
        resolve(step, "长句无法确定可验证文本", sourceText);
        continue;
      }
      const segment = shortSegment(text);
      if (segment === null) {
        resolve(step, "无法确定可验证文本", sourceText);
        continue;
      }
      if (step === null) {
        doc.ambiguous.push({ step: null, reason: "缺少步骤编号，无法定位步骤", sourceText });
        continue;
      }
      const list = byStep.get(step) ?? [];
      pushAssertion(list, { type: "text", text: segment });
      byStep.set(step, list);
      softCount += 1;
      continue;
    }

    const clauses = quotes.length > 0 ? quoteClauses(text, quotes) : [];
    const longLine = [...text].length > QUOTE_GATE_MAX;
    const blockedByGate = quotes.some((_, index) => {
      const clause = clauses[index]!;
      if (NEGATIVE.test(clause)) return false;
      return longLine && !DISPLAY_VERB.test(clause);
    });
    if (blockedByGate) {
      resolve(step, "长句无法确认引号文本是界面可见断言", sourceText);
      continue;
    }

    if (step === null) {
      doc.ambiguous.push({ step: null, reason: "缺少步骤编号，无法定位步骤", sourceText });
      continue;
    }

    const list = byStep.get(step) ?? [];
    for (const assertion of numeric) {
      pushAssertion(list, assertion);
      hardCount += 1;
    }
    for (const [index, quote] of quotes.entries()) {
      pushAssertion(
        list,
        NEGATIVE.test(clauses[index]!)
          ? { type: "notVisible", text: quote.text }
          : { type: "visible", text: quote.text }
      );
      hardCount += 1;
    }
    byStep.set(step, list);
  }

  doc.steps = [...byStep.entries()]
    .filter(([, assertions]) => assertions.length > 0)
    .sort(([left], [right]) => left - right)
    .map(([step, assert]) => ({ step, assert }));

  doc.confidence =
    hardCount > 0 && doc.manual.length === 0 && doc.ambiguous.length === 0 && softCount === 0
      ? "high"
      : hardCount > 0 || softCount > 0
        ? "medium"
        : "low";
  return doc;
}
