/** UI verification is separate from functional pass/fail: a case can execute
 * its flow correctly while the rendered screen still differs from the design.
 * `unverified` is the honest default until a design contract + screenshot
 * comparison exists. */
export type UiVerificationStatus = "passed" | "failed" | "unverified" | "not-applicable";

export type UiSourceFormat = "png" | "jpeg" | "unknown";

export interface UiTextStyleSummary {
  textsTotal: number;
  checked: number;
  lighter: number;
  similar: number;
  heavier: number;
  highConfidenceHeavier: number;
  unverified: number;
  byReason: Record<string, number>;
}

export interface UiVerification {
  status: UiVerificationStatus;
  reason?: string;
  contractRef?: string;
  screenId?: string;
  sourceFormat?: UiSourceFormat;
  /** True only when the source is lossless PNG. */
  lossless?: boolean;
  detailThreshold?: number;
  regions?: number;
  evidence?: string[];
  /** 字重提示（report-only；不改变 UI 门禁）。 */
  textStyles?: UiTextStyleSummary;
  /** 本次用例的访问屏覆盖账本（requested/matched/compared/skipped/unmatched）。 */
  coverage?: UiCoverage;
}

export interface UiScreenRef {
  id: string;
  name: string;
}

export interface UiCoverage {
  requested: number;
  matched: number;
  compared: number;
  skipped: number;
  unmatched: number;
  comparedScreens: UiScreenRef[];
  skippedScreens: UiScreenRef[];
  unmatchedScreens: string[];
}

export interface UiCoverageSummary {
  /** 含 coverage 的用例数。 */
  cases: number;
  requested: number;
  matched: number;
  compared: number;
  skipped: number;
  unmatched: number;
  /** 去重后的屏幕（按 id/name 归一）。 */
  comparedScreens: UiScreenRef[];
  skippedScreens: UiScreenRef[];
  unmatchedScreens: string[];
  /** 契约屏总数与未被任何用例成功比对的契约屏。 */
  contractScreens: number;
  contractNotCompared: UiScreenRef[];
}

export interface UiSummary {
  passed: number;
  failed: number;
  unverified: number;
  notApplicable: number;
  /** 字重提示汇总（report-only）。 */
  textStyles?: UiTextStyleSummary;
}

export function normalizeUiTextStyles(value: unknown): UiTextStyleSummary | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const numberAt = (key: string): number | null =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : null;
  const textsTotal = numberAt("textsTotal") ?? numberAt("texts");
  if (textsTotal === null) return null;
  const byReason: Record<string, number> = {};
  if (record.byReason !== null && typeof record.byReason === "object" && !Array.isArray(record.byReason)) {
    for (const [reason, count] of Object.entries(record.byReason as Record<string, unknown>)) {
      if (typeof count === "number" && Number.isFinite(count)) byReason[reason] = count;
    }
  }
  return {
    textsTotal,
    checked: numberAt("checked") ?? 0,
    lighter: numberAt("lighter") ?? 0,
    similar: numberAt("similar") ?? 0,
    heavier: numberAt("heavier") ?? 0,
    highConfidenceHeavier: numberAt("highConfidenceHeavier") ?? 0,
    unverified: numberAt("unverified") ?? 0,
    byReason
  };
}

export function addUiTextStyles(
  current: UiTextStyleSummary | undefined,
  next: UiTextStyleSummary
): UiTextStyleSummary {
  if (current === undefined) {
    return { ...next, byReason: { ...next.byReason } };
  }
  const byReason = { ...current.byReason };
  for (const [reason, count] of Object.entries(next.byReason)) {
    byReason[reason] = (byReason[reason] ?? 0) + count;
  }
  return {
    textsTotal: current.textsTotal + next.textsTotal,
    checked: current.checked + next.checked,
    lighter: current.lighter + next.lighter,
    similar: current.similar + next.similar,
    heavier: current.heavier + next.heavier,
    highConfidenceHeavier: current.highConfidenceHeavier + next.highConfidenceHeavier,
    unverified: current.unverified + next.unverified,
    byReason
  };
}

export function unverifiedUi(reason: string): UiVerification {
  return { status: "unverified", reason };
}

/** A UI pass is only trustworthy from a lossless PNG source. JPEG screenshots
 * (Android artemis path) are report-only because compression artifacts can
 * both invent and hide detail differences. */
export function isUiPass(ui: UiVerification | undefined): boolean {
  return ui?.status === "passed" && ui.sourceFormat === "png" && ui.lossless === true;
}

export function summarizeUi(cases: Array<{ ui?: UiVerification }>): UiSummary {
  const summary: UiSummary = { passed: 0, failed: 0, unverified: 0, notApplicable: 0 };
  let textStyles: UiTextStyleSummary | undefined;
  for (const entry of cases) {
    const status = entry.ui?.status ?? "unverified";
    if (status === "passed") summary.passed += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "not-applicable") summary.notApplicable += 1;
    else summary.unverified += 1;
    if (entry.ui?.textStyles !== undefined) {
      textStyles = addUiTextStyles(textStyles, entry.ui.textStyles);
    }
  }
  if (textStyles !== undefined) summary.textStyles = textStyles;
  return summary;
}

function screenKey(screen: UiScreenRef): string {
  return screen.id !== "" ? `id:${screen.id}` : `name:${screen.name}`;
}

function uniqueScreens(screens: UiScreenRef[]): UiScreenRef[] {
  const seen = new Map<string, UiScreenRef>();
  for (const screen of screens) {
    const key = screenKey(screen);
    if (!seen.has(key)) seen.set(key, screen);
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** 汇总 UI 访问屏覆盖率（DESIGN §13.222）：请求/匹配/比对/跳过/未匹配，
 * 以及契约屏中未被任何用例成功比对的缺口；无 coverage 时返回 null（不伪造 0）。 */
export function summarizeUiCoverage(
  cases: Array<{ ui?: UiVerification }>,
  contractScreens: UiScreenRef[] = []
): UiCoverageSummary | null {
  const covered = cases.filter((entry) => entry.ui?.coverage !== undefined);
  if (covered.length === 0) return null;
  let requested = 0;
  let matched = 0;
  let compared = 0;
  let skipped = 0;
  let unmatched = 0;
  const comparedScreens: UiScreenRef[] = [];
  const skippedScreens: UiScreenRef[] = [];
  const unmatchedScreens: string[] = [];
  for (const entry of covered) {
    const coverage = entry.ui!.coverage!;
    requested += coverage.requested;
    matched += coverage.matched;
    compared += coverage.compared;
    skipped += coverage.skipped;
    unmatched += coverage.unmatched;
    comparedScreens.push(...coverage.comparedScreens);
    skippedScreens.push(...coverage.skippedScreens);
    unmatchedScreens.push(...coverage.unmatchedScreens);
  }
  const uniqueCompared = uniqueScreens(comparedScreens);
  const comparedKeys = new Set(uniqueCompared.map(screenKey));
  const contractNotCompared = uniqueScreens(
    contractScreens.filter((screen) => !comparedKeys.has(screenKey(screen)))
  );
  return {
    cases: covered.length,
    requested,
    matched,
    compared,
    skipped,
    unmatched,
    comparedScreens: uniqueCompared,
    skippedScreens: uniqueScreens(skippedScreens),
    unmatchedScreens: [...new Set(unmatchedScreens)].sort((left, right) => left.localeCompare(right)),
    contractScreens: contractScreens.length,
    contractNotCompared
  };
}
