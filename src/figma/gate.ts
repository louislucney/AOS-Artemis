import fs from "node:fs";

import type { PreflightReport } from "./preflight.js";

/** 三件套硬门禁：tests.xlsx 存在且不早于 tests.json（缺/过期均不通过）。 */
export function artifactGateIssue(preflight: PreflightReport | null): string | null {
  if (!preflight) return null;
  if (!preflight.artifacts.excelPresent) {
    return `缺少配套 tests.xlsx（三件套强制：须由 figma_generate_tests 同源生成 ${preflight.artifacts.excelFile}）`;
  }
  if (preflight.artifacts.excelStale) {
    return "tests.xlsx 早于 tests.json（疑似手改或未重新生成；请重新运行 figma_generate_tests）";
  }
  return null;
}

/** 真实数据硬门禁：每条用例的 taskDesc 必须携带【真实数据】条款。 */
export function dataPolicyGateIssue(preflight: PreflightReport | null): string | null {
  if (!preflight) return null;
  const missingPolicy = preflight.dataPolicy.missing;
  if (missingPolicy.length === 0) return null;
  const names = missingPolicy.slice(0, 3).map((entry) => entry.name).join("、");
  return (
    `用例缺少真实数据约束【真实数据】（禁止伪造页面/假数据，数据须经真实请求链路）：` +
    `${names}${missingPolicy.length > 3 ? ` 等 ${missingPolicy.length} 条` : ""}` +
    "（需由 figma_generate_tests 重新生成）"
  );
}

function coverageTierIssue(preflight: PreflightReport, options: { strict?: boolean }): string | null {
  const coverage = preflight.coverage;
  if (!coverage.available) {
    return "流程覆盖校验不可用：缺 flows.json，无法判定流程完整性（按不通过处理）";
  }
  const uncovered = coverage.uncoveredScreens.length + coverage.uncoveredEdges.length;
  const generation = preflight.generation as { truncated?: unknown } | null;
  const truncated = generation?.truncated === true;
  const strictWeak = options.strict === true && preflight.weakCases.length > 0;
  if (uncovered > 0 || truncated) {
    return (
      `流程未完整覆盖：未硬覆盖屏幕 ${coverage.uncoveredScreens.length} · ` +
      `未硬覆盖跳转 ${coverage.uncoveredEdges.length}${truncated ? " · 路径截断" : ""}` +
      (strictWeak ? ` · --strict 弱断言 ${preflight.weakCases.length} 条` : "")
    );
  }
  if (strictWeak) {
    return `--strict 门禁未通过：弱断言 ${preflight.weakCases.length} 条（explore 步骤已豁免）`;
  }
  return null;
}

/** Reason the run fails the flow-coverage gate, or null when it passes.
 * Hard gates: artifact integrity (tests.xlsx present and not older than
 * tests.json — 三件套强制), real-data policy (every case's taskDesc carries
 * the 【真实数据】 clause — fabricated pages/data are forbidden), and flow
 * coverage (hard-class gaps always gate; inferred exploration gaps never do).
 * `--strict` additionally gates on weak assertions (non-explore steps without
 * a checkable expectation). Fail-closed: unreadable preflight data or missing
 * flows.json both count as "cannot prove completeness" (DESIGN §6.10). */
export function coverageGateIssue(
  preflight: PreflightReport | null,
  options: { strict?: boolean } = {}
): string | null {
  if (!preflight) {
    return "流程覆盖校验不可用：预检数据缺失（tests.json 不可读）";
  }
  const issues = [
    artifactGateIssue(preflight),
    dataPolicyGateIssue(preflight),
    coverageTierIssue(preflight, options)
  ].filter((issue): issue is string => issue !== null);
  return issues.length > 0 ? issues.join("；") : null;
}

/** True when the tests file declares an imported case set (`meta.source` 前缀 `imported:`）。 */
export function isImportedTestsFile(testsPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(testsPath, "utf8")) as {
      meta?: { source?: unknown };
    } | null;
    const source = parsed?.meta?.source;
    return typeof source === "string" && source.startsWith("imported:");
  } catch {
    return false;
  }
}
