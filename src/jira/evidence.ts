import fs from "node:fs";
import path from "node:path";

import type { EvidenceBundle } from "../artemis/evidence.js";
import { type AdfNode, adfBulletList, adfDoc, adfParagraph } from "./adf.js";

export type EvidencePlatform = "android" | "ios" | "unknown";

export interface EvidenceCommentFacts {
  platform: EvidencePlatform;
  deviceSerial: string | null;
  failureDomain: string | null;
}

export interface EvidenceCommentDraft {
  text: string;
  adf: AdfNode;
  /** 存在的候选附件（绝对路径，≤6；已过滤不存在项）。 */
  attachments: string[];
}

const ATTACHMENT_CAP = 6;
const FAILED_ITEM_CAP = 10;

/** 候选附件：锚定步骤截图 + 设计差异标注图（annotated.png 优先）。 */
export function candidateAttachments(bundle: EvidenceBundle): string[] {
  const candidates: string[] = [];
  for (const artifact of bundle.artifacts) {
    if (artifact.kind === "screenshot" && artifact.path) {
      candidates.push(artifact.path);
    }
    if (artifact.kind === "design-diff" && artifact.path) {
      const annotated = path.join(path.dirname(artifact.path), "annotated.png");
      candidates.push(fs.existsSync(annotated) ? annotated : artifact.path);
    }
  }
  return [...new Set(candidates)]
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .slice(0, ATTACHMENT_CAP);
}

export function buildEvidenceComment(
  bundle: EvidenceBundle,
  facts: EvidenceCommentFacts
): EvidenceCommentDraft {
  const title = `【AOS 失败证据】trace ${bundle.traceId}`;
  const meta = [
    `平台: ${facts.platform}${facts.deviceSerial ? ` · 设备: ${facts.deviceSerial}` : ""}`,
    `状态: ${bundle.status ?? "unknown"}${bundle.error ? `（${bundle.error}）` : ""}`,
    `失败域: ${facts.failureDomain ?? "未分类"}`
  ];
  const failed = bundle.failedItems.slice(0, FAILED_ITEM_CAP).map((item) => {
    const parts = [item.itemText ?? "（未命名检查项）"];
    if (item.kind) parts.push(`类型=${item.kind}`);
    if (item.evidence) parts.push(`证据=${item.evidence}`);
    return parts.join(" · ");
  });
  const crashes = bundle.crashes.map(
    (crash) => `${crash.kind} · ${crash.exceptionClass}（${crash.package}，×${crash.occurrences}）`
  );
  const attachments = candidateAttachments(bundle);
  const degraded = [...bundle.degraded];

  const lines: string[] = [title, ...meta.map((line) => `- ${line}`)];
  if (failed.length > 0) lines.push("", "失败清单:", ...failed.map((line) => `- ${line}`));
  if (crashes.length > 0) lines.push("", "崩溃签名:", ...crashes.map((line) => `- ${line}`));
  if (attachments.length > 0) {
    lines.push("", "附件:", ...attachments.map((file) => `- ${path.basename(file)}`));
  }
  if (degraded.length > 0) lines.push("", "降级说明:", ...degraded.map((line) => `- ${line}`));
  const text = lines.join("\n");

  const adf = adfDoc([
    adfParagraph(title),
    adfBulletList(meta),
    ...(failed.length > 0 ? [adfParagraph("失败清单"), adfBulletList(failed)] : []),
    ...(crashes.length > 0 ? [adfParagraph("崩溃签名"), adfBulletList(crashes)] : []),
    ...(attachments.length > 0
      ? [adfParagraph("附件"), adfBulletList(attachments.map((file) => path.basename(file)))]
      : []),
    ...(degraded.length > 0 ? [adfParagraph("降级说明"), adfBulletList(degraded)] : [])
  ]);
  return { text, adf, attachments };
}
