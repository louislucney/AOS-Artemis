import type { CalibrationReport } from "./calibration.js";
import type { FeedbackSuggestion, GenerationFeedback } from "./generation-feedback.js";
import type { PreflightReport } from "./preflight.js";
import type { SuiteRunReport } from "./suite-runner.js";

export interface SuiteLoopCheck {
  testsPath: string;
  preflight: PreflightReport;
  issue: string | null;
  routeDrift: string[];
}

export interface SuiteLoopInput {
  generatedAt: string;
  check: SuiteLoopCheck | null;
  run: SuiteRunReport | null;
  feedback: GenerationFeedback | null;
  feedbackError?: string | null;
  calibration: CalibrationReport | null;
}

export interface SuiteLoopReport {
  generatedAt: string;
  steps: {
    check: {
      testsPath: string;
      cases: number;
      weakCases: number;
      coverageAvailable: boolean;
      uncoveredScreens: number;
      uncoveredEdges: number;
      routeDrift: string[];
      issue: string | null;
    } | null;
    run: {
      executed: number;
      passed: number;
      failed: number;
      skipped: number;
      flaky: number;
      failureDomains: Record<string, number>;
    } | null;
    feedback: {
      suggestions: number;
      issues: { weakAssertions: number; apiErrors: number; data: number; screens: number };
      error: string | null;
    } | null;
    calibration: {
      matched: number;
      mcpMiss: number;
      mcpFalseAlarm: number;
      missRate: number | null;
      falseAlarmRate: number | null;
    } | null;
  };
  nextActions: string[];
  topSuggestions: FeedbackSuggestion[];
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

export { percent as loopPercent };

/** Deterministic 测试→完善 下一步动作（不含 LLM 判定）。 */
export function deriveLoopActions(input: SuiteLoopInput): string[] {
  const actions: string[] = [];
  if (!input.check) {
    actions.push("无法读取 tests.json：先运行 figma_generate_tests（或修正 --tests 路径）");
  } else {
    if (input.check.issue) {
      actions.push(
        `${input.check.issue}；补原型连线/提高 maxFlows 后重新生成（figma_generate_tests requireFullCoverage:true）`
      );
    }
    if (input.check.preflight.weakCases.length > 0) {
      actions.push(
        `弱断言 ${input.check.preflight.weakCases.length} 条：为对应步骤补目的地屏文本提示后重新生成`
      );
    }
    if (input.check.routeDrift.length > 0) {
      actions.push(`路线漂移 ${input.check.routeDrift.length} 处：${input.check.routeDrift.join("、")}（测试引用但设计缺失，核对设计或改用例）`);
    }
  }
  if (input.run) {
    const flaky = input.run.cases.filter((entry) => entry.retry?.flaky === true).length;
    if (input.run.failed > 0) {
      actions.push(`首跑失败 ${input.run.failed} 例：按失败域定位（应用缺陷/环境/数据环境/行为或设计/用例缺陷）并修正后重跑 --retry 复诊`);
    }
    if (flaky > 0) {
      actions.push(`flaky ${flaky} 例：确认非真缺陷后加 quarantine（需 owner 签字）`);
    }
  }
  if (input.feedback?.ok) {
    const { issues } = input.feedback;
    if (issues.apiErrors.length > 0) {
      actions.push(
        `未处理 API 错误 ${issues.apiErrors.length} 类：补 error-codes.json 处理规则（按 api error 门禁需 handledPattern）`
      );
    }
    if (issues.data.length > 0) {
      actions.push(`数据类失败 ${issues.data.length} 组：把数据前置写入 taskDesc（fixture/后端数据对齐）`);
    }
    if (issues.screens.length > 0) {
      actions.push(
        `失败热点屏幕 top${Math.min(3, issues.screens.length)}：${issues.screens
          .slice(0, 3)
          .map((entry) => entry.screen)
          .join("、")}`
      );
    }
  }
  if (input.calibration) {
    if (input.calibration.mcpMiss > 0) {
      actions.push(
        `差分校准：MCP 漏报 ${input.calibration.mcpMiss} 例（XCTest fail / MCP pass）——复核判定或补断言；漏报率 ${percent(input.calibration.missRate)}`
      );
    }
    if (input.calibration.mcpFalseAlarm > 0) {
      actions.push(
        `差分校准：MCP 误报 ${input.calibration.mcpFalseAlarm} 例（XCTest pass / MCP fail）——复核等待/数据；误报率 ${percent(input.calibration.falseAlarmRate)}`
      );
    }
  }
  if (actions.length === 0) {
    actions.push("闭环无阻塞：覆盖完整、无失败/漂移/校准缺口（可进入下一轮设计变更）");
  }
  return actions;
}

export function buildSuiteLoopReport(input: SuiteLoopInput): SuiteLoopReport {
  const failureDomains: Record<string, number> = {};
  let flaky = 0;
  if (input.run) {
    for (const entry of input.run.cases) {
      if (entry.status !== "passed") {
        const domain = entry.failure?.domain ?? "unclassified";
        failureDomains[domain] = (failureDomains[domain] ?? 0) + 1;
      }
      if (entry.retry?.flaky === true) flaky += 1;
    }
  }
  return {
    generatedAt: input.generatedAt,
    steps: {
      check: input.check
        ? {
            testsPath: input.check.testsPath,
            cases: input.check.preflight.cases,
            weakCases: input.check.preflight.weakCases.length,
            coverageAvailable: input.check.preflight.coverage.available,
            uncoveredScreens: input.check.preflight.coverage.uncoveredScreens.length,
            uncoveredEdges: input.check.preflight.coverage.uncoveredEdges.length,
            routeDrift: input.check.routeDrift,
            issue: input.check.issue
          }
        : null,
      run: input.run
        ? {
            executed: input.run.executed,
            passed: input.run.passed,
            failed: input.run.failed,
            skipped: input.run.skipped,
            flaky,
            failureDomains
          }
        : null,
      feedback: input.feedback
        ? {
            suggestions: input.feedback.suggestions.length,
            issues: {
              weakAssertions: input.feedback.issues.weakAssertions.length,
              apiErrors: input.feedback.issues.apiErrors.length,
              data: input.feedback.issues.data.length,
              screens: input.feedback.issues.screens.length
            },
            error: null
          }
        : input.feedbackError
          ? { suggestions: 0, issues: { weakAssertions: 0, apiErrors: 0, data: 0, screens: 0 }, error: input.feedbackError }
          : null,
      calibration: input.calibration
        ? {
            matched: input.calibration.matched,
            mcpMiss: input.calibration.mcpMiss,
            mcpFalseAlarm: input.calibration.mcpFalseAlarm,
            missRate: input.calibration.missRate,
            falseAlarmRate: input.calibration.falseAlarmRate
          }
        : null
    },
    nextActions: deriveLoopActions(input),
    topSuggestions: (input.feedback?.suggestions ?? []).slice(0, 10)
  };
}

export function renderSuiteLoopMarkdown(report: SuiteLoopReport): string {
  const lines: string[] = ["# 测试闭环报告（test → improve）", "", `> 生成时间: ${report.generatedAt}`, ""];
  lines.push("## 步骤结果", "");
  const check = report.steps.check;
  lines.push(
    `- 静态检查: ${
      check
        ? check.issue
          ? `未通过（${check.issue}）`
          : `通过（用例 ${check.cases} · 弱断言 ${check.weakCases} · 未覆盖屏幕 ${check.uncoveredScreens} · 未覆盖跳转 ${check.uncoveredEdges}）`
        : "不可用（无 tests.json）"
    }`
  );
  const run = report.steps.run;
  lines.push(
    `- 执行: ${
      run
        ? `pass ${run.passed} / fail ${run.failed} / skipped ${run.skipped}（flaky ${run.flaky}）` +
          (Object.keys(run.failureDomains).length > 0
            ? ` · 失败域 ${Object.entries(run.failureDomains)
                .map(([domain, count]) => `${domain}×${count}`)
                .join("、")}`
            : "")
        : "未执行（--skip-run）"
    }`
  );
  const feedback = report.steps.feedback;
  lines.push(
    `- 反馈: ${
      feedback
        ? feedback.error
          ? `不可用（${feedback.error}）`
          : `建议 ${feedback.suggestions} 条（弱断言 ${feedback.issues.weakAssertions} · API ${feedback.issues.apiErrors} · 数据 ${feedback.issues.data} · 热点 ${feedback.issues.screens}）`
        : "未生成"
    }`
  );
  const calibration = report.steps.calibration;
  lines.push(
    `- 差分校准: ${
      calibration
        ? `对齐 ${calibration.matched} · MCP 漏报 ${calibration.mcpMiss}（${percent(calibration.missRate)}）· MCP 误报 ${calibration.mcpFalseAlarm}（${percent(calibration.falseAlarmRate)}）`
        : "未提供"
    }`
  );
  lines.push("", "## 下一步动作", "");
  report.nextActions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  if (report.topSuggestions.length > 0) {
    lines.push("", "## 生成改进建议（top）", "");
    for (const suggestion of report.topSuggestions) {
      const refs = [
        suggestion.caseIds.length > 0 ? `cases=${suggestion.caseIds.join(",")}` : null,
        suggestion.traceIds.length > 0 ? `traces=${suggestion.traceIds.join(",")}` : null
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`- [${suggestion.kind}] ${suggestion.message}${refs ? `（${refs}）` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}
