import type { GeneratedTest, StepExpectation } from "./test-gen.js";

/** 用例展示层派生：Excel / Markdown / 汇总共用，避免两套渲染规则。 */
export interface CaseSummary {
  modules: string[];
  sections: string[];
  cases: number;
  withTestData: number;
  openQuestions: number;
  variantGroups: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function expectationHints(expectation: unknown): string[] {
  const record = asRecord(expectation);
  if (!record) return [];
  if (Array.isArray(record.hints)) {
    return record.hints.filter((hint): hint is string => typeof hint === "string" && hint.trim() !== "");
  }
  return typeof record.text === "string" && record.text.trim() !== "" ? [record.text] : [];
}

function expectationScreen(expectation: unknown): string | null {
  const record = asRecord(expectation);
  return record && typeof record.screen === "string" && record.screen.trim() !== ""
    ? record.screen
    : null;
}

function expectationKind(expectation: unknown): string | null {
  const record = asRecord(expectation);
  return record && typeof record.kind === "string" ? record.kind : null;
}

function displayScreen(testCase: GeneratedTest, screen: string | null): string | null {
  if (screen === null) return null;
  const index = testCase.screens.indexOf(screen);
  return index >= 0 ? (testCase.displayScreens?.[index] ?? screen) : screen;
}

export function expectedResultLines(testCase: GeneratedTest): string[] {
  const lines: string[] = [];
  for (let index = 0; index < (testCase.prelude ?? []).length; index += 1) {
    lines.push(`P${index + 1}) —（前导导航）`);
  }
  const expectations = testCase.expectations ?? [];
  testCase.steps.forEach((_step, index) => {
    const expectation = expectations[index];
    if (expectation === undefined) {
      lines.push(`${index + 1}) —（无显式期望）`);
      return;
    }
    if (expectationKind(expectation) === "explore") {
      lines.push(`${index + 1}) （探索，不判定）`);
      return;
    }
    const screen = displayScreen(testCase, expectationScreen(expectation));
    const hints = expectationHints(expectation).slice(0, 3);
    const source =
      (expectation as StepExpectation).hintsSource === "acceptance" ? "（验收口径）" : "";
    const head = screen !== null ? `→ ${screen}` : "";
    const tail = hints.length > 0 ? `${head !== "" ? "：" : ""}${hints.join("、")}` : "";
    lines.push(`${index + 1}) ${head}${tail || (head === "" ? "—" : "")}${source}`);
  });
  const variant = testCase.variant;
  if (variant) {
    for (const item of variant.expected ?? []) {
      const text = item.trim();
      if (text !== "") lines.push(`变体预期（${variant.label}）：${text}`);
    }
  }
  return lines;
}

export function testDataLines(testCase: GeneratedTest): string[] {
  return (testCase.testData ?? []).map((item) => `- ${item}`);
}

export function openQuestionLines(testCase: GeneratedTest): string[] {
  return (testCase.openQuestions ?? []).map((item) => `- ${item}`);
}

export function designRefLine(testCase: GeneratedTest): string {
  const refs = testCase.designRefs;
  if (refs && refs.screens.length > 0) {
    return refs.screens
      .map((screen, index) => {
        const nodeId = refs.nodeIds[index];
        return nodeId ? `${screen}(${nodeId})` : screen;
      })
      .join(" → ");
  }
  return (testCase.screens ?? []).length > 0 ? testCase.screens.join(" → ") : "—";
}

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = (value ?? "").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function summarizeCases(cases: GeneratedTest[]): CaseSummary {
  return {
    modules: unique(cases.map((testCase) => testCase.module ?? "未分组")),
    sections: unique(cases.map((testCase) => testCase.section ?? "未指定")),
    cases: cases.length,
    withTestData: cases.filter((testCase) => (testCase.testData ?? []).length > 0).length,
    openQuestions: cases.reduce((sum, testCase) => sum + (testCase.openQuestions ?? []).length, 0),
    variantGroups: unique(cases.map((testCase) => testCase.variant?.group)).length
  };
}
