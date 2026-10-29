import type { AssertionDoc } from "./assertions.js";
import type { ParsedExcelCase } from "./excel.js";
import type { WebJobCaseFilter } from "./job-spec.js";
import type { WebResultCase, WebResultVerdictStatus } from "./results.js";

export interface DeriveVerdictsInput {
  payloadCases: WebResultCase[];
  /** null＝原件不可解析，禁用断言门禁。 */
  sourceCases: ParsedExcelCase[] | null;
  assertions: Map<string, AssertionDoc> | null;
  caseFilter: WebJobCaseFilter;
  /**
   * 任务级 error / 强制 failed 且用例全 PASS：逐例结果不写回，也不补写未执行用例。
   */
  suppressPerCaseResult: boolean;
}

export interface DeriveVerdictsResult {
  cases: WebResultCase[];
  warnings: string[];
  unverified: number;
  missing: number;
  reasons: Array<{ caseId: string; status: WebResultVerdictStatus; reason: string }>;
}

const REASON_TEXT: Record<string, string> = {
  "case-not-in-source": "原件中找不到该用例",
  "assertion-doc-missing": "缺少断言文档",
  "no-executable-assertion": "没有可执行的断言",
  "manual-or-ambiguous": "断言含人工或歧义项",
  "soft-assertion-only": "仅有软断言，缺少高置信可执行断言",
  "assertion-proof-missing": "runner 未上报断言证据",
  "source-unreadable": "原件不可解析，无法生成断言"
};

const MAX_LISTED = 10;

function summarize(items: string[]): string {
  const head = items.slice(0, MAX_LISTED).join("、");
  return items.length > MAX_LISTED ? `${head}…` : head;
}

function hasInlineManual(doc: AssertionDoc): boolean {
  return doc.steps.some((step) => step.assert.some((assertion) => assertion.type === "manual"));
}

function hasExecutableAssertion(doc: AssertionDoc): boolean {
  return doc.steps.some((step) => step.assert.some((assertion) => assertion.type !== "manual"));
}

/**
 * PASS 的断言门禁：断言文档可执行、无人工/歧义、runner 上报的硬断言数 > 0。
 * 空预期（只有 `无预期` 注释、没有步骤）按“无可执行断言”处理，而不是“人工/歧义”。
 */
export function assertionGate(
  doc: AssertionDoc | undefined,
  assertionCount: number | undefined
): { status: "PASS" | "UNVERIFIED"; reason: string } {
  if (doc === undefined) return { status: "UNVERIFIED", reason: "assertion-doc-missing" };
  if (!hasExecutableAssertion(doc)) {
    if (doc.ambiguous.length > 0 || hasInlineManual(doc)) {
      return { status: "UNVERIFIED", reason: "manual-or-ambiguous" };
    }
    return { status: "UNVERIFIED", reason: "no-executable-assertion" };
  }
  if (doc.manual.length > 0 || doc.ambiguous.length > 0 || hasInlineManual(doc)) {
    return { status: "UNVERIFIED", reason: "manual-or-ambiguous" };
  }
  if (doc.confidence !== "high") {
    return { status: "UNVERIFIED", reason: "soft-assertion-only" };
  }
  if (assertionCount === undefined || assertionCount <= 0) {
    return { status: "UNVERIFIED", reason: "assertion-proof-missing" };
  }
  return { status: "PASS", reason: "ok" };
}

/** 任务用例范围：空过滤＝全部；否则按（去空白后的）模块或用例编号精确匹配。 */
export function selectSourceCases(
  cases: ParsedExcelCase[],
  filter: WebJobCaseFilter
): ParsedExcelCase[] {
  const modules = filter.modules.map((module) => module.trim()).filter((module) => module !== "");
  const caseIds = filter.caseIds.map((caseId) => caseId.trim()).filter((caseId) => caseId !== "");
  if (modules.length === 0 && caseIds.length === 0) return cases;
  const moduleSet = new Set(modules);
  const caseIdSet = new Set(caseIds);
  return cases.filter((entry) => {
    const caseId = entry.caseId.trim();
    if (caseId !== "" && caseIdSet.has(caseId)) return true;
    const module = entry.module?.trim() ?? "";
    return module !== "" && moduleSet.has(module);
  });
}

function downgrade(entry: WebResultCase, reason: string): WebResultCase {
  return {
    ...entry,
    status: "UNVERIFIED",
    failureReason: `未验证：${REASON_TEXT[reason] ?? reason}`
  };
}

/**
 * 中心侧结果判定：runner 的 PASS 只在有断言证据时保留，否则降级 UNVERIFIED；
 * 任务范围内但结果缺失的用例补 `SKIP`（Excel 写 `SKIP（未执行）`）。
 */
