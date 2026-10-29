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
  kind: "quote" | "bracket";
}

interface FieldList {
  labels: string[];
}

interface ClauseOutcome {
  assertions: Assertion[];
  soft: boolean;
  manual: string | null;
  unresolved: boolean;
}

const NUMBER_PREFIX = /^(\d{1,4})\s*[.、)）．]\s*/;
const ROMAN_PREFIX = /^(?:i{1,3}|iv|vi{0,3}|v|ix|x)[.、)）]\s*/i;
const LETTER_PREFIX = /^[a-z][.、)）]\s*/i;
const BULLET_PREFIX = /^(?:[•·▪◦*]|[-–—]\s+)\s*/;
const CONTEXT_PREFIX =
  /^(?:--|——|备注\s*[:：]?|備註\s*[:：]?|【备注】|【備註】|注\s*[:：]|note\b\s*[:：]?)\s*/i;

const NEGATIVE =
  /不(?!同|仅|僅|但|过|過|断|斷|少|久|符|变|變|停|只)|沒(?:有)?|没(?:有)?|未有|未(?:顯示|显示|出現|出现|加載|加载|返回|生效|完成|成功|存在|找到|彈出|弹出|支持|見|见)|消失|隱藏|隐藏|不可見|不可见|不能|\b(?:not|no|never|hidden|absent)\b|\b\w+n't\b|\bdisappear(?:s|ed|ing)?\b/i;

const MANUAL =
  /后台|後台|排序|最近|上次|GPS|刷新|配置|积分余额|積分餘額|至少|(?<![不未沒没])存在|資料|数据|數據|\bbackend\b|\bserver(?:-side)?\b|\bsort(?:ed|s|ing)?\b|\border(?:s|ed)?\b|\blast\b|\blatest\b|\brefresh(?:ed|es|ing)?\b|\bconfig(?:uration|ure)?\b|\bbalance\b|\bat least\b|\bexists?\b|\bdata\b/i;

const COUNT_RE =
  /(最多可|最多為|最多为|最多|至多|上限為|上限为|上限|不超過|不超过)\s*(?:為|为|是|有|可|放|放入|儲存|储存|存入|存)?\s*(\d{1,6}|[零〇一二两兩三四五六七八九十百]{1,4})/;

const DISPLAY_VERBS = [
  "显示",
  "顯示",
  "展示",
  "出现",
  "出現",
  "呈现",
  "呈現",
  "弹出",
  "彈出",
  "跳转至",
  "跳轉至",
  "跳转到",
  "跳轉到",
  "提示",
  "可见",
  "可見"
];
const DISPLAY_VERB = new RegExp(DISPLAY_VERBS.join("|"));
const DISPLAY_VERB_ALL = new RegExp(DISPLAY_VERBS.join("|"), "g");
const FIELD_VERB_ALL = /显示|顯示|展示|包含|包括/g;
const LABEL_REJECT = /(?:並|并且|且|可|需|以及|并|則|则|才|再)/;
const LABEL_PROSE = /(?:載入中|加载中|^請稍候|^请稍候)/;
const LABEL_STATE = /已|^(?:表示|完成後|返回)|(?:正常|正確|正确|成功|失敗|失败|完成|更新|提交|刪除|新增)$/;
const LABEL_SHAPE = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff ._/&()#+-]*$/;
const ACTION_START =
  /^(?:點擊|点击|點選|点选|輸入|输入|選擇|选择|滑動|滑动|長按|长按|開啟|打开|操作|勾選|勾选|提交|展開|展开|收起|切換|切换|參閱|参阅|如圖|如图|見圖|见图|如下|詳情|详情|請稍候|请稍候)/;
const NAV_START = /^(?:返回|確認|确认)/;
const ANNOTATION_BRACKETS = new Set(["待確認", "待确认", "设计稿", "設計稿", "備註", "备注"]);
const CALC_HINT = /÷|向下取整|四捨五入|四舍五入|向上取整|除以|乘以|×|=/;
const CALC_STRONG_HINT = /÷|向下取整|四捨五入|四舍五入|向上取整|除以|乘以|×/;
const VAGUE =
  /^(?:功能正常|內容完整|内容完整|正確顯示|正确显示|數據正確|数据正确|資料正確|资料正确|正確|正确|正常)$/;
