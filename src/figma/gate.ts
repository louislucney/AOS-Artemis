import type { PreflightReport } from "./preflight.js";

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
  const issues: string[] = [];
  if (!preflight.artifacts.excelPresent) {
    issues.push(
      `缺少配套 tests.xlsx（三件套强制：须由 figma_generate_tests 同源生成 ${preflight.artifacts.excelFile}）`
    );
  } else if (preflight.artifacts.excelStale) {
    issues.push("tests.xlsx 早于 tests.json（疑似手改或未重新生成；请重新运行 figma_generate_tests）");
  }
  const missingPolicy = preflight.dataPolicy.missing;
  if (missingPolicy.length > 0) {
    const names = missingPolicy.slice(0, 3).map((entry) => entry.name).join("、");
    issues.push(
      `用例缺少真实数据约束【真实数据】（禁止伪造页面/假数据，数据须经真实请求链路）：` +
        `${names}${missingPolicy.length > 3 ? ` 等 ${missingPolicy.length} 条` : ""}` +
        "（需由 figma_generate_tests 重新生成）"
    );
  }
  const coverage = preflight.coverage;
  if (!coverage.available) {
    issues.push("流程覆盖校验不可用：缺 flows.json，无法判定流程完整性（按不通过处理）");
  } else {
    const uncovered = coverage.uncoveredScreens.length + coverage.uncoveredEdges.length;
    const generation = preflight.generation as { truncated?: unknown } | null;
    const truncated = generation?.truncated === true;
    const strictWeak = options.strict === true && preflight.weakCases.length > 0;
    if (uncovered > 0 || truncated) {
      issues.push(
        `流程未完整覆盖：未硬覆盖屏幕 ${coverage.uncoveredScreens.length} · ` +
          `未硬覆盖跳转 ${coverage.uncoveredEdges.length}${truncated ? " · 路径截断" : ""}` +
          (strictWeak ? ` · --strict 弱断言 ${preflight.weakCases.length} 条` : "")
      );
    } else if (strictWeak) {
      issues.push(`--strict 门禁未通过：弱断言 ${preflight.weakCases.length} 条（explore 步骤已豁免）`);
    }
  }
  return issues.length > 0 ? issues.join("；") : null;
}
