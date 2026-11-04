export interface SummaryCounts {
  passed: number;
  failed: number;
  inconclusive: number;
  unchecked: number;
}

function countOf(summary: Record<string, unknown>, key: string): number {
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 平台无关的 `test_summary` 判定：有失败 → FAIL；全通过且无未决 → PASS；否则不判 PASS。 */
export function summaryStatus(
  summary: Record<string, unknown> | null
): "PASS" | "FAIL" | "UNVERIFIED" {
  if (summary === null) return "UNVERIFIED";
  const counts: SummaryCounts = {
    passed: countOf(summary, "passed"),
    failed: countOf(summary, "failed"),
    inconclusive: countOf(summary, "inconclusive"),
    unchecked: countOf(summary, "unchecked")
  };
  if (counts.failed > 0) return "FAIL";
  if (counts.passed > 0 && counts.inconclusive === 0 && counts.unchecked === 0) return "PASS";
  return "UNVERIFIED";
}

export interface ExpectedTextCheck {
  anchored: boolean;
  passed: number;
  failed: number;
  texts: string[];
  missing: string[];
}

/** 从预期散文提取可做 L1 的文本锚点；无引号/无“显示/出现/包含” → 不产 L1。 */
export function extractExpectedTexts(expected: string | null | undefined): string[] {
  const text = (expected ?? "").trim();
  if (text === "") return [];
  const out: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length < 2 || out.includes(trimmed)) return;
    out.push(trimmed);
  };
  for (const match of text.matchAll(/[“"']([^”"']{2,}?)[”"']/g)) {
    push(match[1] ?? "");
  }
  for (const match of text.matchAll(
    /(?:显示|出现|包含|可见|should show|should display)\s*[「“"']?([^，。；\n」”"']+)/gi
  )) {
    push(match[1] ?? "");
  }
  return out;
}

/** L1：在原始 OCR/UI 文本中检查预期锚点；不过模型、不脱敏。 */
export function checkExpectedTexts(
  expected: string | null | undefined,
  labels: string[]
): ExpectedTextCheck {
  const texts = extractExpectedTexts(expected);
  if (texts.length === 0) {
    return { anchored: false, passed: 0, failed: 0, texts: [], missing: [] };
  }
  const haystack = labels.join("\n");
  const missing = texts.filter((text) => !haystack.includes(text));
  return {
    anchored: true,
    passed: texts.length - missing.length,
    failed: missing.length,
    texts,
    missing
  };
}
