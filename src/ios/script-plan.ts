import { isExploreKind, type StepKind } from "../provenance.js";

export interface IosScriptExpectation {
  index: number;
  screen: string | null;
  hints: string[];
  /** `explore` (deferred) steps are recorded but never gate adherence;
   * absent kind in the 【AOS-EXPECT】 payload = assert (legacy artifacts). */
  kind: StepKind;
}

export interface IosScriptPreflight {
  /** Screen the case expects the journey to start on. */
  screen: string;
  hints: string[];
  /** pending → matched/unmatched on first observation; unchecked when hints are empty. */
  status: "pending" | "matched" | "unmatched" | "unchecked";
  matchedAtStep: number | null;
}

export interface IosScriptPlan {
  /** Deterministic start-state check target (from the 【AOS-EXPECT】 block). */
  start: { screen: string; hints: string[] } | null;
  steps: IosScriptExpectation[];
}

export interface IosScriptAdherence {
  /** 可核对断言数（hints 非空，仅 assert 类）。 */
  checkable: number;
  /** 已命中（hints 全部在某个观测中出现）的可核对断言数。 */
  satisfied: number;
  /** 无 hints、无法确定性核对的断言数（仅 assert 类）。 */
  unchecked: number;
  /** 全程未出现过的可核对断言（仅 assert 类）。 */
  unresolved: Array<{ index: number; screen: string | null; hints: string[] }>;
  /** 探索（deferred）步骤：不参与门禁；`reached` 为目标屏名作为**完整可见标签**出现的条数。 */
  deferred: { total: number; reached: number };
}

const SCRIPT_EXPECT_MARKER = "【AOS-EXPECT】";

function scriptHintsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((hint): hint is string => typeof hint === "string" && hint.trim() !== "")
        .map((hint) => hint.trim())
    : [];
}

/** Parse the machine-readable plan block emitted by figma_generate_tests
 * (`【AOS-EXPECT】{"start":{screen,hints},"steps":[{index,screen,hints,kind?}]}`).
 * Returns null when the block is absent/invalid/empty. */
export function parseScriptPlan(taskDesc: string): IosScriptPlan | null {
  const line = taskDesc.split("\n").find((entry) => entry.includes(SCRIPT_EXPECT_MARKER));
  if (!line) return null;
  const raw = line.slice(line.indexOf(SCRIPT_EXPECT_MARKER) + SCRIPT_EXPECT_MARKER.length).trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let start: IosScriptPlan["start"] = null;
  const startRaw = record.start;
  if (startRaw && typeof startRaw === "object" && !Array.isArray(startRaw)) {
    const startRecord = startRaw as Record<string, unknown>;
    const screen =
      typeof startRecord.screen === "string" && startRecord.screen.trim() !== ""
        ? startRecord.screen.trim()
        : "";
    if (screen) start = { screen, hints: scriptHintsOf(startRecord.hints) };
  }
  const expectations: IosScriptExpectation[] = [];
  const steps = record.steps;
  if (Array.isArray(steps)) {
    for (const entry of steps) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const stepRecord = entry as Record<string, unknown>;
      const index =
        typeof stepRecord.index === "number" && Number.isFinite(stepRecord.index)
          ? Math.floor(stepRecord.index)
          : expectations.length + 1;
      const screen =
        typeof stepRecord.screen === "string" && stepRecord.screen.trim() !== ""
          ? stepRecord.screen.trim()
          : null;
      expectations.push({
        index,
        screen,
        hints: scriptHintsOf(stepRecord.hints),
        kind: isExploreKind(stepRecord.kind) ? "explore" : "assert"
      });
    }
  }
  if (!start && expectations.length === 0) return null;
  return { start, steps: expectations };
}

export const normalizeMatchText = (value: string): string => value.replace(/\s+/g, "");

export function matchScriptExpectations(
  expectations: IosScriptExpectation[],
  satisfied: Set<number>,
  screenText: string
): number[] {
  const normalized = normalizeMatchText(screenText);
  const labels = new Set(
    screenText
      .split(" | ")
      .map((part) => normalizeMatchText(part))
      .filter((part) => part !== "")
  );
  const hits: number[] = [];
  for (const expectation of expectations) {
    if (satisfied.has(expectation.index)) continue;
    const hintMatch =
      expectation.hints.length > 0 &&
      expectation.hints.every((hint) => normalized.includes(normalizeMatchText(hint)));
    // Exploration targets match only as a complete visible label (never as a
    // loose substring), so short screen names cannot fake `reached`.
    const screenMatch =
      expectation.kind === "explore" &&
      expectation.screen !== null &&
      labels.has(normalizeMatchText(expectation.screen));
    if (hintMatch || screenMatch) {
      satisfied.add(expectation.index);
      hits.push(expectation.index);
    }
  }
  return hits;
}

export function buildScriptAdherence(
  expectations: IosScriptExpectation[],
  satisfied: Set<number>
): IosScriptAdherence {
  const assertions = expectations.filter((expectation) => expectation.kind === "assert");
  const explorations = expectations.filter((expectation) => expectation.kind === "explore");
  const checkable = assertions.filter((expectation) => expectation.hints.length > 0);
  const unresolved = checkable
    .filter((expectation) => !satisfied.has(expectation.index))
    .map((expectation) => ({
      index: expectation.index,
      screen: expectation.screen,
      hints: expectation.hints
    }));
  return {
    checkable: checkable.length,
    satisfied: checkable.length - unresolved.length,
    unchecked: assertions.length - checkable.length,
    unresolved,
    deferred: {
      total: explorations.length,
      reached: explorations.filter((expectation) => satisfied.has(expectation.index)).length
    }
  };
}

export function formatUnresolvedScriptItems(items: IosScriptAdherence["unresolved"]): string {
  return items
    .map(
      (item) =>
        `步骤${item.index}${item.screen ? `（${item.screen}）` : ""} 预期「${item.hints.join("」「")}」`
    )
    .join("；");
}
