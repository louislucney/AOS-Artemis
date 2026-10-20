/** UI verification is separate from functional pass/fail: a case can execute
 * its flow correctly while the rendered screen still differs from the design.
 * `unverified` is the honest default until a design contract + screenshot
 * comparison exists. */
export type UiVerificationStatus = "passed" | "failed" | "unverified" | "not-applicable";

export type UiSourceFormat = "png" | "jpeg" | "unknown";

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
}

export interface UiSummary {
  passed: number;
  failed: number;
  unverified: number;
  notApplicable: number;
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
  for (const entry of cases) {
    const status = entry.ui?.status ?? "unverified";
    if (status === "passed") summary.passed += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "not-applicable") summary.notApplicable += 1;
    else summary.unverified += 1;
  }
  return summary;
}