const NEGATIVE_LABEL_HEAD =
  /(?:沒有|沒|未|不)[^，,。；;\n]{0,6}(?:顯示|显示|出現|出现|呈現|呈现|彈出|弹出|加載|加载|返回|生效|完成|成功|支持|找到|存在)\s*$/;

const CURRENCY_RE = /-?(?:[A-Z]{1,3}\s*)?[$¥€£]\s*-?\d[\d,]*(?:\.\d+)?/g;
const UNIT_RE = /\d[\d,]*(?:\.\d+)?\s*(?:points?|pts?|S\s*Points?|%|秒|分鐘|分钟|積分|积分)/gi;
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

const SHORT_MAX = 30;
const QUOTE_GATE_MAX = 60;

function extractQuotes(text: string): QuoteHit[] {
  const hits: QuoteHit[] = [];
  const pattern =
    /“([^”]{1,200})”|"([^"\n]{1,200})"|「([^」]{1,200})」|『([^』]{1,200})』|‘([^’]{1,200})’|’([^‘]{1,200})‘|【([^】]{1,200})】/g;
  for (const match of text.matchAll(pattern)) {
    const captured = match.slice(1).find((value) => value !== undefined) ?? "";
    const value = captured.trim();
    if (value === "" || match.index === undefined) continue;
    hits.push({
      text: value,
      start: match.index,
      end: match.index + match[0].length,
      kind: match[0].startsWith("【") ? "bracket" : "quote"
    });
  }
  return hits;
}

function maskQuotes(text: string, hits: QuoteHit[]): string {
  let masked = "";
  let cursor = 0;
  for (const hit of hits) {
    masked += text.slice(cursor, hit.start) + "\u0000".repeat(hit.end - hit.start);
    cursor = hit.end;
  }
  return masked + text.slice(cursor);
}

function splitOutsideQuotes(text: string, separators: string): string[] {
  const hits = extractQuotes(text);
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (hits.some((hit) => index >= hit.start && index < hit.end)) continue;
    const char = text[index]!;
    if (!separators.includes(char)) continue;
    if (char === "," && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) {
      continue;
    }
    parts.push(text.slice(start, index));
    start = index + 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function splitFieldParts(text: string, allowComma: boolean): string[] {
  const hits = extractQuotes(text);
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (hits.some((hit) => index >= hit.start && index < hit.end)) continue;
    const char = text[index]!;
    const separator = char === "、" || (allowComma && (char === "," || char === "，"));
    if (!separator) continue;
    if (char === "," && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) {
      continue;
    }
    parts.push(text.slice(start, index).trim());
    start = index + 1;
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function chineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "零" || raw === "〇") return 0;
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
  const hundred = raw.match(/^([一二两兩三四五六七八九])百(.*)$/);
  if (hundred) {
    const rest = chineseNumber(hundred[2]!) ?? 0;
    return digits[hundred[1]!]! * 100 + rest;
  }
  const ten = raw.match(/^([一二两兩三四五六七八九])?十([一二三四五六七八九])?$/);
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

function stripRounding(raw: string): string {
  return raw.replace(/向下取整|四捨五入|四舍五入|向上取整/g, " ");
}

function roundingMode(text: string): "floor" | "ceil" | "round" | null {
  if (/四捨五入|四舍五入/.test(text)) return "round";
  if (/向上取整/.test(text)) return "ceil";
  if (/向下取整/.test(text)) return "floor";
  return null;
}

function normalizeExpression(raw: string): string | null {
  let expression = stripRounding(raw)
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
  const mode = roundingMode(normalized);

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
    expected =
      mode === "floor"
        ? Math.floor(computed)
        : mode === "ceil"
          ? Math.ceil(computed)
          : mode === "round"
            ? Math.round(computed)
            : computed;
  }
  return { expression, expected };
}

