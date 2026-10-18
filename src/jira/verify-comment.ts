import { type AdfNode, adfBulletList, adfDoc, adfParagraph } from "./adf.js";

/** 结论评论（`AOS-VERIFY:<KEY>` marker 幂等复用）的构建与「映射用例」行解析。 */

export const VERIFY_MARKER_PREFIX = "AOS-VERIFY:";

export function verifyMarker(issueKey: string): string {
  return `${VERIFY_MARKER_PREFIX}${issueKey}`;
}

export type VerifyConclusion = "passed" | "failed" | "inconclusive";
export type CaseClassification = "strong" | "weak" | "explore";

export interface VerifyCommentInput {
  issue: { key: string; summary: string };
  conclusion: VerifyConclusion;
  composition: { strong: number; weak: number; explore: number };
  source: string;
  device: string;
  manifestPaths: string[];
  failed: Array<{
    caseId: string;
    name: string;
    classification: CaseClassification;
    traceId: string | null;
  }>;
  mapping?: { caseIds: string[] };
}

const CLASSIFICATION_LABEL: Record<CaseClassification, string> = {
  strong: "强",
  weak: "弱",
  explore: "探索"
};

export function buildVerifyComment(input: VerifyCommentInput): { text: string; adf: AdfNode } {
  const { strong, weak, explore } = input.composition;
  const total = strong + weak + explore;
  const strongFailed = input.failed.filter((entry) => entry.classification === "strong").length;
  const weakFailed = input.failed.filter((entry) => entry.classification !== "strong").length;
  const conclusionText =
    input.conclusion === "passed"
      ? "PASS"
      : input.conclusion === "failed"
        ? `FAIL（强断言失败 ${strongFailed} 条）`
        : strong === 0
          ? "无法判定（无强断言；弱断言仅记录路径，不代表验证通过）"
          : `无法判定（弱断言失败 ${weakFailed} 条；弱断言仅记录路径，不代表验证通过）`;

  const lines: string[] = [`【AOS 自动验证】${input.issue.key} ${input.issue.summary}`];
  lines.push(`- 结论: ${conclusionText}`);
  lines.push(`- 构成: 强 ${strong} · 弱 ${weak} · 探索 ${explore}（共 ${total} 条）`);
  lines.push(`- 来源: ${input.source}`);
  lines.push(`- 设备: ${input.device}`);
  for (const manifestPath of input.manifestPaths) lines.push(`- 批次: ${manifestPath}`);
  for (const entry of input.failed) {
    const trace = entry.traceId === null ? "" : `trace ${entry.traceId}，`;
    lines.push(`- 失败: ${entry.name}（${trace}${CLASSIFICATION_LABEL[entry.classification]}）`);
  }
  if (weak + explore > 0 && input.conclusion !== "inconclusive") {
    lines.push("弱断言仅记录路径，不代表验证通过");
  }
  if (input.mapping && input.mapping.caseIds.length > 0) {
    lines.push(`映射用例: ${input.mapping.caseIds.join(", ")}`);
  }

  const text = lines.join("\n");
  const adf = adfDoc([adfParagraph(lines[0] ?? ""), adfBulletList(lines.slice(1))]);
  return { text, adf };
}

const MAPPING_LINE_PATTERN = /^[-*•]?\s*映射用例[:：]\s*(.+)$/m;

export function parseVerifyMapping(text: string): string[] {
  const match = MAPPING_LINE_PATTERN.exec(text);
  if (match === null) return [];
  return match[1]!
    .split(/[,，、\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