export function deriveCaseVerdicts(input: DeriveVerdictsInput): DeriveVerdictsResult {
  const { payloadCases, sourceCases, assertions, caseFilter, suppressPerCaseResult } = input;

  /** 任务级错误不采纳逐例 PASS，写 ERROR（避免 Excel 残留旧 PASS）。 */
  const suppressed = (entry: WebResultCase): WebResultCase => ({
    ...entry,
    status: "ERROR",
    failureReason: "任务级错误，未采纳逐例 PASS"
  });

  if (sourceCases === null) {
    // fail-closed：没有原件就无法证明预期，PASS 不得直通；缺失范围同样未知，不补 SKIP。
    const cases: WebResultCase[] = [];
    const reasons: DeriveVerdictsResult["reasons"] = [];
    const downgraded: string[] = [];
    for (const entry of payloadCases) {
      if (entry.status !== "PASS") {
        cases.push(entry);
        continue;
      }
      const caseId = entry.caseId.trim();
      if (suppressPerCaseResult) {
        cases.push(suppressed(entry));
        reasons.push({ caseId, status: "ERROR", reason: "task-level-error" });
        continue;
      }
      cases.push(downgrade(entry, "source-unreadable"));
      downgraded.push(`${caseId}:source-unreadable`);
      reasons.push({ caseId, status: "UNVERIFIED", reason: "source-unreadable" });
    }
    const warnings = [
      "verdict-source-unreadable: 原件不可解析，无法生成断言；PASS 一律不采用"
    ];
    if (downgraded.length > 0) {
      warnings.unshift(
        `verdict-unverified: ${downgraded.length} 个 PASS 降级为 UNVERIFIED（${summarize(downgraded)}）`
      );
    }
    return {
      cases,
      warnings,
      unverified: downgraded.length,
      missing: 0,
      reasons
    };
  }

  const selected = selectSourceCases(sourceCases, caseFilter);
  const sourceById = new Map<string, ParsedExcelCase>();
  for (const entry of sourceCases) {
    const caseId = entry.caseId.trim();
    if (caseId === "" || sourceById.has(caseId)) continue;
    sourceById.set(caseId, entry);
  }
  const payloadIds = new Set(payloadCases.map((entry) => entry.caseId.trim()));

  const cases: WebResultCase[] = [];
  const reasons: DeriveVerdictsResult["reasons"] = [];
  const downgraded: string[] = [];

  for (const entry of payloadCases) {
    if (entry.status !== "PASS") {
      cases.push(entry);
      continue;
    }
    const caseId = entry.caseId.trim();
    if (suppressPerCaseResult) {
      cases.push(suppressed(entry));
      reasons.push({ caseId, status: "ERROR", reason: "task-level-error" });
      continue;
    }
    const source = sourceById.get(caseId);
    if (source === undefined) {
      cases.push(downgrade(entry, "case-not-in-source"));
      downgraded.push(`${caseId}:case-not-in-source`);
      reasons.push({ caseId, status: "UNVERIFIED", reason: "case-not-in-source" });
      continue;
    }
    const gate = assertionGate(assertions?.get(caseId), entry.assertionCount);
    if (gate.status === "PASS") {
      cases.push(entry);
      continue;
    }
    cases.push(downgrade(entry, gate.reason));
    downgraded.push(`${caseId}:${gate.reason}`);
    reasons.push({ caseId, status: "UNVERIFIED", reason: gate.reason });
  }

  // 缺失用例覆盖**全部原件用例**（不只是 caseFilter 选中范围）：过滤只影响执行范围，
  // 未选中/未执行的用例同样要写 SKIP，避免旧 PASS 残留。
  const missing: ParsedExcelCase[] = [];
  for (const entry of sourceCases) {
    const caseId = entry.caseId.trim();
    if (caseId === "" || payloadIds.has(caseId)) continue;
    payloadIds.add(caseId);
    missing.push(entry);
  }

  const warnings: string[] = [];
  if (downgraded.length > 0) {
    warnings.push(
      `verdict-unverified: ${downgraded.length} 个 PASS 降级为 UNVERIFIED（${summarize(downgraded)}）`
    );
  }
  const hasFilter =
    caseFilter.modules.some((module) => module.trim() !== "") ||
    caseFilter.caseIds.some((caseId) => caseId.trim() !== "");
  const outOfScope = sourceCases.length - selected.length;
  if (hasFilter && outOfScope > 0) {
    warnings.push(
      `verdict-partial-scope: 过滤条件仅选中 ${selected.length}/${sourceCases.length} 个用例，其余 ${outOfScope} 个写 SKIP（未执行）`
    );
  }

  let missingCount = 0;
  if (missing.length > 0) {
    for (const entry of missing) {
      const caseId = entry.caseId.trim();
      if (suppressPerCaseResult) {
        cases.push({
          caseId,
          name: entry.name,
          status: "ERROR",
          durationMs: 0,
          failureReason: "任务级错误，未执行",
          synthetic: true
        });
        reasons.push({ caseId, status: "ERROR", reason: "task-level-error" });
        continue;
      }
      cases.push({
        caseId,
        name: entry.name,
        status: "SKIP",
        durationMs: 0,
        failureReason: "未执行",
        synthetic: true
      });
      reasons.push({ caseId, status: "SKIP", reason: "未执行" });
    }
    missingCount = missing.length;
    warnings.push(
      suppressPerCaseResult
        ? `verdict-missing-result: ${missingCount} 个用例未执行，写 ERROR（任务级错误）（${summarize(
            missing.map((entry) => entry.caseId.trim())
          )}）`
        : `verdict-missing-result: ${missingCount} 个用例未执行，写 SKIP（未执行）（${summarize(
            missing.map((entry) => entry.caseId.trim())
          )}）`
    );
  }

  return {
    cases,
    warnings,
    unverified: downgraded.length,
    missing: missingCount,
    reasons
  };
}