function extractFieldList(clause: string): FieldList | null {
  const quotes = extractQuotes(clause);
  const masked = maskQuotes(clause, quotes);
  const matches = [...masked.matchAll(FIELD_VERB_ALL)];
  const last = matches.at(-1);
  if (last === undefined || last.index === undefined) return null;
  const allowComma = last[0] === "包含" || last[0] === "包括";
  const start = last.index + last[0].length;
  let rest = clause.slice(start).trim();
  rest = rest
    .replace(/^[\s：:]+/, "")
    .replace(/[\s。；;]+$/g, "")
    .trim()
    .replace(/等(?:字段|欄位)?$/g, "")
    .trim();
  if (!rest.includes("、") && !(allowComma && /[,，]/.test(rest))) return null;
  const parts = splitFieldParts(rest, allowComma);
  if (parts.some((part) => part === "")) return null;
  const labels: string[] = [];
  for (const part of parts) {
    const raw = part.replace(/^[\s：:]+/, "");
    if (raw === "") return null;
    if (/^[)）(（]$/.test(raw)) continue;
    if (/^[)）(（]/.test(raw) || !/[A-Za-z0-9\u4e00-\u9fff]/.test(raw)) return null;
    if (/[。；;，,：:！!?？]$/.test(raw)) return null;
    if (LABEL_STATE.test(raw)) return null;
    if (VAGUE.test(raw)) continue;
    if (LABEL_PROSE.test(raw)) return null;
    if (raw.replace(/\s+/g, "").length > 24) return null;
    if (LABEL_REJECT.test(raw)) return null;
    if (!LABEL_SHAPE.test(raw)) return null;
    if (/[“”"'‘’「」『』【】]/.test(raw)) return null;
    labels.push(raw);
  }
  if (labels.length < 2) return null;
  return { labels };
}

function displayLabel(masked: string): { label: string; negative: boolean } | null {
  const matches = [...masked.matchAll(DISPLAY_VERB_ALL)];
  const last = matches.at(-1);
  if (last === undefined || last.index === undefined) return null;
  const head = masked.slice(0, last.index + last[0].length);
  let label = masked.slice(last.index + last[0].length);
  label = label.replace(/^[\s：:，,、]+/, "").replace(/[\s。；;]+$/g, "");
  label = label.replace(/(?:說明|说明)?(?:彈窗|弹窗)$/, "");
  label = label.replace(/(?:頁面|页面|視窗|视窗)$/, "").trim();
  if ([...label].length > 2) label = label.replace(/^(?:在|於|于)/, "").trim();
  label = label.replace(/等$/, "").trim();
  if (label === "" || VAGUE.test(label)) return null;
  if (/^[)）(（]/.test(label) || !/[A-Za-z0-9\u4e00-\u9fff]/.test(label)) return null;
  if ([...label].length > 30) return null;
  if (label.includes("\u0000") || label.includes("、")) return null;
  if (/[：:\d]|[$¥€£]/.test(label)) return null;
  if (/且|並且|并且|並|并|以及|不|沒|未/.test(label)) return null;
  return { label, negative: NEGATIVE_LABEL_HEAD.test(head) };
}

function isDateOrStepLike(text: string, start: number, end: number): boolean {
  const token = text.slice(start, end);
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 4);
  if (/第\s*$/.test(before)) return true;
  if (/^\s*(?:步|步驟|步骤)/.test(after)) return true;
  if (/[-/.]\d/.test(after)) return true;
  if (/\d[-/.]$/.test(before)) return true;
  if (/:\s*$/.test(before)) return true;
  if (/^\s*:\d{2}/.test(after)) return true;
  if (/^\s*(?:年|月|日|號|号)/.test(after) && token.length <= 4) return true;
  return false;
}

function extractValueTokens(text: string): string[] {
  const found: Array<{ text: string; start: number; end: number }> = [];
  const add = (start: number, end: number): void => {
    const value = text.slice(start, end).trim();
    if (value !== "") found.push({ text: value, start, end });
  };
  for (const match of text.matchAll(CURRENCY_RE)) {
    if (match.index !== undefined) add(match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(UNIT_RE)) {
    if (match.index !== undefined) add(match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(NUMBER_RE)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (found.some((item) => start < item.end && end > item.start)) continue;
    if (isDateOrStepLike(text, start, end)) continue;
    add(start, end);
  }
  found.sort((left, right) => left.start - right.start);
  const values: string[] = [];
  for (const item of found) {
    if (!values.includes(item.text)) values.push(item.text);
  }
  return values;
}

function shortSegment(text: string): string | null {
  let trimmed = text.trim().replace(/[\s。.!！；;]+$/g, "");
  trimmed = trimmed.replace(/^(?:且|並且|并且|並|并|以及|及|然後|然后)\s*/, "");
  const stripped = trimmed
    .replace(
      /^(?:頁面|页面|界面|彈窗|弹窗|應用|应用|app)?(?:上)?(?:顯示|显示|展示|出現|出现|呈現|呈现|提示|彈出|弹出|可見|可见|跳轉到|跳转到|跳轉至|跳转至)(?:了|：|:)?\s*/i,
      ""
    )
    .trim();
  if (stripped === "" || VAGUE.test(stripped)) return null;
  if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(stripped)) return null;
  if ([...stripped].length > 30) return null;
  if (/[?？]/.test(stripped)) return null;
  if (/\d{4}\s*[-/年]\s*\d{1,2}|\d{1,2}\s*[-/:]\s*\d{1,2}/.test(stripped)) return null;
  if (/第\s*\d+\s*步/.test(stripped)) return null;
  return stripped;
}

function manualReason(text: string): string {
  if (MANUAL.test(text)) return "依赖后台/数据状态，无法自动断言";
  if (CALC_STRONG_HINT.test(text)) return "计算式无法解析";
  return "长句无法确定可验证文本";
}

function pushAssertion(list: Assertion[], assertion: Assertion): boolean {
  if (list.some((existing) => JSON.stringify(existing) === JSON.stringify(assertion))) return false;
  list.push(assertion);
  return true;
}

function isAnnotationQuote(hit: QuoteHit): boolean {
  return hit.kind === "bracket" && ANNOTATION_BRACKETS.has(hit.text);
}

function quoteSegment(text: string, hit: QuoteHit): string {
  const masked = maskQuotes(text, extractQuotes(text));
  let start = 0;
  for (let index = 0; index <= masked.length; index += 1) {
    const char = masked[index];
    if (index !== masked.length && !/[，,。；;\n]/.test(char ?? "")) continue;
    if (hit.start >= start && hit.start < index) return masked.slice(start, index);
    start = index + 1;
  }
  return masked;
}

function quoteAssertions(text: string, quotes: QuoteHit[]): Assertion[] {
  const assertions: Assertion[] = [];
  for (const quote of quotes) {
    if (isAnnotationQuote(quote)) continue;
    const negative = NEGATIVE.test(quoteSegment(text, quote));
    pushAssertion(assertions, {
      type: negative ? "notVisible" : "visible",
      text: quote.text
    });
  }
  return assertions;
}

function startsWithValue(text: string): boolean {
  return (
    /^\s*-?(?:[A-Z]{1,3}\s*)?[$¥€£]?\s*-?\d/.test(text) || /^\s*\d/.test(text)
  );
}

function classifyClause(
  clause: string,
  statementHasDisplay: boolean,
  allowActionText: boolean,
  multiClause: boolean
): ClauseOutcome {
  const quotes = extractQuotes(clause);
  const masked = maskQuotes(clause, quotes);
  const negative = NEGATIVE.test(masked);
  if (MANUAL.test(masked)) {
    return { assertions: [], soft: false, manual: manualReason(masked), unresolved: false };
  }

  const field = extractFieldList(clause);
  if (field !== null) {
    const assertions: Assertion[] = field.labels.map((text) => ({
      type: negative ? "notVisible" : "visible",
      text
    }));
    for (const assertion of quoteAssertions(clause, quotes)) pushAssertion(assertions, assertion);
    return { assertions, soft: false, manual: null, unresolved: false };
  }

  if (CALC_HINT.test(masked)) {
    const calc = tryCalc(masked);
    if (calc !== null) {
      const assertions: Assertion[] = [{ type: "calc", ...calc }];
      for (const assertion of quoteAssertions(clause, quotes)) pushAssertion(assertions, assertion);
      return { assertions, soft: false, manual: null, unresolved: false };
    }
    if (CALC_STRONG_HINT.test(masked)) {
      return { assertions: [], soft: false, manual: null, unresolved: true };
    }
  }

  const count = tryCount(masked);
  if (count !== null) {
    const assertions: Assertion[] = [count];
    for (const assertion of quoteAssertions(clause, quotes)) pushAssertion(assertions, assertion);
    return { assertions, soft: false, manual: null, unresolved: false };
  }

  const assertions = quoteAssertions(clause, quotes);
  const hasDisplay = DISPLAY_VERB.test(masked);
  const hasCorrespond = /(?:對應|对应)/.test(masked);
  if (hasDisplay || (hasCorrespond && (statementHasDisplay || startsWithValue(masked)))) {
    for (const value of extractValueTokens(masked)) {
      pushAssertion(assertions, {
        type: negative ? "notVisible" : "visible",
        text: value
      });
    }
  }
  if (assertions.length > 0) {
    return { assertions, soft: false, manual: null, unresolved: false };
  }

  if (hasDisplay) {
    const display = displayLabel(masked);
    if (display !== null) {
      return {
        assertions: [
          {
            type: display.negative ? "notVisible" : "visible",
            text: display.label
          }
        ],
        soft: false,
        manual: null,
        unresolved: false
      };
    }
  }

  if (!hasDisplay) {
    const segment = shortSegment(clause);
    if (
      segment !== null &&
      (allowActionText || !ACTION_START.test(segment)) &&
      (!multiClause || !NAV_START.test(segment))
    ) {
      return {
        assertions: [{ type: "text", text: segment }],
        soft: true,
        manual: null,
        unresolved: false
      };
    }
  }
  return { assertions: [], soft: false, manual: null, unresolved: true };
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
  const physicalLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (physicalLines.length === 0) {
    doc.manual.push({ step: null, reason: "无预期", sourceText: "" });
    return doc;
  }
  const singleLine = physicalLines.length === 1;

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

  for (const line of physicalLines) {
    const statements = splitOutsideQuotes(line, "；;。");
    for (const statement of statements) {
      const sourceText = statement.trim();
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

      const withoutNumber = numbered ? sourceText.replace(NUMBER_PREFIX, "") : sourceText;
      const allowActionText =
        !numbered &&
        (ROMAN_PREFIX.test(withoutNumber) ||
          LETTER_PREFIX.test(withoutNumber) ||
          BULLET_PREFIX.test(withoutNumber));
      const withoutPrefix = numbered
        ? withoutNumber
        : withoutNumber
            .replace(ROMAN_PREFIX, "")
            .replace(LETTER_PREFIX, "")
            .replace(BULLET_PREFIX, "");
      const text = withoutPrefix.trim();
      if (text === "") continue;
      if (CONTEXT_PREFIX.test(text)) continue;
      if (/[:：]$/.test(text)) continue;

      let step = currentStep;
      if (step === null && singleLine && input.steps.length > 0) {
        step = input.steps.length;
        currentStep = step;
      }
      if (step === null) {
        doc.ambiguous.push({ step: null, reason: "缺少步骤编号，无法定位步骤", sourceText });
        continue;
      }

      const statementMasked = maskQuotes(text, extractQuotes(text));
      const statementHasDisplay = DISPLAY_VERB.test(statementMasked);
      const containsFieldList =
        /(?:包含|包括)/.test(statementMasked) && /[、,，]/.test(statementMasked);
      const clauses = containsFieldList ? [text] : splitOutsideQuotes(text, "，,");
      const longStatement = [...text].length > QUOTE_GATE_MAX;
      let gateBlocked = false;
      for (const clause of clauses) {
        const hits = extractQuotes(clause);
        if (hits.length === 0) continue;
        for (const hit of hits) {
          if (hit.kind === "bracket") continue;
          const segment = quoteSegment(clause, hit);
          if (NEGATIVE.test(segment)) continue;
          if (longStatement && !DISPLAY_VERB.test(segment)) gateBlocked = true;
        }
      }
      if (gateBlocked) {
        resolve(step, "长句无法确认引号文本是界面可见断言", sourceText);
        continue;
      }

      const multiClause = clauses.length > 1;
      const outcomes = clauses.map((clause) =>
        classifyClause(clause, statementHasDisplay, allowActionText, multiClause)
      );
      const manualOutcome = outcomes.find((outcome) => outcome.manual !== null);
      if (manualOutcome) {
        resolve(step, manualOutcome.manual!, sourceText);
        continue;
      }
      if (outcomes.every((outcome) => outcome.assertions.length === 0)) {
        const long = [...text].length > SHORT_MAX;
        resolve(step, long ? "长句无法确定可验证文本" : "无法确定可验证文本", sourceText);
        continue;
      }

      const list = byStep.get(step) ?? [];
      for (const outcome of outcomes) {
        for (const assertion of outcome.assertions) {
          if (!pushAssertion(list, assertion)) continue;
          if (outcome.soft) softCount += 1;
          else hardCount += 1;
        }
      }
      byStep.set(step, list);
    }
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
