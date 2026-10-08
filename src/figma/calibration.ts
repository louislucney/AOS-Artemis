export type XcTestStatus = "passed" | "failed" | "skipped" | "unknown";

export interface XcTestCaseResult {
  name: string;
  status: XcTestStatus;
}

function normalizeStatus(value: unknown): XcTestStatus {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "passed" || normalized === "pass" || normalized === "success") return "passed";
  if (normalized === "failed" || normalized === "fail" || normalized === "failure") return "failed";
  if (normalized === "skipped" || normalized === "skip") return "skipped";
  return "unknown";
}

/** Tolerant parser for `xcrun xcresulttool get test-results tests` output and
 * simplified `{tests:[{name,status}]}` exports. Never throws on shape drift. */
export function parseXcResultTests(input: unknown): XcTestCaseResult[] {
  const results: XcTestCaseResult[] = [];
  const seen = new Set<string>();

  const push = (name: unknown, status: unknown): void => {
    if (typeof name !== "string" || name.trim() === "") return;
    const key = `${name}\u0000${String(status)}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ name: name.trim(), status: normalizeStatus(status) });
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.tests)) {
      for (const test of record.tests) {
        if (test && typeof test === "object") {
          const entry = test as Record<string, unknown>;
          push(entry.name, entry.status ?? entry.result ?? entry.testStatus);
        }
      }
    }
    const nodeType = typeof record.nodeType === "string" ? record.nodeType.toLowerCase() : "";
    if (nodeType.includes("test case")) {
      push(record.name, record.result ?? record.status);
    }
    for (const key of ["testNodes", "children", "subtests"]) {
      if (record[key] !== undefined) walk(record[key]);
    }
  };

  walk(input);
  return results;
}

export type McpOutcome = "passed" | "failed" | "pending" | "untested";
export type XcOutcome = "passed" | "failed" | "skipped" | "absent";
export type CalibrationVerdict =
  | "agreed-pass"
  | "agreed-fail"
  | "mcp-miss"
  | "mcp-false-alarm"
  | "mcp-pending"
  | "skipped"
  | "xctest-only"
  | "mcp-only"
  | "untested";

export interface CalibrationEntry {
  caseId: string;
  caseName: string;
  mcp: McpOutcome;
  xctest: XcOutcome;
  verdict: CalibrationVerdict;
  testName: string | null;
}

export interface CalibrationReport {
  generatedAt: string;
  xcSource: string;
  matched: number;
  mcpMiss: number;
  mcpFalseAlarm: number;
  agreedPass: number;
  agreedFail: number;
  /** mcpMiss / (agreedFail + mcpMiss); null when no true failures observed. */
  missRate: number | null;
  /** mcpFalseAlarm / (agreedPass + mcpFalseAlarm); null when no true passes observed. */
  falseAlarmRate: number | null;
  cases: CalibrationEntry[];
  unmatchedXcTests: string[];
}

/** Aligns XCTest results with the MCP ledger by case_id embedded in test names
 * (e.g. `test_order_flow_case-<12hex>()`); no case_id → unmatched, never guessed. */
export function buildCalibration(input: {
  cases: Array<{ id: string; name: string }>;
  mcpOutcomes: Map<string, Exclude<McpOutcome, "untested">>;
  xcTests: XcTestCaseResult[];
  generatedAt: string;
  xcSource: string;
}): CalibrationReport {
  const idsByLength = [...input.cases.map((entry) => entry.id)].sort(
    (a, b) => b.length - a.length
  );
  const caseNames = new Map(input.cases.map((entry) => [entry.id, entry.name]));

  const byCaseId = new Map<string, XcTestCaseResult>();
  const unmatchedXcTests: string[] = [];
  for (const test of input.xcTests) {
    const matched = idsByLength.find((id) => test.name.includes(id));
    if (matched) byCaseId.set(matched, test);
    else unmatchedXcTests.push(test.name);
  }

  const entries: CalibrationEntry[] = [];
  for (const testCase of input.cases) {
    const mcp: McpOutcome = input.mcpOutcomes.get(testCase.id) ?? "untested";
    const xc = byCaseId.get(testCase.id) ?? null;
    const xctest: XcOutcome = xc ? (xc.status === "unknown" ? "absent" : xc.status) : "absent";
    let verdict: CalibrationVerdict;
    if (xctest === "absent" && mcp === "untested") verdict = "untested";
    else if (xctest === "absent") verdict = "mcp-only";
    else if (mcp === "untested") verdict = "xctest-only";
    else if (xctest === "skipped") verdict = "skipped";
    else if (mcp === "pending") verdict = "mcp-pending";
    else if (xctest === "failed" && mcp === "passed") verdict = "mcp-miss";
    else if (xctest === "passed" && mcp === "failed") verdict = "mcp-false-alarm";
    else if (xctest === "passed" && mcp === "passed") verdict = "agreed-pass";
    else if (xctest === "failed" && mcp === "failed") verdict = "agreed-fail";
    else verdict = "untested";
    entries.push({
      caseId: testCase.id,
      caseName: caseNames.get(testCase.id) ?? testCase.id,
      mcp,
      xctest,
      verdict,
      testName: xc?.name ?? null
    });
  }

  const count = (verdict: CalibrationVerdict): number =>
    entries.filter((entry) => entry.verdict === verdict).length;
  const agreedPass = count("agreed-pass");
  const agreedFail = count("agreed-fail");
  const mcpMiss = count("mcp-miss");
  const mcpFalseAlarm = count("mcp-false-alarm");
  const matched = agreedPass + agreedFail + mcpMiss + mcpFalseAlarm;
  const trueFailures = agreedFail + mcpMiss;
  const truePasses = agreedPass + mcpFalseAlarm;
  return {
    generatedAt: input.generatedAt,
    xcSource: input.xcSource,
    matched,
    mcpMiss,
    mcpFalseAlarm,
    agreedPass,
    agreedFail,
    missRate: trueFailures > 0 ? mcpMiss / trueFailures : null,
    falseAlarmRate: truePasses > 0 ? mcpFalseAlarm / truePasses : null,
    cases: entries,
    unmatchedXcTests
  };
}
