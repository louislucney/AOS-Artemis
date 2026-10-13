/** 台账状态 → 结论（面板与 run-report 共用的单一事实源；DESIGN §13.95）：
 * completed→passed、submitted→pending（界面展示文案"运行中"）、其余→failed。 */
export type TaskOutcome = "passed" | "failed" | "pending";

export function outcomeOf(ledgerStatus: string): TaskOutcome {
  if (ledgerStatus === "completed") return "passed";
  if (ledgerStatus === "submitted") return "pending";
  return "failed";
}
