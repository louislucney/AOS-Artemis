import type { SuiteCaseResult } from "./suite-runner.js";

export type FlakeCaseStatus = SuiteCaseResult["status"] | "missing";

export type FlakeVerdict = "stable-pass" | "stable-fail" | "flaky" | "untested";

export interface FlakeCaseReport {
  caseId: string;
  name: string | null;
  statuses: FlakeCaseStatus[];
  passRate: number;
  flips: number;
  flaky: boolean;
  verdict: FlakeVerdict;
}

export interface FlakeRound {
  round: number;
  passed: number;
  failed: number;
  executed: number;
}

export interface FlakeReport {
  generatedAt: string;
  runs: number;
  cases: FlakeCaseReport[];
  rounds: FlakeRound[];
  summary: {
    flakyCases: number;
    stablePass: number;
    stableFail: number;
    untestedCases: number;
    meanPassRate: number | null;
    stddevPassRate: number | null;
  };
}

/** 重复采样指标（纯函数）：行=用例、列=轮次；flaky 需同时出现通过与非通过。 */
export function buildFlakeReport(input: {
  generatedAt: string;
  caseIds: string[];
  caseNames?: Map<string, string>;
  rounds: SuiteCaseResult[][];
}): FlakeReport {
  const runs = input.rounds.length;
  const cases: FlakeCaseReport[] = input.caseIds.map((caseId) => {
    const statuses: FlakeCaseStatus[] = input.rounds.map((round) => {
      const entry = round.find((candidate) => candidate.caseId === caseId);
      return entry ? entry.status : "missing";
    });
    const passedCount = statuses.filter((status) => status === "passed").length;
    const missingCount = statuses.filter((status) => status === "missing").length;
    const failureLike = runs - passedCount - missingCount;
    let flips = 0;
    for (let index = 1; index < statuses.length; index += 1) {
      if (statuses[index] !== statuses[index - 1]) flips += 1;
    }
    let verdict: FlakeVerdict;
    if (passedCount === runs) verdict = "stable-pass";
    else if (passedCount === 0 && missingCount < runs) verdict = "stable-fail";
    else if (passedCount > 0 && failureLike > 0) verdict = "flaky";
    else verdict = "untested";
    return {
      caseId,
      name: input.caseNames?.get(caseId) ?? null,
      statuses,
      passRate: runs > 0 ? passedCount / runs : 0,
      flips,
      flaky: verdict === "flaky",
      verdict
    };
  });

  const rounds: FlakeRound[] = input.rounds.map((round, index) => {
    const passed = round.filter((entry) => entry.status === "passed").length;
    return { round: index + 1, passed, failed: round.length - passed, executed: round.length };
  });

  const measured = cases.filter((entry) => entry.verdict !== "untested");
  const meanPassRate =
    measured.length > 0
      ? measured.reduce((sum, entry) => sum + entry.passRate, 0) / measured.length
      : null;
  const stddevPassRate =
    meanPassRate === null
      ? null
      : Math.sqrt(
          measured.reduce((sum, entry) => sum + (entry.passRate - meanPassRate) ** 2, 0) /
            measured.length
        );

  return {
    generatedAt: input.generatedAt,
    runs,
    cases,
    rounds,
    summary: {
      flakyCases: cases.filter((entry) => entry.verdict === "flaky").length,
      stablePass: cases.filter((entry) => entry.verdict === "stable-pass").length,
      stableFail: cases.filter((entry) => entry.verdict === "stable-fail").length,
      untestedCases: cases.filter((entry) => entry.verdict === "untested").length,
      meanPassRate,
      stddevPassRate
    }
  };
}

export function renderFlakeMarkdown(report: FlakeReport): string {
  const lines: string[] = [
    "# Flake 采样报告（执行确定性量化）",
    "",
    `> 生成时间: ${report.generatedAt}`,
    `> 轮次: ${report.runs} · 用例: ${report.cases.length}`,
    "> 口径：翻转率决定投入强度（L2 条数/是否入门禁），不决定 D1 存废；`missing`=该轮未执行。",
    ""
  ];
  const header = ["用例", ...report.cases[0]?.statuses.map((_, index) => `R${index + 1}`) ?? [], "通过率", "翻转", "判定"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const entry of report.cases) {
    const label = entry.name ? `${entry.name} (${entry.caseId})` : entry.caseId;
    lines.push(
      `| ${[label, ...entry.statuses, `${(entry.passRate * 100).toFixed(0)}%`, String(entry.flips), entry.verdict].join(" | ")} |`
    );
  }
  lines.push("", "## 汇总", "");
  lines.push(
    `- 轮次通过数: ${report.rounds.map((round) => `R${round.round} ${round.passed}/${round.executed}`).join(" · ")}`,
    `- flaky ${report.summary.flakyCases} · stable-pass ${report.summary.stablePass} · stable-fail ${report.summary.stableFail} · 未执行 ${report.summary.untestedCases}`,
    `- 平均通过率 ${report.summary.meanPassRate === null ? "-" : `${(report.summary.meanPassRate * 100).toFixed(1)}%`} · 标准差 ${
      report.summary.stddevPassRate === null ? "-" : report.summary.stddevPassRate.toFixed(3)
    }`
  );
  return lines.join("\n") + "\n";
}
