import { type AdfNode, adfBulletList, adfDoc, adfParagraph } from "./adf.js";

export interface RegressionIssueFacts {
  projectName?: string | null;
  runId: string;
  taskId?: string | null;
  featureName?: string | null;
  platform: string;
  device?: string | null;
  appVersion?: string | null;
  runAt?: string | null;
  caseId: string;
  caseName: string;
  failureDomain?: string | null;
  failureConfidence?: string | null;
  failureReason?: string | null;
  traceId?: string | null;
  evidencePaths: string[];
  artifactUrl?: string | null;
  verdictNote?: string | null;
}

function present(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function buildRegressionIssueSummary(facts: RegressionIssueFacts): string {
  const feature = present(facts.featureName);
  return `[回归] ${feature !== null ? `${feature} · ` : ""}${facts.caseName} 失败`;
}

export function buildRegressionIssueDescription(facts: RegressionIssueFacts): AdfNode {
  const bullets: string[] = [];
  const projectName = present(facts.projectName);
  if (projectName !== null) bullets.push(`项目：${projectName}`);
  bullets.push(`运行 ID：${facts.runId}`);
  const taskId = present(facts.taskId);
  if (taskId !== null) bullets.push(`任务 ID：${taskId}`);
  bullets.push(`用例：${facts.caseId} · ${facts.caseName}`);
  bullets.push(`端：${facts.platform}`);
  const device = present(facts.device);
  if (device !== null) bullets.push(`设备：${device}`);
  const appVersion = present(facts.appVersion);
  if (appVersion !== null) bullets.push(`应用版本：${appVersion}`);
  const runAt = present(facts.runAt);
  if (runAt !== null) bullets.push(`运行时间：${runAt}`);
  const failureDomain = present(facts.failureDomain);
  if (failureDomain !== null) {
    const confidence = present(facts.failureConfidence);
    bullets.push(`失败域：${failureDomain}${confidence !== null ? `（置信：${confidence}）` : ""}`);
  }
  const failureReason = present(facts.failureReason);
  if (failureReason !== null) bullets.push(`失败理由：${failureReason}`);
  const traceId = present(facts.traceId);
  if (traceId !== null) bullets.push(`traceId：${traceId}`);
  const verdictNote = present(facts.verdictNote);
  if (verdictNote !== null) bullets.push(`裁决备注：${verdictNote}`);
  for (const evidencePath of facts.evidencePaths) {
    const entry = present(evidencePath);
    if (entry !== null) bullets.push(`证据路径：${entry}`);
  }
  const artifactUrl = present(facts.artifactUrl);
  if (artifactUrl !== null) bullets.push(`产物 URL：${artifactUrl}`);

  return adfDoc([adfParagraph(buildRegressionIssueSummary(facts)), adfBulletList(bullets)]);
}
